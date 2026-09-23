import { listProjectModelPrices } from "@ironside/db";
import { enrichObservationCost, type ModelPriceOverride } from "@ironside/pricing";
import type { Observation } from "@ironside/shared";
import type { Pool } from "pg";

/**
 * Per-project override cache. Ingest batches arrive far more often than
 * owners edit prices, and a stale window of this length only delays which
 * price a freshly changed rule applies to — never whether cost is derived.
 */
const OVERRIDE_CACHE_TTL_MS = 30_000;

interface CachedOverrides {
  loadedAt: number;
  overrides: ModelPriceOverride[];
}

const cache = new Map<string, CachedOverrides>();

/** Test hook: drop cached overrides so a later batch re-reads Postgres. */
export function resetModelPriceOverrideCache(): void {
  cache.clear();
}

export async function loadModelPriceOverrides(pool: Pool, projectId: string): Promise<ModelPriceOverride[]> {
  const cached = cache.get(projectId);
  if (cached && Date.now() - cached.loadedAt < OVERRIDE_CACHE_TTL_MS) return cached.overrides;
  const rows = await listProjectModelPrices(pool, projectId);
  const overrides = rows.map((row) => ({
    pattern: row.pattern,
    ...(row.inputCostPerToken !== null && { input: row.inputCostPerToken }),
    ...(row.outputCostPerToken !== null && { output: row.outputCostPerToken }),
    ...(row.cacheReadInputTokenCost !== null && { cache_read: row.cacheReadInputTokenCost }),
    ...(row.cacheWriteInputTokenCost !== null && { cache_write: row.cacheWriteInputTokenCost })
  }));
  cache.set(projectId, { loadedAt: Date.now(), overrides });
  return overrides;
}

/**
 * Derives cost for observations that reported usage and a model but no cost
 * (spec/cost-pricing-v1.md). Mutates in place before the ClickHouse insert
 * so the derived cost is part of the same durable row as the usage it came
 * from; retries of the same batch recompute identically. Returns how many
 * observations gained a cost.
 */
export async function enrichObservationCosts(
  pool: Pool,
  projectId: string,
  observations: Observation[]
): Promise<number> {
  const candidates = observations.filter(
    (observation) =>
      observation.model &&
      observation.usageDetails &&
      (!observation.costDetails || Object.keys(observation.costDetails).length === 0)
  );
  if (candidates.length === 0) return 0;
  const overrides = await loadModelPriceOverrides(pool, projectId);
  let enriched = 0;
  for (const observation of candidates) {
    if (enrichObservationCost(observation, { overrides })) enriched += 1;
  }
  return enriched;
}
