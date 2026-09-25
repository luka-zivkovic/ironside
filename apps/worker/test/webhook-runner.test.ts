import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createClickHouseClient, runMigrations as runChMigrations } from "@ironside/clickhouse";
import {
  claimWebhookDelivery,
  createWebhookRule,
  getWebhookDeliveryStatus,
  getWebhookRule,
  markWebhookDelivered,
  runMigrations as runPgMigrations,
  type WebhookRule
} from "@ironside/db";
import type { Trace } from "@ironside/shared";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runWebhooks, type RunWebhooksOptions } from "../src/webhooks/webhook-runner.js";
import { loadConfig } from "../src/config.js";
import { insertPublishedTrace } from "./support/published-traces.js";
import { REBINDING_HOST } from "./support/rebinding-dns.js";

// A destination whose DNS answers the per-run check with a public address and
// the connection with loopback (DNS rebinding); see support/rebinding-dns.ts.
vi.mock("node:dns", async (importOriginal) =>
  (await import("./support/rebinding-dns.js")).withRebindingLookup(await importOriginal())
);
vi.mock("node:dns/promises", async (importOriginal) =>
  (await import("./support/rebinding-dns.js")).withRebindingPromises(await importOriginal())
);

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);

const ORG_NAME = "webhook-runner-test-org";
let orgId: string;
let server: Server;
let serverUrl: string;
let receivedRequests: { url: string; headers: Record<string, string>; body: string }[] = [];
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
      receivedRequests.push({ url: req.url ?? "", headers: req.headers as Record<string, string>, body });
      res.statusCode = respondWithStatus;
      if (respondWithStatus >= 300 && respondWithStatus < 400) res.setHeader("location", "/elsewhere");
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

  it("delivers each settled version once: a later run starts after it, and a run from a stale position skips it without moving the position", async () => {
    const projectId = await newProject();
    const first = trace(projectId);
    await publish(first);
    const hook = await rule(projectId);

    expect((await run(hook)).delivered).toBe(1);
    expect(await run(hook)).toEqual({ matched: 0, delivered: 0, skipped: 0, failed: [] });
    const position = (await getWebhookRule(pool, projectId, hook.id))!.feedCursor;

    // A run claimed twice by different replicas starts from the old position.
    const second = trace(projectId);
    await publish(second);
    const stale = await runWebhooks({
      pool,
      clickhouse,
      rule: hook,
      signingSecret: "my-secret",
      traceQuietPeriodSeconds: 0,
      allowPrivateDestinations: true
    });
    expect(stale).toEqual({ matched: 2, delivered: 1, skipped: 1, failed: [] });
    expect(payloads().map((payload) => payload.traceId)).toEqual([first.id, second.id]);
    expect((await getWebhookRule(pool, projectId, hook.id))!.feedCursor).toEqual(position);

    // The current position then skips what the stale run sent.
    expect(await run(hook)).toEqual({ matched: 1, delivered: 0, skipped: 1, failed: [] });
    expect(receivedRequests).toHaveLength(2);
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

  it("does not follow a redirect, which could lead past the SSRF guard", async () => {
    const projectId = await newProject();
    const hooked = trace(projectId);
    await publish(hooked);
    const hook = await rule(projectId);

    respondWithStatus = 307;
    expect(await run(hook)).toEqual({
      matched: 1,
      delivered: 0,
      skipped: 0,
      failed: [{ traceId: hooked.id, error: "destination responded HTTP 307" }]
    });
    expect(receivedRequests.map((request) => request.url)).toEqual(["/hook"]);
  });

  it("stops without sending at a version another run is still delivering, and says so on the rule", async () => {
    const projectId = await newProject();
    const inFlight = trace(projectId);
    await publish(inFlight);
    const hook = await rule(projectId);
    await claimWebhookDelivery(pool, `d_${ulid()}`, hook.id, inFlight.id, await feedVersion(projectId, inFlight.id));

    expect(await run(hook)).toEqual({ matched: 1, delivered: 0, skipped: 0, failed: [], waitingFor: inFlight.id });
    expect(receivedRequests).toHaveLength(0);
    expect((await getWebhookRule(pool, projectId, hook.id))!).toMatchObject({
      feedCursor: null,
      lastRunStatus: "success",
      lastRunError: `stopped at ${inFlight.id}: another run is still delivering it`
    });
  });

  describe("handing off from a previous-release worker, which keys deliveries by activity time", () => {
    /** What a worker from before migration 0006 records for a trace it sends. */
    async function scannerDelivery(hook: WebhookRule, traceId: string, activity: string, finished = true) {
      const id = (await claimWebhookDelivery(pool, `d_${ulid()}`, hook.id, traceId, activity))!;
      if (finished) await markWebhookDelivered(pool, id);
    }

    async function moveHandoff(hook: WebhookRule, sql: string) {
      await pool.query(`update webhook_rules set scanner_handoff_at = ${sql} where id = $1`, [hook.id]);
    }

    it("does not resend what the previous release delivered, and waits for what it is still sending", async () => {
      const projectId = await newProject();
      const sent = trace(projectId);
      const sending = trace(projectId);
      const sentActivity = await publish(sent);
      const sendingActivity = await publish(sending);
      const hook = await rule(projectId);
      await scannerDelivery(hook, sent.id, sentActivity);
      await scannerDelivery(hook, sending.id, sendingActivity, false);

      expect(await run(hook)).toEqual({ matched: 2, delivered: 0, skipped: 1, failed: [], waitingFor: sending.id });
      expect(receivedRequests).toHaveLength(0);
    });

    it("while the previous release may still run, skips what it sent after the handoff too", async () => {
      const projectId = await newProject();
      const hook = await rule(projectId);
      const hooked = trace(projectId);
      const activity = await publish(hooked);
      await scannerDelivery(hook, hooked.id, activity);

      expect(await run(hook)).toEqual({ matched: 1, delivered: 0, skipped: 1, failed: [] });
      expect(receivedRequests).toHaveLength(0);
    });

    it("marks what it delivers under the old key while the previous release may still run, so that release skips it", async () => {
      const projectId = await newProject();
      const hooked = trace(projectId);
      const activity = await publish(hooked);
      const hook = await rule(projectId);

      expect((await run(hook)).delivered).toBe(1);
      expect(await getWebhookDeliveryStatus(pool, hook.id, hooked.id, activity)).toBe("covered");
      // The previous release's claim for the same trace finds the key taken.
      expect(await claimWebhookDelivery(pool, `d_${ulid()}`, hook.id, hooked.id, activity)).toBeNull();
    });

    it("after the handoff window, honors old deliveries only for traces published before the window ended", async () => {
      const projectId = await newProject();
      const early = trace(projectId);
      const late = trace(projectId);
      const earlyActivity = await publish(early);
      const lateActivity = await publish(late);
      const hook = await rule(projectId);
      await scannerDelivery(hook, early.id, earlyActivity);
      await scannerDelivery(hook, late.id, lateActivity);
      // Handed off two days ago; only the early trace was published before it.
      await moveHandoff(hook, "now() - interval '2 days'");
      await pool.query(
        "update evaluator_trace_feed set published_at = now() - interval '3 days' where project_id = $1 and trace_id = $2",
        [projectId, early.id]
      );

      expect(await run(hook)).toEqual({ matched: 2, delivered: 1, skipped: 1, failed: [] });
      expect(payloads().map((payload) => payload.traceId)).toEqual([late.id]);
      // Outside the window nothing is marked under the old key.
      expect(await getWebhookDeliveryStatus(pool, hook.id, late.id, lateActivity)).toBe("delivered");
    });

    it("holds the old key while it sends, so the previous release cannot claim the trace meanwhile", async () => {
      const projectId = await newProject();
      const hooked = trace(projectId);
      const activity = await publish(hooked);
      const hook = await rule(projectId);

      let oldClaimDuringSend: string | null | undefined;
      const fetchImpl = (async () => {
        oldClaimDuringSend = await claimWebhookDelivery(pool, `d_${ulid()}`, hook.id, hooked.id, activity);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      expect((await run(hook, { fetchImpl })).delivered).toBe(1);
      expect(oldClaimDuringSend).toBeNull();
      expect(await getWebhookDeliveryStatus(pool, hook.id, hooked.id, activity)).toBe("covered");
    });

    it("releases the old key when its send fails, so either release may retry", async () => {
      const projectId = await newProject();
      const hooked = trace(projectId);
      const activity = await publish(hooked);
      const hook = await rule(projectId);

      respondWithStatus = 503;
      expect((await run(hook)).failed).toHaveLength(1);
      expect(await getWebhookDeliveryStatus(pool, hook.id, hooked.id, activity)).toBe("failed");

      // The previous release retries first and delivers; this release then skips the trace.
      await scannerDelivery(hook, hooked.id, activity);
      respondWithStatus = 200;
      expect(await run(hook)).toEqual({ matched: 1, delivered: 0, skipped: 1, failed: [] });
    });

    it("after the window, still skips what the previous release sent for entries published inside it", async () => {
      const projectId = await newProject();
      const hooked = trace(projectId);
      const activity = await publish(hooked);
      const hook = await rule(projectId);
      await scannerDelivery(hook, hooked.id, activity);
      // Handed off 48 hours ago; the trace was published an hour into the window.
      await moveHandoff(hook, "now() - interval '48 hours'");
      await pool.query(
        "update evaluator_trace_feed set published_at = now() - interval '47 hours' where project_id = $1 and trace_id = $2",
        [projectId, hooked.id]
      );

      expect(await run(hook)).toEqual({ matched: 1, delivered: 0, skipped: 1, failed: [] });
      expect(receivedRequests).toHaveLength(0);
    });

    it("sends a republished trace again even when its activity time matches an old delivery, once the window has passed", async () => {
      const projectId = await newProject();
      const hooked = trace(projectId);
      const activity = await publish(hooked);
      const hook = await rule(projectId);
      await scannerDelivery(hook, hooked.id, activity);
      await moveHandoff(hook, "now() - interval '2 days'");
      await pool.query(
        "update evaluator_trace_feed set published_at = now() - interval '3 days' where project_id = $1 and trace_id = $2",
        [projectId, hooked.id]
      );
      expect((await run(hook)).skipped).toBe(1);

      // A batch received earlier but written now publishes the trace again with the same activity time.
      await publish(hooked, activity);
      expect((await run(hook)).delivered).toBe(1);
      expect(payloads().map((payload) => payload.traceId)).toEqual([hooked.id]);
    });
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

  it("refuses a destination that rebinds to a private address after the per-run check, sending nothing", async () => {
    const projectId = await newProject();
    const published = trace(projectId);
    await publish(published);
    const hook = await createWebhookRule(pool, {
      id: `webhook_${ulid()}`,
      projectId,
      name: "rebinding rule",
      destinationUrl: `http://${REBINDING_HOST}:${new URL(serverUrl).port}/hook`,
      signingSecretEncrypted: "unused-in-this-test",
      filter: {}
    });
    // The per-run check sees a public address; the connection is refused at loopback.
    const result = await run(hook, { allowPrivateDestinations: false });
    expect(result.failed).toEqual([
      { traceId: published.id, error: "destination URL resolves to a non-public address: 127.0.0.1" }
    ]);
    expect(receivedRequests).toHaveLength(0);
  });
});
