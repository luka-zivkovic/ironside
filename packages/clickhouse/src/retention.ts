import type { ClickHouseClient } from "@clickhouse/client";
import { fromClickHouseDateTime, toClickHouseDateTime } from "./datetime.js";

const RETAINED_TABLES = ["traces", "observations", "scores"] as const;
export type RetainedTable = (typeof RETAINED_TABLES)[number];

interface PartitionRow {
  partition: string;
  /** Earliest DateTime64 value covered by this partition — a whole-month partition's min timestamp. */
  min_date: string;
}

/**
 * Every partitioned table's monthly partition id (e.g. "202601"), oldest
 * first, with the earliest timestamp actually stored in that partition
 * (not just the partition boundary — a partition created mid-month via a
 * backfill can have a min_date later than the 1st).
 */
export async function listPartitions(client: ClickHouseClient, table: RetainedTable): Promise<PartitionRow[]> {
  const result = await client.query({
    query: `
      select partition, min(min_date) as min_date
      from system.parts
      where table = {table:String} and database = currentDatabase() and active
      group by partition
      order by partition asc
    `,
    query_params: { table },
    format: "JSONEachRow"
  });
  return result.json<PartitionRow>();
}

// The max-timestamp check and the DROP PARTITION itself are two separate
// statements — ClickHouse has no cross-statement transaction to make
// this atomic. Ingest is fully async (apps/api/src/routes/ingest.ts
// fast-ACKs to a queue; a worker inserts later) and event timestamps are
// client-supplied and unclamped, so a row for this partition can in
// principle land between the check and the drop: a backfill client
// sending an old-dated event, or simply a queued ingest job that hadn't
// drained yet when the check ran. A DROP PARTITION would then destroy
// that row permanently with no error and no way to detect it happened.
// This grace period pushes the effective cutoff back far enough that
// any realistic ingest lag (queue backlog, worker retry/backoff) has
// long since drained before a partition becomes droppable — it does not
// make the two statements atomic, but it makes the race window "an
// event arrives implausibly late" rather than "an event arrives at all
// during normal operation."
const PARTITION_DROP_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

/**
 * Drops every partition of `table` whose data is entirely older than
 * `olderThan` (plus PARTITION_DROP_GRACE_PERIOD_MS additional safety
 * margin — see that constant's comment for why). "Entirely older" is a
 * deliberate safety margin on top of that: a partition drop is a hard
 * delete of the WHOLE partition, and this codebase's partitions are
 * calendar-month (`toYYYYMM`), NOT per-project — a single partition
 * holds every project's rows for that month. This is why
 * partition-drop-based retention can only implement a GLOBAL floor, not
 * a per-project one; see spec/retention-v1.md for the per-project
 * mechanism (row-level DELETE) used for projects wanting SHORTER
 * retention than the global floor.
 *
 * Returns the partition ids actually dropped, oldest first, so a caller
 * can log/verify what happened rather than trusting a silent success.
 */
export async function dropPartitionsOlderThan(
  client: ClickHouseClient,
  table: RetainedTable,
  olderThan: Date
): Promise<string[]> {
  const effectiveCutoff = new Date(olderThan.getTime() - PARTITION_DROP_GRACE_PERIOD_MS);
  const partitions = await listPartitions(client, table);
  const dropped: string[] = [];

  for (const partition of partitions) {
    // A partition is only safe to drop once EVERY row it could contain
    // is past the cutoff — approximated here by checking the actual max
    // timestamp present, not just assuming a YYYYMM partition ends at
    // month boundary (a late-arriving backfilled row could still be
    // within the retention window even in an old-looking partition id).
    const maxResult = await client.query({
      query: `select max(${timestampColumn(table)}) as max_ts from ${table} where _partition_id = {partition:String}`,
      query_params: { partition: partition.partition },
      format: "JSONEachRow"
    });
    const [row] = await maxResult.json<{ max_ts: string }>();
    if (!row?.max_ts) continue; // partition already empty (e.g. race with a concurrent drop)

    const maxTs = new Date(fromClickHouseDateTime(row.max_ts));
    if (maxTs >= effectiveCutoff) continue; // has data within the retention window (plus grace period) — never drop

    // Observations and scores are part of a trace snapshot. An old child can
    // legitimately belong to a recent trace (late import/backfill). Dropping
    // that child's monthly partition would change the evaluator-visible tree
    // without changing the trace's activity/version, so retain the whole
    // partition while any row in it belongs to a trace still in-window.
    if (
      table !== "traces" &&
      await partitionHasChildOfRetainedTrace(
        client,
        table,
        partition.partition,
        effectiveCutoff
      )
    ) {
      continue;
    }

    await client.exec({ query: `alter table ${table} drop partition ${partition.partition}` });
    dropped.push(partition.partition);
  }

  return dropped;
}

