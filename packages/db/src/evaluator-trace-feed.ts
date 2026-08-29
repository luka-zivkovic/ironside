import type { Pool } from "pg";

export interface EvaluatorTraceActivity {
  traceId: string;
  traceVersion: string;
  publishedAt: string;
}

export interface EvaluatorTraceFeedCursor {
  publishedAt: string;
  traceId: string;
}

/**
 * Records the newest trace/observation activity only after ClickHouse and the
 * raw-event index are fully materialized. Replaying the same ingest batch is
 * a no-op and does not move published_at; a genuinely newer activity version
 * moves the row forward so every independent consumer sees it again.
 */
export async function publishEvaluatorTraceActivities(
  pool: Pool,
  input: { projectId: string; traceIds: string[]; traceVersion: string }
): Promise<void> {
  const traceIds = [...new Set(input.traceIds)].filter((traceId) => traceId.length > 0);
  if (traceIds.length === 0) return;

  await pool.query(
    `insert into evaluator_trace_feed (project_id, trace_id, trace_version)
     select $1, trace_id, $3::timestamptz
     from unnest($2::text[]) as trace_id
     on conflict (project_id, trace_id) do update
       set trace_version = excluded.trace_version,
           published_at = greatest(
             clock_timestamp(),
             evaluator_trace_feed.published_at + interval '1 microsecond'
           )
       where evaluator_trace_feed.trace_version < excluded.trace_version`,
    [input.projectId, traceIds, input.traceVersion]
  );
}

export async function listEvaluatorTraceActivities(
  pool: Pool,
  input: {
    projectId: string;
    cursor?: EvaluatorTraceFeedCursor | undefined;
    limit: number;
  }
): Promise<EvaluatorTraceActivity[]> {
  const result = await pool.query<{
    trace_id: string;
    trace_version: Date;
    published_at: Date;
  }>(
    `select trace_id, trace_version, published_at
       from evaluator_trace_feed
      where project_id = $1
        and (
          $2::timestamptz is null
          or (published_at, trace_id) > ($2::timestamptz, $3::text)
        )
      order by published_at asc, trace_id asc
      limit $4`,
    [input.projectId, input.cursor?.publishedAt ?? null, input.cursor?.traceId ?? "", input.limit]
  );
  return result.rows.map((row) => ({
    traceId: row.trace_id,
    traceVersion: row.trace_version.toISOString(),
    publishedAt: row.published_at.toISOString()
  }));
}
