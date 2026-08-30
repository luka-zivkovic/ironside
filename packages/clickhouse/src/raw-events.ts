import type { ClickHouseClient } from "@clickhouse/client";
import { fromClickHouseDateTime, toClickHouseDateTime } from "./datetime.js";

export interface RawEventRefInput {
  projectId: string;
  traceId: string;
  objectKey: string;
  receivedAt: string;
}

export interface TraceRawRetentionInput {
  projectId: string;
  traceId: string;
  expiredAt: string;
}

export interface RawObjectRefSnapshot {
  refs: { traceId: string; applied: number; receivedAt?: string }[];
  truncated: boolean;
}

export interface RetainedRawEventRefInput {
  projectId: string;
  traceId: string;
  objectKey: string;
  receivedAt: string;
}

/**
 * Records the exact raw object containing events for each mapped trace.
 * `applied=false` is the pre-domain-insert marker; `applied=true` replaces it
 * after domain rows succeed. Retention later writes version 2. Reprocessing is
 * safe because `applied` is the ReplacingMergeTree version for
 * (project_id, trace_id, object_key).
 */
export async function insertRawEventRefs(
  client: ClickHouseClient,
  refs: RawEventRefInput[],
  eventTs: string,
  applied = true
): Promise<void> {
  if (refs.length === 0) return;

  const unique = new Map<string, RawEventRefInput>();
  for (const ref of refs) {
    unique.set(`${ref.projectId}\0${ref.traceId}\0${ref.objectKey}`, ref);
  }

  const version = toClickHouseDateTime(eventTs);
  await client.insert({
    table: "raw_event_refs",
    values: [...unique.values()].map((ref) => ({
      project_id: ref.projectId,
      trace_id: ref.traceId,
      object_key: ref.objectKey,
      received_at: toClickHouseDateTime(ref.receivedAt),
      event_ts: version,
      applied: applied ? 1 : 0
    })),
    format: "JSONEachRow"
  });
}

/**
 * Logically expires exact refs without a ClickHouse mutation. `applied = 2`
 * is a monotonic ReplacingMergeTree tombstone: later ingest retries writing
 * 0/1 cannot resurrect it. `receivedAt` must be copied from the authoritative
 * snapshot so the replacement lands in the same monthly partition.
 */
export async function markRawObjectRefsRetentionExpired(
  client: ClickHouseClient,
  refs: RetainedRawEventRefInput[],
  expiredAt: string
): Promise<void> {
  if (refs.length === 0) return;
  const unique = new Map<string, RetainedRawEventRefInput>();
  for (const ref of refs) {
    unique.set(`${ref.projectId}\0${ref.traceId}\0${ref.objectKey}`, ref);
  }
  await client.insert({
    table: "raw_event_refs",
    values: [...unique.values()].map((ref) => ({
      project_id: ref.projectId,
      trace_id: ref.traceId,
      object_key: ref.objectKey,
      received_at: toClickHouseDateTime(ref.receivedAt),
      event_ts: toClickHouseDateTime(expiredAt),
      applied: 2
    })),
    format: "JSONEachRow"
  });
}

/**
 * Fail-closed visibility check for operator-run raw retention. Unlike the
 * ingest hot-path helper above, this scan has explicit resource limits and
 * handles one invocation's aggregate trace-id set in a single query.
 */
export async function getRetentionVisibleTraceIds(
  client: ClickHouseClient,
  projectId: string,
  traceIds: string[]
): Promise<Set<string>> {
  if (traceIds.length === 0) return new Set();
  if (traceIds.length > 10_000) {
    throw new Error("raw retention visibility check is capped at 10000 trace ids");
  }
  const result = await client.query({
    query: `
      select distinct trace_id
      from (
        select id as trace_id
        from traces final
        where project_id = {projectId:String} and id in {traceIds:Array(String)}
        union all
        select trace_id
        from observations final
        where project_id = {projectId:String} and trace_id in {traceIds:Array(String)}
        union all
        select trace_id
        from scores final
        where project_id = {projectId:String} and trace_id in {traceIds:Array(String)}
      )
      limit {limit:UInt32}
    `,
    query_params: { projectId, traceIds, limit: traceIds.length + 1 },
    clickhouse_settings: {
      max_execution_time: 30,
      max_threads: 2,
      max_memory_usage: String(256 * 1024 * 1024),
      max_rows_to_read: "5000000",
      read_overflow_mode: "throw"
    },
    format: "JSONEachRow"
  });
  const rows = await result.json<{ trace_id: string }>();
  if (rows.length > traceIds.length) {
    throw new Error("raw retention visibility result exceeded its input bound");
  }
  return new Set(rows.map((row) => row.trace_id));
}

