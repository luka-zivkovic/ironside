import { Pool } from "pg";

const lockPools = new WeakMap<Pool, Pool>();

/**
 * Cross-store seqlock for evaluator-visible ClickHouse trees. Writers take a
 * shared lock, so normal ingest/import concurrency is preserved. Retention
 * takes the exclusive side across its ClickHouse deletes and PG feed cleanup,
 * preventing a partial tree from being deleted between materialization and
 * publication. Session locks are required because ClickHouse work cannot be
 * enclosed by a PostgreSQL transaction.
 */
export async function withEvaluatorDataWriteFence<T>(
  pool: Pool,
  operation: () => Promise<T>
): Promise<T> {
  return withFence(pool, "shared", operation);
}

export async function withEvaluatorRetentionFence<T>(
  pool: Pool,
  operation: () => Promise<T>
): Promise<T> {
  return withFence(pool, "exclusive", operation);
}

async function withFence<T>(
  pool: Pool,
  mode: "shared" | "exclusive",
  operation: () => Promise<T>
): Promise<T> {
  // Never hold a lock client from the same bounded pool used inside the
  // callback: N concurrent shared writers could consume every connection and
  // then deadlock waiting for their own nested queries. The companion pool is
  // used only for advisory-lock sessions; application queries keep the full
  // capacity of the caller's pool.
  const client = await lockPoolFor(pool).connect();
  const lockFunction = mode === "shared" ? "pg_advisory_lock_shared" : "pg_advisory_lock";
  const unlockFunction = mode === "shared" ? "pg_advisory_unlock_shared" : "pg_advisory_unlock";
  let acquired = false;
  const lockNamespace = process.env.VITEST === "true"
    ? `ironside:evaluator-lifecycle:test:${process.env.VITEST_WORKER_ID ?? process.pid}`
    : "ironside:evaluator-lifecycle";
  try {
    await client.query(
      `select ${lockFunction}(hashtextextended($1::text, 20260830))`,
      [lockNamespace]
    );
    acquired = true;
    return await operation();
  } finally {
    try {
      if (acquired) {
        await client.query(
          `select ${unlockFunction}(hashtextextended($1::text, 20260830))`,
          [lockNamespace]
        );
      }
    } finally {
      client.release();
    }
  }
}

function lockPoolFor(pool: Pool): Pool {
  const existing = lockPools.get(pool);
  if (existing) return existing;
  const created = new Pool({
    ...pool.options,
    allowExitOnIdle: true
  });
  lockPools.set(pool, created);
  return created;
}

export async function closeEvaluatorLifecycleFence(pool: Pool): Promise<void> {
  const lockPool = lockPools.get(pool);
  if (!lockPool) return;
  lockPools.delete(pool);
  await lockPool.end();
}
