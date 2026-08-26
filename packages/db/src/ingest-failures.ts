import type { Pool } from "pg";

export interface IngestEventFailure {
  id: string;
  projectId: string;
  batchId: string;
  /** Object-storage key of the raw batch envelope containing the failed event — payload pointer for debugging/replay. */
  objectKey: string;
  eventId: string;
  source: string;
  eventType: string;
  error: string;
  createdAt: Date;
}

interface IngestEventFailureRow {
  id: string;
  project_id: string;
  batch_id: string;
  object_key: string;
  event_id: string;
  source: string;
  event_type: string;
  error: string;
  created_at: Date;
}

function fromRow(row: IngestEventFailureRow): IngestEventFailure {
  return {
    id: row.id,
    projectId: row.project_id,
    batchId: row.batch_id,
    objectKey: row.object_key,
    eventId: row.event_id,
    source: row.source,
    eventType: row.event_type,
    error: row.error,
    createdAt: row.created_at
  };
}

export interface RecordIngestFailureInput {
  id: string;
  projectId: string;
  batchId: string;
  objectKey: string;
  eventId: string;
  source: string;
  eventType: string;
  error: string;
}

/**
 * Batch-inserts failure rows — normally one statement per processed
 * batch. Chunked at 8000 rows per statement: Postgres's wire protocol
 * caps bind parameters at 65535 (Int16), i.e. ~8191 rows at 8 params
 * each, and a single LangFuse envelope event can nest an UNBOUNDED
 * number of inner SDK events (the inner batch schema has .min(1) but no
 * .max(); only the 10MB body limit bounds it — ~200k minimal events).
 * Without chunking, a huge all-failing batch would blow the param limit,
 * the best-effort catch in the processor would swallow the throw, and
 * ZERO diagnostics would persist for exactly the batch a self-hoster
 * most needs to see (review-flagged).
 */
const MAX_ROWS_PER_INSERT = 8000;

export async function recordIngestFailures(
  pool: Pool,
  failures: RecordIngestFailureInput[]
): Promise<void> {
  for (let offset = 0; offset < failures.length; offset += MAX_ROWS_PER_INSERT) {
    const chunk = failures.slice(offset, offset + MAX_ROWS_PER_INSERT);
    const values: string[] = [];
    const params: string[] = [];
    chunk.forEach((f, i) => {
      const base = i * 8;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`
      );
      params.push(f.id, f.projectId, f.batchId, f.objectKey, f.eventId, f.source, f.eventType, f.error);
    });
    await pool.query(
      `insert into ingest_event_failures (id, project_id, batch_id, object_key, event_id, source, event_type, error)
       values ${values.join(", ")}`,
      params
    );
  }
}

/** Newest-first, project-scoped. */
export async function listIngestFailures(
  pool: Pool,
  projectId: string,
  limit: number
): Promise<IngestEventFailure[]> {
  const result = await pool.query<IngestEventFailureRow>(
    `select * from ingest_event_failures
     where project_id = $1
     order by created_at desc, id desc
     limit $2`,
    [projectId, limit]
  );
  return result.rows.map(fromRow);
}

export interface IngestFailureObjectSummary {
  count: number;
  newestCreatedAt: Date | null;
  truncated: boolean;
}

/**
 * Bounded diagnostic summary for one raw object. The covering index supports
 * the newest-first limit without counting/sorting the entire diagnostic set.
 */
export async function inspectIngestFailuresForObject(
  pool: Pool,
  projectId: string,
  objectKey: string,
  limit: number
): Promise<IngestFailureObjectSummary> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("ingest failure inspection limit must be between 1 and 10000");
  }
  const result = await pool.query<{ created_at: Date }>(
    `select created_at
     from ingest_event_failures
     where project_id = $1 and object_key = $2
     order by created_at desc, id asc
     limit $3`,
    [projectId, objectKey, limit + 1]
  );
  return {
    count: Math.min(result.rows.length, limit),
    newestCreatedAt: result.rows[0]?.created_at ?? null,
    truncated: result.rows.length > limit
  };
}

/**
 * Deletes diagnostics for one exact retained raw object without ever issuing
 * an unbounded project/object DELETE. A surviving row makes the operation
 * fail closed so the caller keeps the raw object.
 */
export async function deleteIngestFailuresForRetainedObject(
  pool: Pool,
  projectId: string,
  objectKey: string,
  limit: number
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("ingest failure deletion limit must be between 1 and 10000");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const selected = await client.query<{ id: string }>(
      `select id
       from ingest_event_failures
       where project_id = $1 and object_key = $2
       order by created_at desc, id asc
       limit $3
       for update`,
      [projectId, objectKey, limit + 1]
    );
    if (selected.rows.length > limit) {
      throw new Error(`raw retention diagnostic deletion exceeds the ${limit}-row cap`);
    }
    const ids = selected.rows.map((row) => row.id);
    let deleted = 0;
    if (ids.length > 0) {
      const result = await client.query(
        `delete from ingest_event_failures
         where project_id = $1 and object_key = $2 and id = any($3::text[])`,
        [projectId, objectKey, ids]
      );
      deleted = result.rowCount ?? 0;
      if (deleted !== ids.length) {
        throw new Error("raw retention diagnostic deletion did not match its locked row set");
      }
    }
    const remaining = await client.query(
      `select 1 from ingest_event_failures
       where project_id = $1 and object_key = $2 limit 1`,
      [projectId, objectKey]
    );
    if (remaining.rows.length > 0) {
      throw new Error("raw retention diagnostic rows remain after bounded deletion");
    }
    await client.query("commit");
    return deleted;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Drops failure rows older than the cutoff — called from the retention
 * sweep so the dead-letter table can't grow unbounded. Returns the number
 * of rows purged.
 */
export async function purgeIngestFailuresOlderThan(pool: Pool, days: number): Promise<number> {
  const result = await pool.query(
    `delete from ingest_event_failures where created_at < now() - ($1 || ' days')::interval`,
    [days]
  );
  return result.rowCount ?? 0;
}
