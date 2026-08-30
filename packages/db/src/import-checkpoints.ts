import type { Pool } from "pg";

export type ImportSource = "langfuse" | "langsmith";
export type ImportStatus = "idle" | "running" | "error";

export interface ImportCheckpoint {
  id: string;
  projectId: string;
  source: ImportSource;
  checkpoint: Record<string, unknown>;
  status: ImportStatus;
  lastError: string | null;
  importedCount: number;
  runToken: string | null;
  leaseExpiresAt: Date | null;
}

interface ImportCheckpointRow {
  id: string;
  project_id: string;
  source: ImportSource;
  checkpoint: Record<string, unknown>;
  status: ImportStatus;
  last_error: string | null;
  imported_count: string; // bigint comes back as string over node-postgres
  run_token: string | null;
  lease_expires_at: Date | null;
}

function fromRow(row: ImportCheckpointRow): ImportCheckpoint {
  return {
    id: row.id,
    projectId: row.project_id,
    source: row.source,
    checkpoint: row.checkpoint,
    status: row.status,
    lastError: row.last_error,
    importedCount: Number(row.imported_count),
    runToken: row.run_token,
    leaseExpiresAt: row.lease_expires_at
  };
}

/** Fetches the checkpoint for (projectId, source), or null if the importer has never run for this project. */
export async function getImportCheckpoint(
  pool: Pool,
  projectId: string,
  source: ImportSource
): Promise<ImportCheckpoint | null> {
  const result = await pool.query<ImportCheckpointRow>(
    "select * from import_checkpoints where project_id = $1 and source = $2",
    [projectId, source]
  );
  const row = result.rows[0];
  return row ? fromRow(row) : null;
}

/**
 * Atomically claims the checkpoint for a run: creates it if absent, and
 * transitions status to 'running' only if it isn't already running or its
 * lease expired —
 * `select ... for update skip locked`-free approach via a conditional
 * update, so two concurrent triggers of the same import don't both start a
 * run. The per-run token fences progress and publication after takeover.
 * Returns null if another live run is already in progress.
 */
export async function claimImportRun(
  pool: Pool,
  projectId: string,
  source: ImportSource,
  id: string
): Promise<ImportCheckpoint | null> {
  await pool.query(
    `insert into import_checkpoints (id, project_id, source)
     values ($1, $2, $3)
     on conflict (project_id, source) do nothing`,
    [id, projectId, source]
  );
  const result = await pool.query<ImportCheckpointRow>(
    `update import_checkpoints
     set status = 'running', last_error = null, run_token = $3,
         lease_expires_at = clock_timestamp() + interval '5 minutes',
         updated_at = now()
     where project_id = $1 and source = $2
       and (
         status != 'running'
         or lease_expires_at is null
         or lease_expires_at <= clock_timestamp()
       )
     returning *`,
    [projectId, source, id]
  );
  const row = result.rows[0];
  return row ? fromRow(row) : null;
}

/** Persists progress mid-run (or at completion) so an interrupt resumes from here, not from scratch. */
export async function saveImportProgress(
  pool: Pool,
  projectId: string,
  source: ImportSource,
  runToken: string,
  checkpoint: Record<string, unknown>,
  importedDelta: number
): Promise<void> {
  const result = await pool.query(
    `update import_checkpoints
     set checkpoint = $4, imported_count = imported_count + $5,
         lease_expires_at = clock_timestamp() + interval '5 minutes',
         updated_at = now()
     where project_id = $1 and source = $2 and status = 'running'
       and run_token = $3 and lease_expires_at > clock_timestamp()`,
    [projectId, source, runToken, JSON.stringify(checkpoint), importedDelta]
  );
  if (result.rowCount !== 1) throw new Error("import run lease was lost");
}

export async function renewImportRunLease(
  pool: Pool,
  projectId: string,
  source: ImportSource,
  runToken: string
): Promise<void> {
  const result = await pool.query(
    `update import_checkpoints
        set lease_expires_at = clock_timestamp() + interval '5 minutes',
            updated_at = now()
      where project_id = $1 and source = $2 and status = 'running'
        and run_token = $3 and lease_expires_at > clock_timestamp()`,
    [projectId, source, runToken]
  );
  if (result.rowCount !== 1) throw new Error("import run lease was lost");
}

export async function markImportRunIdle(
  pool: Pool,
  projectId: string,
  source: ImportSource,
  runToken: string
): Promise<void> {
  const result = await pool.query(
    `update import_checkpoints
        set status = 'idle', run_token = null, lease_expires_at = null,
            updated_at = now()
      where project_id = $1 and source = $2 and status = 'running'
        and run_token = $3 and lease_expires_at > clock_timestamp()`,
    [projectId, source, runToken]
  );
  if (result.rowCount !== 1) throw new Error("import run lease was lost");
}

export async function markImportRunFailed(
  pool: Pool,
  projectId: string,
  source: ImportSource,
  runToken: string,
  error: string
): Promise<boolean> {
  const result = await pool.query(
    `update import_checkpoints
        set status = 'error', last_error = $4, run_token = null,
            lease_expires_at = null, updated_at = now()
      where project_id = $1 and source = $2 and status = 'running'
        and run_token = $3`,
    [projectId, source, runToken, error]
  );
  return result.rowCount === 1;
}
