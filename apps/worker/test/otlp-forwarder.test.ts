import { createServer, type Server } from "node:http";
import {
  createClickHouseClient,
  insertObservations,
  insertTraces,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import { runMigrations as runPgMigrations } from "@ironside/db";
import { ulid } from "ulid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { forwardOtlpTraces } from "../src/forwarders/otlp-forwarder.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);

let projectId: string;
let server: Server;
let serverUrl: string;
let receivedRequests: { headers: Record<string, string>; body: unknown }[] = [];
let respondWithStatus = 200;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  const orgId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "otlp-forwarder-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, "otlp-forwarder-test"]
  );

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      receivedRequests.push({
        headers: req.headers as Record<string, string>,
        body: JSON.parse(body || "{}")
      });
      res.statusCode = respondWithStatus;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address && typeof address === "object") {
    serverUrl = `http://localhost:${address.port}/v1/traces`;
  }
});

beforeEach(() => {
  receivedRequests = [];
  respondWithStatus = 200;
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'otlp-forwarder-test-org'");
  await pool.end();
  await clickhouse.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("forwardOtlpTraces", () => {
  it("forwards each matching trace as its own OTLP export request, with correctly nested spans", async () => {
    const marker = `otlp_fwd_${ulid()}`;
    const traceId = `trace_${marker}`;
    const rootId = `obs_${marker}_root`;
    const childId = `obs_${marker}_child`;
    const eventTs = new Date().toISOString();

    await insertTraces(
      clickhouse,
      [
        {
          id: traceId,
          projectId,
          timestamp: "2026-07-12T00:00:00.000Z",
          name: "checkout",
          tags: [marker],
          metadata: {}
        }
      ],
      { eventTs }
    );
    await insertObservations(
      clickhouse,
      [
        {
          id: rootId,
          traceId,
          projectId,
          type: "span",
          name: "handle-request",
          startTime: "2026-07-12T00:00:00.000Z",
          endTime: "2026-07-12T00:00:01.000Z",
          level: "default",
          metadata: {}
        },
        {
          id: childId,
          traceId,
          projectId,
          parentObservationId: rootId,
          type: "generation",
          name: "llm-call",
          model: "gpt-4o",
          startTime: "2026-07-12T00:00:00.200Z",
          endTime: "2026-07-12T00:00:00.900Z",
          usageDetails: { input_tokens: 10, output_tokens: 20 },
          level: "default",
          metadata: {}
        }
      ],
      { eventTs }
    );

    const result = await forwardOtlpTraces({
      clickhouse,
      rule: {
        id: "rule_1",
        projectId,
        name: "test rule",
        destinationUrl: serverUrl,
        destinationAuthHeaderEncrypted: "unused-in-this-test",
        filter: { tags: [marker] },
        enabled: true,
        pollIntervalSeconds: 300,
        nextRunAt: new Date()
      },
      // The forwarder takes the already-decrypted value; encryption is the
      // API/worker layer's job (@ironside/shared's decryptSecret), not exercised here.
      destinationAuthHeader: "Bearer test-token",
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });

    expect(result.matched).toBe(1);
    expect(result.forwarded).toBe(1);
    expect(result.failed).toEqual([]);
    expect(receivedRequests).toHaveLength(1);

    const req = receivedRequests[0]!;
    expect(req.headers.authorization).toBe("Bearer test-token");
    const spans = (
      req.body as { resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[] }
    ).resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(2);
    const rootSpan = spans.find((s) => s.name === "handle-request");
    const childSpan = spans.find((s) => s.name === "llm-call");
    expect(childSpan?.parentSpanId).toBe(rootSpan?.spanId);
    expect(
      (childSpan?.attributes as { key: string; value: { stringValue: string } }[]).find(
        (a) => a.key === "gen_ai.request.model"
      )?.value.stringValue
    ).toBe("gpt-4o");
  });

  it("records a per-trace failure without aborting the rest of the run", async () => {
    respondWithStatus = 500;
    const marker = `otlp_fwd_fail_${ulid()}`;
    await insertTraces(
      clickhouse,
      [
        {
          id: `trace_${marker}`,
          projectId,
          timestamp: new Date().toISOString(),
          tags: [marker],
          metadata: {}
        }
      ],
      { eventTs: new Date().toISOString() }
    );

    const result = await forwardOtlpTraces({
      clickhouse,
      rule: {
        id: "rule_2",
        projectId,
        name: "failing rule",
        destinationUrl: serverUrl,
        destinationAuthHeaderEncrypted: null,
        filter: { tags: [marker] },
        enabled: true,
        pollIntervalSeconds: 300,
        nextRunAt: new Date()
      },
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });

    expect(result.matched).toBe(1);
    expect(result.forwarded).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toMatch(/500/);
  });

  it("only forwards the authenticated project's traces matching the rule's filter", async () => {
    const marker = `otlp_fwd_isolation_${ulid()}`;
    await insertTraces(
      clickhouse,
      [
        {
          id: `trace_${marker}_match`,
          projectId,
          timestamp: new Date().toISOString(),
          tags: [marker],
          metadata: {}
        },
        {
          id: `trace_${marker}_nomatch`,
          projectId,
          timestamp: new Date().toISOString(),
          tags: ["different-tag"],
          metadata: {}
        }
      ],
      { eventTs: new Date().toISOString() }
    );

    const result = await forwardOtlpTraces({
      clickhouse,
      rule: {
        id: "rule_3",
        projectId,
        name: "filtered rule",
        destinationUrl: serverUrl,
        destinationAuthHeaderEncrypted: null,
        filter: { tags: [marker] },
        enabled: true,
        pollIntervalSeconds: 300,
        nextRunAt: new Date()
      },
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });

    expect(result.matched).toBe(1);
    expect(result.forwarded).toBe(1);
  });

  it("refuses to run against a destination URL that resolves to a private/internal address (SSRF guard)", async () => {
    const result = forwardOtlpTraces({
      clickhouse,
      rule: {
        id: "rule_ssrf",
        projectId,
        name: "ssrf-attempt rule",
        destinationUrl: "http://127.0.0.1:9/v1/traces",
        destinationAuthHeaderEncrypted: null,
        filter: {},
        enabled: true,
        pollIntervalSeconds: 300,
        nextRunAt: new Date()
      },
      traceQuietPeriodSeconds: 0
    });
    await expect(result).rejects.toThrow(/non-public address/);
    expect(receivedRequests).toHaveLength(0);
  });
});
