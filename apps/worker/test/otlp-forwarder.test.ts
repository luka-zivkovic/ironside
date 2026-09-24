import { createServer, type Server } from "node:http";
import { createClickHouseClient, runMigrations as runChMigrations } from "@ironside/clickhouse";
import {
  createOtlpForwardRule,
  getOtlpForwardRule,
  updateOtlpForwardRule,
  runMigrations as runPgMigrations,
  type OtlpForwardRule
} from "@ironside/db";
import { ulid } from "ulid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { forwardOtlpTraces } from "../src/forwarders/otlp-forwarder.js";
import { loadConfig } from "../src/config.js";
import { insertPublishedTrace } from "./support/published-traces.js";

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
      if (respondWithStatus >= 300 && respondWithStatus < 400) res.setHeader("location", "/elsewhere");
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

/**
 * A saved rule, disabled: forwardOtlpTraces ignores `enabled`, and disabled
 * rules stay out of reach of the scheduler tests, which claim every due rule
 * in the shared database and would otherwise run it concurrently.
 */
async function createDisabledRule(
  input: Omit<Parameters<typeof createOtlpForwardRule>[1], "projectId">
): Promise<OtlpForwardRule> {
  const created = await createOtlpForwardRule(pool, { ...input, projectId });
  await updateOtlpForwardRule(pool, projectId, created.id, { enabled: false });
  return (await getOtlpForwardRule(pool, projectId, created.id))!;
}

/** An unsaved rule starting at the beginning of the feed; progress writes to a missing id are no-ops. */
function rule(overrides: Partial<OtlpForwardRule> = {}): OtlpForwardRule {
  return {
    id: `rule_${ulid()}`,
    projectId,
    name: "test rule",
    destinationUrl: serverUrl,
    destinationAuthHeaderEncrypted: null,
    filter: {},
    enabled: true,
    pollIntervalSeconds: 300,
    nextRunAt: new Date(),
    feedCursor: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    lastRunForwardedCount: null,
    ...overrides
  };
}

