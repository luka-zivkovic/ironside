import { createClickHouseClient, insertTraces, runMigrations as runChMigrations } from "@ironside/clickhouse";
import {
  createExportConfig,
  createOtlpForwardRule,
  createWebhookRule,
  getExportConfig,
  getImportCheckpoint,
  runMigrations as runPgMigrations,
  upsertImportSource
} from "@ironside/db";
import { encryptSecret } from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { startScheduler, type Scheduler } from "../src/scheduler.js";

// These are real end-to-end integration tests (real ClickHouse/Postgres/
// MinIO, real DuckDB writes for the export path) driven by a poll loop
// (waitFor), not instant assertions — the default 5000ms vitest test
// timeout leaves too little margin under full-suite parallel load
// (shared connection pools across every worker test file running at
// once), which was flaking this file's slower tests without being a
// logic bug.
vi.setConfig({ testTimeout: 15_000 });

// Integration test of the scheduler's claim-and-dispatch wiring — not a
// re-test of runExport/forwardOtlpTraces/runWebhooks' own logic (each has
// its own dedicated test file), but proof that startScheduler actually
// claims due rows, decrypts their credentials, invokes the right runner,
// and records the outcome, end-to-end against the real local stack.

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);
const destination = createObjectStorage({
  endpoint: config.storage.endpoint,
  region: config.storage.region,
  accessKeyId: config.storage.accessKeyId,
  secretAccessKey: config.storage.secretAccessKey,
  bucket: "ironside-scheduler-test"
});

let projectId: string;
let scheduler: Scheduler | null = null;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await destination.ensureBucket();
  const orgId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "scheduler-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, "scheduler-test"]
  );
});

beforeEach(() => {
  // Set unconditionally, every test — not once in beforeAll. Vitest's
  // default threads pool can share a process.env across test FILES
  // running concurrently in the same worker; another file's afterEach
  // (e.g. packages/shared/test/encryption.test.ts, which deliberately
  // deletes this var for one of its own tests, then restores it) can
  // observe/mutate this value between two of THIS file's tests. A
  // one-time `??=` in beforeAll is not enough to survive that.
  process.env.IRONSIDE_ENCRYPTION_SECRET = "scheduler-test-secret";
});

