import type { ClickHouseClient } from "@clickhouse/client";
import { fromClickHouseDateTime, toClickHouseDateTime } from "./datetime.js";
import { chunkByParamBytes } from "./params.js";

export interface TraceFilter {
  projectId: string;
  from?: string;
  to?: string;
  userId?: string;
  sessionId?: string;
  environment?: string;
  tags?: string[];
  metadataKey?: string;
  metadataValue?: string;
  /**
   * Case-insensitive substring of the trace's name, input or output, or of
   * any of its observations' names, inputs or outputs; or an exact trace id.
   * Inputs and outputs are matched as their stored JSON text.
   */
  search?: string;
  /** Traces with at least one observation at this level. */
  level?: string;
  /** Traces with at least one observation of this model. */
  model?: string;
  /** Traces whose duration (see TRACE_DURATION_MS) is at least this long. */
  minDurationMs?: number;
  /** Traces whose total cost (see OBSERVATION_COST) is at least this, in USD. */
  minCost?: number;
  /**
   * Only include traces whose latest ingest activity is at or before this
   * instant. Activity includes trace and observation writes. Scores are
   * downstream annotations and deliberately do not reopen a trace. This is
   * the source-agnostic quiet-period watermark from trace-envelope-v1.
   */
  settledBefore?: string;
}

/**
 * One activity clock for every ingest source. `event_ts` is the API/import
 * receipt time already used as the deterministic ReplacingMergeTree version,
 * so retries do not move the watermark while genuinely later writes do.
 * FINAL is essential: retention's engine-native tombstones carry a fresh
 * event_ts but represent deletion, not activity, and must disappear here.
 */
function traceActivityQuery(traceIdParam?: string, traceIdsParam?: string): string {
  const traceCondition = traceIdParam
    ? `and id = {${traceIdParam}:String}`
    : traceIdsParam
      ? `and id in {${traceIdsParam}:Array(String)}`
      : "";
  const observationCondition = traceIdParam
    ? `and trace_id = {${traceIdParam}:String}`
    : traceIdsParam
      ? `and trace_id in {${traceIdsParam}:Array(String)}`
      : "";
  return `
    select trace_id, max(activity_at) as last_activity_at
    from (
      select id as trace_id, event_ts as activity_at
      from traces final
      where project_id = {projectId:String} ${traceCondition}
      union all
      select trace_id, event_ts as activity_at
      from observations final
      where project_id = {projectId:String} ${observationCondition}
    )
    group by trace_id
  `;
}

/**
 * One observation's cost in USD: its `total` component when it reports one
 * (derived and LangFuse costs always do), otherwise the sum of its components.
 * Kept Decimal so sums are exact: in Float64, 0.7 + 0.1 falls just short of a
 * 0.8 floor.
 */
const OBSERVATION_COST = `if(mapContains(cost_details, 'total'),
  cost_details['total'],
  arraySum(mapValues(cost_details)))`;

/**
 * One observation's token count in the canonical usage vocabulary
 * (spec/usage-keys-v1.md): `total_tokens` when reported, otherwise input plus
 * output. Other keys, such as cache reads, can overlap those two and are left
 * out rather than double counted.
 */
const OBSERVATION_TOKENS = `if(mapContains(usage_details, 'total_tokens'),
  usage_details['total_tokens'],
  usage_details['input_tokens'] + usage_details['output_tokens'])`;
const OBSERVATION_HAS_TOKENS = `(mapContains(usage_details, 'total_tokens')
  or mapContains(usage_details, 'input_tokens')
  or mapContains(usage_details, 'output_tokens'))`;

/**
 * A trace's duration in milliseconds, aggregated over its observations: first
 * start to last end. Null when no observation has ended, the same rule as
 * getAggregates' latency percentiles.
 */
const TRACE_DURATION_MS = "dateDiff('millisecond', min(start_time), max(end_time))";

/** Trace ids with an observation matching `condition` in the filtered project. */
function tracesWithObservations(condition: string): string {
  return `id in (
    select trace_id from observations final
    where project_id = {projectId:String} and ${condition}
  )`;
}

/** Trace ids whose observations, grouped per trace, satisfy `having`. */
function tracesWhereObservations(having: string): string {
  return `id in (
    select trace_id from observations final
    where project_id = {projectId:String}
    group by trace_id
    having ${having}
  )`;
}

