import type { Pool } from "pg";
import {
  FEED_CURSOR_COLUMNS,
  feedCursorFromRow,
  type DestinationFeedCursor,
  type ExportFilter
} from "./export-configs.js";

export interface OtlpForwardRule {
  id: string;
  projectId: string;
  name: string;
  destinationUrl: string;
  /** Ciphertext, never plaintext — decrypt via @ironside/shared's decryptSecret before use. Null if the destination needs no auth. */
  destinationAuthHeaderEncrypted: string | null;
  filter: ExportFilter;
  enabled: boolean;
  pollIntervalSeconds: number;
  nextRunAt: Date;
  /** Null until the first trace is forwarded; the next run starts at the beginning of the feed. */
  feedCursor: DestinationFeedCursor | null;
  lastRunAt: Date | null;
  lastRunStatus: "success" | "error" | null;
  /** Why the last run stopped, or which traces the destination rejected and were skipped. */
  lastRunError: string | null;
  lastRunForwardedCount: number | null;
}

interface OtlpForwardRuleRow {
  id: string;
  project_id: string;
  name: string;
  destination_url: string;
  destination_auth_header_encrypted: string | null;
  filter: ExportFilter;
  enabled: boolean;
  poll_interval_seconds: number;
  next_run_at: Date;
  feed_cursor_trace_id: string | null;
  feed_cursor_published_at_text?: string | null;
  last_run_at: Date | null;
  last_run_status: "success" | "error" | null;
  last_run_error: string | null;
  last_run_forwarded_count: string | null;
}

function fromRow(row: OtlpForwardRuleRow): OtlpForwardRule {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    destinationUrl: row.destination_url,
    destinationAuthHeaderEncrypted: row.destination_auth_header_encrypted,
    filter: row.filter,
    enabled: row.enabled,
    pollIntervalSeconds: row.poll_interval_seconds,
    nextRunAt: row.next_run_at,
    feedCursor: feedCursorFromRow(row),
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastRunError: row.last_run_error,
    lastRunForwardedCount:
      row.last_run_forwarded_count === null ? null : Number(row.last_run_forwarded_count)
  };
}

export interface CreateOtlpForwardRuleInput {
  id: string;
  projectId: string;
  name: string;
  destinationUrl: string;
  /** Already-encrypted ciphertext — callers encrypt before calling this, same contract as export-configs.ts's createExportConfig. */
  destinationAuthHeaderEncrypted?: string;
  filter: ExportFilter;
}

