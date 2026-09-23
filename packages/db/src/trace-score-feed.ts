import type { Pool } from "pg";
import type { DestinationFeedCursor } from "./export-configs.js";

// Same per-project lock as publishEvaluatorTraceActivities, so both feeds
// share one commit order and one watermark per project.
const FEED_LOCK_SALT = 72819463;

/**
 * Records that these traces' scores changed without trace or observation
 * activity, after the score rows are in ClickHouse. Each call moves the
 * traces to the end of the score feed; a retried batch moves them again,
 * which only re-sends the same scores.
 */
export async function publishTraceScoreActivity(
  pool: Pool,
  input: { projectId: string; traceIds: string[] }
): Promise<void> {
  const traceIds = [...new Set(input.traceIds)].filter((traceId) => traceId.length > 0);
  if (traceIds.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1::text, $2))", [
      input.projectId,
      FEED_LOCK_SALT
    ]);
    const watermark = await client.query<{ published_at: string }>(
      `insert into evaluator_trace_feed_watermarks (project_id, published_at)
       values ($1, clock_timestamp())
       on conflict (project_id) do update
         set published_at = greatest(
           excluded.published_at,
           evaluator_trace_feed_watermarks.published_at + interval '1 microsecond'
         )
       returning to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as published_at`,
      [input.projectId]
    );
    await client.query(
      `insert into trace_score_feed (project_id, trace_id, published_at)
       select $1, trace_id, $3::timestamptz from unnest($2::text[]) as trace_id
       on conflict (project_id, trace_id) do update set published_at = excluded.published_at`,
      [input.projectId, traceIds, watermark.rows[0]!.published_at]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Score feed entries after `cursor`, in commit order; positions carry microsecond precision. */
export async function listTraceScoreActivities(
  pool: Pool,
  input: { projectId: string; cursor?: DestinationFeedCursor | null; limit: number }
): Promise<DestinationFeedCursor[]> {
  const result = await pool.query<{ trace_id: string; published_at: string }>(
    `select trace_id,
            to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as published_at
       from trace_score_feed
      where project_id = $1
        and ($2::timestamptz is null or (published_at, trace_id) > ($2::timestamptz, $3::text))
      order by published_at asc, trace_id asc
      limit $4`,
    [input.projectId, input.cursor?.publishedAt ?? null, input.cursor?.traceId ?? "", input.limit]
  );
  return result.rows.map((row) => ({ publishedAt: row.published_at, traceId: row.trace_id }));
}