/** Shared by listTraces and getAggregates — same filter surface, different projection. */
function buildTraceConditions(filter: TraceFilter): {
  conditions: string[];
  params: Record<string, unknown>;
} {
  const conditions: string[] = ["project_id = {projectId:String}"];
  const params: Record<string, unknown> = { projectId: filter.projectId };

  if (filter.from) {
    conditions.push("timestamp >= {from:DateTime64(3)}");
    params.from = toClickHouseDateTime(filter.from);
  }
  if (filter.to) {
    conditions.push("timestamp <= {to:DateTime64(3)}");
    params.to = toClickHouseDateTime(filter.to);
  }
  if (filter.userId) {
    conditions.push("user_id = {userId:String}");
    params.userId = filter.userId;
  }
  if (filter.sessionId) {
    conditions.push("session_id = {sessionId:String}");
    params.sessionId = filter.sessionId;
  }
  if (filter.environment) {
    conditions.push("environment = {environment:String}");
    params.environment = filter.environment;
  }
  if (filter.tags && filter.tags.length > 0) {
    conditions.push("hasAll(tags, {tags:Array(String)})");
    params.tags = filter.tags;
  }
  if (filter.metadataKey && filter.metadataValue) {
    conditions.push("metadata[{metadataKey:String}] = {metadataValue:String}");
    params.metadataKey = filter.metadataKey;
    params.metadataValue = filter.metadataValue;
  }
  // The observation filters below scan the project's observations, which are
  // partitioned by their own start time rather than the trace's timestamp.
  if (filter.search) {
    const matches = (column: string) => `positionCaseInsensitiveUTF8(${column}, {search:String}) > 0`;
    conditions.push(`(
      id = {search:String}
      or ${matches("name")} or ${matches("input")} or ${matches("output")}
      or ${tracesWithObservations(`(${matches("name")} or ${matches("input")} or ${matches("output")})`)}
    )`);
    params.search = filter.search;
  }
  if (filter.level) {
    conditions.push(tracesWithObservations("level = {level:String}"));
    params.level = filter.level;
  }
  if (filter.model) {
    conditions.push(tracesWithObservations("model = {model:String}"));
    params.model = filter.model;
  }
  if (filter.minDurationMs !== undefined) {
    conditions.push(tracesWhereObservations(`${TRACE_DURATION_MS} >= {minDurationMs:Int64}`));
    params.minDurationMs = filter.minDurationMs;
  }
  if (filter.minCost !== undefined) {
    conditions.push(
      tracesWhereObservations(`sum(${OBSERVATION_COST}) >= toDecimal128({minCost:String}, 9)`)
    );
    // As decimal text: converting a Float64 truncates, so 1.001 would become 1.000999999.
    params.minCost = filter.minCost.toFixed(9);
  }

  if (filter.settledBefore) {
    conditions.push(`id in (
      select trace_id
      from (${traceActivityQuery()})
      where last_activity_at <= {settledBefore:DateTime64(6)}
    )`);
    params.settledBefore = toClickHouseDateTime(filter.settledBefore);
  }

  return { conditions, params };
}

export interface ListTracesFilter extends TraceFilter {
  limit: number;
  /** Decoded keyset cursor: the (timestamp, id) of the last row of the previous page. */
  cursor?: { timestamp: string; id: string };
}

export interface TraceRow {
  id: string;
  timestamp: string;
  name: string | null;
  user_id: string | null;
  session_id: string | null;
  environment: string | null;
  tags: string[];
  metadata: Record<string, string>;
}

export interface SettledTraceVersionRow extends TraceRow {
  trace_version: string;
}

export interface SettledTraceVersionCursor {
  traceVersion: string;
  traceId: string;
}

/**
 * Stable bootstrap scan for evaluator consumers. Unlike the operator trace
 * list, ordering and pagination use the server-owned latest activity clock,
 * which is also the immutable identity of the settled snapshot.
 */
export async function listSettledTraceVersions(
  client: ClickHouseClient,
  input: {
    projectId: string;
    settledBefore: string;
    limit: number;
    cursor?: SettledTraceVersionCursor | undefined;
  }
): Promise<SettledTraceVersionRow[]> {
  const cursorCondition = input.cursor
    ? `and (activity.last_activity_at, t.id) >
         ({cursorVersion:DateTime64(6)}, {cursorTraceId:String})`
    : "";
  const result = await client.query({
    query: `
      select t.id, t.timestamp, t.name, t.user_id, t.session_id,
             t.environment, t.tags, t.metadata,
             activity.last_activity_at as trace_version
      from traces as t final
      inner join (${traceActivityQuery()}) as activity on activity.trace_id = t.id
      where t.project_id = {projectId:String}
        and activity.last_activity_at <= {settledBefore:DateTime64(6)}
        ${cursorCondition}
      order by activity.last_activity_at asc, t.id asc
      limit {limit:UInt32}
    `,
    query_params: {
      projectId: input.projectId,
      settledBefore: toClickHouseDateTime(input.settledBefore),
      limit: input.limit,
      ...(input.cursor && {
        cursorVersion: toClickHouseDateTime(input.cursor.traceVersion),
        cursorTraceId: input.cursor.traceId
      })
    },
    format: "JSONEachRow"
  });
  const rows = await result.json<SettledTraceVersionRow>();
  return rows.map((row) => ({
    ...row,
    timestamp: fromClickHouseDateTime(row.timestamp),
    // Ingest receipt clocks originate as JavaScript ISO timestamps and the
    // write boundary stores millisecond precision. ClickHouse renders the
    // DateTime64(6) column with three additional zeroes; collapse those so
    // the durable Postgres feed and ClickHouse snapshot use one exact token.
    trace_version: new Date(fromClickHouseDateTime(row.trace_version)).toISOString()
  }));
}