export async function createOtlpForwardRule(
  pool: Pool,
  input: CreateOtlpForwardRuleInput
): Promise<OtlpForwardRule> {
  const result = await pool.query<OtlpForwardRuleRow>(
    `insert into otlp_forward_rules (id, project_id, name, destination_url, destination_auth_header_encrypted, filter)
     values ($1, $2, $3, $4, $5, $6)
     returning *, ${FEED_CURSOR_COLUMNS}`,
    [
      input.id,
      input.projectId,
      input.name,
      input.destinationUrl,
      input.destinationAuthHeaderEncrypted ?? null,
      JSON.stringify(input.filter)
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("failed to create OTLP forward rule");
  return fromRow(row);
}

export async function getOtlpForwardRule(
  pool: Pool,
  projectId: string,
  id: string
): Promise<OtlpForwardRule | null> {
  const result = await pool.query<OtlpForwardRuleRow>(
    `select *, ${FEED_CURSOR_COLUMNS} from otlp_forward_rules where project_id = $1 and id = $2`,
    [projectId, id]
  );
  const row = result.rows[0];
  return row ? fromRow(row) : null;
}

export async function listOtlpForwardRules(pool: Pool, projectId: string): Promise<OtlpForwardRule[]> {
  const result = await pool.query<OtlpForwardRuleRow>(
    `select *, ${FEED_CURSOR_COLUMNS} from otlp_forward_rules where project_id = $1 order by created_at asc`,
    [projectId]
  );
  return result.rows.map(fromRow);
}

export async function listEnabledOtlpForwardRules(pool: Pool): Promise<OtlpForwardRule[]> {
  const result = await pool.query<OtlpForwardRuleRow>(
    `select *, ${FEED_CURSOR_COLUMNS} from otlp_forward_rules where enabled = true order by id asc`
  );
  return result.rows.map(fromRow);
}

export interface UpdateOtlpForwardRuleInput {
  enabled?: boolean;
  pollIntervalSeconds?: number;
}

/** Project-scoped, same not-found-either-way contract as export-configs.ts's updateExportConfig. */
export async function updateOtlpForwardRule(
  pool: Pool,
  projectId: string,
  id: string,
  input: UpdateOtlpForwardRuleInput
): Promise<OtlpForwardRule | null> {
  const result = await pool.query<OtlpForwardRuleRow>(
    `update otlp_forward_rules
     set enabled = coalesce($3, enabled),
         poll_interval_seconds = coalesce($4, poll_interval_seconds),
         updated_at = now()
     where id = $1 and project_id = $2
     returning *, ${FEED_CURSOR_COLUMNS}`,
    [id, projectId, input.enabled ?? null, input.pollIntervalSeconds ?? null]
  );
  const row = result.rows[0];
  return row ? fromRow(row) : null;
}

export async function deleteOtlpForwardRule(pool: Pool, projectId: string, id: string): Promise<boolean> {
  const result = await pool.query(
    "delete from otlp_forward_rules where id = $1 and project_id = $2",
    [id, projectId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Same claim-and-reschedule contract as export-configs.ts's claimDueExportConfigs. */
export async function claimDueOtlpForwardRules(
  pool: Pool,
  limit: number
): Promise<OtlpForwardRule[]> {
  const result = await pool.query<OtlpForwardRuleRow>(
    `update otlp_forward_rules
     set next_run_at = now() + (poll_interval_seconds || ' seconds')::interval
     where id in (
       select id from otlp_forward_rules
       where enabled = true and next_run_at <= now()
       order by next_run_at asc
       limit $1
       for update skip locked
     )
     returning *, ${FEED_CURSOR_COLUMNS}`,
    [limit]
  );
  return result.rows.map(fromRow);
}

/**
 * Records a forwarding run: its outcome and how far it got through the trace
 * feed. The position is stored only if it still holds the value the run
 * started from, so a slow run claimed twice by different worker replicas
 * cannot move it back. `runAgainSoon` makes the next scheduler tick continue
 * a backlog the run stopped short of.
 */
export async function recordOtlpForwardRun(
  pool: Pool,
  id: string,
  run: {
    status: "success" | "error";
    error?: string;
    forwarded: number;
    feedCursor: { from: DestinationFeedCursor | null; to: DestinationFeedCursor | null };
    runAgainSoon?: boolean;
  }
): Promise<void> {
  await pool.query(
    `update otlp_forward_rules
     set last_run_at = now(), last_run_status = $2, last_run_error = $3,
         last_run_forwarded_count = $4,
         feed_cursor_published_at = case when ${UNCHANGED} then $7::timestamptz else feed_cursor_published_at end,
         feed_cursor_trace_id = case when ${UNCHANGED} then $8::text else feed_cursor_trace_id end,
         next_run_at = case when $9 then now() else next_run_at end,
         updated_at = now()
     where id = $1`,
    [
      id,
      run.status,
      run.error ?? null,
      run.forwarded,
      run.feedCursor.from?.publishedAt ?? null,
      run.feedCursor.from?.traceId ?? null,
      run.feedCursor.to?.publishedAt ?? null,
      run.feedCursor.to?.traceId ?? null,
      run.runAgainSoon ?? false
    ]
  );
}

const UNCHANGED = `feed_cursor_published_at is not distinct from $5::timestamptz
  and feed_cursor_trace_id is not distinct from $6::text`;
