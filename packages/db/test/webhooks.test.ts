import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";
import {
  claimWebhookDelivery,
  createWebhookRule,
  getWebhookDeliveryStatus,
  getWebhookRule,
  markWebhookCovered,
  markWebhookDelivered,
  markWebhookFailed,
  recordWebhookRun
} from "../src/webhooks.js";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://ironside:ironside@localhost:5433/ironside"
});

let projectId: string;
let ruleId: string;
const TRACE_VERSION = "2026-08-17T12:00:00.000Z";

beforeAll(async () => {
  await runMigrations(pool);
  const orgId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "webhooks-db-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, "webhooks-db-test"]
  );
  const rule = await createWebhookRule(pool, {
    id: `webhook_${ulid()}`,
    projectId,
    name: "test rule",
    destinationUrl: "http://localhost:9999/hook",
    signingSecretEncrypted: "unused-in-this-test",
    filter: {}
  });
  ruleId = rule.id;
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'webhooks-db-test-org'");
  await pool.end();
});

describe("claimWebhookDelivery — exactly-once per settled version", () => {
  it("the first claim for a (rule, trace, version) tuple succeeds", async () => {
    const traceId = `trace_${ulid()}`;
    const deliveryId = await claimWebhookDelivery(pool, `d_${ulid()}`, ruleId, traceId, TRACE_VERSION);
    expect(deliveryId).toBeTruthy();
  });

  it("a second claim attempt for a trace already marked delivered is rejected", async () => {
    const traceId = `trace_${ulid()}`;
    const first = await claimWebhookDelivery(pool, `d_${ulid()}`, ruleId, traceId, TRACE_VERSION);
    expect(first).toBeTruthy();
    await markWebhookDelivered(pool, first!);

    const second = await claimWebhookDelivery(pool, `d_${ulid()}`, ruleId, traceId, TRACE_VERSION);
    expect(second).toBeNull();
  });

  it("a genuinely later settled trace version is independently deliverable", async () => {
    const traceId = `trace_${ulid()}`;
    const first = await claimWebhookDelivery(
      pool,
      `d_${ulid()}`,
      ruleId,
      traceId,
      TRACE_VERSION
    );
    expect(first).toBeTruthy();
    await markWebhookDelivered(pool, first!);

    // A late ingest event is received after the first delivery, so its
    // activity timestamp becomes a new snapshot version after it settles.
    const delivered = await pool.query<{ delivered_at: Date }>(
      "select delivered_at from webhook_deliveries where id = $1",
      [first]
    );
    const nextVersion = new Date(delivered.rows[0]!.delivered_at.getTime() + 1000).toISOString();
    const second = await claimWebhookDelivery(
      pool,
      `d_${ulid()}`,
      ruleId,
      traceId,
      nextVersion
    );
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("a retry after a FAILED delivery is allowed, reusing the same delivery row id (not a new one)", async () => {
    const traceId = `trace_${ulid()}`;
    const first = await claimWebhookDelivery(pool, `d_${ulid()}`, ruleId, traceId, TRACE_VERSION);
    expect(first).toBeTruthy();
    await markWebhookFailed(pool, first!, "boom");

    const retryAttemptId = `d_${ulid()}`;
    const second = await claimWebhookDelivery(pool, retryAttemptId, ruleId, traceId, TRACE_VERSION);
    expect(second).toBeTruthy();
    // The ORIGINAL delivery row's id is preserved across a retry, not
    // reassigned to whatever id this attempt generated.
    expect(second).toBe(first);
    expect(second).not.toBe(retryAttemptId);
  });

  it("a stuck 'pending' row (claimer crashed before recording an outcome) is NOT reclaimable while fresh, but IS reclaimable once stale", async () => {
    const traceId = `trace_${ulid()}`;
    const first = await claimWebhookDelivery(pool, `d_${ulid()}`, ruleId, traceId, TRACE_VERSION);
    expect(first).toBeTruthy();
    // Simulate a crash: never call markWebhookDelivered/markWebhookFailed,
    // so the row is left 'pending' forever, as if the process died between
    // claiming and recording an outcome.

    const stillFresh = await claimWebhookDelivery(pool, `d_${ulid()}`, ruleId, traceId, TRACE_VERSION);
    expect(stillFresh).toBeNull(); // a genuinely in-flight-looking row must not be double-claimed

    // Backdate attempted_at past the staleness window to simulate time
    // passing without a real sleep.
    await pool.query(
      "update webhook_deliveries set attempted_at = now() - interval '11 minutes' where id = $1",
      [first]
    );

    const reclaimed = await claimWebhookDelivery(pool, `d_${ulid()}`, ruleId, traceId, TRACE_VERSION);
    expect(reclaimed).toBe(first); // reclaims the SAME row, not a new one
  });

  it("concurrent claim attempts for the SAME (rule, trace, version) tuple: exactly one wins, proven with real parallel DB calls, not sequential ones", async () => {
    const traceId = `trace_${ulid()}`;
    // 10 genuinely concurrent claim attempts via Promise.all — this is the
    // actual race the unique constraint exists to prevent. A naive
    // check-then-insert implementation would let more than one win here;
    // the atomic INSERT ... ON CONFLICT must not.
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        claimWebhookDelivery(pool, `d_${ulid()}`, ruleId, traceId, TRACE_VERSION)
      )
    );
    const winners = attempts.filter((id) => id !== null);
    expect(winners).toHaveLength(1);
  });

  it("different traces under the same rule can all be claimed independently", async () => {
    const traceIds = Array.from({ length: 5 }, () => `trace_${ulid()}`);
    const results = await Promise.all(
      traceIds.map((traceId) =>
        claimWebhookDelivery(pool, `d_${ulid()}`, ruleId, traceId, TRACE_VERSION)
      )
    );
    expect(results.every((id) => id !== null)).toBe(true);
  });

  it("the same trace under DIFFERENT rules can each be claimed independently (uniqueness is per-rule, not global per trace)", async () => {
    const otherRule = await createWebhookRule(pool, {
      id: `webhook_${ulid()}`,
      projectId,
      name: "other rule",
      destinationUrl: "http://localhost:9999/other-hook",
      signingSecretEncrypted: "unused-in-this-test",
      filter: {}
    });
    const traceId = `trace_${ulid()}`;

    const first = await claimWebhookDelivery(pool, `d_${ulid()}`, ruleId, traceId, TRACE_VERSION);
    const second = await claimWebhookDelivery(
      pool,
      `d_${ulid()}`,
      otherRule.id,
      traceId,
      TRACE_VERSION
    );
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });
});

