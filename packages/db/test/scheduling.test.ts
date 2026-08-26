import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";
import { claimDueExportConfigs, createExportConfig } from "../src/export-configs.js";
import { claimDueOtlpForwardRules, createOtlpForwardRule } from "../src/otlp-forward-rules.js";
import { claimDueWebhookRules, createWebhookRule } from "../src/webhooks.js";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://ironside:ironside@localhost:5433/ironside"
});

let projectId: string;

beforeAll(async () => {
  await runMigrations(pool);
  const orgId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "scheduling-db-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, "scheduling-db-test"]
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'scheduling-db-test-org'");
  await pool.end();
});

// Only export-configs is exercised in full detail below; the same claim
// query shape (verified identical by reading otlp-forward-rules.ts and
// webhooks.ts) is spot-checked once each for otlp forwards and webhooks
// to confirm the pattern was applied consistently, not to re-prove every
// property three times.
describe("claimDueExportConfigs", () => {
  it("a newly-created config is due immediately (next_run_at defaults to now())", async () => {
    const config = await createExportConfig(pool, {
      id: `export_${ulid()}`,
      projectId,
      name: "immediately-due",
      format: "jsonl",
      filter: {},
      destinationBucket: "b",
      destinationPrefix: "",
      destinationEndpoint: "http://localhost:9010",
      destinationRegion: "us-east-1",
      destinationAccessKeyId: "k",
      destinationSecretAccessKeyEncrypted: "unused-in-this-test"
    });
    const due = await claimDueExportConfigs(pool, 100);
    expect(due.map((c) => c.id)).toContain(config.id);
  });

  it("claiming advances next_run_at, so the same row is NOT claimed again immediately after", async () => {
    const config = await createExportConfig(pool, {
      id: `export_${ulid()}`,
      projectId,
      name: "claim-once",
      format: "jsonl",
      filter: {},
      destinationBucket: "b",
      destinationPrefix: "",
      destinationEndpoint: "http://localhost:9010",
      destinationRegion: "us-east-1",
      destinationAccessKeyId: "k",
      destinationSecretAccessKeyEncrypted: "unused-in-this-test"
    });

    const first = await claimDueExportConfigs(pool, 100);
    expect(first.map((c) => c.id)).toContain(config.id);

    const second = await claimDueExportConfigs(pool, 100);
    expect(second.map((c) => c.id)).not.toContain(config.id);
  });

  it("a disabled config is never claimed even when due", async () => {
    await pool.query(
      `insert into export_configs (id, project_id, name, format, filter, destination_bucket,
         destination_prefix, destination_endpoint, destination_region, destination_access_key_id,
         destination_secret_access_key_encrypted, enabled)
       values ($1, $2, 'disabled', 'jsonl', '{}', 'b', '', 'http://localhost:9010', 'us-east-1', 'k', 'unused', false)`,
      [`export_${ulid()}`, projectId]
    );
    const due = await claimDueExportConfigs(pool, 1000);
    for (const c of due) expect(c.enabled).toBe(true);
  });

  it("a config whose next_run_at is in the future is not claimed", async () => {
    const id = `export_${ulid()}`;
    await pool.query(
      `insert into export_configs (id, project_id, name, format, filter, destination_bucket,
         destination_prefix, destination_endpoint, destination_region, destination_access_key_id,
         destination_secret_access_key_encrypted, next_run_at)
       values ($1, $2, 'future', 'jsonl', '{}', 'b', '', 'http://localhost:9010', 'us-east-1', 'k', 'unused', now() + interval '1 hour')`,
      [id, projectId]
    );
    const due = await claimDueExportConfigs(pool, 1000);
    expect(due.map((c) => c.id)).not.toContain(id);
  });

  it("reschedules next_run_at to roughly now + pollIntervalSeconds, not a fixed/default interval", async () => {
    const config = await createExportConfig(pool, {
      id: `export_${ulid()}`,
      projectId,
      name: "custom-interval",
      format: "jsonl",
      filter: {},
      destinationBucket: "b",
      destinationPrefix: "",
      destinationEndpoint: "http://localhost:9010",
      destinationRegion: "us-east-1",
      destinationAccessKeyId: "k",
      destinationSecretAccessKeyEncrypted: "unused-in-this-test"
    });
    await pool.query("update export_configs set poll_interval_seconds = 120 where id = $1", [
      config.id
    ]);

    const before = Date.now();
    const [claimed] = await claimDueExportConfigs(pool, 100).then((rows) =>
      rows.filter((c) => c.id === config.id)
    );
    expect(claimed).toBeTruthy();
    const deltaSeconds = (claimed!.nextRunAt.getTime() - before) / 1000;
    expect(deltaSeconds).toBeGreaterThan(110);
    expect(deltaSeconds).toBeLessThan(130);
  });

  it("concurrent claim ticks never claim the same due row twice (FOR UPDATE SKIP LOCKED)", async () => {
    const config = await createExportConfig(pool, {
      id: `export_${ulid()}`,
      projectId,
      name: "concurrent-claim",
      format: "jsonl",
      filter: {},
      destinationBucket: "b",
      destinationPrefix: "",
      destinationEndpoint: "http://localhost:9010",
      destinationRegion: "us-east-1",
      destinationAccessKeyId: "k",
      destinationSecretAccessKeyEncrypted: "unused-in-this-test"
    });

    const [batchA, batchB] = await Promise.all([
      claimDueExportConfigs(pool, 100),
      claimDueExportConfigs(pool, 100)
    ]);
    const claimedBoth = [...batchA, ...batchB].filter((c) => c.id === config.id);
    expect(claimedBoth).toHaveLength(1);
  });
});

describe("claimDueOtlpForwardRules", () => {
  it("claims a newly-created rule and advances next_run_at", async () => {
    const rule = await createOtlpForwardRule(pool, {
      id: `fwd_${ulid()}`,
      projectId,
      name: "immediately-due",
      destinationUrl: "http://localhost:9999/v1/traces",
      filter: {}
    });
    const first = await claimDueOtlpForwardRules(pool, 100);
    expect(first.map((r) => r.id)).toContain(rule.id);

    const second = await claimDueOtlpForwardRules(pool, 100);
    expect(second.map((r) => r.id)).not.toContain(rule.id);
  });
});

describe("claimDueWebhookRules", () => {
  it("claims a newly-created rule and advances next_run_at", async () => {
    const rule = await createWebhookRule(pool, {
      id: `webhook_sched_${ulid()}`,
      projectId,
      name: "immediately-due",
      destinationUrl: "http://localhost:9999/hook",
      signingSecretEncrypted: "unused-in-this-test",
      filter: {}
    });
    const first = await claimDueWebhookRules(pool, 100);
    expect(first.map((r) => r.id)).toContain(rule.id);

    const second = await claimDueWebhookRules(pool, 100);
    expect(second.map((r) => r.id)).not.toContain(rule.id);
  });
});