async function partitionHasChildOfRetainedTrace(
  client: ClickHouseClient,
  table: Exclude<RetainedTable, "traces">,
  partition: string,
  cutoff: Date
): Promise<boolean> {
  const result = await client.query({
    query: `
      select count() as count
        from ${table} final
       where _partition_id = {partition:String}
         and (project_id, trace_id) in (
           select project_id, id
             from traces final
            where timestamp >= {cutoff:DateTime64(3)}
         )
    `,
    query_params: {
      partition,
      cutoff: toClickHouseDateTime(cutoff.toISOString())
    },
    format: "JSONEachRow"
  });
  const [row] = await result.json<{ count: string }>();
  return Number(row?.count ?? 0) > 0;
}

function timestampColumn(table: RetainedTable): string {
  return table === "observations" ? "start_time" : "timestamp";
}

// Every non-generated column for each table, in schema order, EXCLUDING
// is_deleted and event_ts (those two are always overridden to 1/now64(6)
// below). ReplacingMergeTree dedups by (order-by key, id) keeping the row
// with the highest event_ts — a re-insert that omitted any column here
// would silently replace a full row with one that has NULL/default
// values for the missing columns, corrupting the data. Must be kept in
// sync with packages/clickhouse/migrations/0001_baseline.sql.
const TABLE_COLUMNS: Record<RetainedTable, readonly string[]> = {
  traces: [
    "project_id", "id", "timestamp", "name", "user_id", "session_id",
    "environment", "release", "version", "tags", "metadata", "input", "output"
  ],
  observations: [
    "project_id", "id", "trace_id", "parent_observation_id", "type", "name",
    "start_time", "end_time", "level", "status_message", "model",
    "model_parameters", "input", "output", "usage_details", "cost_details",
    "completion_start_time", "metadata"
  ],
  scores: [
    "project_id", "id", "trace_id", "observation_id", "name", "data_type",
    "value", "string_value", "source", "import_source", "comment", "metadata", "timestamp"
  ]
};

/**
 * Row-level retention for a single project — heavier than a partition
 * drop (an INSERT-based mutation via the same ReplacingMergeTree
 * re-insert pattern used everywhere else in this codebase — see
 * packages/clickhouse/src/rows.ts's InsertOptions.eventTs contract; it
 * doesn't reclaim disk until ClickHouse's background merge processes the
 * old version) but the only mechanism that can target ONE project's data
 * without touching every other project sharing the same monthly
 * partition.
 *
 * Marks rows `is_deleted = 1` — this is ReplacingMergeTree(event_ts,
 * is_deleted)'s ENGINE-NATIVE tombstone column, not just an app-level
 * soft-delete convention: `FINAL` doesn't merely dedup to the row with
 * the highest event_ts, it also EXCLUDES that row entirely once its
 * latest version has is_deleted != 0 (confirmed directly against a real
 * ClickHouse instance — a naive assumption that FINAL just returns "the
 * row, but with is_deleted=1 visible" is wrong and this module's test
 * suite is written against the real observed behavior, not that
 * assumption). Background merges eventually remove the physical rows
 * entirely, same as the ALTER ... DELETE mutation this replaces.
 */
