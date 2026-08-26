import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";
import {
  deleteIngestFailuresForRetainedObject,
  inspectIngestFailuresForObject,
  listIngestFailures,
  purgeIngestFailuresOlderThan,
  recordIngestFailures
} from "../src/ingest-failures.js";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://ironside:ironside@localhost:5433/ironside"
});

let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  await runMigrations(pool);
  const orgId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  otherProjectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "ingest-failures-db-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3), ($4, $2, $5)",
    [projectId, orgId, "ingest-failures-db-test", otherProjectId, "ingest-failures-db-test-other"]
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'ingest-failures-db-test-org'");
  await pool.end();
});

function failure(overrides: { projectId?: string; error?: string; objectKey?: string } = {}) {
  return {
    id: `ingfail_${ulid()}`,
    projectId: overrides.projectId ?? projectId,
    batchId: `batch_${ulid()}`,
    objectKey: overrides.objectKey ?? `raw/some/key/${ulid()}.json`,
    eventId: `evt_${ulid()}`,
    source: "native",
    eventType: "trace-upsert",
    error: overrides.error ?? "score requires value or stringValue"
  };
}

describe("recordIngestFailures / listIngestFailures", () => {
  it("batch-inserts multiple failures in one call and lists them newest-first, project-scoped", async () => {
    const mine = [failure(), failure(), failure()];
    const theirs = failure({ projectId: otherProjectId });
    await recordIngestFailures(pool, [...mine, theirs]);

    const listed = await listIngestFailures(pool, projectId, 100);
    const listedIds = listed.map((f) => f.id);
    for (const f of mine) expect(listedIds).toContain(f.id);
    expect(listedIds).not.toContain(theirs.id);

    const first = listed.find((f) => f.id === mine[0]!.id);
    expect(first?.batchId).toBe(mine[0]!.batchId);
    expect(first?.objectKey).toBe(mine[0]!.objectKey);
    expect(first?.eventId).toBe(mine[0]!.eventId);
    expect(first?.error).toBe(mine[0]!.error);
    expect(first?.createdAt).toBeInstanceOf(Date);
  });

  it("recording an empty array is a no-op, not an invalid empty INSERT", async () => {
    await expect(recordIngestFailures(pool, [])).resolves.not.toThrow();
  });

  it("survives more rows than one Postgres statement can bind — regression: 8 params/row against the 65535 wire-protocol param cap means >8191 rows in one unchunked INSERT throws, and the processor's best-effort catch would silently swallow it, persisting ZERO diagnostics for exactly the batch most worth seeing (a 10MB LangFuse envelope can nest ~200k inner events)", async () => {
    const batchId = `batch_${ulid()}`;
    const many = Array.from({ length: 8500 }, (_, i) => ({
      id: `ingfail_${ulid()}`,
      projectId,
      batchId,
      objectKey: "raw/big/batch.json",
      eventId: `evt_${i}`,
      source: "langfuse",
      eventType: "langfuse-ingestion",
      error: "event failed LangFuse mapping"
    }));
    await recordIngestFailures(pool, many);

    const count = await pool.query<{ n: string }>(
      "select count(*) as n from ingest_event_failures where batch_id = $1",
      [batchId]
    );
    expect(Number(count.rows[0]!.n)).toBe(8500);

    const bounded = await inspectIngestFailuresForObject(
      pool,
      projectId,
      "raw/big/batch.json",
      1_000
    );
    expect(bounded).toMatchObject({ count: 1_000, truncated: true });
    expect(bounded.newestCreatedAt).toBeInstanceOf(Date);
  });

  it("respects the limit", async () => {
    await recordIngestFailures(pool, [failure(), failure(), failure()]);
    const listed = await listIngestFailures(pool, projectId, 2);
    expect(listed).toHaveLength(2);
  });

  it("deletes one exact object's diagnostics through a bounded locked row set", async () => {
    const objectKey = `raw/${projectId}/2025/01/01/${ulid()}.json`;
    await recordIngestFailures(pool, [
      failure({ objectKey }),
      failure({ objectKey }),
      failure()
    ]);

    expect(
      await deleteIngestFailuresForRetainedObject(pool, projectId, objectKey, 2)
    ).toBe(2);
    expect(await inspectIngestFailuresForObject(pool, projectId, objectKey, 1)).toMatchObject({
      count: 0,
      truncated: false
    });
  });

  it("deletes nothing when an object's diagnostics exceed the supplied cap", async () => {
    const objectKey = `raw/${projectId}/2025/01/01/${ulid()}.json`;
    await recordIngestFailures(pool, [
      failure({ objectKey }),
      failure({ objectKey }),
      failure({ objectKey })
    ]);

    await expect(
      deleteIngestFailuresForRetainedObject(pool, projectId, objectKey, 2)
    ).rejects.toThrow("exceeds the 2-row cap");
    expect(await inspectIngestFailuresForObject(pool, projectId, objectKey, 3)).toMatchObject({
      count: 3,
      truncated: false
    });
  });
});

describe("purgeIngestFailuresOlderThan", () => {
  it("purges rows older than the cutoff and keeps recent ones", async () => {
    const old = failure({ error: "old-row" });
    const recent = failure({ error: "recent-row" });
    await recordIngestFailures(pool, [old, recent]);
    // Backdate the old row past the cutoff — same simulate-time-passing
    // technique webhooks.test.ts uses for stale pending claims.
    await pool.query("update ingest_event_failures set created_at = now() - interval '31 days' where id = $1", [
      old.id
    ]);

    const purged = await purgeIngestFailuresOlderThan(pool, 30);
    expect(purged).toBeGreaterThanOrEqual(1);

    const listed = await listIngestFailures(pool, projectId, 1000);
    const ids = listed.map((f) => f.id);
    expect(ids).not.toContain(old.id);
    expect(ids).toContain(recent.id);
  });
});