/**
 * Lists traces newest-first with keyset (timestamp, id) pagination — stable
 * under concurrent inserts, unlike OFFSET-based paging. Uses FINAL: at
 * current (pre-production) query volume, correctness (no duplicate rows
 * from unmerged ReplacingMergeTree parts) matters more than the cost of a
 * merge-on-read; revisit if this becomes a hot path at scale (M6+).
 */
export async function listTraces(
  client: ClickHouseClient,
  filter: ListTracesFilter
): Promise<TraceRow[]> {
  const { conditions, params } = buildTraceConditions(filter);

  if (filter.cursor) {
    // Keyset pagination on (timestamp DESC, id DESC): strictly-less-than the
    // last row of the previous page.
    conditions.push(
      "(timestamp, id) < ({cursorTimestamp:DateTime64(3)}, {cursorId:String})"
    );
    params.cursorTimestamp = toClickHouseDateTime(filter.cursor.timestamp);
    params.cursorId = filter.cursor.id;
  }

  const result = await client.query({
    query: `
      select id, timestamp, name, user_id, session_id, environment, tags, metadata
      from traces final
      where ${conditions.join(" and ")}
      order by timestamp desc, id desc
      limit {limit:UInt32}
    `,
    query_params: { ...params, limit: filter.limit },
    format: "JSONEachRow"
  });

  const rows = await result.json<TraceRow>();
  // Normalize CH's "YYYY-MM-DD HH:MM:SS.mmm" to real ISO-8601 at the read
  // boundary — see fromClickHouseDateTime's docstring for why this matters
  // beyond just API response shape (cursor correctness depends on it too).
  return rows.map((row) => ({ ...row, timestamp: fromClickHouseDateTime(row.timestamp) }));
}

/**
 * ClickHouse ignores skip indexes under FINAL by default. Enabling them is
 * safe for these lookups because they filter only on id and trace_id, which
 * every version of a row shares, so no newer version can be skipped while an
 * older one is kept.
 */
const SKIP_INDEXES_WITH_FINAL = { use_skip_indexes_if_final: 1 } as const;

export interface TraceMetricsRow {
  trace_id: string;
  /** Null when no observation has ended. */
  duration_ms: number | null;
  /** Null when no observation reports a cost. */
  total_cost: number | null;
  /** Null when no observation reports input, output or total tokens. */
  total_tokens: number | null;
  error_count: number;
  models: string[];
}

/**
 * Per-trace figures for one page of the trace list, computed from each
 * trace's observations with the same rules the list filters use. A trace
 * with no observations has no row.
 */
export async function listTraceMetrics(
  client: ClickHouseClient,
  projectId: string,
  traceIds: string[]
): Promise<Map<string, TraceMetricsRow>> {
  if (traceIds.length === 0) return new Map();
  const result = await client.query({
    // 64-bit integers serialize as JSON strings; the display figures are cast
    // to Float64 so they arrive as numbers, like getAggregates' sums.
    query: `
      select
        trace_id,
        toFloat64(${TRACE_DURATION_MS}) as duration_ms,
        if(countIf(notEmpty(cost_details)) = 0, null, toFloat64(sum(${OBSERVATION_COST}))) as total_cost,
        if(countIf(${OBSERVATION_HAS_TOKENS}) = 0, null, toFloat64(sum(${OBSERVATION_TOKENS}))) as total_tokens,
        toUInt32(countIf(level = 'error')) as error_count,
        arraySort(groupUniqArrayIf(assumeNotNull(model), model is not null)) as models
      from observations final
      where project_id = {projectId:String} and trace_id in {traceIds:Array(String)}
      group by trace_id
    `,
    query_params: { projectId, traceIds: [...new Set(traceIds)] },
    clickhouse_settings: SKIP_INDEXES_WITH_FINAL,
    format: "JSONEachRow"
  });
  const rows = await result.json<TraceMetricsRow>();
  return new Map(rows.map((row) => [row.trace_id, row]));
}

export interface TraceDetailRow {
  id: string;
  timestamp: string;
  name: string | null;
  user_id: string | null;
  session_id: string | null;
  environment: string | null;
  release: string | null;
  version: string | null;
  tags: string[];
  metadata: Record<string, string>;
  input: string | null;
  output: string | null;
}

export interface VersionedTraceDetailRow extends TraceDetailRow {
  trace_version: string;
}

export interface VersionedTraceSummaryRow extends TraceRow {
  trace_version: string;
}

/** Current trace payload plus its server-owned latest activity version. */
export async function getVersionedTrace(
  client: ClickHouseClient,
  projectId: string,
  traceId: string
): Promise<VersionedTraceDetailRow | null> {
  return (await getVersionedTraces(client, projectId, [traceId])).get(traceId) ?? null;
}

