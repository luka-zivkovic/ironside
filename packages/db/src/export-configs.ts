import type { Pool } from "pg";

export type ExportFormat = "parquet" | "jsonl";
export type ExportRunStatus = "success" | "error";

export interface ExportFilter {
  from?: string;
  to?: string;
  userId?: string;
  sessionId?: string;
  tags?: string[];
  metadataKey?: string;
  metadataValue?: string;
}

/** Position in the durable trace feed (evaluator_trace_feed), ordered by (publishedAt, traceId). */
export interface DestinationFeedCursor {
  publishedAt: string;
  traceId: string;
}

export interface ExportConfig {
  id: string;
  projectId: string;
  name: string;
  format: ExportFormat;
  filter: ExportFilter;
  destinationBucket: string;
  destinationPrefix: string;
  destinationEndpoint: string;
  destinationRegion: string;
  destinationAccessKeyId: string;
  /** Ciphertext, never plaintext — decrypt via @ironside/shared's decryptSecret before use. */
  destinationSecretAccessKeyEncrypted: string;
  enabled: boolean;
  lastRunAt: Date | null;
  lastRunStatus: ExportRunStatus | null;
  lastRunError: string | null;
  lastRunRowCount: number | null;
  pollIntervalSeconds: number;
  nextRunAt: Date;
  /** Null until the first run exports anything; the next run starts at the beginning of the feed. */
  feedCursor: DestinationFeedCursor | null;
  /** Position in trace_score_feed: scores that changed after their trace was exported. */
  scoreFeedCursor: DestinationFeedCursor | null;
}

interface ExportConfigRow {
  id: string;
  project_id: string;
  name: string;
  format: ExportFormat;
  filter: ExportFilter;
  destination_bucket: string;
  destination_prefix: string;
  destination_endpoint: string;
  destination_region: string;
  destination_access_key_id: string;
  destination_secret_access_key_encrypted: string;
  enabled: boolean;
  last_run_at: Date | null;
  last_run_status: ExportRunStatus | null;
  last_run_error: string | null;
  last_run_row_count: string | null; // bigint comes back as string over node-postgres
  poll_interval_seconds: number;
  next_run_at: Date;
  feed_cursor_published_at: Date | null;
  feed_cursor_trace_id: string | null;
  score_cursor_trace_id: string | null;
  score_cursor_published_at_text?: string | null;
}

/** Microsecond ISO, the precision evaluator_trace_feed.published_at carries; Date would truncate it to milliseconds. */
export const FEED_CURSOR_COLUMNS = `
  to_char(feed_cursor_published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    as feed_cursor_published_at_text`;

const EXPORT_CURSOR_COLUMNS = `${FEED_CURSOR_COLUMNS},
  to_char(score_cursor_published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    as score_cursor_published_at_text`;

export function feedCursorFromRow(row: {
  feed_cursor_published_at_text?: string | null;
  feed_cursor_trace_id: string | null;
}): DestinationFeedCursor | null {
  return row.feed_cursor_published_at_text && row.feed_cursor_trace_id !== null
    ? { publishedAt: row.feed_cursor_published_at_text, traceId: row.feed_cursor_trace_id }
    : null;
}

function fromRow(row: ExportConfigRow & { feed_cursor_published_at_text?: string | null }): ExportConfig {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    format: row.format,
    filter: row.filter,
    destinationBucket: row.destination_bucket,
    destinationPrefix: row.destination_prefix,
    destinationEndpoint: row.destination_endpoint,
    destinationRegion: row.destination_region,
    destinationAccessKeyId: row.destination_access_key_id,
    destinationSecretAccessKeyEncrypted: row.destination_secret_access_key_encrypted,
    enabled: row.enabled,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastRunError: row.last_run_error,
    lastRunRowCount: row.last_run_row_count === null ? null : Number(row.last_run_row_count),
    pollIntervalSeconds: row.poll_interval_seconds,
    nextRunAt: row.next_run_at,
    feedCursor: feedCursorFromRow(row),
    scoreFeedCursor:
      row.score_cursor_published_at_text && row.score_cursor_trace_id !== null
        ? { publishedAt: row.score_cursor_published_at_text, traceId: row.score_cursor_trace_id }
        : null
  };
}

export interface CreateExportConfigInput {
  id: string;
  projectId: string;
  name: string;
  format: ExportFormat;
  filter: ExportFilter;
  destinationBucket: string;
  destinationPrefix?: string;
  destinationEndpoint: string;
  destinationRegion?: string;
  destinationAccessKeyId: string;
  /** Already-encrypted ciphertext — callers encrypt before calling this. */
  destinationSecretAccessKeyEncrypted: string;
}

