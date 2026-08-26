import type { Pool } from "pg";
import type { ImportSource } from "./import-checkpoints.js";

export interface ImportSourceConfig {
  id: string;
  projectId: string;
  provider: ImportSource;
  /** Ciphertext, never plaintext — decrypt via @ironside/shared's decryptSecret before use, then JSON.parse into the provider-specific credential shape. */
  encryptedCredentials: string;
  enabled: boolean;
  pollIntervalSeconds: number;
  nextRunAt: Date;
}

interface ImportSourceRow {
  id: string;
  project_id: string;
  provider: ImportSource;
  encrypted_credentials: string;
  enabled: boolean;
  poll_interval_seconds: number;
  next_run_at: Date;
}

function fromRow(row: ImportSourceRow): ImportSourceConfig {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    encryptedCredentials: row.encrypted_credentials,
    enabled: row.enabled,
    pollIntervalSeconds: row.poll_interval_seconds,
    nextRunAt: row.next_run_at
  };
}

export interface UpsertImportSourceInput {
  id: string;
  projectId: string;
  provider: ImportSource;
  /** Already-encrypted ciphertext — callers encrypt before calling this. */
  encryptedCredentials: string;
  pollIntervalSeconds?: number;
}

/**
 * Upserts by (project_id, provider) — same "one source per project per
 * provider" uniqueness as import_checkpoints, so re-connecting the same
 * provider (e.g. rotating credentials) replaces the existing row rather
 * than erroring or creating a duplicate a caller would then have to find
 * and delete first.
 */
export async function upsertImportSource(
  pool: Pool,
  input: UpsertImportSourceInput
): Promise<ImportSourceConfig> {
  // 3600 matches the baseline column default — coalesce can't
  // reference DEFAULT as a value inside a function call, so the literal
  // is duplicated here rather than relying on the column default (which
  // only applies to genuinely-omitted columns, not an explicit NULL).
  // $5 is explicitly cast to ::integer — node-postgres sends an untyped
  // NULL parameter as text by default, and coalesce(text, integer) fails
  // with "column is of type integer but expression is of type text"
  // without the cast (confirmed empirically, not assumed).
  const DEFAULT_POLL_INTERVAL_SECONDS = 3600;
  const result = await pool.query<ImportSourceRow>(
    `insert into import_sources (id, project_id, provider, encrypted_credentials, poll_interval_seconds)
     values ($1, $2, $3, $4, coalesce($5::integer, $6))
     on conflict (project_id, provider) do update
       set encrypted_credentials = excluded.encrypted_credentials,
           poll_interval_seconds = coalesce($5::integer, import_sources.poll_interval_seconds),
           enabled = true,
           updated_at = now()
     returning *`,
    [
      input.id,
      input.projectId,
      input.provider,
      input.encryptedCredentials,
      input.pollIntervalSeconds ?? null,
      DEFAULT_POLL_INTERVAL_SECONDS
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("failed to upsert import source");
  return fromRow(row);
}

export async function listImportSources(pool: Pool, projectId: string): Promise<ImportSourceConfig[]> {
  const result = await pool.query<ImportSourceRow>(
    "select * from import_sources where project_id = $1 order by created_at asc",
    [projectId]
  );
  return result.rows.map(fromRow);
}

export interface UpdateImportSourceInput {
  enabled?: boolean;
  pollIntervalSeconds?: number;
}

/** Project-scoped, same not-found-either-way contract as export-configs.ts's updateExportConfig. */
export async function updateImportSource(
  pool: Pool,
  projectId: string,
  id: string,
  input: UpdateImportSourceInput
): Promise<ImportSourceConfig | null> {
  const result = await pool.query<ImportSourceRow>(
    `update import_sources
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

export async function deleteImportSource(pool: Pool, projectId: string, id: string): Promise<boolean> {
  const result = await pool.query(
    "delete from import_sources where id = $1 and project_id = $2",
    [id, projectId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Same claim-and-reschedule contract as export-configs.ts's claimDueExportConfigs. */
export async function claimDueImportSources(pool: Pool, limit: number): Promise<ImportSourceConfig[]> {
  const result = await pool.query<ImportSourceRow>(
    `update import_sources
     set next_run_at = now() + (poll_interval_seconds || ' seconds')::interval
     where id in (
       select id from import_sources
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