/** Summary-only batch form for evaluator feed pages; omits large payloads. */
export async function getVersionedTraceSummaries(
  client: ClickHouseClient,
  projectId: string,
  traceIds: string[]
): Promise<Map<string, VersionedTraceSummaryRow>> {
  const uniqueTraceIds = [...new Set(traceIds)].filter(Boolean);
  if (uniqueTraceIds.length === 0) return new Map();
  const result = await client.query({
    query: `
      select t.id, t.timestamp, t.name, t.user_id, t.session_id,
             t.environment, t.tags, t.metadata,
             activity.last_activity_at as trace_version
      from traces as t final
      inner join (${traceActivityQuery(undefined, "traceIds")}) as activity on activity.trace_id = t.id
      where t.project_id = {projectId:String} and t.id in {traceIds:Array(String)}
    `,
    query_params: { projectId, traceIds: uniqueTraceIds },
    format: "JSONEachRow"
  });
  const rows = await result.json<VersionedTraceSummaryRow>();
  return new Map(rows.map((row) => [row.id, {
    ...row,
    timestamp: fromClickHouseDateTime(row.timestamp),
    trace_version: new Date(fromClickHouseDateTime(row.trace_version)).toISOString()
  }]));
}

/** Bounded batch form used by evaluator feed pages to avoid one CH query per trace. */
export async function getVersionedTraces(
  client: ClickHouseClient,
  projectId: string,
  traceIds: string[]
): Promise<Map<string, VersionedTraceDetailRow>> {
  const uniqueTraceIds = [...new Set(traceIds)].filter(Boolean);
  if (uniqueTraceIds.length === 0) return new Map();
  const result = await client.query({
    query: `
      select t.id, t.timestamp, t.name, t.user_id, t.session_id, t.environment,
             t.release, t.version, t.tags, t.metadata, t.input, t.output,
             activity.last_activity_at as trace_version
      from traces as t final
      inner join (${traceActivityQuery(undefined, "traceIds")}) as activity on activity.trace_id = t.id
      where t.project_id = {projectId:String} and t.id in {traceIds:Array(String)}
    `,
    query_params: { projectId, traceIds: uniqueTraceIds },
    format: "JSONEachRow"
  });
  const rows = await result.json<VersionedTraceDetailRow>();
  return new Map(rows.map((row) => [row.id, {
    ...row,
    timestamp: fromClickHouseDateTime(row.timestamp),
    trace_version: new Date(fromClickHouseDateTime(row.trace_version)).toISOString()
  }]));
}

/** Current trace identities only, used for bounded Postgres feed pruning. */
export async function listExistingTraceIds(
  client: ClickHouseClient,
  projectId: string,
  traceIds: string[]
): Promise<Set<string>> {
  const uniqueTraceIds = [...new Set(traceIds)].filter(Boolean);
  if (uniqueTraceIds.length === 0) return new Set();
  const result = await client.query({
    query: `
      select id
      from traces final
      where project_id = {projectId:String} and id in {traceIds:Array(String)}
    `,
    query_params: { projectId, traceIds: uniqueTraceIds },
    format: "JSONEachRow"
  });
  const rows = await result.json<{ id: string }>();
  return new Set(rows.map((row) => row.id));
}

export interface ObservationRow {
  id: string;
  trace_id: string;
  parent_observation_id: string | null;
  type: string;
  name: string | null;
  start_time: string;
  end_time: string | null;
  level: string;
  status_message: string | null;
  model: string | null;
  model_parameters: Record<string, string>;
  input: string | null;
  output: string | null;
  usage_details: Record<string, number>;
  cost_details: Record<string, number>;
  completion_start_time: string | null;
  metadata: Record<string, string>;
}

/** Fetches one trace by id, project-scoped. Returns null if not found. */
export async function getTrace(
  client: ClickHouseClient,
  projectId: string,
  traceId: string,
  settledBefore?: string
): Promise<TraceDetailRow | null> {
  const settledCondition = settledBefore
    ? `and id in (
        select trace_id
        from (${traceActivityQuery("traceId")})
        where last_activity_at <= {settledBefore:DateTime64(6)}
      )`
    : "";
  const result = await client.query({
    query: `
      select id, timestamp, name, user_id, session_id, environment, release, version,
             tags, metadata, input, output
      from traces final
      where project_id = {projectId:String} and id = {traceId:String}
        ${settledCondition}
      limit 1
    `,
    query_params: {
      projectId,
      traceId,
      ...(settledBefore && { settledBefore: toClickHouseDateTime(settledBefore) })
    },
    format: "JSONEachRow"
  });
  const rows = await result.json<TraceDetailRow>();
  const row = rows[0];
  if (!row) return null;
  return { ...row, timestamp: fromClickHouseDateTime(row.timestamp) };
}

export interface TraceRawAnchorRow {
  id: string;
  tags: string[];
  /** ISO-8601. The ReplacingMergeTree version column — set from the ingest batch's server-side receivedAt, which also dates the raw object key. */
  event_ts: string;
}

/**
 * Fetches the minimal facts the raw-event-log lookup needs: the trace's
 * tags (importer detection) and its event_ts. event_ts — not the
 * client-supplied `timestamp` — anchors the raw/{project}/{yyyy}/{mm}/{dd}/
 * prefix scan, because both event_ts and the object key are derived from
 * the same server-side batch receivedAt; a client clock that is hours or
 * days off would otherwise point the scan at empty prefixes.
 */