export async function createExportConfig(
  pool: Pool,
  input: CreateExportConfigInput
): Promise<ExportConfig> {
  const result = await pool.query<ExportConfigRow>(
    `insert into export_configs (
       id, project_id, name, format, filter, destination_bucket, destination_prefix,
       destination_endpoint, destination_region, destination_access_key_id,
       destination_secret_access_key_encrypted
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning *, ${EXPORT_CURSOR_COLUMNS}`,
    [
      input.id,
      input.projectId,
      input.name,
      input.format,
      JSON.stringify(input.filter),
      input.destinationBucket,
      input.destinationPrefix ?? "",
      input.destinationEndpoint,
      input.destinationRegion ?? "us-east-1",
      input.destinationAccessKeyId,
      input.destinationSecretAccessKeyEncrypted
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("failed to create export config");
  return fromRow(row);
}

export async function getExportConfig(
  pool: Pool,
  projectId: string,
  id: string
): Promise<ExportConfig | null> {
  const result = await pool.query<ExportConfigRow>(
    `select *, ${EXPORT_CURSOR_COLUMNS} from export_configs where project_id = $1 and id = $2`,
    [projectId, id]
  );
  const row = result.rows[0];
  return row ? fromRow(row) : null;
}

export async function listExportConfigs(pool: Pool, projectId: string): Promise<ExportConfig[]> {
  const result = await pool.query<ExportConfigRow>(
    `select *, ${EXPORT_CURSOR_COLUMNS} from export_configs where project_id = $1 order by created_at asc`,
    [projectId]
  );
  return result.rows.map(fromRow);
}

export async function listEnabledExportConfigs(pool: Pool): Promise<ExportConfig[]> {
  const result = await pool.query<ExportConfigRow>(
    `select *, ${EXPORT_CURSOR_COLUMNS} from export_configs where enabled = true order by id asc`
  );
  return result.rows.map(fromRow);
}

export interface UpdateExportConfigInput {
  enabled?: boolean;
  pollIntervalSeconds?: number;
}

/** Project-scoped: returns null if the id doesn't exist or belongs to a different project — same "not found" response either way, so a caller can't distinguish "wrong id" from "someone else's config" (no cross-project enumeration). */
export async function updateExportConfig(
  pool: Pool,
  projectId: string,
  id: string,
  input: UpdateExportConfigInput
): Promise<ExportConfig | null> {
  const result = await pool.query<ExportConfigRow>(
    `update export_configs
     set enabled = coalesce($3, enabled),
         poll_interval_seconds = coalesce($4, poll_interval_seconds),
         updated_at = now()
     where id = $1 and project_id = $2
     returning *, ${EXPORT_CURSOR_COLUMNS}`,
    [id, projectId, input.enabled ?? null, input.pollIntervalSeconds ?? null]
  );
  const row = result.rows[0];
  return row ? fromRow(row) : null;
}

export async function deleteExportConfig(pool: Pool, projectId: string, id: string): Promise<boolean> {
  const result = await pool.query(
    "delete from export_configs where id = $1 and project_id = $2",
    [id, projectId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Claims every enabled config whose next_run_at has arrived, atomically
 * advancing next_run_at (to now + its own poll_interval_seconds) in the
 * same statement — so a crash between claiming and actually running
 * doesn't strand the row "due forever" (it'll be picked up again next
 * tick, at worst poll_interval_seconds late) nor does a slow run get
 * claimed twice by an overlapping tick (next_run_at has already moved
 * forward the instant this query returns). `for update skip locked`
 * lets multiple scheduler ticks (or, if ever run with >1 worker replica,
 * multiple processes) run concurrently without blocking on each other or
 * double-claiming the same row.
 */
export async function claimDueExportConfigs(
  pool: Pool,
  limit: number
): Promise<ExportConfig[]> {
  const result = await pool.query<ExportConfigRow>(
    `update export_configs
     set next_run_at = now() + (poll_interval_seconds || ' seconds')::interval
     where id in (
       select id from export_configs
       where enabled = true and next_run_at <= now()
       order by next_run_at asc
       limit $1
       for update skip locked
     )
     returning *, ${EXPORT_CURSOR_COLUMNS}`,
    [limit]
  );
  return result.rows.map(fromRow);
}

/**
 * Records a run's outcome. A successful run also stores how far it read the
 * trace and score feeds; a failed one leaves both positions alone so the next
 * run sends the same traces again. A position is stored only if it still
 * holds the value the run started from: with several worker replicas, a slow
 * run can be claimed twice, and the later-finishing run must not move the
 * position back. `runAgainSoon` makes the next scheduler tick continue a
 * backlog the run stopped short of.
 */
export async function recordExportRun(
  pool: Pool,
  id: string,
  outcome: {
    status: ExportRunStatus;
    error?: string;
    rowCount?: number;
    feedCursor?: { from: DestinationFeedCursor | null; to: DestinationFeedCursor | null };
    scoreFeedCursor?: { from: DestinationFeedCursor | null; to: DestinationFeedCursor | null };
    runAgainSoon?: boolean;
  }
): Promise<void> {
  const feed = outcome.feedCursor;
  const scores = outcome.scoreFeedCursor;
  await pool.query(
    `update export_configs
     set last_run_at = now(), last_run_status = $2, last_run_error = $3,
         last_run_row_count = $4,
         feed_cursor_published_at = case when $5 and ${unchanged("feed", 6)} then $8::timestamptz else feed_cursor_published_at end,
         feed_cursor_trace_id = case when $5 and ${unchanged("feed", 6)} then $9::text else feed_cursor_trace_id end,
         score_cursor_published_at = case when $10 and ${unchanged("score", 11)} then $13::timestamptz else score_cursor_published_at end,
         score_cursor_trace_id = case when $10 and ${unchanged("score", 11)} then $14::text else score_cursor_trace_id end,
         next_run_at = case when $15 then now() else next_run_at end,
         updated_at = now()
     where id = $1`,
    [
      id,
      outcome.status,
      outcome.error ?? null,
      outcome.rowCount ?? null,
      feed !== undefined,
      feed?.from?.publishedAt ?? null,
      feed?.from?.traceId ?? null,
      feed?.to?.publishedAt ?? null,
      feed?.to?.traceId ?? null,
      scores !== undefined,
      scores?.from?.publishedAt ?? null,
      scores?.from?.traceId ?? null,
      scores?.to?.publishedAt ?? null,
      scores?.to?.traceId ?? null,
      outcome.runAgainSoon ?? false
    ]
  );
}

/** SQL that is true while the stored cursor still equals the parameters at $n and $n+1. */
function unchanged(kind: "feed" | "score", n: number): string {
  return `${kind}_cursor_published_at is not distinct from $${n}::timestamptz
    and ${kind}_cursor_trace_id is not distinct from $${n + 1}::text`;
}
