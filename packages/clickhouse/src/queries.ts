import type { ClickHouseClient } from "@clickhouse/client";
import { fromClickHouseDateTime, toClickHouseDateTime } from "./datetime.js";

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
function traceActivityQuery(traceIdParam?: string): string {
  const traceCondition = traceIdParam
    ? `and id = {${traceIdParam}:String}`
    : "";
  const observationCondition = traceIdParam
    ? `and trace_id = {${traceIdParam}:String}`
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

/** Shared by listTraces and getAggregates — same filter surface, different projection. */
function buildTraceConditions(
  filter: TraceFilter,
  options: { includeSettledCondition?: boolean } = {}
): {
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

  if (filter.settledBefore && options.includeSettledCondition !== false) {
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

export interface ExportTraceRow {
  id: string;
  timestamp: string;
  name: string | null;
  user_id: string | null;
  session_id: string | null;
  tags: string[];
  metadata: Record<string, string>;
  input: string | null;
  output: string | null;
  /** Stable version for one settled snapshot; advances on any later trace activity. */
  last_activity_at: string;
}

/**
 * Fetches ALL traces matching a filter (no pagination) for a bulk export.
 * Buffered via .json() rather than streamed — acceptable at current scale;
 * a very large export should switch to ResultSet.stream() (see
 * @clickhouse/client's Row streaming API) before this becomes a memory
 * concern. FINAL is required here: retention uses the engine's tombstone
 * column, so reading physical rows directly could export a deleted trace
 * and treat its deletion marker as a new settled version.
 */
export async function exportTraces(
  client: ClickHouseClient,
  filter: TraceFilter
): Promise<ExportTraceRow[]> {
  // The activity join both gates incomplete traces and returns the settled
  // snapshot version used by webhook exactly-once delivery. Keep the normal
  // trace predicates inside a subquery so their existing unqualified column
  // names remain unambiguous after the join.
  const { conditions, params } = buildTraceConditions(filter, {
    includeSettledCondition: false
  });
  if (filter.settledBefore) {
    params.settledBefore = toClickHouseDateTime(filter.settledBefore);
  }

  const result = await client.query({
    query: `
      select t.id, t.timestamp, t.name, t.user_id, t.session_id, t.tags,
             t.metadata, t.input, t.output,
             activity.last_activity_at as last_activity_at
      from (
        select id, timestamp, name, user_id, session_id, tags, metadata, input, output
        from traces final
        where ${conditions.join(" and ")}
      ) as t
      inner join (${traceActivityQuery()}) as activity on activity.trace_id = t.id
      ${filter.settledBefore ? "where activity.last_activity_at <= {settledBefore:DateTime64(6)}" : ""}
      order by t.timestamp asc, t.id asc
    `,
    query_params: params,
    format: "JSONEachRow"
  });

  const rows = await result.json<ExportTraceRow>();
  return rows.map((row) => ({
    ...row,
    timestamp: fromClickHouseDateTime(row.timestamp),
    last_activity_at: fromClickHouseDateTime(row.last_activity_at)
  }));
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
