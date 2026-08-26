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
}

interface ImportCheckpointRow {
  id: string;
  project_id: string;
  source: ImportSource;
  checkpoint: Record<string, unknown>;
  status: ImportStatus;
  last_error: string | null;
  imported_count: string; // bigint comes back as string over node-postgres
}

function fromRow(row: ImportCheckpointRow): ImportCheckpoint {
  return {
    id: row.id,
    projectId: row.project_id,
    source: row.source,
    checkpoint: row.checkpoint,
    status: row.status,
    lastError: row.last_error,
    importedCount: Number(row.imported_count)
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
 * transitions status to 'running' only if it isn't already running —
 * `select ... for update skip locked`-free approach via a conditional
 * update, so two concurrent triggers of the same import don't both start
 * a run. Returns null if another run is already in progress.
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
     set status = 'running', last_error = null, updated_at = now()
     where project_id = $1 and source = $2 and status != 'running'
     returning *`,
    [projectId, source]
  );
  const row = result.rows[0];
  return row ? fromRow(row) : null;
}

/** Persists progress mid-run (or at completion) so an interrupt resumes from here, not from scratch. */
export async function saveImportProgress(
  pool: Pool,
  projectId: string,
  source: ImportSource,
  checkpoint: Record<string, unknown>,
  importedDelta: number
): Promise<void> {
  await pool.query(
    `update import_checkpoints
     set checkpoint = $3, imported_count = imported_count + $4, updated_at = now()
     where project_id = $1 and source = $2`,
    [projectId, source, JSON.stringify(checkpoint), importedDelta]
  );
}

export async function markImportRunIdle(
  pool: Pool,
  projectId: string,
  source: ImportSource
): Promise<void> {
  await pool.query(
    `update import_checkpoints set status = 'idle', updated_at = now()
     where project_id = $1 and source = $2`,
    [projectId, source]
  );
}

export async function markImportRunFailed(
  pool: Pool,
  projectId: string,
  source: ImportSource,
  error: string
): Promise<void> {
  await pool.query(
    `update import_checkpoints set status = 'error', last_error = $3, updated_at = now()
     where project_id = $1 and source = $2`,
    [projectId, source, error]
  );
}