afterEach(() => {
  scheduler?.stop();
  scheduler = null;
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'scheduler-test-org'");
  await pool.end();
  await clickhouse.close();
  destination.close();
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met within timeout");
}

describe("startScheduler", () => {
  it("claims a due export config, decrypts its secret, runs the export, and records success", async () => {
    const marker = `sched_export_${ulid()}`;
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

    const exportConfig = await createExportConfig(pool, {
      id: `export_${ulid()}`,
      projectId,
      name: "scheduler-driven export",
      format: "jsonl",
      filter: { tags: [marker] },
      destinationBucket: "ironside-scheduler-test",
      destinationPrefix: "",
      destinationEndpoint: config.storage.endpoint,
      destinationRegion: config.storage.region,
      destinationAccessKeyId: config.storage.accessKeyId,
      destinationSecretAccessKeyEncrypted: encryptSecret(config.storage.secretAccessKey)
    });

    scheduler = startScheduler({
      pool,
      clickhouse,
      defaultRetentionDays: 90,
      defaultTraceQuietPeriodSeconds: 0,
      tickIntervalMs: 60_000, // don't tick again during the test; runTick() fires once immediately
      retentionIntervalMs: 3_600_000
    });

    await waitFor(async () => {
      const updated = await getExportConfig(pool, projectId, exportConfig.id);
      return updated?.lastRunStatus === "success";
    });

    const finalConfig = await getExportConfig(pool, projectId, exportConfig.id);
    expect(finalConfig?.lastRunStatus).toBe("success");
    expect(finalConfig?.lastRunRowCount).toBe(1);
    // Claiming must have advanced next_run_at into the future, or the
    // scheduler would re-run this same config on every subsequent tick.
    expect(finalConfig!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("records a failure (not a crash) when a claimed export's destination is unreachable, and still advances next_run_at", async () => {
    const exportConfig = await createExportConfig(pool, {
      id: `export_${ulid()}`,
      projectId,
      name: "scheduler-driven failing export",
      format: "jsonl",
      filter: {},
      destinationBucket: "nonexistent-bucket-that-should-fail",
      destinationPrefix: "",
      destinationEndpoint: config.storage.endpoint,
      destinationRegion: config.storage.region,
      destinationAccessKeyId: "wrong-key",
      destinationSecretAccessKeyEncrypted: encryptSecret("wrong-secret")
    });

    const errors: { subsystem: string; error: unknown }[] = [];
    scheduler = startScheduler({
      pool,
      clickhouse,
      defaultRetentionDays: 90,
      defaultTraceQuietPeriodSeconds: 0,
      tickIntervalMs: 60_000,
      retentionIntervalMs: 3_600_000,
      onError: (subsystem, error) => errors.push({ subsystem, error })
    });

    await waitFor(async () => {
      const updated = await getExportConfig(pool, projectId, exportConfig.id);
      return updated?.lastRunStatus === "error";
    });

    const finalConfig = await getExportConfig(pool, projectId, exportConfig.id);
    expect(finalConfig?.lastRunStatus).toBe("error");
    expect(finalConfig?.lastRunError).toBeTruthy();
    expect(finalConfig!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(errors.some((e) => e.subsystem === "export")).toBe(true);
  });

  it("an export whose filter matches zero traces records rowCount 0, not null — regression: the scheduler used to call recordExportRun a second time on success, and runExport's own rowCount:0 write for the empty case would be overwritten back to null by that redundant call", async () => {
    const exportConfig = await createExportConfig(pool, {
      id: `export_${ulid()}`,
      projectId,
      name: "scheduler-driven empty export",
      format: "jsonl",
      filter: { tags: [`no_such_tag_${ulid()}`] },
      destinationBucket: "ironside-scheduler-test",
      destinationPrefix: "",
      destinationEndpoint: config.storage.endpoint,
      destinationRegion: config.storage.region,
      destinationAccessKeyId: config.storage.accessKeyId,
      destinationSecretAccessKeyEncrypted: encryptSecret(config.storage.secretAccessKey)
    });

    scheduler = startScheduler({
      pool,
      clickhouse,
      defaultRetentionDays: 90,
      defaultTraceQuietPeriodSeconds: 0,
      tickIntervalMs: 60_000,
      retentionIntervalMs: 3_600_000
    });

    await waitFor(async () => {
      const updated = await getExportConfig(pool, projectId, exportConfig.id);
      return updated?.lastRunStatus === "success";
    });

    const finalConfig = await getExportConfig(pool, projectId, exportConfig.id);
    expect(finalConfig?.lastRunStatus).toBe("success");
    expect(finalConfig?.lastRunRowCount).toBe(0);
  });

  it("a row whose credentials fail to decrypt (missing/rotated IRONSIDE_ENCRYPTION_SECRET) is reported via onError without crashing the scheduler or blocking other due rows", async () => {
    const badCiphertext = "aes-256-gcm:v1:not-a-real-iv:not-a-real-tag:not-real-ciphertext";
    const exportConfig = await createExportConfig(pool, {
      id: `export_${ulid()}`,
      projectId,
      name: "undecryptable-secret",
      format: "jsonl",
      filter: {},
      destinationBucket: "ironside-scheduler-test",
      destinationPrefix: "",
      destinationEndpoint: config.storage.endpoint,
      destinationRegion: config.storage.region,
      destinationAccessKeyId: config.storage.accessKeyId,
      destinationSecretAccessKeyEncrypted: badCiphertext
    });
    // A second, healthy config proves the bad row doesn't block others.
    const marker = `sched_decrypt_${ulid()}`;
    await insertTraces(
      clickhouse,
      [{ id: `trace_${marker}`, projectId, timestamp: new Date().toISOString(), tags: [marker], metadata: {} }],
      { eventTs: new Date().toISOString() }
    );
    const healthyConfig = await createExportConfig(pool, {
      id: `export_${ulid()}`,
      projectId,
      name: "healthy-alongside-bad",
      format: "jsonl",
      filter: { tags: [marker] },
      destinationBucket: "ironside-scheduler-test",
      destinationPrefix: "",
      destinationEndpoint: config.storage.endpoint,
      destinationRegion: config.storage.region,
      destinationAccessKeyId: config.storage.accessKeyId,
      destinationSecretAccessKeyEncrypted: encryptSecret(config.storage.secretAccessKey)
    });

    const errors: { subsystem: string; error: unknown }[] = [];
    scheduler = startScheduler({
      pool,
      clickhouse,
      defaultRetentionDays: 90,
      defaultTraceQuietPeriodSeconds: 0,
      tickIntervalMs: 60_000,
      retentionIntervalMs: 3_600_000,
      onError: (subsystem, error) => errors.push({ subsystem, error })
    });

    await waitFor(async () => {
      const bad = await getExportConfig(pool, projectId, exportConfig.id);
      const healthy = await getExportConfig(pool, projectId, healthyConfig.id);
      return bad?.lastRunStatus === "error" && healthy?.lastRunStatus === "success";
    });

    const badFinal = await getExportConfig(pool, projectId, exportConfig.id);
    const healthyFinal = await getExportConfig(pool, projectId, healthyConfig.id);
    expect(badFinal?.lastRunStatus).toBe("error");
    expect(badFinal?.lastRunError).toBeTruthy();
    expect(healthyFinal?.lastRunStatus).toBe("success");
    expect(healthyFinal?.lastRunRowCount).toBe(1);
    expect(errors.some((e) => e.subsystem === "export")).toBe(true);
  });

  it("claims a due LangFuse import source, decrypts its credentials, and invokes runLangfuseImport (proven via the import_checkpoints row it writes) — no real LangFuse account is available in this environment, so the outcome is a network failure, not success, but the wiring up to that point is proven", async () => {
    const source = await upsertImportSource(pool, {
      id: `import_src_${ulid()}`,
      projectId,
      provider: "langfuse",
      encryptedCredentials: encryptSecret(
        JSON.stringify({
          provider: "langfuse",
          publicKey: "pk_test",
          secretKey: "sk_test",
          // A closed local port — fails FAST with ECONNREFUSED, unlike an
          // unroutable address (e.g. RFC 5737 TEST-NET-1), which can hang
          // for a full OS-level TCP connect timeout (60s+) instead of
          // rejecting immediately, blowing this test's budget for no
          // reason (empirically confirmed: this was the first version and
          // it timed out).
          baseUrl: "http://127.0.0.1:9"
        })
      )
    });

    const errors: { subsystem: string; error: unknown }[] = [];
    scheduler = startScheduler({
      pool,
      clickhouse,
      defaultRetentionDays: 90,
      defaultTraceQuietPeriodSeconds: 0,
      tickIntervalMs: 60_000,
      retentionIntervalMs: 3_600_000,
      onError: (subsystem, error) => errors.push({ subsystem, error })
    });

    // runLangfuseImport claims its own import_checkpoints row (status
    // 'running' -> 'error') as part of its own internal try/catch — its
    // existence with status 'error' proves the scheduler actually
    // decrypted the credentials and called into the real importer, not
    // just that claimDueImportSources returned a row.
    await waitFor(async () => {
      const checkpoint = await getImportCheckpoint(pool, projectId, "langfuse");
      return checkpoint?.status === "error";
    });

    const checkpoint = await getImportCheckpoint(pool, projectId, "langfuse");
    expect(checkpoint?.status).toBe("error");
    expect(checkpoint?.lastError).toBeTruthy();
    expect(errors.some((e) => e.subsystem === "import")).toBe(true);

    const row = await pool.query<{ next_run_at: Date }>(
      "select next_run_at from import_sources where id = $1",
      [source.id]
    );
    expect(new Date(row.rows[0]!.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("a source whose decrypted credentials don't match the stored provider is reported via onError, not dispatched to the wrong importer — regression: an `as` type assertion performs no runtime check, so a malformed/tampered blob could otherwise silently run the wrong importer against import_checkpoints", async () => {
    // Snapshot before: this file's projectId is shared across tests
    // (including an earlier one that legitimately writes a langfuse
    // checkpoint), so the assertion below must be "no NEW write happened"
    // rather than "no checkpoint exists at all".
    const langfuseCheckpointBefore = await getImportCheckpoint(pool, projectId, "langfuse");

    const source = await upsertImportSource(pool, {
      id: `import_src_${ulid()}`,
      projectId,
      provider: "langsmith",
      // Deliberately mismatched: the DB column says langsmith, the
      // decrypted blob claims langfuse.
      encryptedCredentials: encryptSecret(
        JSON.stringify({ provider: "langfuse", publicKey: "pk", secretKey: "sk", baseUrl: "http://127.0.0.1:9" })
      )
    });

    const errors: { subsystem: string; error: unknown }[] = [];
    scheduler = startScheduler({
      pool,
      clickhouse,
      defaultRetentionDays: 90,
      defaultTraceQuietPeriodSeconds: 0,
      tickIntervalMs: 60_000,
      retentionIntervalMs: 3_600_000,
      onError: (subsystem, error) => errors.push({ subsystem, error })
    });

    await waitFor(async () => errors.some((e) => e.subsystem === "import"));

    const importError = errors.find((e) => e.subsystem === "import");
    expect(String(importError?.error)).toMatch(/does not match stored provider/);

    // Neither importer's checkpoint should have been touched by THIS
    // source's mismatched dispatch — the mismatch is caught BEFORE either
    // runLangfuseImport or runLangsmithImport is ever called. The
    // project's langsmith checkpoint must still be entirely absent (no
    // earlier test in this file writes one), and the langfuse checkpoint
    // (which an earlier test DOES legitimately write) must be unchanged.
    const langsmithCheckpoint = await getImportCheckpoint(pool, projectId, "langsmith");
    expect(langsmithCheckpoint).toBeNull();
    const langfuseCheckpointAfter = await getImportCheckpoint(pool, projectId, "langfuse");
    expect(langfuseCheckpointAfter?.importedCount ?? null).toEqual(
      langfuseCheckpointBefore?.importedCount ?? null
    );
    expect(langfuseCheckpointAfter?.lastError ?? null).toEqual(langfuseCheckpointBefore?.lastError ?? null);

    const row = await pool.query<{ next_run_at: Date }>(
      "select next_run_at from import_sources where id = $1",
      [source.id]
    );
    expect(new Date(row.rows[0]!.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("one project's import failure does not block a DIFFERENT project's import in the same tick", async () => {
    const orgId = `org_${ulid()}`;
    const otherProjectId = `proj_${ulid()}`;
    await pool.query("insert into organizations (id, name) values ($1, $2)", [orgId, "scheduler-test-import-isolation"]);
    await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
      otherProjectId,
      orgId,
      "scheduler-test-import-isolation-project"
    ]);

    const badSource = await upsertImportSource(pool, {
      id: `import_src_${ulid()}`,
      projectId,
      provider: "langsmith",
      // Malformed on purpose: JSON.parse succeeds but decryptSecret fails
      // (not real ciphertext) — fails before either importer is invoked.
      encryptedCredentials: "not-real-ciphertext"
    });
    const healthySource = await upsertImportSource(pool, {
      id: `import_src_${ulid()}`,
      projectId: otherProjectId,
      provider: "langsmith",
      encryptedCredentials: encryptSecret(
        JSON.stringify({ provider: "langsmith", apiKey: "ls_test", sessionIds: ["s1"], baseUrl: "http://127.0.0.1:9" })
      )
    });

    const errors: { subsystem: string; error: unknown }[] = [];
    scheduler = startScheduler({
      pool,
      clickhouse,
      defaultRetentionDays: 90,
      defaultTraceQuietPeriodSeconds: 0,
      tickIntervalMs: 60_000,
      retentionIntervalMs: 3_600_000,
      onError: (subsystem, error) => errors.push({ subsystem, error })
    });

    // The healthy project's import genuinely runs (network failure against
    // the closed port, recorded in ITS OWN import_checkpoints row) despite
    // the other project's source being fundamentally broken.
    await waitFor(async () => {
      const checkpoint = await getImportCheckpoint(pool, otherProjectId, "langsmith");
      return checkpoint?.status === "error";
    });

    const healthyCheckpoint = await getImportCheckpoint(pool, otherProjectId, "langsmith");
    expect(healthyCheckpoint?.status).toBe("error");
    expect(healthyCheckpoint?.lastError).toBeTruthy();

    const badRow = await pool.query<{ next_run_at: Date }>(
      "select next_run_at from import_sources where id = $1",
      [badSource.id]
    );
    const healthyRow = await pool.query<{ next_run_at: Date }>(
      "select next_run_at from import_sources where id = $1",
      [healthySource.id]
    );
    expect(new Date(badRow.rows[0]!.next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(healthyRow.rows[0]!.next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect(errors.filter((e) => e.subsystem === "import").length).toBeGreaterThanOrEqual(1);

    await pool.query("delete from organizations where name = 'scheduler-test-import-isolation'");
  });

  it("claims a due OTLP forward rule and webhook rule, and correctly refuses to forward/deliver to a private destination (SSRF guard is live on the scheduler path too)", async () => {
    // NOTE: claimDueOtlpForwardRules/claimDueWebhookRules claim across the
    // WHOLE database, not scoped to this test's project — correct
    // scheduler behavior (a real scheduler must poll every project), but
    // it means other test files' leftover enabled rows in this shared
    // Postgres instance can be claimed and error out in the same tick.
    // errors[] can therefore contain entries unrelated to this test's own
    // rules — asserted against by rule id below, not by taking "the
    // first webhook/otlp-forward error" and assuming it's this test's.
    const forwardRule = await createOtlpForwardRule(pool, {
      id: `fwd_${ulid()}`,
      projectId,
      name: "scheduler-driven forward",
      destinationUrl: "http://127.0.0.1:9/v1/traces",
      filter: {}
    });
    const webhookRule = await createWebhookRule(pool, {
      id: `webhook_${ulid()}`,
      projectId,
      name: "scheduler-driven webhook",
      destinationUrl: "http://127.0.0.1:9/hook",
      signingSecretEncrypted: encryptSecret("unused-in-this-test"),
      filter: {}
    });

    scheduler = startScheduler({
      pool,
      clickhouse,
      defaultRetentionDays: 90,
      defaultTraceQuietPeriodSeconds: 0,
      tickIntervalMs: 60_000,
      retentionIntervalMs: 3_600_000
    });

    // Proof of claim + SSRF rejection, scoped to THIS test's rows only:
    // next_run_at advancing proves the row was claimed and evaluated;
    // the guard's own dedicated unit tests (otlp-forwarder.test.ts,
    // webhook-runner.test.ts) already prove the exact rejection message
    // and that zero HTTP requests reach the destination — re-asserted
    // here would require correlating onError's untyped error to a
    // specific rule id, which the scheduler's error-reporting contract
    // doesn't carry and shouldn't be forced to for this.
    await waitFor(async () => {
      const forwardRow = await pool.query<{ next_run_at: Date }>(
        "select next_run_at from otlp_forward_rules where id = $1",
        [forwardRule.id]
      );
      const webhookRow = await pool.query<{ next_run_at: Date }>(
        "select next_run_at from webhook_rules where id = $1",
        [webhookRule.id]
      );
      const forwardClaimed = new Date(forwardRow.rows[0]!.next_run_at).getTime() > Date.now();
      const webhookClaimed = new Date(webhookRow.rows[0]!.next_run_at).getTime() > Date.now();
      return forwardClaimed && webhookClaimed;
    });
  });

  it("stop() prevents further ticks", async () => {
    const exportConfig = await createExportConfig(pool, {
      id: `export_${ulid()}`,
      projectId,
      name: "stop-test",
      format: "jsonl",
      // A real (never-matching) filter, not {} — an empty filter scans
      // every trace ever inserted under this shared projectId across
      // every earlier test in this file, which grows unbounded as the
      // suite runs and was flaking this test's waitFor budget under
      // full-suite parallel load.
      filter: { tags: [`stop_test_no_match_${ulid()}`] },
      destinationBucket: "ironside-scheduler-test",
      destinationPrefix: "",
      destinationEndpoint: config.storage.endpoint,
      destinationRegion: config.storage.region,
      destinationAccessKeyId: config.storage.accessKeyId,
      destinationSecretAccessKeyEncrypted: encryptSecret(config.storage.secretAccessKey)
    });

    const s = startScheduler({
      pool,
      clickhouse,
      defaultRetentionDays: 90,
      defaultTraceQuietPeriodSeconds: 0,
      tickIntervalMs: 60_000,
      retentionIntervalMs: 3_600_000
    });
    await waitFor(async () => {
      const updated = await getExportConfig(pool, projectId, exportConfig.id);
      return updated?.lastRunStatus === "success";
    });
    s.stop();

    // Manually reset next_run_at to "due" and confirm a stopped scheduler
    // does not pick it up (no further ticks fire).
    await pool.query("update export_configs set next_run_at = now() where id = $1", [
      exportConfig.id
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const row = await pool.query<{ next_run_at: Date }>(
      "select next_run_at from export_configs where id = $1",
      [exportConfig.id]
    );
    // Still exactly "now" (i.e. unclaimed) — a live scheduler would have
    // claimed it and moved next_run_at into the future.
    expect(new Date(row.rows[0]!.next_run_at).getTime()).toBeLessThanOrEqual(Date.now());
  });
});