/**
 * Bounded authoritative ref snapshot for one exact raw object. This is used
 * only by the operator-run retention intent preparer; exceeding the cap is a
 * veto, never permission to infer that the omitted references are absent.
 */
export async function getRawObjectRefSnapshot(
  client: ClickHouseClient,
  projectId: string,
  objectKey: string,
  limit: number
): Promise<RawObjectRefSnapshot> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("raw object ref limit must be a positive integer");
  }
  const result = await client.query({
    query: `
      select trace_id, applied, received_at
      from raw_event_refs final
      where project_id = {projectId:String}
        and object_key = {objectKey:String}
      order by trace_id asc
      limit {limit:UInt32}
    `,
    query_params: { projectId, objectKey, limit: limit + 1 },
    clickhouse_settings: {
      max_execution_time: 30,
      max_threads: 2,
      max_memory_usage: String(256 * 1024 * 1024),
      max_rows_to_read: "5000000",
      read_overflow_mode: "throw"
    },
    format: "JSONEachRow"
  });
  const rows = await result.json<{
    trace_id: string;
    applied: number | string;
    received_at: string;
  }>();
  return {
    refs: rows.slice(0, limit).map((row) => ({
      traceId: row.trace_id,
      applied: Number(row.applied),
      receivedAt: fromClickHouseDateTime(row.received_at)
    })),
    truncated: rows.length > limit
  };
}

/**
 * Permanently records that at least one raw object for each trace was
 * deliberately expired. This evidence is append-only: a later ingest that
 * reuses the trace id must not make the older raw-history gap disappear.
 */
export async function recordTraceRawRetentionExpired(
  client: ClickHouseClient,
  entries: TraceRawRetentionInput[]
): Promise<void> {
  if (entries.length === 0) return;
  const unique = new Map<string, TraceRawRetentionInput>();
  for (const entry of entries) {
    unique.set(`${entry.projectId}\0${entry.traceId}`, entry);
  }
  await client.insert({
    table: "raw_event_trace_retention",
    values: [...unique.values()].map((entry) => ({
      project_id: entry.projectId,
      trace_id: entry.traceId,
      expired_at: toClickHouseDateTime(entry.expiredAt)
    })),
    format: "JSONEachRow"
  });
}

export async function getTraceRawRetentionExpiredMap(
  client: ClickHouseClient,
  projectId: string,
  traceIds: string[]
): Promise<Map<string, boolean>> {
  if (traceIds.length === 0) return new Map();
  const result = await client.query({
    query: `
      select trace_id
      from raw_event_trace_retention
      where project_id = {projectId:String} and trace_id in {traceIds:Array(String)}
      group by trace_id
    `,
    query_params: { projectId, traceIds },
    format: "JSONEachRow"
  });
  const rows = await result.json<{ trace_id: string }>();
  return new Map(rows.map((row) => [row.trace_id, true]));
}

/** Resource-bounded marker verification for the destructive retention path. */
export async function getRetentionExpiredTraceIds(
  client: ClickHouseClient,
  projectId: string,
  traceIds: string[]
): Promise<Set<string>> {
  if (traceIds.length === 0) return new Set();
  if (traceIds.length > 10_000) {
    throw new Error("raw retention marker verification is capped at 10000 trace ids");
  }
  const result = await client.query({
    query: `
      select trace_id
      from raw_event_trace_retention
      where project_id = {projectId:String} and trace_id in {traceIds:Array(String)}
      group by trace_id
      limit {limit:UInt32}
    `,
    query_params: { projectId, traceIds, limit: traceIds.length + 1 },
    clickhouse_settings: {
      max_execution_time: 30,
      max_threads: 2,
      max_memory_usage: String(256 * 1024 * 1024),
      max_rows_to_read: "5000000",
      read_overflow_mode: "throw"
    },
    format: "JSONEachRow"
  });
  const rows = await result.json<{ trace_id: string }>();
  if (rows.length > traceIds.length) {
    throw new Error("raw retention marker verification exceeded its input bound");
  }
  return new Set(rows.map((row) => row.trace_id));
}

