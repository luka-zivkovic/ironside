import { afterAll, describe, expect, it } from "vitest";
import { createClickHouseClient } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { insertObservations, insertTraces } from "../src/rows.js";
import { dropPartitionsOlderThan, listPartitions, markProjectDataDeletedOlderThan } from "../src/retention.js";

const client = createClickHouseClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.CLICKHOUSE_USER ?? "ironside",
  password: process.env.CLICKHOUSE_PASSWORD ?? "ironside",
  database: process.env.CLICKHOUSE_DB ?? "ironside"
});

describe("retention", () => {
  afterAll(() => client.close());

  it("dropPartitionsOlderThan drops only whole-month partitions entirely past the cutoff, across every project sharing that partition", async () => {
    await runMigrations(client);

    // Two old-month traces (different projects, same monthly partition —
    // proving a partition drop is NOT project-scoped) and one recent trace
    // that must survive.
    const oldProjectA = `proj_retention_old_a_${crypto.randomUUID()}`;
    const oldProjectB = `proj_retention_old_b_${crypto.randomUUID()}`;
    const recentProject = `proj_retention_recent_${crypto.randomUUID()}`;

    await insertTraces(
      client,
      [
        { id: `trace_${crypto.randomUUID()}`, projectId: oldProjectA, timestamp: "2020-01-15T00:00:00.000Z", tags: [], metadata: {} },
        { id: `trace_${crypto.randomUUID()}`, projectId: oldProjectB, timestamp: "2020-01-20T00:00:00.000Z", tags: [], metadata: {} },
        { id: `trace_${crypto.randomUUID()}`, projectId: recentProject, timestamp: new Date().toISOString(), tags: [], metadata: {} }
      ],
      { eventTs: new Date().toISOString() }
    );

    const dropped = await dropPartitionsOlderThan(client, "traces", new Date("2024-01-01T00:00:00Z"));
    expect(dropped).toContain("202001");

    const remaining = await client.query({
      query: "select project_id from traces where project_id in {projects:Array(String)}",
      query_params: { projects: [oldProjectA, oldProjectB, recentProject] },
      format: "JSONEachRow"
    });
    const remainingProjects = (await remaining.json<{ project_id: string }>()).map((r) => r.project_id);
    expect(remainingProjects).not.toContain(oldProjectA);
    expect(remainingProjects).not.toContain(oldProjectB);
    expect(remainingProjects).toContain(recentProject);
  });

  it("does not drop a partition whose max timestamp is BEFORE the nominal cutoff but still inside the grace-period buffer", async () => {
    // Guards against a real TOCTOU race flagged in code review: the
    // max-timestamp check and the actual DROP PARTITION are two separate
    // ClickHouse statements with no cross-statement transaction. Since
    // ingest is fully async and event timestamps are client-supplied and
    // unclamped, a row can in principle land in an old partition between
    // the check and the drop (a backfill client, or a queued job that
    // hadn't drained). The grace period exists so a normal amount of
    // ingest lag can't cause that race to actually destroy data.
    //
    // Without a grace period, a trace timestamped strictly BEFORE the
    // `olderThan` cutoff would be dropped — that's the exact case this
    // test targets: 12 hours before the nominal cutoff, which is old
    // enough to be dropped by a naive check but still inside the 24h
    // PARTITION_DROP_GRACE_PERIOD_MS buffer subtracted from the
    // effective cutoff.
    //
    // Deliberately uses a RECENT cutoff (hours, not years) so this
    // fixture lands in the CURRENT month's partition. This test suite's
    // files run concurrently against one shared, non-test-scoped
    // ClickHouse instance (Vitest's default file parallelism); another
    // file's retention test (apps/worker/test/retention-runner.test.ts)
    // legitimately drops partitions using cutoffs of up to 365 days —
    // an old-dated fixture here (this test originally used "5 years
    // ago") is real, genuinely-droppable data from ANY such test's
    // point of view, so a concurrently-running retention call elsewhere
    // can destroy it out from under this test, independent of whether
    // THIS test's own logic is correct. A current-month fixture is safe
    // from every other test's cutoff, since none of them use a cutoff
    // shorter than a day. Reproduced and confirmed as the actual failure
    // mode via `vitest run ... --no-file-parallelism` (passes) vs the
    // default parallel run (flaky) before applying this fix.
    const graceProject = `proj_retention_grace_${crypto.randomUUID()}`;
    const nominalCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago — same month as "now" on any reasonable test run
    const justBeforeNominalCutoff = new Date(nominalCutoff.getTime() - 12 * 60 * 60 * 1000); // 12h earlier — strictly before the cutoff, but inside the 24h grace period

    await insertTraces(
      client,
      [{ id: `trace_${crypto.randomUUID()}`, projectId: graceProject, timestamp: justBeforeNominalCutoff.toISOString(), tags: [], metadata: {} }],
      { eventTs: new Date().toISOString() }
    );

    await dropPartitionsOlderThan(client, "traces", nominalCutoff);

    const stillThere = await client.query({
      query: "select project_id from traces where project_id = {p:String}",
      query_params: { p: graceProject },
      format: "JSONEachRow"
    });
    expect((await stillThere.json()).length).toBe(1);
  });

  it("does not drop a partition that still has data within the retention window", async () => {
    // A partition mixing old and recent-enough data must survive whole —
    // dropPartitionsOlderThan checks the partition's actual max
    // timestamp, not just its nominal month.
    const mixedProject = `proj_retention_mixed_${crypto.randomUUID()}`;
    const recentInOldPartition = new Date();
    recentInOldPartition.setUTCFullYear(recentInOldPartition.getUTCFullYear() - 4, 0, 15);

    await insertTraces(
      client,
      [{ id: `trace_${crypto.randomUUID()}`, projectId: mixedProject, timestamp: new Date().toISOString(), tags: [], metadata: {} }],
      { eventTs: new Date().toISOString() }
    );

    // Sanity: the current month's partition must not be reported as
    // droppable by a cutoff of "1 year ago".
    const oneYearAgo = new Date();
    oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);
    const dropped = await dropPartitionsOlderThan(client, "traces", oneYearAgo);

    const stillThere = await client.query({
      query: "select project_id from traces where project_id = {p:String}",
      query_params: { p: mixedProject },
      format: "JSONEachRow"
    });
    expect((await stillThere.json()).length).toBe(1);
    expect(dropped).not.toContain(currentPartitionId());
  });

  it("markProjectDataDeletedOlderThan marks only the target project's old rows deleted, preserving every other column", async () => {
    const targetProject = `proj_retention_markdel_${crypto.randomUUID()}`;
    const otherProject = `proj_retention_markdel_other_${crypto.randomUUID()}`;
    const oldTraceId = `trace_${crypto.randomUUID()}`;
    const recentTraceId = `trace_${crypto.randomUUID()}`;
    const otherOldTraceId = `trace_${crypto.randomUUID()}`;
    // Keep fixtures in current/future physical partitions so another test
    // file's legitimate global partition drop cannot erase the physical
    // tombstone this assertion inspects. They are old/recent relative to this
    // test's advanced logical cutoff, not an ancient shared partition.
    const oldTimestamp = new Date();
    const cutoff = new Date(oldTimestamp.getTime() + 24 * 60 * 60 * 1000);
    const recentTimestamp = new Date(cutoff.getTime() + 24 * 60 * 60 * 1000);

    await insertTraces(
      client,
      [
        {
          id: oldTraceId,
          projectId: targetProject,
          timestamp: oldTimestamp.toISOString(),
          name: "old-trace",
          userId: "user_123",
          tags: ["a", "b"],
          metadata: { key: "value" },
          input: { q: "hello" },
          output: { a: "world" }
        },
        {
          id: recentTraceId,
          projectId: targetProject,
          timestamp: recentTimestamp.toISOString(),
          name: "recent-trace",
          tags: [],
          metadata: {}
        },
        {
          id: otherOldTraceId,
          projectId: otherProject,
          timestamp: oldTimestamp.toISOString(),
          name: "other-project-old-trace",
          tags: [],
          metadata: {}
        }
      ],
      { eventTs: new Date().toISOString() }
    );

    await markProjectDataDeletedOlderThan(client, "traces", targetProject, cutoff);

    // ReplacingMergeTree(event_ts, is_deleted)'s is_deleted is the
    // engine's own tombstone marker: FINAL doesn't just dedup to the
    // latest version, it EXCLUDES a row entirely once its latest version
    // has is_deleted != 0. So the correct proof the old trace was marked
    // deleted is that FINAL no longer returns it at all.
    const finalResult = await client.query({
      query: "select id from traces final where id in {ids:Array(String)} order by id",
      query_params: { ids: [oldTraceId, recentTraceId, otherOldTraceId] },
      format: "JSONEachRow"
    });
    const finalIds = (await finalResult.json<{ id: string }>()).map((r) => r.id);
    expect(finalIds).not.toContain(oldTraceId); // marked deleted — FINAL excludes it
    expect(finalIds).toContain(recentTraceId); // too recent to be touched
    expect(finalIds).toContain(otherOldTraceId); // different project — untouched

    // Separately (without FINAL, since the deleted row is invisible to
    // it), inspect the latest physical version of the deleted row to
    // prove every OTHER column survived the mark-deleted re-insert
    // intact — the exact bug class a partial-column re-insert would
    // cause (silently nulling out name/tags/metadata/input/output).
    const latestVersionResult = await client.query({
      query: `
        select name, user_id, tags, metadata, input, output, is_deleted
        from traces
        where id = {id:String}
        order by event_ts desc
        limit 1
      `,
      query_params: { id: oldTraceId },
      format: "JSONEachRow"
    });
    const [latestVersion] = await latestVersionResult.json<{
      name: string;
      user_id: string;
      tags: string[];
      metadata: Record<string, string>;
      input: string;
      output: string;
      is_deleted: number;
    }>();
    expect(latestVersion?.is_deleted).toBe(1);
    expect(latestVersion?.name).toBe("old-trace");
    expect(latestVersion?.user_id).toBe("user_123");
    expect(latestVersion?.tags).toEqual(["a", "b"]);
    expect(latestVersion?.metadata).toEqual({ key: "value" });
    expect(JSON.parse(latestVersion?.input ?? "null")).toEqual({ q: "hello" });
    expect(JSON.parse(latestVersion?.output ?? "null")).toEqual({ a: "world" });
  });

  it("retains old observations while their parent trace remains in-window", async () => {
    const projectId = `proj_retention_tree_${crypto.randomUUID()}`;
    const traceId = `trace_${crypto.randomUUID()}`;
    const observationId = `obs_${crypto.randomUUID()}`;
    const eventTs = new Date().toISOString();
    await insertTraces(client, [{
      id: traceId,
      projectId,
      timestamp: new Date().toISOString(),
      tags: [],
      metadata: {}
    }], { eventTs });
    await insertObservations(client, [{
      id: observationId,
      traceId,
      projectId,
      type: "span",
      startTime: "2020-01-15T00:00:00.000Z",
      level: "default",
      metadata: {}
    }], { eventTs });

    const cutoff = new Date("2024-01-01T00:00:00.000Z");
    await markProjectDataDeletedOlderThan(client, "observations", projectId, cutoff);
    const dropped = await dropPartitionsOlderThan(client, "observations", cutoff);

    const remaining = await client.query({
      query: "select id from observations final where project_id = {projectId:String} and id = {observationId:String}",
      query_params: { projectId, observationId },
      format: "JSONEachRow"
    });
    expect(await remaining.json()).toHaveLength(1);
    expect(dropped).not.toContain("202001");
  });

  it("listPartitions returns partitions oldest-first with their actual min timestamp", async () => {
    const partitions = await listPartitions(client, "traces");
    expect(partitions.length).toBeGreaterThan(0);
    const sorted = [...partitions].sort((a, b) => a.partition.localeCompare(b.partition));
    expect(partitions.map((p) => p.partition)).toEqual(sorted.map((p) => p.partition));
  });
});

function currentPartitionId(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
