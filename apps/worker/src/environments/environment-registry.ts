import {
  getRetainedEnvironmentStats,
  scanEnvironmentTracePage,
  type ClickHouseClient
} from "@ironside/clickhouse";
import {
  checkpointEnvironmentRegistryRebuild,
  finalizeEnvironmentRegistryRebuild,
  observeProjectEnvironments,
  type EnvironmentRegistryRebuildClaim
} from "@ironside/db";
import {
  MAX_OBSERVED_ENVIRONMENTS_PER_PROJECT,
  type Trace
} from "@ironside/shared";
import type { Pool } from "pg";

export const ENVIRONMENT_REBUILD_PAGE_SIZE = 2_000;

export async function observeTraceEnvironments(
  pool: Pool,
  projectId: string,
  traces: Trace[],
  onOverflow?: (count: number) => void
): Promise<void> {
  const result = await observeProjectEnvironments(
    pool,
    projectId,
    traces.flatMap((trace) =>
      trace.environment
        ? [{ environment: trace.environment, traceTimestamp: trace.timestamp }]
        : []
    )
  );
  if (result.overflowed > 0) onOverflow?.(result.overflowed);
}

export interface EnvironmentRegistryRebuildChunkResult {
  status: "checkpointed" | "complete";
  rowsScanned: number;
  environmentCount: number;
  overflowed: boolean;
}

/** One bounded chunk. Checkpoints keep a huge low-cardinality project safe. */
export async function runEnvironmentRegistryRebuildChunk(input: {
  pool: Pool;
  clickhouse: ClickHouseClient;
  claim: EnvironmentRegistryRebuildClaim;
  onOverflow?: () => void;
}): Promise<EnvironmentRegistryRebuildChunkResult> {
  const candidates = [...new Set(input.claim.candidates)];
  const page = await scanEnvironmentTracePage(input.clickhouse, {
    projectId: input.claim.projectId,
    pageSize: ENVIRONMENT_REBUILD_PAGE_SIZE,
    ...(input.claim.cursor && { cursor: input.claim.cursor })
  });

  const candidateSet = new Set(candidates);
  for (const environment of page.environments) {
    if (candidateSet.has(environment)) continue;
    candidateSet.add(environment);
    candidates.push(environment);
    if (candidates.length > MAX_OBSERVED_ENVIRONMENTS_PER_PROJECT) break;
  }

  const overflowed = candidates.length > MAX_OBSERVED_ENVIRONMENTS_PER_PROJECT;
  const complete = overflowed || page.exhausted;
  if (!complete) {
    if (!page.nextCursor) {
      throw new Error("environment registry scan did not exhaust and returned no cursor");
    }
    await checkpointEnvironmentRegistryRebuild(
      input.pool,
      input.claim,
      page.nextCursor,
      candidates
    );
    return {
      status: "checkpointed",
      rowsScanned: page.rowsScanned,
      environmentCount: candidates.length,
      overflowed: false
    };
  }

  const selected = candidates.slice(0, MAX_OBSERVED_ENVIRONMENTS_PER_PROJECT);
  let rebuildOverflowed = overflowed;
  const finalized = await finalizeEnvironmentRegistryRebuild(
    input.pool,
    input.claim,
    async (postWatermarkNames) => {
      // Finalization holds the project advisory lock while this exact query
      // runs. The union is bounded at 2 * registry cap: scanned candidates
      // plus every registry name observed after the scan watermark.
      const exactNames = [...new Set([...selected, ...postWatermarkNames])];
      const stats = await getRetainedEnvironmentStats(
        input.clickhouse,
        input.claim.projectId,
        exactNames
      );
      if (stats.length > MAX_OBSERVED_ENVIRONMENTS_PER_PROJECT) {
        rebuildOverflowed = true;
      }
      return stats.map((environment) => ({
        name: environment.name,
        firstSeenAt: new Date(environment.firstSeenAt),
        lastSeenAt: new Date(environment.lastSeenAt)
      }));
    },
    overflowed
  );
  // A preserved live overflow was already counted by the ingest path. Only
  // count overflow independently discovered by this rebuild lane here.
  if (rebuildOverflowed) input.onOverflow?.();
  return {
    status: "complete",
    rowsScanned: page.rowsScanned,
    environmentCount: finalized.count,
    overflowed: finalized.overflowed
  };
}