export interface TraceRawIndex {
  objectKeys: string[];
  /** At least one mapped raw batch has not finished inserting domain rows. */
  hasPendingRefs: boolean;
  /** At least one previously indexed raw object was deliberately expired. */
  retentionExpired: boolean;
}

/** Fast exact guard for evaluator snapshot reads during ingest materialization. */
export async function hasPendingTraceRawRefs(
  client: ClickHouseClient,
  projectId: string,
  traceId: string
): Promise<boolean> {
  return (await listPendingTraceRawRefIds(client, projectId, [traceId])).has(traceId);
}

/** True when one exact raw object still has any snapshot-affecting pending ref. */
export async function hasPendingRawObjectRefs(
  client: ClickHouseClient,
  projectId: string,
  objectKey: string
): Promise<boolean> {
  const result = await client.query({
    query: `
      select 1 as pending
      from raw_event_refs
      where project_id = {projectId:String}
        and object_key = {objectKey:String}
      group by trace_id, object_key
      having max(applied) = 0
      limit 1
    `,
    query_params: { projectId, objectKey },
    clickhouse_settings: {
      max_execution_time: 30,
      max_threads: 2,
      max_memory_usage: String(256 * 1024 * 1024),
      max_rows_to_read: "5000000",
      read_overflow_mode: "throw"
    },
    format: "JSONEachRow"
  });
  return (await result.json<{ pending: number }>()).length > 0;
}

/** Bounded batch guard used by evaluator feed pages during materialization. */
export async function listPendingTraceRawRefIds(
  client: ClickHouseClient,
  projectId: string,
  traceIds: string[]
): Promise<Set<string>> {
  const uniqueTraceIds = [...new Set(traceIds)].filter(Boolean);
  if (uniqueTraceIds.length === 0) return new Set();
  const result = await client.query({
    query: `
      select distinct trace_id
      from (
        select trace_id, object_key
        from raw_event_refs
        where project_id = {projectId:String}
          and trace_id in {traceIds:Array(String)}
        group by trace_id, object_key
        having max(applied) = 0
      )
    `,
    query_params: { projectId, traceIds: uniqueTraceIds },
    format: "JSONEachRow"
  });
  const rows = await result.json<{ trace_id: string }>();
  return new Set(rows.map((row) => row.trace_id));
}

/**
 * Exact raw object keys known for a trace. `limit + 1` keys are returned so
 * the caller can distinguish exactly-at-limit from truncated-by-limit.
 */
export async function getTraceRawIndex(
  client: ClickHouseClient,
  projectId: string,
  traceId: string,
  limit: number
): Promise<TraceRawIndex> {
  const [retention, refsResult, pendingResult] = await Promise.all([
    getTraceRawRetentionExpiredMap(client, projectId, [traceId]),
    client.query({
      query: `
        select object_key, min(received_at) as received_at
        from raw_event_refs
        where project_id = {projectId:String}
          and trace_id = {traceId:String}
        group by object_key
        having max(applied) = 1
        order by received_at asc, object_key asc
        limit {limit:UInt32}
      `,
      query_params: { projectId, traceId, limit: limit + 1 },
      format: "JSONEachRow"
    }),
    client.query({
      query: `
        select count() as pending_count
        from (
          select object_key
          from raw_event_refs
          where project_id = {projectId:String}
            and trace_id = {traceId:String}
          group by object_key
          having max(applied) = 0
        )
      `,
      query_params: { projectId, traceId },
      format: "JSONEachRow"
    })
  ]);
  const refs = await refsResult.json<{ object_key: string }>();
  const [pending] = await pendingResult.json<{ pending_count: number | string }>();
  const hasPendingRefs = Number(pending?.pending_count ?? 0) > 0;
  const retentionExpired = retention.get(traceId) === true;
  return {
    objectKeys: refs.map((row) => row.object_key),
    hasPendingRefs,
    retentionExpired
  };
}
