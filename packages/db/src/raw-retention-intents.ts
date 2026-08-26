import type { Pool, PoolClient } from "pg";

export type RawRetentionClassification = "applied" | "terminal_failed";
export type RawRetentionIntentState = "prepared" | "executing" | "complete";
export const RAW_RETENTION_PREPARATION_MAX_OBJECTS = 100;
export const RAW_RETENTION_PREPARATION_MAX_BYTES = 1024 * 1024 * 1024;
export const RAW_RETENTION_INTENT_MAX_TRACE_IDS = 10_000;
export const RAW_RETENTION_PREPARATION_MAX_TRACE_IDS = 10_000;
export const RAW_RETENTION_PREPARATION_MAX_TRACE_ID_BYTES = 1024 * 1024;
export const RAW_RETENTION_EXECUTION_MAX_INTENTS = 10;

const RAW_RETENTION_EXECUTION_LOCK_ID = "3690190065439071701";
const RAW_RETENTION_OBJECT_LOCK_SEED = "3690190065439071702";

export interface RawRetentionIntent {
  id: string;
  preparationId: string;
  projectId: string;
  ingestBatchId: string;
  objectKey: string;
  objectSizeBytes: number;
  retentionCutoffDay: string;
  effectiveRetentionDays: number;
  traceIds: string[];
  classification: RawRetentionClassification;
  diagnosticCount: number;
  state: RawRetentionIntentState;
  attempts: number;
  lastError: string | null;
  preparedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface CreateRawRetentionIntentInput {
  id: string;
  preparationId: string;
  projectId: string;
  ingestBatchId: string;
  objectKey: string;
  objectSizeBytes: number;
  retentionCutoffDay: string;
  effectiveRetentionDays: number;
  traceIds: string[];
  classification: RawRetentionClassification;
  diagnosticCount: number;
}

interface RawRetentionIntentRow {
  id: string;
  preparation_id: string;
  project_id: string;
  ingest_batch_id: string;
  object_key: string;
  object_size_bytes: string | number;
  retention_cutoff_day: string | Date;
  effective_retention_days: number;
  trace_ids: unknown;
  classification: RawRetentionClassification;
  diagnostic_count: number;
  state: RawRetentionIntentState;
  attempts: number;
  last_error: string | null;
  prepared_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

function fromRow(row: RawRetentionIntentRow): RawRetentionIntent {
  if (!Array.isArray(row.trace_ids) || row.trace_ids.some((value) => typeof value !== "string")) {
    throw new Error(`raw retention intent ${row.id} has invalid trace_ids`);
  }
  const traceIds = row.trace_ids as string[];
  const cutoff = row.retention_cutoff_day instanceof Date
    ? row.retention_cutoff_day.toISOString().slice(0, 10)
    : row.retention_cutoff_day;
  return {
    id: row.id,
    preparationId: row.preparation_id,
    projectId: row.project_id,
    ingestBatchId: row.ingest_batch_id,
    objectKey: row.object_key,
    objectSizeBytes: Number(row.object_size_bytes),
    retentionCutoffDay: cutoff,
    effectiveRetentionDays: row.effective_retention_days,
    traceIds,
    classification: row.classification,
    diagnosticCount: row.diagnostic_count,
    state: row.state,
    attempts: row.attempts,
    lastError: row.last_error,
    preparedAt: row.prepared_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

/** Inserts one bounded preparation atomically; conflicts remain unchanged. */
export async function createRawRetentionIntents(
  pool: Pool,
  inputs: CreateRawRetentionIntentInput[]
): Promise<RawRetentionIntent[]> {
  if (inputs.length === 0) return [];
  if (inputs.length > RAW_RETENTION_PREPARATION_MAX_OBJECTS) {
    throw new Error(
      `raw retention preparation is capped at ${RAW_RETENTION_PREPARATION_MAX_OBJECTS} objects`
    );
  }
  if (new Set(inputs.map((input) => input.projectId)).size !== 1) {
    throw new Error("raw retention preparation must target one exact project");
  }
  if (new Set(inputs.map((input) => input.preparationId)).size !== 1) {
    throw new Error("raw retention intents must share one preparation id");
  }
  let totalBytes = 0;
  let totalTraceIds = 0;
  let totalTraceIdBytes = 0;
  for (const input of inputs) {
    if (!Number.isSafeInteger(input.objectSizeBytes) || input.objectSizeBytes < 0) {
      throw new Error("raw retention object size must be a non-negative safe integer");
    }
    totalBytes += input.objectSizeBytes;
    if (input.traceIds.length > RAW_RETENTION_INTENT_MAX_TRACE_IDS) {
      throw new Error(
        `raw retention intent is capped at ${RAW_RETENTION_INTENT_MAX_TRACE_IDS} trace ids`
      );
    }
    totalTraceIds += input.traceIds.length;
    // Conservative upper bound for Postgres jsonb::text: quoted JSON strings
    // plus comma/space separators and array brackets.
    totalTraceIdBytes += 2;
    for (const traceId of input.traceIds) {
      totalTraceIdBytes += Buffer.byteLength(JSON.stringify(traceId), "utf8") + 2;
    }
  }
  if (totalBytes > RAW_RETENTION_PREPARATION_MAX_BYTES) {
    throw new Error(
      `raw retention preparation exceeds the ${RAW_RETENTION_PREPARATION_MAX_BYTES} byte cap`
    );
  }
  if (totalTraceIds > RAW_RETENTION_PREPARATION_MAX_TRACE_IDS) {
    throw new Error(
      `raw retention preparation exceeds the ${RAW_RETENTION_PREPARATION_MAX_TRACE_IDS} trace-id cap`
    );
  }
  if (totalTraceIdBytes > RAW_RETENTION_PREPARATION_MAX_TRACE_ID_BYTES) {
    throw new Error(
      `raw retention preparation exceeds the ${RAW_RETENTION_PREPARATION_MAX_TRACE_ID_BYTES} trace-id byte cap`
    );
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted: RawRetentionIntent[] = [];
    for (const input of inputs) {
      const result = await insertOne(client, input);
      if (result) inserted.push(result);
    }
    await client.query("commit");
    return inserted;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function insertOne(
  client: PoolClient,
  input: CreateRawRetentionIntentInput
): Promise<RawRetentionIntent | null> {
  const result = await client.query<RawRetentionIntentRow>(
    `insert into raw_retention_intents (
       id, preparation_id, project_id, ingest_batch_id, object_key,
       object_size_bytes, retention_cutoff_day, effective_retention_days,
       trace_ids, classification, diagnostic_count
     ) values ($1, $2, $3, $4, $5, $6, $7::date, $8, $9::jsonb, $10, $11)
     on conflict (project_id, object_key) do nothing
     returning *`,
    [
      input.id,
      input.preparationId,
      input.projectId,
      input.ingestBatchId,
      input.objectKey,
      input.objectSizeBytes,
      input.retentionCutoffDay,
      input.effectiveRetentionDays,
      JSON.stringify(input.traceIds),
      input.classification,
      input.diagnosticCount
    ]
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

export async function listRawRetentionIntents(
  pool: Pool,
  projectId: string,
  state: RawRetentionIntentState,
  limit: number
): Promise<RawRetentionIntent[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > RAW_RETENTION_PREPARATION_MAX_OBJECTS) {
    throw new Error(
      `raw retention intent list limit must be between 1 and ${RAW_RETENTION_PREPARATION_MAX_OBJECTS}`
    );
  }
  const result = await pool.query<RawRetentionIntentRow>(
    `select * from raw_retention_intents
     where project_id = $1 and state = $2
     order by prepared_at asc, id asc
     limit $3`,
    [projectId, state, limit]
  );
  return result.rows.map(fromRow);
}

export async function getRawRetentionIntent(
  pool: Pool,
  projectId: string,
  objectKey: string
): Promise<RawRetentionIntent | null> {
  const result = await pool.query<RawRetentionIntentRow>(
    `select * from raw_retention_intents where project_id = $1 and object_key = $2`,
    [projectId, objectKey]
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

/** Loads an explicit bounded intent set; callers decide whether missing ids are fatal. */
export async function getRawRetentionIntentsByIds(
  pool: Pool,
  projectId: string,
  intentIds: string[]
): Promise<RawRetentionIntent[]> {
  if (intentIds.length === 0 || intentIds.length > RAW_RETENTION_EXECUTION_MAX_INTENTS) {
    throw new Error(
      `raw retention execution requires between 1 and ${RAW_RETENTION_EXECUTION_MAX_INTENTS} intent ids`
    );
  }
  const result = await pool.query<RawRetentionIntentRow>(
    `select * from raw_retention_intents
     where project_id = $1 and id = any($2::text[])`,
    [projectId, intentIds]
  );
  return result.rows.map(fromRow);
}

/**
 * Serializes destructive raw-retention commands across worker replicas.
 * Session locks require a pinned client and an explicit unlock in finally.
 */
export async function withRawRetentionExecutionLock<T>(
  pool: Pool,
  operation: () => Promise<T>
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1::bigint) as acquired",
      [RAW_RETENTION_EXECUTION_LOCK_ID]
    );
    if (result.rows[0]?.acquired !== true) return { acquired: false };
    try {
      return { acquired: true, value: await operation() };
    } finally {
      await client.query("select pg_advisory_unlock($1::bigint)", [
        RAW_RETENTION_EXECUTION_LOCK_ID
      ]);
    }
  } finally {
    client.release();
  }
}

/**
 * Coordinates one raw object with the ingest processor. Hash collisions only
 * cause conservative extra serialization; they can never authorize deletion.
 */
export async function withRawRetentionObjectLock<T>(
  pool: Pool,
  projectId: string,
  objectKey: string,
  operation: () => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  const identity = JSON.stringify([projectId, objectKey]);
  try {
    await client.query(
      "select pg_advisory_lock(hashtextextended($1, $2::bigint))",
      [identity, RAW_RETENTION_OBJECT_LOCK_SEED]
    );
    try {
      return await operation();
    } finally {
      await client.query(
        "select pg_advisory_unlock(hashtextextended($1, $2::bigint))",
        [identity, RAW_RETENTION_OBJECT_LOCK_SEED]
      );
    }
  } finally {
    client.release();
  }
}

/** Non-blocking variant used by explicit commands so a stuck ingest cannot hang an operator shell. */
export async function tryWithRawRetentionObjectLock<T>(
  pool: Pool,
  projectId: string,
  objectKey: string,
  operation: () => Promise<T>
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const client = await pool.connect();
  const identity = JSON.stringify([projectId, objectKey]);
  try {
    const result = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, $2::bigint)) as acquired",
      [identity, RAW_RETENTION_OBJECT_LOCK_SEED]
    );
    if (result.rows[0]?.acquired !== true) return { acquired: false };
    try {
      return { acquired: true, value: await operation() };
    } finally {
      await client.query(
        "select pg_advisory_unlock(hashtextextended($1, $2::bigint))",
        [identity, RAW_RETENTION_OBJECT_LOCK_SEED]
      );
    }
  } finally {
    client.release();
  }
}

/** Begins or resumes the irreversible phase. */
export async function claimRawRetentionIntentExecution(
  pool: Pool,
  projectId: string,
  intentId: string
): Promise<RawRetentionIntent | null> {
  const result = await pool.query<RawRetentionIntentRow>(
    `update raw_retention_intents
     set state = 'executing', attempts = attempts + 1,
         last_error = null, updated_at = now()
     where project_id = $1 and id = $2 and state in ('prepared', 'executing')
     returning *`,
    [projectId, intentId]
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

export async function recordRawRetentionIntentError(
  pool: Pool,
  projectId: string,
  intentId: string,
  error: string
): Promise<void> {
  await pool.query(
    `update raw_retention_intents
     set last_error = $3, updated_at = now()
     where project_id = $1 and id = $2 and state <> 'complete'`,
    [projectId, intentId, error.slice(0, 2_000)]
  );
}

export async function completeRawRetentionIntent(
  pool: Pool,
  projectId: string,
  intentId: string
): Promise<boolean> {
  const result = await pool.query(
    `update raw_retention_intents
     set state = 'complete', last_error = null,
         completed_at = coalesce(completed_at, now()), updated_at = now()
     where project_id = $1 and id = $2 and state = 'executing'`,
    [projectId, intentId]
  );
  return (result.rowCount ?? 0) === 1;
}
