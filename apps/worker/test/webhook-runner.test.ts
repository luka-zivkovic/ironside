import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createClickHouseClient, insertTraces, runMigrations as runChMigrations } from "@ironside/clickhouse";
import { createWebhookRule, runMigrations as runPgMigrations } from "@ironside/db";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWebhooks } from "../src/webhooks/webhook-runner.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);

let projectId: string;
let server: Server;
let serverUrl: string;
let receivedRequests: { headers: Record<string, string>; body: string }[] = [];
let respondWithStatus = 200;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  const orgId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "webhook-runner-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, "webhook-runner-test"]
  );

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      receivedRequests.push({ headers: req.headers as Record<string, string>, body });
      res.statusCode = respondWithStatus;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address && typeof address === "object") {
    serverUrl = `http://localhost:${address.port}/hook`;
  }
});

beforeEach(() => {
  receivedRequests = [];
  respondWithStatus = 200;
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'webhook-runner-test-org'");
  await pool.end();
  await clickhouse.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("runWebhooks", () => {
  it("delivers a correctly-signed webhook for a matching trace", async () => {
    const marker = `webhook_e2e_${ulid()}`;
    const traceId = `trace_${marker}`;
    await insertTraces(
      clickhouse,
      [
        {
          id: traceId,
          projectId,
          timestamp: new Date().toISOString(),
          name: "checkout",
          tags: [marker],
          metadata: {}
        }
      ],
      { eventTs: new Date().toISOString() }
    );

    const rule = await createWebhookRule(pool, {
      id: `webhook_${ulid()}`,
      projectId,
      name: "test rule",
      destinationUrl: serverUrl,
      signingSecretEncrypted: "unused-in-this-test",
      filter: { tags: [marker] }
    });

    const result = await runWebhooks({
      pool,
      clickhouse,
      rule,
      signingSecret: "my-secret",
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });

    expect(result.matched).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toEqual([]);
    expect(receivedRequests).toHaveLength(1);

    const req = receivedRequests[0]!;
    const payload = JSON.parse(req.body) as {
      traceId: string;
      event: string;
      traceVersion: string;
    };
    expect(payload.traceId).toBe(traceId);
    expect(payload.event).toBe("trace.matched");
    expect(new Date(payload.traceVersion).toString()).not.toBe("Invalid Date");

    const expectedSignature = `sha256=${createHmac("sha256", "my-secret").update(req.body).digest("hex")}`;
    expect(req.headers["x-ironside-signature"]).toBe(expectedSignature);
  });

  it("fires exactly once per settled version: a second run does not re-deliver an unchanged trace", async () => {
    const marker = `webhook_once_${ulid()}`;
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
    const rule = await createWebhookRule(pool, {
      id: `webhook_${ulid()}`,
      projectId,
      name: "exactly-once rule",
      destinationUrl: serverUrl,
      signingSecretEncrypted: "unused-in-this-test",
      filter: { tags: [marker] }
    });

    const first = await runWebhooks({ pool, clickhouse, rule, signingSecret: "s", traceQuietPeriodSeconds: 0, allowPrivateDestinations: true });
    expect(first.delivered).toBe(1);

    const second = await runWebhooks({ pool, clickhouse, rule, signingSecret: "s", traceQuietPeriodSeconds: 0, allowPrivateDestinations: true });
    expect(second.matched).toBe(1); // still matches the filter
    expect(second.delivered).toBe(0); // but NOT re-delivered
    expect(second.skipped).toBe(1);
    expect(receivedRequests).toHaveLength(1); // only the first run's request ever arrived
  });

  it("delivers once more when later trace activity creates a new settled version", async () => {
    const marker = `webhook_version_${ulid()}`;
    const traceId = `trace_${marker}`;
    const initialActivity = new Date(Date.now() - 60_000).toISOString();
    const trace = {
      id: traceId,
      projectId,
      timestamp: initialActivity,
      tags: [marker],
      metadata: {}
    };
    await insertTraces(clickhouse, [trace], { eventTs: initialActivity });
    const rule = await createWebhookRule(pool, {
      id: `webhook_${ulid()}`,
      projectId,
      name: "versioned-delivery rule",
      destinationUrl: serverUrl,
      signingSecretEncrypted: "unused-in-this-test",
      filter: { tags: [marker] }
    });

    const first = await runWebhooks({
      pool,
      clickhouse,
      rule,
      signingSecret: "s",
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });
    expect(first.delivered).toBe(1);
    const firstVersion = (
      JSON.parse(receivedRequests[0]!.body) as { traceVersion: string }
    ).traceVersion;

    // Ensure the server-receipt version is strictly after delivered_at even
    // on millisecond-resolution clocks, then write the same trace id again.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const laterActivity = new Date().toISOString();
    await insertTraces(clickhouse, [trace], { eventTs: laterActivity });

    const second = await runWebhooks({
      pool,
      clickhouse,
      rule,
      signingSecret: "s",
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });
    expect(second.delivered).toBe(1);
    expect(receivedRequests).toHaveLength(2);
    const secondVersion = (
      JSON.parse(receivedRequests[1]!.body) as { traceVersion: string }
    ).traceVersion;
    expect(new Date(secondVersion).getTime()).toBeGreaterThan(
      new Date(firstVersion).getTime()
    );
  });

  it("a failed delivery is retried on the next run (does not permanently block the trace)", async () => {
    const marker = `webhook_retry_${ulid()}`;
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
    const rule = await createWebhookRule(pool, {
      id: `webhook_${ulid()}`,
      projectId,
      name: "retry rule",
      destinationUrl: serverUrl,
      signingSecretEncrypted: "unused-in-this-test",
      filter: { tags: [marker] }
    });

    respondWithStatus = 500;
    const first = await runWebhooks({ pool, clickhouse, rule, signingSecret: "s", traceQuietPeriodSeconds: 0, allowPrivateDestinations: true });
    expect(first.delivered).toBe(0);
    expect(first.failed).toHaveLength(1);

    respondWithStatus = 200;
    const second = await runWebhooks({ pool, clickhouse, rule, signingSecret: "s", traceQuietPeriodSeconds: 0, allowPrivateDestinations: true });
    expect(second.delivered).toBe(1);
    expect(second.skipped).toBe(0);
  });

  it("a filter matching zero traces delivers nothing, successfully", async () => {
    const rule = await createWebhookRule(pool, {
      id: `webhook_${ulid()}`,
      projectId,
      name: "empty rule",
      destinationUrl: serverUrl,
      signingSecretEncrypted: "unused-in-this-test",
      filter: { tags: ["__no_such_tag__"] }
    });
    const result = await runWebhooks({ pool, clickhouse, rule, signingSecret: "s", traceQuietPeriodSeconds: 0, allowPrivateDestinations: true });
    expect(result.matched).toBe(0);
    expect(result.delivered).toBe(0);
  });

  it("a DB failure recording a CONFIRMED-successful delivery propagates as an error, and does NOT mark the row 'failed' (which would enable a real duplicate send on retry)", async () => {
    const marker = `webhook_dbfail_${ulid()}`;
    const traceId = `trace_${marker}`;
    await insertTraces(
      clickhouse,
      [
        {
          id: traceId,
          projectId,
          timestamp: new Date().toISOString(),
          tags: [marker],
          metadata: {}
        }
      ],
      { eventTs: new Date().toISOString() }
    );
    const rule = await createWebhookRule(pool, {
      id: `webhook_${ulid()}`,
      projectId,
      name: "db-fail-after-delivery rule",
      destinationUrl: serverUrl,
      signingSecretEncrypted: "unused-in-this-test",
      filter: { tags: [marker] }
    });

    // A Pool whose query() throws ONLY for the "mark delivered" UPDATE —
    // every other statement (the claim INSERT, exportTraces' SELECT)
    // behaves normally by delegating to the real pool.
    const flakyPool = {
      query: (text: string, params?: unknown[]) => {
        if (
          typeof text === "string" &&
          text.trimStart().startsWith("update webhook_deliveries set status = 'delivered'")
        ) {
          return Promise.reject(new Error("simulated DB outage after HTTP delivery"));
        }
        return pool.query(text, params as never);
      }
    } as unknown as Pool;

    await expect(
      runWebhooks({
        pool: flakyPool,
        clickhouse,
        rule,
        signingSecret: "s",
        traceQuietPeriodSeconds: 0,
        allowPrivateDestinations: true
      })
    ).rejects.toThrow(/simulated DB outage/);

    // The destination DID receive exactly one real HTTP request — this is
    // the crux of the test: a naive implementation that catches this DB
    // error and calls markWebhookFailed would leave the row retryable,
    // and a subsequent run would send a SECOND real request for the same
    // trace. Assert that did not happen, and that the row is not 'failed'.
    expect(receivedRequests).toHaveLength(1);
    const row = await pool.query<{ status: string }>(
      "select status from webhook_deliveries where webhook_rule_id = $1 and trace_id = $2",
      [rule.id, traceId]
    );
    expect(row.rows[0]?.status).not.toBe("failed");
  });

  it("refuses to run against a destination URL that resolves to a private/internal address (SSRF guard)", async () => {
    const rule = await createWebhookRule(pool, {
      id: `webhook_${ulid()}`,
      projectId,
      name: "ssrf-attempt rule",
      destinationUrl: "http://127.0.0.1:9/hook",
      signingSecretEncrypted: "unused-in-this-test",
      filter: {}
    });
    await expect(runWebhooks({ pool, clickhouse, rule, signingSecret: "s", traceQuietPeriodSeconds: 0 })).rejects.toThrow(
      /non-public address/
    );
    expect(receivedRequests).toHaveLength(0);
  });
});