export async function getTraceRawAnchor(
  client: ClickHouseClient,
  projectId: string,
  traceId: string
): Promise<TraceRawAnchorRow | null> {
  const result = await client.query({
    query: `
      select id, tags, event_ts
      from traces final
      where project_id = {projectId:String} and id = {traceId:String}
      limit 1
    `,
    query_params: { projectId, traceId },
    format: "JSONEachRow"
  });
  const rows = await result.json<TraceRawAnchorRow>();
  const row = rows[0];
  if (!row) return null;
  return { ...row, event_ts: fromClickHouseDateTime(row.event_ts) };
}

export interface ListTracePageFilter extends TraceFilter {
  limit: number;
  /** 1-based page number — LangFuse-compat offset pagination, unlike listTraces' keyset cursor. */
  page: number;
  /** Sort direction on (timestamp, id); LangFuse's list API defaults to newest-first. */
  order: "asc" | "desc";
}

/**
 * Page/offset-paginated trace list with full payloads (input/output) and a
 * total count — the shape LangFuse's GET /api/public/traces contract needs
 * (`meta.totalItems`/`totalPages`), which keyset-cursor listTraces can't
 * provide. OFFSET pagination is unstable under concurrent inserts (a page
 * boundary can shift between requests) — an accepted LangFuse-compat
 * tradeoff, inherent to their page-number contract, not a bug to fix here;
 * Ironside's native API keeps keyset cursors for exactly this reason.
 */
export async function listTracePage(
  client: ClickHouseClient,
  filter: ListTracePageFilter
): Promise<{ rows: TraceDetailRow[]; totalItems: number }> {
  const { conditions, params } = buildTraceConditions(filter);
  const direction = filter.order === "asc" ? "asc" : "desc";
  const offset = (filter.page - 1) * filter.limit;

  const [pageResult, countResult] = await Promise.all([
    client.query({
      query: `
        select id, timestamp, name, user_id, session_id, environment, release, version,
               tags, metadata, input, output
        from traces final
        where ${conditions.join(" and ")}
        order by timestamp ${direction}, id ${direction}
        limit {limit:UInt32} offset {offset:UInt64}
      `,
      query_params: { ...params, limit: filter.limit, offset },
      format: "JSONEachRow"
    }),
    client.query({
      // Same UInt64-serializes-as-string caveat as getAggregates' count.
      query: `select toUInt32(count()) as total from traces final where ${conditions.join(" and ")}`,
      query_params: params,
      format: "JSONEachRow"
    })
  ]);

  const rows = await pageResult.json<TraceDetailRow>();
  const [countRow] = await countResult.json<{ total: number }>();
  return {
    rows: rows.map((row) => ({ ...row, timestamp: fromClickHouseDateTime(row.timestamp) })),
    totalItems: countRow?.total ?? 0
  };
}

export interface ScoreRow {
  id: string;
  trace_id: string;
  observation_id: string | null;
  name: string;
  data_type: string;
  value: number | null;
  string_value: string | null;
  source: string;
  comment: string | null;
  timestamp: string;
  metadata: Record<string, string>;
}

/** Fetches all scores for a trace, project-scoped, oldest-first. */
export async function listScoresForTrace(
  client: ClickHouseClient,
  projectId: string,
  traceId: string
): Promise<ScoreRow[]> {
  const result = await client.query({
    // value is Nullable(Float64) and round-trips as a plain JSON number;
    // no map-cast needed here, unlike usage/cost Maps elsewhere.
    query: `
      select id, trace_id, observation_id, name, data_type, value, string_value,
             source, comment, timestamp, metadata
      from scores final
      where project_id = {projectId:String} and trace_id = {traceId:String}
      order by timestamp asc, id asc
    `,
    query_params: { projectId, traceId },
    format: "JSONEachRow"
  });
  const rows = await result.json<ScoreRow>();
  return rows.map((row) => ({ ...row, timestamp: fromClickHouseDateTime(row.timestamp) }));
}

/** Fetches all observations for a trace, project-scoped, oldest-first. */
export async function listObservationsForTrace(
  client: ClickHouseClient,
  projectId: string,
  traceId: string
): Promise<ObservationRow[]> {
  const result = await client.query({
    // usage_details/cost_details are Map(String, UInt64)/Map(String,
    // Decimal64(9)); ClickHouse serializes those value types as JSON
    // strings over JSONEachRow (precision preservation beyond JS's safe
    // integer range) — cast to Map(String, Float64) so they round-trip as
    // plain numbers, matching ObservationRow's declared types. Same fix as
    // getAggregates' sumMap casts, applied at the per-row read here.
    query: `
      select id, trace_id, parent_observation_id, type, name, start_time, end_time,
             level, status_message, model, model_parameters, input, output,
             mapApply((k, v) -> (k, toFloat64(v)), usage_details) as usage_details,
             mapApply((k, v) -> (k, toFloat64(v)), cost_details) as cost_details,
             completion_start_time, metadata
      from observations final
      where project_id = {projectId:String} and trace_id = {traceId:String}
      order by start_time asc
    `,
    query_params: { projectId, traceId },
    format: "JSONEachRow"
  });
  const rows = await result.json<ObservationRow>();
  return rows.map((row) => ({
    ...row,
    start_time: fromClickHouseDateTime(row.start_time),
    end_time: row.end_time ? fromClickHouseDateTime(row.end_time) : null,
    completion_start_time: row.completion_start_time
      ? fromClickHouseDateTime(row.completion_start_time)
      : null
  }));
}