describe("markWebhookCovered", () => {
  it("leaves a key that a claim cannot take, and that reads back as covered", async () => {
    const traceId = `trace_${ulid()}`;
    const claimed = (await claimWebhookDelivery(pool, `d_${ulid()}`, ruleId, traceId, TRACE_VERSION))!;
    await markWebhookCovered(pool, claimed);

    expect(await getWebhookDeliveryStatus(pool, ruleId, traceId, TRACE_VERSION)).toBe("covered");
    // The 0.3.0 claim is the same statement: it takes over only failed or stale pending rows.
    expect(await claimWebhookDelivery(pool, `d_${ulid()}`, ruleId, traceId, TRACE_VERSION)).toBeNull();
    await pool.query(
      "update webhook_deliveries set attempted_at = now() - interval '1 hour' where id = $1",
      [claimed]
    );
    expect(await claimWebhookDelivery(pool, `d_${ulid()}`, ruleId, traceId, TRACE_VERSION)).toBeNull();
    expect(await getWebhookDeliveryStatus(pool, ruleId, `trace_${ulid()}`, TRACE_VERSION)).toBeNull();
  });
});

describe("recordWebhookRun", () => {
  it("stores the run and moves the feed position only from the value the run started at", async () => {
    const rule = await createWebhookRule(pool, {
      id: `webhook_${ulid()}`,
      projectId,
      name: "cursor rule",
      destinationUrl: "http://localhost:9999/hook",
      signingSecretEncrypted: "unused-in-this-test",
      filter: {}
    });
    expect(rule.feedCursor).toBeNull();
    expect(rule.lastRunAt).toBeNull();
    const first = { publishedAt: "2026-09-24T10:00:00.000001Z", traceId: "trace_a" };
    const second = { publishedAt: "2026-09-24T10:00:00.000002Z", traceId: "trace_b" };

    await recordWebhookRun(pool, rule.id, {
      status: "success",
      delivered: 2,
      feedCursor: { from: null, to: first },
      runAgainSoon: true
    });
    const afterFirst = (await getWebhookRule(pool, projectId, rule.id))!;
    expect(afterFirst).toMatchObject({
      feedCursor: first,
      lastRunStatus: "success",
      lastRunError: null,
      lastRunDeliveredCount: 2
    });
    expect(afterFirst.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());

    // A run that started from the old position (claimed twice) records its outcome but not its position.
    await recordWebhookRun(pool, rule.id, {
      status: "error",
      error: "trace_b: destination responded HTTP 500",
      delivered: 0,
      feedCursor: { from: null, to: second }
    });
    expect((await getWebhookRule(pool, projectId, rule.id))!).toMatchObject({
      feedCursor: first,
      lastRunStatus: "error",
      lastRunError: "trace_b: destination responded HTTP 500",
      lastRunDeliveredCount: 0
    });

    await recordWebhookRun(pool, rule.id, {
      status: "success",
      delivered: 1,
      feedCursor: { from: first, to: second }
    });
    expect((await getWebhookRule(pool, projectId, rule.id))!.feedCursor).toEqual(second);
  });

  it("gives a new rule its creation time as its scanner handoff", async () => {
    const before = Date.now();
    const rule = await createWebhookRule(pool, {
      id: `webhook_${ulid()}`,
      projectId,
      name: "handoff rule",
      destinationUrl: "http://localhost:9999/hook",
      signingSecretEncrypted: "unused-in-this-test",
      filter: {}
    });
    expect(rule.scannerHandoffAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(Date.parse(rule.scannerHandoffAt)).toBeGreaterThanOrEqual(before - 5_000);
  });
});