describe("forwardOtlpTraces", () => {
  it("forwards each matching trace as its own OTLP export request, with correctly nested spans", async () => {
    const marker = `otlp_fwd_${ulid()}`;
    const traceId = `trace_${marker}`;
    const rootId = `obs_${marker}_root`;
    const childId = `obs_${marker}_child`;
    const eventTs = new Date().toISOString();

    await insertPublishedTrace({ pool, clickhouse }, {
      trace: {
        id: traceId,
        projectId,
        timestamp: "2026-07-12T00:00:00.000Z",
        name: "checkout",
        tags: [marker],
        metadata: {}
      },
      receivedAt: eventTs,
      observations: [
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
      ]
    });

    const result = await forwardOtlpTraces({
      pool,
      clickhouse,
      rule: rule({ filter: { tags: [marker] }, destinationAuthHeaderEncrypted: "unused-in-this-test" }),
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

  it("stops at the first trace the destination rejects and resumes from it on the next run", async () => {
    const marker = `otlp_fwd_fail_${ulid()}`;
    const traceIds = [`trace_${marker}_1`, `trace_${marker}_2`];
    for (const id of traceIds) {
      await insertPublishedTrace({ pool, clickhouse }, {
        trace: { id, projectId, timestamp: new Date().toISOString(), tags: [marker], metadata: {} }
      });
    }
    const stored = await createDisabledRule({
      id: `rule_${ulid()}`,
      name: "flaky destination",
      destinationUrl: serverUrl,
      filter: { tags: [marker] }
    });

    respondWithStatus = 500;
    const failedRun = await forwardOtlpTraces({
      pool,
      clickhouse,
      rule: stored,
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });
    expect(failedRun).toMatchObject({ matched: 1, forwarded: 0 });
    expect(failedRun.failed).toEqual([{ traceId: traceIds[0], error: expect.stringMatching(/500/), skipped: false }]);
    // Earlier traces in this shared project did not match and were stepped
    // over; the position stops short of the rejected trace.
    expect((await getOtlpForwardRule(pool, projectId, stored.id))?.feedCursor?.traceId).not.toBe(traceIds[0]);

    respondWithStatus = 200;
    receivedRequests = [];
    const recovered = await forwardOtlpTraces({
      pool,
      clickhouse,
      rule: (await getOtlpForwardRule(pool, projectId, stored.id))!,
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });
    expect(recovered).toMatchObject({ matched: 2, forwarded: 2, failed: [] });
    expect(receivedRequests).toHaveLength(2);

    const nothingNew = await forwardOtlpTraces({
      pool,
      clickhouse,
      rule: (await getOtlpForwardRule(pool, projectId, stored.id))!,
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });
    expect(nothingNew).toMatchObject({ matched: 0, forwarded: 0 });
  });

  it("stops, without skipping anything, when the destination refuses the credentials or the path", async () => {
    const marker = `otlp_fwd_auth_${ulid()}`;
    const traceIds = [`trace_${marker}_1`, `trace_${marker}_2`];
    for (const id of traceIds) {
      await insertPublishedTrace({ pool, clickhouse }, {
        trace: { id, projectId, timestamp: new Date().toISOString(), tags: [marker], metadata: {} }
      });
    }
    for (const status of [401, 403, 404]) {
      const stored = await createDisabledRule({
        id: `rule_${ulid()}`,
        name: `destination answering ${status}`,
        destinationUrl: serverUrl,
        filter: { tags: [marker] }
      });
      const refuse: typeof fetch = (async () => new Response("{}", { status })) as unknown as typeof fetch;

      const result = await forwardOtlpTraces({
        pool,
        clickhouse,
        rule: stored,
        fetchImpl: refuse,
        traceQuietPeriodSeconds: 0,
        allowPrivateDestinations: true
      });

      expect(result).toMatchObject({ matched: 1, forwarded: 0 });
      expect(result.failed).toEqual([{ traceId: traceIds[0], error: `destination responded HTTP ${status}`, skipped: false }]);
      // The position stops short of the first matching trace, so nothing is lost once the rule is fixed.
      expect((await getOtlpForwardRule(pool, projectId, stored.id))?.feedCursor?.traceId).not.toBe(traceIds[0]);
    }
  });

  it("skips a trace the destination permanently rejects, keeps forwarding, and records the rejection", async () => {
    const marker = `otlp_fwd_reject_${ulid()}`;
    const traceIds = [`trace_${marker}_1`, `trace_${marker}_2`];
    for (const id of traceIds) {
      await insertPublishedTrace({ pool, clickhouse }, {
        trace: { id, projectId, timestamp: new Date().toISOString(), tags: [marker], metadata: {} }
      });
    }
    const stored = await createDisabledRule({
      id: `rule_${ulid()}`,
      name: "picky destination",
      destinationUrl: serverUrl,
      filter: { tags: [marker] }
    });
    let calls = 0;
    const rejectFirst: typeof fetch = (async () =>
      new Response("{}", { status: calls++ === 0 ? 413 : 200 })) as unknown as typeof fetch;

    const result = await forwardOtlpTraces({
      pool,
      clickhouse,
      rule: stored,
      fetchImpl: rejectFirst,
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });

    expect(result).toMatchObject({ matched: 2, forwarded: 1 });
    expect(result.failed).toEqual([{ traceId: traceIds[0], error: expect.stringMatching(/413/), skipped: true }]);
    const recorded = await getOtlpForwardRule(pool, projectId, stored.id);
    expect(recorded).toMatchObject({ lastRunStatus: "error", lastRunForwardedCount: 1 });
    expect(recorded?.lastRunError).toMatch(new RegExp(`${traceIds[0]} \\(skipped\\)`));
    expect(recorded?.feedCursor?.traceId).toBe(traceIds[1]);
  });

  it("does not follow a redirect, which could lead past the SSRF guard", async () => {
    const marker = `otlp_fwd_redirect_${ulid()}`;
    const traceId = `trace_${marker}`;
    await insertPublishedTrace({ pool, clickhouse }, {
      trace: { id: traceId, projectId, timestamp: new Date().toISOString(), tags: [marker], metadata: {} }
    });
    const stored = await createDisabledRule({
      id: `rule_${ulid()}`,
      name: "redirecting destination",
      destinationUrl: serverUrl,
      filter: { tags: [marker] }
    });

    respondWithStatus = 307;
    const result = await forwardOtlpTraces({
      pool,
      clickhouse,
      rule: stored,
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });
    expect(result.failed).toEqual([{ traceId, error: "destination responded HTTP 307", skipped: false }]);
    expect(receivedRequests).toHaveLength(1);
  });

  it("stops at a destination that does not answer within the request timeout", async () => {
    const marker = `otlp_fwd_timeout_${ulid()}`;
    const traceId = `trace_${marker}`;
    await insertPublishedTrace({ pool, clickhouse }, {
      trace: { id: traceId, projectId, timestamp: new Date().toISOString(), tags: [marker], metadata: {} }
    });
    const neverAnswers: typeof fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;

    const result = await forwardOtlpTraces({
      pool,
      clickhouse,
      rule: rule({ filter: { tags: [marker] } }),
      fetchImpl: neverAnswers,
      requestTimeoutMs: 50,
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });

    expect(result).toMatchObject({ matched: 1, forwarded: 0 });
    expect(result.failed).toEqual([{ traceId, error: expect.any(String), skipped: false }]);
  });

  it("only forwards the authenticated project's traces matching the rule's filter", async () => {
    const marker = `otlp_fwd_isolation_${ulid()}`;
    for (const [suffix, tags] of [["match", [marker]], ["nomatch", ["different-tag"]]] as const) {
      await insertPublishedTrace({ pool, clickhouse }, {
        trace: {
          id: `trace_${marker}_${suffix}`,
          projectId,
          timestamp: new Date().toISOString(),
          tags: [...tags],
          metadata: {}
        }
      });
    }

    const result = await forwardOtlpTraces({
      pool,
      clickhouse,
      rule: rule({ filter: { tags: [marker] } }),
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });

    expect(result.matched).toBe(1);
    expect(result.forwarded).toBe(1);
  });

  it("refuses to run against a destination URL that resolves to a private/internal address (SSRF guard), and records why", async () => {
    const stored = await createDisabledRule({
      id: `rule_${ulid()}`,
      name: "private destination",
      destinationUrl: "http://127.0.0.1:9/v1/traces",
      filter: {}
    });
    const result = forwardOtlpTraces({ pool, clickhouse, rule: stored, traceQuietPeriodSeconds: 0 });
    await expect(result).rejects.toThrow(/non-public address/);
    expect(receivedRequests).toHaveLength(0);
    const recorded = await getOtlpForwardRule(pool, projectId, stored.id);
    expect(recorded).toMatchObject({ lastRunStatus: "error", lastRunError: expect.stringMatching(/non-public address/) });
  });
});