/** A stored row with its exact ReplacingMergeTree version, as ClickHouse renders DateTime64(6). */
export type StoredTraceRow = TraceDetailRow & { event_ts: string };
export type StoredObservationRow = ObservationRow & { event_ts: string };

/**
 * Stored traces for these ids, project-scoped: one row per id, the most
 * recently written. A partial update is merged into this row before it is
 * written (spec/langfuse-compat-v1.md); a trace whose timestamp moved to
 * another day can still have an older row under its previous sort key.
 */
export async function listTracesByIds(
  client: ClickHouseClient,
  projectId: string,
  traceIds: string[]
): Promise<StoredTraceRow[]> {
  const rows: StoredTraceRow[] = [];
  for (const chunk of chunkByParamBytes([...new Set(traceIds)], [(traceId) => traceId])) {
    rows.push(...(await listTracesByIdChunk(client, projectId, chunk)));
  }
  return rows;
}

async function listTracesByIdChunk(
  client: ClickHouseClient,
  projectId: string,
  traceIds: string[]
): Promise<StoredTraceRow[]> {
  const result = await client.query({
    query: `
      select id, timestamp, name, user_id, session_id, environment, release, version,
             tags, metadata, input, output, toString(event_ts) as event_ts
      from traces final
      where project_id = {projectId:String} and id in {traceIds:Array(String)}
      order by id, event_ts desc
      limit 1 by id
    `,
    query_params: { projectId, traceIds },
    clickhouse_settings: SKIP_INDEXES_WITH_FINAL,
    format: "JSONEachRow"
  });
  const rows = await result.json<StoredTraceRow>();
  return rows.map((row) => ({ ...row, timestamp: fromClickHouseDateTime(row.timestamp) }));
}

/**
 * Stored observations for these ids, project-scoped: one row per id, the
 * most recently written. Filtering on trace_id as well lets its bloom-filter
 * index skip granules. Same purpose as listTracesByIds.
 */
export async function listObservationsByIds(
  client: ClickHouseClient,
  projectId: string,
  observations: { id: string; traceId: string }[]
): Promise<StoredObservationRow[]> {
  const rows: StoredObservationRow[] = [];
  const chunks = chunkByParamBytes(observations, [(row) => row.traceId, (row) => row.id]);
  for (const chunk of chunks) rows.push(...(await listObservationsByIdChunk(client, projectId, chunk)));
  return rows;
}

async function listObservationsByIdChunk(
  client: ClickHouseClient,
  projectId: string,
  observations: { id: string; traceId: string }[]
): Promise<StoredObservationRow[]> {
  const result = await client.query({
    // Same Map value casts as listObservationsForTrace.
    query: `
      select id, trace_id, parent_observation_id, type, name, start_time, end_time,
             level, status_message, model, model_parameters, input, output,
             mapApply((k, v) -> (k, toFloat64(v)), usage_details) as usage_details,
             mapApply((k, v) -> (k, toFloat64(v)), cost_details) as cost_details,
             completion_start_time, metadata, toString(event_ts) as event_ts
      from observations final
      where project_id = {projectId:String}
        and trace_id in {traceIds:Array(String)}
        and id in {observationIds:Array(String)}
      order by id, event_ts desc
      limit 1 by id
    `,
    query_params: {
      projectId,
      traceIds: [...new Set(observations.map((observation) => observation.traceId))],
      observationIds: [...new Set(observations.map((observation) => observation.id))]
    },
    clickhouse_settings: SKIP_INDEXES_WITH_FINAL,
    format: "JSONEachRow"
  });
  const rows = await result.json<StoredObservationRow>();
  return rows.map((row) => ({
    ...row,
    start_time: fromClickHouseDateTime(row.start_time),
    end_time: row.end_time ? fromClickHouseDateTime(row.end_time) : null,
    completion_start_time: row.completion_start_time
      ? fromClickHouseDateTime(row.completion_start_time)
      : null
  }));
}

/** Where a stored record sits in its table's sort key, and the version it was written with. */
export interface StoredRowKey {
  kind: "trace" | "observation" | "score";
  id: string;
  /** Empty for a trace. */
  trace_id: string;
  /** The timestamp (trace, score) or start time (observation) whose day is in the sort key, as ISO. */
  sort_time: string;
  /** Exact ReplacingMergeTree version, as ClickHouse renders DateTime64(6). */
  event_ts: string;
}

/**
 * Every live row stored for these records, whichever day of the sort key it
 * sits under: traces by id, observations and scores by (trace id, id). A
 * record written again with a timestamp on another day lands under a new
 * sort key, so its old row is only found this way. One query for the three
 * tables; the skip indexes on id and trace_id are safe under FINAL here, for
 * the reason SKIP_INDEXES_WITH_FINAL gives.
 */
