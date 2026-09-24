import type { Pool } from "pg";
import {
  FEED_CURSOR_COLUMNS,
  feedCursorFromRow,
  type DestinationFeedCursor,
  type ExportFilter
} from "./export-configs.js";

export interface WebhookRule {
  id: string;
  projectId: string;
  name: string;
  destinationUrl: string;
  /** Ciphertext, never plaintext — decrypt via @ironside/shared's decryptSecret before use. */
  signingSecretEncrypted: string;
  filter: ExportFilter;
  enabled: boolean;
  pollIntervalSeconds: number;
  nextRunAt: Date;
  /** Null until the first run records a position; the next run starts at the beginning of the feed. */
  feedCursor: DestinationFeedCursor | null;
  /**
   * When the rule moved to feed-version deliveries: the migration time for a
   * rule that existed before migration 0006, otherwise its creation time. In
   * the feed cursor's microsecond ISO format. A worker from the previous
   * release keys deliveries by the trace's activity time; see
   * listScannerDeliveries.
   */
  scannerHandoffAt: string;
  lastRunAt: Date | null;
  lastRunStatus: "success" | "error" | null;
  /** Why the last run stopped. */
  lastRunError: string | null;
  lastRunDeliveredCount: number | null;
}

interface WebhookRuleRow {
  id: string;
  project_id: string;
  name: string;
  destination_url: string;
  signing_secret_encrypted: string;
  filter: ExportFilter;
  enabled: boolean;
  poll_interval_seconds: number;
  next_run_at: Date;
  feed_cursor_trace_id: string | null;
  feed_cursor_published_at_text?: string | null;
  scanner_handoff_at_text: string;
  last_run_at: Date | null;
  last_run_status: "success" | "error" | null;
  last_run_error: string | null;
  last_run_delivered_count: string | null;
}

const RULE_COLUMNS = `*, ${FEED_CURSOR_COLUMNS},
  to_char(scanner_handoff_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    as scanner_handoff_at_text`;

function ruleFromRow(row: WebhookRuleRow): WebhookRule {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    destinationUrl: row.destination_url,
    signingSecretEncrypted: row.signing_secret_encrypted,
    filter: row.filter,
    enabled: row.enabled,
    pollIntervalSeconds: row.poll_interval_seconds,
    nextRunAt: row.next_run_at,
    feedCursor: feedCursorFromRow(row),
    scannerHandoffAt: row.scanner_handoff_at_text,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastRunError: row.last_run_error,
    lastRunDeliveredCount:
      row.last_run_delivered_count === null ? null : Number(row.last_run_delivered_count)
  };
}

export interface CreateWebhookRuleInput {
  id: string;
  projectId: string;
  name: string;
  destinationUrl: string;
  /** Already-encrypted ciphertext — callers encrypt before calling this. */
  signingSecretEncrypted: string;
  filter: ExportFilter;
}