export async function markProjectDataDeletedOlderThan(
  client: ClickHouseClient,
  table: RetainedTable,
  projectId: string,
  olderThan: Date
): Promise<void> {
  const column = timestampColumn(table);
  const columns = TABLE_COLUMNS[table];
  const retainedParentGuard = table === "traces"
    ? ""
    : `and (project_id, trace_id) not in (
         select project_id, id
           from traces final
          where project_id = {projectId:String}
            and timestamp >= {olderThan:DateTime64(3)}
       )`;
  await client.exec({
    query: `
      insert into ${table} (${columns.join(", ")}, is_deleted, event_ts)
      select ${columns.join(", ")}, 1, now64(6)
      from ${table} final
      where project_id = {projectId:String}
        and ${column} < {olderThan:DateTime64(3)}
        and is_deleted = 0
        ${retainedParentGuard}
    `,
    query_params: { projectId, olderThan: toClickHouseDateTime(olderThan.toISOString()) }
  });
}

/**
 * Whole-trace retention: once a durably marked parent is actually absent,
 * remove every child even if that child carries a newer source timestamp.
 * Policy-expired parents still preserved by partition grace/global floors keep
 * their complete tree.
 */
export async function markChildrenOfExpiredTracesDeleted(
  client: ClickHouseClient,
  projectIdsInput: string[]
): Promise<void> {
  const projectIds = [...new Set(projectIdsInput)];
  if (projectIds.length === 0) return;
  for (const projectChunk of chunksOf(projectIds, LIFECYCLE_PROJECT_BATCH_SIZE)) {
    await Promise.all(
      (["observations", "scores"] as const).map((table) => {
        const columns = TABLE_COLUMNS[table];
        return client.exec({
          query: `
            insert into ${table} (${columns.join(", ")}, is_deleted, event_ts)
            select ${columns.join(", ")}, 1, now64(6)
              from ${table} final
             where project_id in {projectIds:Array(String)}
               and is_deleted = 0
               and (project_id, trace_id) in (
                 select project_id, trace_id
                   from evaluator_trace_retention final
                  where project_id in {projectIds:Array(String)}
               )
               and (project_id, trace_id) not in (
                 select project_id, id
                   from traces final
                  where project_id in {projectIds:Array(String)}
               )
          `,
          query_params: { projectIds: projectChunk },
          clickhouse_settings: LIFECYCLE_QUERY_SETTINGS
        });
      })
    );
  }
}

/** Stage durable parent identities before trace deletion makes them invisible. */
export async function recordExpiredEvaluatorTraceIds(
  client: ClickHouseClient,
  entries: Array<{ projectId: string; traceOlderThan: Date }>
): Promise<void> {
  const unique = [...new Map(entries.map((entry) => [entry.projectId, entry])).values()];
  if (unique.length === 0) return;
  for (const entryChunk of chunksOf(unique, LIFECYCLE_PROJECT_BATCH_SIZE)) {
    const projectIds = entryChunk.map((entry) => entry.projectId);
    const cutoffs = entryChunk.map((entry) =>
      toClickHouseDateTime(entry.traceOlderThan.toISOString())
    );
    await client.exec({
      query: `
        insert into evaluator_trace_retention (project_id, trace_id, expired_at)
        select project_id, id, now64(6)
          from traces final
         where project_id in {projectIds:Array(String)}
           and timestamp < arrayElement(
             {cutoffs:Array(DateTime64(3))},
             indexOf({projectIds:Array(String)}, project_id)
           )
      `,
      query_params: { projectIds, cutoffs },
      clickhouse_settings: LIFECYCLE_QUERY_SETTINGS
    });
  }
}

const LIFECYCLE_PROJECT_BATCH_SIZE = 100;
const LIFECYCLE_QUERY_SETTINGS = {
  max_execution_time: 60,
  max_threads: 4,
  max_memory_usage: String(512 * 1024 * 1024),
  max_rows_to_read: "10000000",
  read_overflow_mode: "throw" as const
};

function chunksOf<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}