export async function listStoredRowKeys(
  client: ClickHouseClient,
  projectId: string,
  records: {
    traceIds: string[];
    observations: { traceId: string; id: string }[];
    scores: { traceId: string; id: string }[];
  }
): Promise<StoredRowKey[]> {
  type Entry = { kind: StoredRowKey["kind"]; traceId: string; id: string };
  const entries: Entry[] = [
    ...records.traceIds.map((id) => ({ kind: "trace" as const, traceId: "", id })),
    ...records.observations.map((row) => ({ kind: "observation" as const, ...row })),
    ...records.scores.map((row) => ({ kind: "score" as const, ...row }))
  ];
  const of = (kind: Entry["kind"], field: "traceId" | "id") => (entry: Entry) =>
    entry.kind === kind ? entry[field] : "";
  const chunks = chunkByParamBytes(entries, [
    of("trace", "id"),
    of("observation", "traceId"),
    of("observation", "id"),
    of("score", "traceId"),
    of("score", "id")
  ]);
  const rows: StoredRowKey[] = [];
  for (const chunk of chunks) {
    const byKind = (kind: Entry["kind"]) => chunk.filter((entry) => entry.kind === kind);
    rows.push(
      ...(await listStoredRowKeyChunk(client, projectId, {
        traceIds: byKind("trace").map((entry) => entry.id),
        observations: byKind("observation"),
        scores: byKind("score")
      }))
    );
  }
  return rows;
}

async function listStoredRowKeyChunk(
  client: ClickHouseClient,
  projectId: string,
  records: {
    traceIds: string[];
    observations: { traceId: string; id: string }[];
    scores: { traceId: string; id: string }[];
  }
): Promise<StoredRowKey[]> {
  const { traceIds, observations, scores } = records;
  const unique = (values: string[]) => [...new Set(values)];
  const result = await client.query({
    query: `
      select 'trace' as kind, id, '' as trace_id, toString(timestamp) as sort_time,
             toString(event_ts) as event_ts
        from traces final
       where project_id = {projectId:String} and id in {traceIds:Array(String)}
      union all
      select 'observation' as kind, id, trace_id, toString(start_time) as sort_time,
             toString(event_ts) as event_ts
        from observations final
       where project_id = {projectId:String}
         and trace_id in {observationTraceIds:Array(String)}
         and id in {observationIds:Array(String)}
      union all
      select 'score' as kind, id, trace_id, toString(timestamp) as sort_time,
             toString(event_ts) as event_ts
        from scores final
       where project_id = {projectId:String}
         and trace_id in {scoreTraceIds:Array(String)}
         and id in {scoreIds:Array(String)}
    `,
    query_params: {
      projectId,
      traceIds: unique(traceIds),
      observationTraceIds: unique(observations.map((row) => row.traceId)),
      observationIds: unique(observations.map((row) => row.id)),
      scoreTraceIds: unique(scores.map((row) => row.traceId)),
      scoreIds: unique(scores.map((row) => row.id))
    },
    clickhouse_settings: SKIP_INDEXES_WITH_FINAL,
    format: "JSONEachRow"
  });
  const rows = await result.json<StoredRowKey>();
  // The id and trace-id sets can pair an id with another record's trace.
  const wanted = new Set([
    ...observations.map((row) => `observation\u0000${row.traceId}\u0000${row.id}`),
    ...scores.map((row) => `score\u0000${row.traceId}\u0000${row.id}`)
  ]);
  return rows
    .filter((row) => row.kind === "trace" || wanted.has(`${row.kind}\u0000${row.trace_id}\u0000${row.id}`))
    .map((row) => ({ ...row, sort_time: fromClickHouseDateTime(row.sort_time) }));
}

export interface AggregatesRow {
  trace_count: number;
  token_totals: Record<string, number>;
  cost_totals: Record<string, number>;
  latency_p50: number | null;
  latency_p95: number | null;
  latency_p99: number | null;
}

/**
 * Aggregates over traces matching the filter: count, per-key token/cost
 * sums from their observations, and trace-duration percentiles.
 *
 * Duration is computed per trace as
 * max(observation.end_time) - min(observation.start_time), in
 * milliseconds; traces with no observations carrying an end_time
 * contribute no duration sample (excluded, not treated as 0ms) — a
 * request still mid-flight or a trace with only instantaneous events
 * shouldn't drag the percentiles toward zero.
 */