export async function createWebhookRule(
  pool: Pool,
  input: CreateWebhookRuleInput
): Promise<WebhookRule> {
  const result = await pool.query<WebhookRuleRow>(
    `insert into webhook_rules (id, project_id, name, destination_url, signing_secret_encrypted, filter)
     values ($1, $2, $3, $4, $5, $6)
     returning ${RULE_COLUMNS}`,
    [
      input.id,
      input.projectId,
      input.name,
      input.destinationUrl,
      input.signingSecretEncrypted,
      JSON.stringify(input.filter)
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("failed to create webhook rule");
  return ruleFromRow(row);
}

export async function getWebhookRule(
  pool: Pool,
  projectId: string,
  id: string
): Promise<WebhookRule | null> {
  const result = await pool.query<WebhookRuleRow>(
    `select ${RULE_COLUMNS} from webhook_rules where project_id = $1 and id = $2`,
    [projectId, id]
  );
  const row = result.rows[0];
  return row ? ruleFromRow(row) : null;
}

export async function listWebhookRules(pool: Pool, projectId: string): Promise<WebhookRule[]> {
  const result = await pool.query<WebhookRuleRow>(
    `select ${RULE_COLUMNS} from webhook_rules where project_id = $1 order by created_at asc`,
    [projectId]
  );
  return result.rows.map(ruleFromRow);
}

export async function listEnabledWebhookRules(pool: Pool): Promise<WebhookRule[]> {
  const result = await pool.query<WebhookRuleRow>(
    `select ${RULE_COLUMNS} from webhook_rules where enabled = true order by id asc`
  );
  return result.rows.map(ruleFromRow);
}

export interface UpdateWebhookRuleInput {
  enabled?: boolean;
  pollIntervalSeconds?: number;
}

/** Project-scoped, same not-found-either-way contract as export-configs.ts's updateExportConfig. */
export async function updateWebhookRule(
  pool: Pool,
  projectId: string,
  id: string,
  input: UpdateWebhookRuleInput
): Promise<WebhookRule | null> {
  const result = await pool.query<WebhookRuleRow>(
    `update webhook_rules
     set enabled = coalesce($3, enabled),
         poll_interval_seconds = coalesce($4, poll_interval_seconds),
         updated_at = now()
     where id = $1 and project_id = $2
     returning ${RULE_COLUMNS}`,
    [id, projectId, input.enabled ?? null, input.pollIntervalSeconds ?? null]
  );
  const row = result.rows[0];
  return row ? ruleFromRow(row) : null;
}

export async function deleteWebhookRule(pool: Pool, projectId: string, id: string): Promise<boolean> {
  const result = await pool.query(
    "delete from webhook_rules where id = $1 and project_id = $2",
    [id, projectId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Same claim-and-reschedule contract as export-configs.ts's
 * claimDueExportConfigs — note this claims the RULE for evaluation (does
 * a run of runWebhooks happen at all right now), which is orthogonal to
 * claimWebhookDelivery's per-(rule,trace) exactly-once claim below: a
 * rule can be "due" for evaluation many times while most of its matching
 * traces have already been delivered and get skipped inside that run.
 */
export async function claimDueWebhookRules(pool: Pool, limit: number): Promise<WebhookRule[]> {
  const result = await pool.query<WebhookRuleRow>(
    `update webhook_rules
     set next_run_at = now() + (poll_interval_seconds || ' seconds')::interval
     where id in (
       select id from webhook_rules
       where enabled = true and next_run_at <= now()
       order by next_run_at asc
       limit $1
       for update skip locked
     )
     returning ${RULE_COLUMNS}`,
    [limit]
  );
  return result.rows.map(ruleFromRow);
}

/**
 * Records a webhook run: its outcome and how far it got through the trace
 * feed. The position is stored only if it still holds the value the run
 * started from, so a slow run claimed twice by different worker replicas
 * cannot move it back. `runAgainSoon` makes the next scheduler tick continue
 * a backlog the run stopped short of.
 */
export async function recordWebhookRun(
  pool: Pool,
  id: string,
  run: {
    status: "success" | "error";
    error?: string;
    delivered: number;
    feedCursor: { from: DestinationFeedCursor | null; to: DestinationFeedCursor | null };
    runAgainSoon?: boolean;
  }
): Promise<void> {
  await pool.query(
    `update webhook_rules
     set last_run_at = now(), last_run_status = $2, last_run_error = $3,
         last_run_delivered_count = $4,
         feed_cursor_published_at = case when ${UNCHANGED} then $7::timestamptz else feed_cursor_published_at end,
         feed_cursor_trace_id = case when ${UNCHANGED} then $8::text else feed_cursor_trace_id end,
         next_run_at = case when $9 then now() else next_run_at end,
         updated_at = now()
     where id = $1`,
    [
      id,
      run.status,
      run.error ?? null,
      run.delivered,
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

/** "covered" marks a scanner key already delivered under the trace's feed version (coverScannerDelivery). */
export type WebhookDeliveryStatus = "pending" | "delivered" | "failed" | "covered";

/**
 * Atomically claims delivery of (webhookRuleId, traceId, traceVersion): the
 * exactly-once mechanism. "Exactly once" means exactly one SUCCESSFUL delivery, not
 * exactly one attempt ever — a delivery that previously failed must be
 * retryable, or a single transient error (destination briefly down) would
 * permanently block that trace from ever being delivered.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE with a WHERE clause that only
 * allows the conflicting row to be "claimed" (touched) when its current
 * status is 'failed', or 'pending' for longer than STALE_PENDING_MINUTES
 * (a prior claimer that crashed or was killed between claiming and
 * recording an outcome, so its row would otherwise be stuck 'pending'
 * forever, unretryable) — never when it's already 'delivered', and never
 * a genuinely in-flight (recently claimed, still 'pending') row from a
 * concurrent caller. This keeps the whole claim atomic in one statement
 * (no separate check-then-update, which would have the same TOCTOU race
 * this exists to prevent). Returns the claimed delivery id if this call
 * won the claim (first attempt, retrying a prior failure, or reclaiming a
 * stale abandoned attempt), or null if the pair was already successfully
 * delivered, or is being attempted concurrently by another still-fresh
 * in-flight call. A caller that gets null must NOT send the webhook.
 */
const STALE_PENDING_MINUTES = 10;

export async function claimWebhookDelivery(
  pool: Pool,
  id: string,
  webhookRuleId: string,
  traceId: string,
  traceVersion: string
): Promise<string | null> {
  // On a fresh (webhookRuleId, traceId, traceVersion) tuple, the INSERT wins and `id` (the
  // newly generated id passed in) is used. On a retry of a prior FAILURE
  // (or a reclaim of a stale abandoned 'pending' row), the UPDATE branch
  // fires instead and the EXISTING row's id is kept (never overwritten) —
  // a delivery record's primary key must stay stable across retries, not
  // get reassigned to whatever id the caller happened to generate for
  // this attempt.
  const result = await pool.query<{ id: string }>(
    `insert into webhook_deliveries
       (id, webhook_rule_id, trace_id, trace_version, status, attempted_at)
     values ($1, $2, $3, $4::timestamptz, 'pending', now())
     on conflict (webhook_rule_id, trace_id, trace_version) do update
       set status = 'pending', attempted_at = now()
       where webhook_deliveries.status = 'failed'
          or (webhook_deliveries.status = 'pending'
              and webhook_deliveries.attempted_at < now() - interval '${STALE_PENDING_MINUTES} minutes')
     returning id`,
    [id, webhookRuleId, traceId, traceVersion]
  );
  return result.rows[0]?.id ?? null;
}

export async function markWebhookDelivered(pool: Pool, deliveryId: string): Promise<void> {
  await pool.query(
    "update webhook_deliveries set status = 'delivered', delivered_at = now() where id = $1",
    [deliveryId]
  );
}

export async function markWebhookFailed(
  pool: Pool,
  deliveryId: string,
  error: string
): Promise<void> {
  await pool.query(
    "update webhook_deliveries set status = 'failed', last_error = $2 where id = $1",
    [deliveryId, error]
  );
}

/** The status of one (rule, trace, version) delivery, or null when none was attempted. */
export async function getWebhookDeliveryStatus(
  pool: Pool,
  webhookRuleId: string,
  traceId: string,
  traceVersion: string
): Promise<WebhookDeliveryStatus | null> {
  const result = await pool.query<{ status: WebhookDeliveryStatus }>(
    `select status from webhook_deliveries
     where webhook_rule_id = $1 and trace_id = $2 and trace_version = $3::timestamptz`,
    [webhookRuleId, traceId, traceVersion]
  );
  return result.rows[0]?.status ?? null;
}

/**
 * Deliveries a pre-0006 worker (the scanner) made or is making for these
 * traces, which it keys by the trace's activity time. A trace is "delivered"
 * when the scanner's delivery succeeded, and "in-flight" while its attempt is
 * pending and not yet stale. Rows this release writes are keyed by feed
 * version, or marked "covered" (coverScannerDelivery), so they never match.
 */
export async function listScannerDeliveries(
  pool: Pool,
  webhookRuleId: string,
  versions: { traceId: string; activityVersion: string }[]
): Promise<Map<string, "delivered" | "in-flight">> {
  if (versions.length === 0) return new Map();
  const result = await pool.query<{ trace_id: string; status: "delivered" | "in-flight" }>(
    `select delivery.trace_id,
            case when delivery.status = 'delivered' then 'delivered' else 'in-flight' end as status
     from webhook_deliveries as delivery
     join unnest($2::text[], $3::timestamptz[]) as version(trace_id, trace_version)
       on delivery.trace_id = version.trace_id and delivery.trace_version = version.trace_version
     where delivery.webhook_rule_id = $1
       and (delivery.status = 'delivered'
            or (delivery.status = 'pending'
                and delivery.attempted_at >= now() - interval '${STALE_PENDING_MINUTES} minutes'))`,
    [
      webhookRuleId,
      versions.map((version) => version.traceId),
      versions.map((version) => version.activityVersion)
    ]
  );
  return new Map(result.rows.map((row) => [row.trace_id, row.status]));
}

/**
 * Records that a trace's delivery by feed version also covers its scanner key
 * (its activity time), so a pre-0006 worker still running beside this one
 * finds the key taken and does not send the trace again. Its claim takes over
 * only a failed or stale pending row, which "covered" is neither.
 */
export async function coverScannerDelivery(
  pool: Pool,
  id: string,
  webhookRuleId: string,
  traceId: string,
  activityVersion: string
): Promise<void> {
  await pool.query(
    `insert into webhook_deliveries
       (id, webhook_rule_id, trace_id, trace_version, status, attempted_at, delivered_at)
     values ($1, $2, $3, $4::timestamptz, 'covered', now(), now())
     on conflict (webhook_rule_id, trace_id, trace_version) do update
       set status = 'covered', delivered_at = now()
       where webhook_deliveries.status = 'failed'
          or (webhook_deliveries.status = 'pending'
              and webhook_deliveries.attempted_at < now() - interval '${STALE_PENDING_MINUTES} minutes')`,
    [id, webhookRuleId, traceId, activityVersion]
  );
}
