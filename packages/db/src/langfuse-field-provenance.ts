import { Pool } from "pg";

export type LangfuseEntityKind = "trace" | "observation";

/** Field name -> normalized receive time (YYYY-MM-DDTHH:MM:SS.ffffffZ) of the batch that last sent it. */
export type LangfuseFieldSentAt = Record<string, string>;

// A dedicated pool for the advisory-lock sessions, as the evaluator fence
// does: lock holders then never compete with the queries they run, or with
// the fence they take while holding these locks, for the caller's pool.
const lockPools = new Map<Pool, Pool>();

function lockPoolFor(pool: Pool): Pool {
  const existing = lockPools.get(pool);
  if (existing) return existing;
  const created = new Pool({ ...pool.options, allowExitOnIdle: true });
  lockPools.set(pool, created);
  return created;
}

export async function closeLangfuseMergeLocks(pool: Pool): Promise<void> {
  const lockPool = lockPools.get(pool);
  if (!lockPool) return;
  lockPools.delete(pool);
  await lockPool.end();
}

/**
 * Serializes merges of the same LangFuse traces/observations across worker
 * jobs and replicas: `operation` runs holding a session advisory lock per
 * entity, taken in a fixed order so overlapping batches cannot deadlock.
 * Hash collisions only add serialization.
 */
export async function withLangfuseMergeLocks<T>(
  pool: Pool,
  projectId: string,
  entities: { kind: LangfuseEntityKind; id: string }[],
  operation: () => Promise<T>
): Promise<T> {
  const keys = [...new Set(entities.map((entity) => JSON.stringify([projectId, entity.kind, entity.id])))];
  if (keys.length === 0) return operation();
  const client = await lockPoolFor(pool).connect();
  let locked = false;
  try {
    await client.query(
      `select pg_advisory_lock(lock_key)
         from (
           select distinct hashtextextended(key, 20260924) as lock_key
             from unnest($1::text[]) as key
            order by lock_key
         ) ordered`,
      [keys]
    );
    locked = true;
    return await operation();
  } finally {
    try {
      if (locked) await client.query("select pg_advisory_unlock_all()");
    } finally {
      client.release();
    }
  }
}

export async function getLangfuseFieldSentAt(
  pool: Pool,
  projectId: string,
  entities: { kind: LangfuseEntityKind; id: string }[]
): Promise<Map<string, LangfuseFieldSentAt>> {
  if (entities.length === 0) return new Map();
  const result = await pool.query<{ entity_kind: LangfuseEntityKind; entity_id: string; sent_at: LangfuseFieldSentAt }>(
    `select entity_kind, entity_id, sent_at
       from langfuse_field_provenance
      where project_id = $1
        and (entity_kind, entity_id) in (
          select kind, id from unnest($2::text[], $3::text[]) as target(kind, id)
        )`,
    [projectId, entities.map((entity) => entity.kind), entities.map((entity) => entity.id)]
  );
  return new Map(
    result.rows.map((row) => [langfuseEntityKey(row.entity_kind, row.entity_id), row.sent_at])
  );
}

/** Replaces the recorded field times; callers hold the entity's merge lock. */
export async function recordLangfuseFieldSentAt(
  pool: Pool,
  projectId: string,
  entries: { kind: LangfuseEntityKind; id: string; sentAt: LangfuseFieldSentAt }[]
): Promise<void> {
  if (entries.length === 0) return;
  await pool.query(
    `insert into langfuse_field_provenance (project_id, entity_kind, entity_id, sent_at)
     select $1, kind, id, sent_at
       from unnest($2::text[], $3::text[], $4::jsonb[]) as entry(kind, id, sent_at)
     on conflict (project_id, entity_kind, entity_id) do update
       set sent_at = excluded.sent_at, updated_at = now()`,
    [
      projectId,
      entries.map((entry) => entry.kind),
      entries.map((entry) => entry.id),
      entries.map((entry) => JSON.stringify(entry.sentAt))
    ]
  );
}

/**
 * Drops field times not touched for a while. LangFuse updates follow their
 * create within minutes; an update arriving after its record's times are gone
 * merges as if every stored field was sent at the stored version.
 */
export async function purgeLangfuseFieldSentAtOlderThan(pool: Pool, olderThan: Date): Promise<number> {
  const result = await pool.query("delete from langfuse_field_provenance where updated_at < $1", [olderThan]);
  return result.rowCount ?? 0;
}

export function langfuseEntityKey(kind: LangfuseEntityKind, id: string): string {
  return `${kind}\u0000${id}`;
}