export async function getAggregates(
  client: ClickHouseClient,
  filter: TraceFilter
): Promise<AggregatesRow> {
  const { conditions, params } = buildTraceConditions(filter);

  // Three separate queries, each re-running the traces filter as a
  // subquery — simpler and safer to get correct than combining into one
  // query with correlated Map-typed scalar subqueries (which ClickHouse
  // does not support cleanly). Revisit if this becomes a hot path; at
  // pre-production scale, correctness and running in parallel (Promise.all)
  // matter more than the extra scans.
  //
  // Note: ClickHouse has no cross-statement transactional isolation, so the
  // three queries are NOT a consistent snapshot of each other — a trace or
  // observation written between them may be reflected in one result (e.g.
  // trace_count) but not another (e.g. tokenTotals). Acceptable for a
  // display aggregate; would need reconsidering if this ever backs anything
  // requiring point-in-time consistency.
  const matchedTracesQuery = `
    select id from traces final where ${conditions.join(" and ")}
  `;

  const [countResult, usageResult, durationResult] = await Promise.all([
    client.query({
      // ClickHouse's UInt64 count() serializes as a JSON string over
      // JSONEachRow (avoids precision loss beyond JS's safe integer range);
      // cast to UInt32 so it round-trips as a plain number instead — a
      // per-project trace count realistically never approaches 2^32.
      query: `select toUInt32(count()) as trace_count from (${matchedTracesQuery})`,
      query_params: params,
      format: "JSONEachRow"
    }),
    client.query({
      // sumMap over the UInt64/Decimal64 map value types serializes each
      // sum as a JSON string; cast the summed map to Map(String, Float64)
      // so it round-trips as plain numbers. These are display aggregates
      // (token counts, USD costs), not values where Float64's precision
      // loss beyond 2^53 matters.
      query: `
        select
          mapApply((k, v) -> (k, toFloat64(v)), sumMap(o.usage_details)) as token_totals,
          mapApply((k, v) -> (k, toFloat64(v)), sumMap(o.cost_details)) as cost_totals
        from observations as o final
        where o.project_id = {projectId:String}
          and o.trace_id in (${matchedTracesQuery})
      `,
      query_params: params,
      format: "JSONEachRow"
    }),
    client.query({
      query: `
        select
          quantile(0.5)(duration_ms) as latency_p50,
          quantile(0.95)(duration_ms) as latency_p95,
          quantile(0.99)(duration_ms) as latency_p99
        from (
          select dateDiff('millisecond', min(o.start_time), max(o.end_time)) as duration_ms
          from observations as o final
          where o.project_id = {projectId:String}
            and o.trace_id in (${matchedTracesQuery})
          group by o.trace_id
          having max(o.end_time) is not null
        )
      `,
      query_params: params,
      format: "JSONEachRow"
    })
  ]);

  const [countRow] = await countResult.json<{ trace_count: number }>();
  const [usageRow] = await usageResult.json<{
    token_totals: Record<string, number>;
    cost_totals: Record<string, number>;
  }>();
  const [durationRow] = await durationResult.json<{
    latency_p50: number | null;
    latency_p95: number | null;
    latency_p99: number | null;
  }>();

  return {
    trace_count: countRow?.trace_count ?? 0,
    token_totals: usageRow?.token_totals ?? {},
    cost_totals: usageRow?.cost_totals ?? {},
    latency_p50: durationRow?.latency_p50 ?? null,
    latency_p95: durationRow?.latency_p95 ?? null,
    latency_p99: durationRow?.latency_p99 ?? null
  };
}

/** Observations for a page of traces, project-scoped, oldest-first per trace. Batch form of listObservationsForTrace. */
export async function listObservationsForTraces(
  client: ClickHouseClient,
  projectId: string,
  traceIds: string[]
): Promise<ObservationRow[]> {
  const uniqueTraceIds = [...new Set(traceIds)].filter(Boolean);
  if (uniqueTraceIds.length === 0) return [];
  const result = await client.query({
    // Same Map value casts as listObservationsForTrace.
    query: `
      select id, trace_id, parent_observation_id, type, name, start_time, end_time,
             level, status_message, model, model_parameters, input, output,
             mapApply((k, v) -> (k, toFloat64(v)), usage_details) as usage_details,
             mapApply((k, v) -> (k, toFloat64(v)), cost_details) as cost_details,
             completion_start_time, metadata
      from observations final
      where project_id = {projectId:String} and trace_id in {traceIds:Array(String)}
      order by trace_id asc, start_time asc, id asc
    `,
    query_params: { projectId, traceIds: uniqueTraceIds },
    format: "JSONEachRow"
  });
  const rows = await result.json<ObservationRow>();
  return rows.map((row) => ({
    ...row,
    start_time: fromClickHouseDateTime(row.start_time),
    end_time: row.end_time ? fromClickHouseDateTime(row.end_time) : null,
    completion_start_time: row.completion_start_time
      ? fromClickHouseDateTime(row.completion_start_time)
      : null
  }));
}

/** Scores for a page of traces, project-scoped, oldest-first per trace. Batch form of listScoresForTrace. */
export async function listScoresForTraces(
  client: ClickHouseClient,
  projectId: string,
  traceIds: string[]
): Promise<ScoreRow[]> {
  const uniqueTraceIds = [...new Set(traceIds)].filter(Boolean);
  if (uniqueTraceIds.length === 0) return [];
  const result = await client.query({
    query: `
      select id, trace_id, observation_id, name, data_type, value, string_value,
             source, comment, timestamp, metadata
      from scores final
      where project_id = {projectId:String} and trace_id in {traceIds:Array(String)}
      order by trace_id asc, timestamp asc, id asc
    `,
    query_params: { projectId, traceIds: uniqueTraceIds },
    format: "JSONEachRow"
  });
  const rows = await result.json<ScoreRow>();
  return rows.map((row) => ({ ...row, timestamp: fromClickHouseDateTime(row.timestamp) }));
}
