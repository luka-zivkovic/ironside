import type { Pool } from "pg";
import type { ExportFilter } from "./export-configs.js";

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
    nextRunAt: row.next_run_at
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
     returning *`,
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
    "select * from otlp_forward_rules where project_id = $1 and id = $2",
    [projectId, id]
  );
  const row = result.rows[0];
  return row ? fromRow(row) : null;
}

export async function listOtlpForwardRules(pool: Pool, projectId: string): Promise<OtlpForwardRule[]> {
  const result = await pool.query<OtlpForwardRuleRow>(
    "select * from otlp_forward_rules where project_id = $1 order by created_at asc",
    [projectId]
  );
  return result.rows.map(fromRow);
}

export async function listEnabledOtlpForwardRules(pool: Pool): Promise<OtlpForwardRule[]> {
  const result = await pool.query<OtlpForwardRuleRow>(
    "select * from otlp_forward_rules where enabled = true order by id asc"
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
     returning *`,
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
     returning *`,
    [limit]
  );
  return result.rows.map(fromRow);
}
