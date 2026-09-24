import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createClickHouseClient, runMigrations as runChMigrations } from "@ironside/clickhouse";
import {
  claimWebhookDelivery,
  createWebhookRule,
  getWebhookRule,
  markWebhookDelivered,
  runMigrations as runPgMigrations,
  type WebhookRule
} from "@ironside/db";
import type { Trace } from "@ironside/shared";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWebhooks, type RunWebhooksOptions } from "../src/webhooks/webhook-runner.js";
import { loadConfig } from "../src/config.js";
import { insertPublishedTrace } from "./support/published-traces.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);

const ORG_NAME = "webhook-runner-test-org";
let orgId: string;
let server: Server;
let serverUrl: string;
let receivedRequests: { headers: Record<string, string>; body: string }[] = [];
let respondWithStatus = 200;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  orgId = `org_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [orgId, ORG_NAME]);

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
  await pool.query("delete from organizations where name = $1", [ORG_NAME]);
  await pool.end();
  await clickhouse.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Each test reads its own project's feed from the start. */
async function newProject(): Promise<string> {
  const projectId = `proj_${ulid()}`;
  await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
    projectId,
    orgId,
    "webhook-runner-test"
  ]);
  return projectId;
}

function trace(projectId: string, overrides: Partial<Trace> = {}): Trace {
  return {
    id: `trace_${ulid()}`,
    projectId,
    timestamp: new Date().toISOString(),
    name: "checkout",
    tags: ["hook"],
    metadata: {},
    ...overrides
  };
}

async function publish(input: Trace, receivedAt?: string): Promise<string> {
  return insertPublishedTrace({ pool, clickhouse }, { trace: input, ...(receivedAt && { receivedAt }) });
}

async function rule(projectId: string, filter: WebhookRule["filter"] = { tags: ["hook"] }): Promise<WebhookRule> {
  return createWebhookRule(pool, {
    id: `webhook_${ulid()}`,
    projectId,
    name: "test rule",
    destinationUrl: serverUrl,
    signingSecretEncrypted: "unused-in-this-test",
    filter
  });
}

/** Runs the rule as stored now, as the scheduler would after claiming it. */
async function run(stored: WebhookRule, options: Partial<RunWebhooksOptions> = {}) {
  const current = (await getWebhookRule(pool, stored.projectId, stored.id))!;
  return runWebhooks({
    pool,
    clickhouse,
    rule: current,
    signingSecret: "my-secret",
    traceQuietPeriodSeconds: 0,
    allowPrivateDestinations: true,
    ...options
  });
}

async function feedVersion(projectId: string, traceId: string): Promise<string> {
  const result = await pool.query<{ trace_version: string }>(
    `select to_char(trace_version at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as trace_version
     from evaluator_trace_feed where project_id = $1 and trace_id = $2`,
    [projectId, traceId]
  );
  return result.rows[0]!.trace_version;
}

function payloads(): { traceId: string; traceVersion: string; event: string }[] {
  return receivedRequests.map((request) => JSON.parse(request.body));
}

describe("runWebhooks", () => {
  it("delivers a signed webhook carrying the trace's feed version, and records the run on the rule", async () => {
    const projectId = await newProject();
    const matching = trace(projectId);
    await publish(matching);
    await publish(trace(projectId, { tags: ["other"] }));
    const hook = await rule(projectId);

    const result = await run(hook);

    expect(result).toEqual({ matched: 1, delivered: 1, skipped: 0, failed: [] });
    expect(receivedRequests).toHaveLength(1);
    const request = receivedRequests[0]!;
    expect(JSON.parse(request.body)).toEqual({
      event: "trace.matched",
      traceId: matching.id,
      projectId,
      timestamp: matching.timestamp,
      name: "checkout",
      traceVersion: await feedVersion(projectId, matching.id)
    });
    const expectedSignature = `sha256=${createHmac("sha256", "my-secret").update(request.body).digest("hex")}`;
    expect(request.headers["x-ironside-signature"]).toBe(expectedSignature);

    const stored = (await getWebhookRule(pool, projectId, hook.id))!;
    expect(stored).toMatchObject({ lastRunStatus: "success", lastRunError: null, lastRunDeliveredCount: 1 });
    // The position moved past the non-matching trace too.
    expect(stored.feedCursor).not.toBeNull();
  });

  it("delivers each settled version once: a later run starts after it, and a run from a stale position skips it", async () => {
    const projectId = await newProject();
    await publish(trace(projectId));
    const hook = await rule(projectId);

    expect((await run(hook)).delivered).toBe(1);
    expect(await run(hook)).toEqual({ matched: 0, delivered: 0, skipped: 0, failed: [] });

    // A run claimed twice by different replicas starts from the old position.
    const stale = await runWebhooks({
      pool,
      clickhouse,
      rule: hook,
      signingSecret: "my-secret",
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });
    expect(stale).toEqual({ matched: 1, delivered: 0, skipped: 1, failed: [] });
    expect(receivedRequests).toHaveLength(1);
  });

  it("delivers again when the trace is published again, even by a late batch that does not move its activity time", async () => {
    const projectId = await newProject();
    const hooked = trace(projectId);
    const receivedAt = await publish(hooked);
    const hook = await rule(projectId);
    await run(hook);

    // A batch received earlier but written later: the ClickHouse activity
    // time stays the same, the feed publishes the trace again.
    await publish(hooked, new Date(Date.parse(receivedAt) - 1_000).toISOString());
    expect((await run(hook)).delivered).toBe(1);
    await publish(hooked);
    expect((await run(hook)).delivered).toBe(1);

    const versions = payloads().map((payload) => payload.traceVersion);
    expect(versions).toHaveLength(3);
    expect(new Set(versions).size).toBe(3);
    expect([...versions].sort()).toEqual(versions);
  });

  it("stops at a failed delivery and retries it first on the next run, keeping feed order", async () => {
    const projectId = await newProject();
    const first = trace(projectId);
    const second = trace(projectId);
    await publish(first);
    await publish(second);
    const hook = await rule(projectId);

    respondWithStatus = 500;
    const failedRun = await run(hook);
    expect(failedRun).toEqual({
      matched: 1,
      delivered: 0,
      skipped: 0,
      failed: [{ traceId: first.id, error: "destination responded HTTP 500" }]
    });
    expect(receivedRequests).toHaveLength(1);
    expect((await getWebhookRule(pool, projectId, hook.id))!).toMatchObject({
      lastRunStatus: "error",
      lastRunError: `${first.id}: destination responded HTTP 500`,
      feedCursor: null
    });

    respondWithStatus = 200;
    receivedRequests = [];
    expect(await run(hook)).toEqual({ matched: 2, delivered: 2, skipped: 0, failed: [] });
    expect(payloads().map((payload) => payload.traceId)).toEqual([first.id, second.id]);
  });

  it("stops without sending at a version another run is still delivering", async () => {
    const projectId = await newProject();
    const inFlight = trace(projectId);
    await publish(inFlight);
    const hook = await rule(projectId);
    await claimWebhookDelivery(pool, `d_${ulid()}`, hook.id, inFlight.id, await feedVersion(projectId, inFlight.id));

    expect(await run(hook)).toEqual({ matched: 1, delivered: 0, skipped: 0, failed: [] });
    expect(receivedRequests).toHaveLength(0);
    expect((await getWebhookRule(pool, projectId, hook.id))!.feedCursor).toBeNull();
  });

  it("does not resend what the pre-feed scanner delivered under the trace's activity time", async () => {
    const projectId = await newProject();
    const alreadySent = trace(projectId);
    const neverSent = trace(projectId);
    const sentActivity = await publish(alreadySent);
    await publish(neverSent);
    const hook = await rule(projectId);
    // What migration 0006 leaves for a rule the scanner was serving.
    await pool.query("update webhook_rules set legacy_delivery_cutoff = clock_timestamp() where id = $1", [hook.id]);
    const legacyId = (await claimWebhookDelivery(pool, `d_${ulid()}`, hook.id, alreadySent.id, sentActivity))!;
    await markWebhookDelivered(pool, legacyId);

    expect(await run(hook)).toEqual({ matched: 2, delivered: 1, skipped: 1, failed: [] });
    expect(payloads().map((payload) => payload.traceId)).toEqual([neverSent.id]);

    // Published after the cutoff, the same activity time is a new version.
    await publish(alreadySent, sentActivity);
    expect((await run(hook)).delivered).toBe(1);
    expect(payloads().map((payload) => payload.traceId)).toEqual([neverSent.id, alreadySent.id]);
  });

  it("a filter matching zero traces delivers nothing and still moves past them", async () => {
    const projectId = await newProject();
    await publish(trace(projectId));
    const hook = await rule(projectId, { tags: ["__no_such_tag__"] });

    expect(await run(hook)).toEqual({ matched: 0, delivered: 0, skipped: 0, failed: [] });
    expect((await getWebhookRule(pool, projectId, hook.id))!.feedCursor).not.toBeNull();
  });

  it("a DB failure recording a CONFIRMED-successful delivery propagates as an error, and does NOT mark the row 'failed' (which would enable a real duplicate send on retry)", async () => {
    const projectId = await newProject();
    const hooked = trace(projectId);
    await publish(hooked);
    const hook = await rule(projectId);

    // A Pool whose query() throws ONLY for the "mark delivered" UPDATE —
    // every other statement (the feed reads, the claim INSERT, the run
    // record) behaves normally by delegating to the real pool.
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

    await expect(run(hook, { pool: flakyPool })).rejects.toThrow(/simulated DB outage/);

    // The destination DID receive exactly one real HTTP request — this is
    // the crux of the test: a naive implementation that catches this DB
    // error and calls markWebhookFailed would leave the row retryable,
    // and a subsequent run would send a SECOND real request for the same
    // trace. Assert that did not happen, and that the row is not 'failed'.
    expect(receivedRequests).toHaveLength(1);
    const row = await pool.query<{ status: string }>(
      "select status from webhook_deliveries where webhook_rule_id = $1 and trace_id = $2",
      [hook.id, hooked.id]
    );
    expect(row.rows[0]?.status).not.toBe("failed");
    expect((await getWebhookRule(pool, projectId, hook.id))!).toMatchObject({
      lastRunStatus: "error",
      lastRunError: "simulated DB outage after HTTP delivery",
      feedCursor: null
    });
  });

  it("refuses to run against a destination URL that resolves to a private/internal address (SSRF guard)", async () => {
    const projectId = await newProject();
    await publish(trace(projectId));
    const hook = await createWebhookRule(pool, {
      id: `webhook_${ulid()}`,
      projectId,
      name: "ssrf-attempt rule",
      destinationUrl: "http://127.0.0.1:9/hook",
      signingSecretEncrypted: "unused-in-this-test",
      filter: {}
    });
    await expect(run(hook, { allowPrivateDestinations: false })).rejects.toThrow(/non-public address/);
    expect(receivedRequests).toHaveLength(0);
    expect((await getWebhookRule(pool, projectId, hook.id))!.lastRunStatus).toBe("error");
  });
});
