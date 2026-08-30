import type { Pool } from "pg";

export interface EvaluatorTraceActivity {
  traceId: string;
  traceVersion: string;
  sourceActivityAt: string;
  publishedAt: string;
}

export interface EvaluatorTraceFeedCursor {
  publishedAt: string;
  traceId: string;
}

export class EvaluatorScoreIdempotencyConflictError extends Error {
  constructor(readonly scoreId: string) {
    super(`Evaluator score id was already used for a different request: ${scoreId}`);
    this.name = "EvaluatorScoreIdempotencyConflictError";
  }
}

export async function claimEvaluatorScoreReceipt(
  pool: Pool,
  input: {
    projectId: string;
    scoreId: string;
    traceId: string;
    requestFingerprint: string;
  }
): Promise<{ timestamp: string }> {
  const result = await pool.query<{
    trace_id: string;
    request_fingerprint: string;
    score_timestamp: Date;
  }>(
    `insert into evaluator_score_receipts
       (project_id, score_id, trace_id, request_fingerprint)
     values ($1, $2, $3, $4)
     on conflict (project_id, score_id) do update
       set score_id = excluded.score_id
     returning trace_id, request_fingerprint, score_timestamp`,
    [input.projectId, input.scoreId, input.traceId, input.requestFingerprint]
  );
  const receipt = result.rows[0]!;
  if (
    receipt.trace_id !== input.traceId ||
    receipt.request_fingerprint !== input.requestFingerprint
  ) {
    throw new EvaluatorScoreIdempotencyConflictError(input.scoreId);
  }
  return { timestamp: receipt.score_timestamp.toISOString() };
}

/**
 * Records the newest trace/observation activity only after ClickHouse and the
 * raw-event index are fully materialized. Replaying the same ingest batch is
 * a no-op and does not move published_at; a genuinely newer activity version
 * moves the row forward so every independent consumer sees it again.
 */
