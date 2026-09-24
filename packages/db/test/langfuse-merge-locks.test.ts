import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, describe, expect, it } from "vitest";
import {
  LANGFUSE_MERGE_LOCK_APPLICATION_NAME,
  LANGFUSE_MERGE_LOCK_BUCKETS,
  closeLangfuseMergeLocks,
  withLangfuseMergeLocks
} from "../src/langfuse-field-provenance.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://ironside:ironside@localhost:5433/ironside"
});

afterAll(async () => {
  await closeLangfuseMergeLocks(pool);
  await pool.end();
});

/** Advisory locks each merge-lock session holds right now. */
async function locksPerSession(): Promise<number[]> {
  const result = await pool.query<{ held: number }>(
    `select count(*)::int as held
       from pg_locks join pg_stat_activity using (pid)
      where pg_locks.locktype = 'advisory' and pg_stat_activity.application_name = $1
      group by pid`,
    [LANGFUSE_MERGE_LOCK_APPLICATION_NAME]
  );
  return result.rows.map((row) => row.held);
}

function observations(count: number): { kind: "observation"; id: string }[] {
  return Array.from({ length: count }, (_, index) => ({ kind: "observation", id: `obs_${index}` }));
}

describe("withLangfuseMergeLocks", () => {
  it("holds at most one lock per bucket however many records a batch has, and releases them all", async () => {
    // One lock per record exhausted Postgres's shared lock table at about 13k.
    const held = await withLangfuseMergeLocks(pool, `proj_${ulid()}`, observations(20_000), locksPerSession);
    expect(Math.max(...held)).toBeLessThanOrEqual(LANGFUSE_MERGE_LOCK_BUCKETS);
    expect(Math.max(...held)).toBeGreaterThan(LANGFUSE_MERGE_LOCK_BUCKETS / 2);
    expect(await locksPerSession()).toEqual([]);
  });

  it("makes a batch touching the same record wait, and lets another project's batch run", async () => {
    const projectId = `proj_${ulid()}`;
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstHolding = new Promise<void>((resolve) => {
      const first = withLangfuseMergeLocks(pool, projectId, [{ kind: "trace", id: "trace_1" }], async () => {
        resolve();
        await new Promise<void>((release) => (releaseFirst = release));
        order.push("first");
      });
      void first;
    });
    await firstHolding;

    const sameRecord = withLangfuseMergeLocks(pool, projectId, [{ kind: "trace", id: "trace_1" }], async () => {
      order.push("same record");
    });
    await withLangfuseMergeLocks(pool, `proj_${ulid()}`, [{ kind: "trace", id: "trace_1" }], async () => {
      order.push("other project");
    });
    releaseFirst();
    await sameRecord;
    expect(order).toEqual(["other project", "first", "same record"]);
  });

  it("releases its locks when the operation fails", async () => {
    const projectId = `proj_${ulid()}`;
    const record = [{ kind: "observation" as const, id: "obs_1" }];
    await expect(
      withLangfuseMergeLocks(pool, projectId, record, async () => {
        throw new Error("merge failed");
      })
    ).rejects.toThrow("merge failed");
    expect(await withLangfuseMergeLocks(pool, projectId, record, async () => "ran")).toBe("ran");
  });
});
