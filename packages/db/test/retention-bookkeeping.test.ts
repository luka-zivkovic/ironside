import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeLangfuseFieldSentAtOlderThan } from "../src/langfuse-field-provenance.js";
import { runMigrations } from "../src/migrate.js";
import { pruneStaleTraceScoreFeed } from "../src/trace-score-feed.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://ironside:ironside@localhost:5433/ironside"
});
const orgId = `org_${ulid()}`;

beforeAll(async () => {
  await runMigrations(pool);
  await pool.query("insert into organizations (id, name) values ($1, 'retention-bookkeeping-test')", [orgId]);
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [orgId]);
  await pool.end();
}, 60_000);

async function project(retentionDays: number | null): Promise<string> {
  const id = `proj_${ulid()}`;
  await pool.query("insert into projects (id, organization_id, name, retention_days) values ($1, $2, $1, $3)", [
    id,
    orgId,
    retentionDays
  ]);
  return id;
}

async function scoreFeedEntry(projectId: string, traceId: string, daysOld: number): Promise<void> {
  await pool.query(
    "insert into trace_score_feed (project_id, trace_id, published_at) values ($1, $2, now() - make_interval(days => $3))",
    [projectId, traceId, daysOld]
  );
}

async function scoreFeedTraceIds(projectId: string): Promise<string[]> {
  const result = await pool.query<{ trace_id: string }>(
    "select trace_id from trace_score_feed where project_id = $1 order by trace_id",
    [projectId]
  );
  return result.rows.map((row) => row.trace_id);
}

describe("pruneStaleTraceScoreFeed", () => {
  it("removes entries past their project's retention whose trace never reached the trace feed", async () => {
    const shortRetention = await project(1);
    const defaultRetention = await project(null);
    await scoreFeedEntry(shortRetention, "trace_orphan_old", 3);
    await scoreFeedEntry(shortRetention, "trace_orphan_new", 0);
    await scoreFeedEntry(shortRetention, "trace_in_feed_old", 3);
    await pool.query(
      `insert into evaluator_trace_feed (project_id, trace_id, trace_version, source_activity_at, published_at)
       values ($1, 'trace_in_feed_old', now(), now(), now())`,
      [shortRetention]
    );
    await scoreFeedEntry(defaultRetention, "trace_orphan_old", 3);
    await scoreFeedEntry(defaultRetention, "trace_orphan_older", 10);

    await pruneStaleTraceScoreFeed(pool, 5);

    expect(await scoreFeedTraceIds(shortRetention)).toEqual(["trace_in_feed_old", "trace_orphan_new"]);
    expect(await scoreFeedTraceIds(defaultRetention)).toEqual(["trace_orphan_old"]);
  });
});

describe("purgeLangfuseFieldSentAtOlderThan", () => {
  // More stale rows than one purge batch (5,000), so the purge takes two.
  it("purges every stale row in bounded batches and keeps recent ones", { timeout: 60_000 }, async () => {
    const projectId = await project(null);
    await pool.query(
      `insert into langfuse_field_provenance (project_id, entity_kind, entity_id, sent_at, updated_at)
       select $1, 'observation', 'obs_' || n, '{}'::jsonb, now() - interval '40 days'
         from generate_series(1, 6000) as n`,
      [projectId]
    );
    await pool.query(
      `insert into langfuse_field_provenance (project_id, entity_kind, entity_id, sent_at)
       values ($1, 'trace', 'trace_recent', '{}'::jsonb)`,
      [projectId]
    );

    const purged = await purgeLangfuseFieldSentAtOlderThan(pool, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

    expect(purged).toBeGreaterThanOrEqual(6_000);
    const left = await pool.query<{ entity_id: string }>(
      "select entity_id from langfuse_field_provenance where project_id = $1",
      [projectId]
    );
    expect(left.rows).toEqual([{ entity_id: "trace_recent" }]);
  });
});