export async function publishEvaluatorTraceActivities(
  pool: Pool,
  input: {
    projectId: string;
    traceIds: string[];
    sourceActivityAt: string;
    activityId: string;
  }
): Promise<void> {
  const traceIds = [...new Set(input.traceIds)].filter((traceId) => traceId.length > 0);
  if (traceIds.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("begin");
    // A timestamp or sequence allocated before commit can be overtaken by a
    // concurrent transaction. Serialize publications per project so cursor
    // order is also commit order without coupling unrelated tenants.
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1::text, 72819463))",
      [input.projectId]
    );
    const inserted = await client.query<{ trace_id: string }>(
      `insert into evaluator_trace_feed_activities
         (project_id, trace_id, activity_id)
       select $1, trace_id, $3
       from unnest($2::text[]) as trace_id
       on conflict (project_id, trace_id, activity_id) do nothing
       returning trace_id`,
      [input.projectId, traceIds, input.activityId]
    );
    const newlyPublishedTraceIds = inserted.rows.map((row) => row.trace_id);
    if (newlyPublishedTraceIds.length > 0) {
      const watermark = await client.query<{ published_at: string }>(
        `insert into evaluator_trace_feed_watermarks (project_id, published_at)
         values ($1, clock_timestamp())
         on conflict (project_id) do update
           set published_at = greatest(
             excluded.published_at,
             evaluator_trace_feed_watermarks.published_at + interval '1 microsecond'
           )
         returning to_char(
           published_at at time zone 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) as published_at`,
        [input.projectId]
      );
      await client.query(
        `insert into evaluator_trace_feed
           (project_id, trace_id, trace_version, source_activity_at, published_at)
         select $1, trace_id, $4::timestamptz, $3::timestamptz,
                $4::timestamptz
         from unnest($2::text[]) as trace_id
         on conflict (project_id, trace_id) do update
           set trace_version = excluded.trace_version,
               source_activity_at = greatest(
                 evaluator_trace_feed.source_activity_at,
                 excluded.source_activity_at
               ),
               published_at = excluded.published_at`,
        [
          input.projectId,
          newlyPublishedTraceIds,
          input.sourceActivityAt,
          watermark.rows[0]!.published_at
        ]
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
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
    trace_version: string;
    source_activity_at: Date;
    published_at: string;
  }>(
    `select trace_id,
            to_char(trace_version at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as trace_version,
            source_activity_at,
            to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as published_at
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
    traceVersion: row.trace_version,
    sourceActivityAt: row.source_activity_at.toISOString(),
    publishedAt: row.published_at
  }));
}

export interface EvaluatorTracePublication {
  traceId: string;
  traceVersion: string;
  sourceActivityAt: string;
}

export async function getEvaluatorTracePublications(
  pool: Pool,
  projectId: string,
  traceIds: string[]
): Promise<Map<string, EvaluatorTracePublication>> {
  const uniqueTraceIds = [...new Set(traceIds)].filter(Boolean);
  if (uniqueTraceIds.length === 0) return new Map();
  const result = await pool.query<{
    trace_id: string;
    trace_version: string;
    source_activity_at: Date;
  }>(
    `select trace_id,
            to_char(trace_version at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as trace_version,
            source_activity_at
       from evaluator_trace_feed
      where project_id = $1 and trace_id = any($2::text[])`,
    [projectId, uniqueTraceIds]
  );
  return new Map(result.rows.map((row) => [row.trace_id, {
    traceId: row.trace_id,
    traceVersion: row.trace_version,
    sourceActivityAt: row.source_activity_at.toISOString()
  }]));
}

export async function listEvaluatorPublishedTraceIdsForActivity(
  pool: Pool,
  input: { projectId: string; activityId: string }
): Promise<string[]> {
  const result = await pool.query<{ trace_id: string }>(
    `select trace_id
       from evaluator_trace_feed_activities
      where project_id = $1 and activity_id = $2
      order by trace_id asc`,
    [input.projectId, input.activityId]
  );
  return result.rows.map((row) => row.trace_id);
}

export async function deleteEvaluatorTraceFeedEntries(
  pool: Pool,
  entries: { projectId: string; traceId: string; traceVersion: string }[]
): Promise<number> {
  if (entries.length === 0) return 0;
  const projectIds = entries.map((entry) => entry.projectId);
  const traceIds = entries.map((entry) => entry.traceId);
  const traceVersions = entries.map((entry) => entry.traceVersion);
  const result = await pool.query<{ deleted_count: string }>(
    `with targets as (
       select * from unnest($1::text[], $2::text[], $3::text[])
         as target(project_id, trace_id, trace_version)
     ), deleted_feed as (
       delete from evaluator_trace_feed feed
       using targets
       where feed.project_id = targets.project_id
         and feed.trace_id = targets.trace_id
         and feed.trace_version = targets.trace_version::timestamptz
       returning feed.project_id, feed.trace_id
     ), deleted_activities as (
       delete from evaluator_trace_feed_activities activity
       using deleted_feed
       where activity.project_id = deleted_feed.project_id
         and activity.trace_id = deleted_feed.trace_id
       returning 1
     ), deleted_score_receipts as (
       delete from evaluator_score_receipts receipt
       using deleted_feed
       where receipt.project_id = deleted_feed.project_id
         and receipt.trace_id = deleted_feed.trace_id
       returning 1
     )
     select count(*)::text as deleted_count from deleted_feed`,
    [projectIds, traceIds, traceVersions]
  );
  return Number(result.rows[0]?.deleted_count ?? 0);
}

export async function listEvaluatorTraceFeedKeys(
  pool: Pool,
  input: { after?: { projectId: string; traceId: string }; limit: number }
): Promise<{ projectId: string; traceId: string; traceVersion: string }[]> {
  const result = await pool.query<{
    project_id: string;
    trace_id: string;
    trace_version: string;
  }>(
    `select project_id, trace_id,
            to_char(trace_version at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as trace_version
       from evaluator_trace_feed
      where $1::text is null or (project_id, trace_id) > ($1::text, $2::text)
      order by project_id asc, trace_id asc
      limit $3`,
    [input.after?.projectId ?? null, input.after?.traceId ?? "", input.limit]
  );
  return result.rows.map((row) => ({
    projectId: row.project_id,
    traceId: row.trace_id,
    traceVersion: row.trace_version
  }));
}
