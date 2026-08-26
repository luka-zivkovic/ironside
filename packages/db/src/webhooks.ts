import type { Pool } from "pg";
import type { ExportFilter } from "./export-configs.js";

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
}

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
    nextRunAt: row.next_run_at
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
     returning *`,
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
    "select * from webhook_rules where project_id = $1 and id = $2",
    [projectId, id]
  );
  const row = result.rows[0];
  return row ? ruleFromRow(row) : null;
}

export async function listWebhookRules(pool: Pool, projectId: string): Promise<WebhookRule[]> {
  const result = await pool.query<WebhookRuleRow>(
    "select * from webhook_rules where project_id = $1 order by created_at asc",
    [projectId]
  );
  return result.rows.map(ruleFromRow);
}

export async function listEnabledWebhookRules(pool: Pool): Promise<WebhookRule[]> {
  const result = await pool.query<WebhookRuleRow>(
    "select * from webhook_rules where enabled = true order by id asc"
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
     returning *`,
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
     returning *`,
    [limit]
  );
  return result.rows.map(ruleFromRow);
}

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";

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
