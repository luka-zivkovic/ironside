import { createHash } from "node:crypto";
import {
  insertObservations,
  insertScores,
  insertTraces,
  tombstoneImportedTraceSnapshot,
  type ClickHouseClient
} from "@ironside/clickhouse";
import {
  claimImportRun,
  claimPendingEvaluatorImportSnapshots,
  listEvaluatorImportRecoveryCandidates,
  markImportRunFailed,
  markImportRunIdle,
  publishEvaluatorTraceActivities,
  renewImportRunLease,
  type EvaluatorImportSource,
  type EvaluatorImportTraceSnapshot,
  type EvaluatorPendingImportSnapshot
} from "@ironside/db";
import {
  observationSchema,
  scoreSchema,
  traceSchema,
  type Observation,
  type Trace
} from "@ironside/shared";
import type { Pool } from "pg";
import { ulid } from "ulid";
import { observeTraceEnvironments } from "../environments/environment-registry.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

/** Stable identity for the evaluator-visible part of one imported trace. */
export function importedTraceContentHash(
  trace: Trace,
  observations: Observation[]
): string {
  const snapshot = {
    trace,
    observations: [...observations].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)))
    .digest("hex");
}

export function importedTraceSnapshot(
  trace: Trace,
  observations: Observation[],
  scores: EvaluatorImportTraceSnapshot["scores"],
  scoreActivityAt: string
): EvaluatorImportTraceSnapshot {
  return {
    trace,
    observations: observations.filter((observation) => observation.traceId === trace.id),
    scores: scores.filter((score) => score.traceId === trace.id),
    scoreActivityAt
  };
}

function validateSnapshot(snapshot: EvaluatorImportTraceSnapshot): EvaluatorImportTraceSnapshot {
  const trace = traceSchema.parse(snapshot.trace);
  const observations = snapshot.observations.map((observation) => observationSchema.parse(observation));
  const scores = snapshot.scores.map((score) => scoreSchema.parse(score));
  if (
    observations.some((observation) => observation.traceId !== trace.id) ||
    scores.some((score) => score.traceId !== trace.id)
  ) {
    throw new Error(`imported evaluator snapshot mixes trace identities: ${trace.id}`);
  }
  if (!Number.isFinite(Date.parse(snapshot.scoreActivityAt))) {
    throw new Error(`invalid imported score activity timestamp: ${snapshot.scoreActivityAt}`);
  }
  return { trace, observations, scores, scoreActivityAt: snapshot.scoreActivityAt };
}

export async function materializeEvaluatorImportSnapshot(
  options: {
    pool: Pool;
    clickhouse: ClickHouseClient;
    projectId: string;
    runToken: string;
    onEnvironmentRegistryOverflow?: ((count: number) => void) | undefined;
  },
  state: EvaluatorPendingImportSnapshot
): Promise<void> {
  await renewImportRunLease(options.pool, options.projectId, state.source, options.runToken);
  const snapshot = validateSnapshot(state.snapshot);
  await tombstoneImportedTraceSnapshot(
    options.clickhouse,
    options.projectId,
    state.traceId,
    state.sourceActivityAt
  );
  await Promise.all([
    insertTraces(options.clickhouse, [snapshot.trace], { eventTs: state.sourceActivityAt }),
    insertObservations(options.clickhouse, snapshot.observations, {
      eventTs: state.sourceActivityAt
    }),
    insertScores(options.clickhouse, snapshot.scores, {
      eventTs: snapshot.scoreActivityAt
    })
  ]);
  await observeTraceEnvironments(
    options.pool,
    options.projectId,
    [snapshot.trace],
    options.onEnvironmentRegistryOverflow
  );
  await publishEvaluatorTraceActivities(options.pool, {
    projectId: options.projectId,
    traceIds: [state.traceId],
    sourceActivityAt: state.sourceActivityAt,
    activityId: state.activityId,
    importSource: state.source,
    importRunToken: options.runToken
  });
}

/** Completes durable snapshots left pending by a crashed or failed pull run. */
export async function recoverPendingEvaluatorImportSnapshots(options: {
  pool: Pool;
  clickhouse: ClickHouseClient;
  projectId: string;
  source: EvaluatorImportSource;
  runToken: string;
  onEnvironmentRegistryOverflow?: ((count: number) => void) | undefined;
}): Promise<number> {
  const pending = await claimPendingEvaluatorImportSnapshots(options.pool, options);
  for (const snapshot of pending) {
    await materializeEvaluatorImportSnapshot(options, snapshot);
  }
  return pending.length;
}

/**
 * Independent crash recovery. It does not need provider credentials, so a
 * disabled/deleted source cannot strand a snapshot behind a pending barrier.
 */
export async function recoverAbandonedEvaluatorImports(options: {
  pool: Pool;
  clickhouse: ClickHouseClient;
  limit: number;
  onEnvironmentRegistryOverflow?: ((count: number) => void) | undefined;
  onError?: (projectId: string, source: EvaluatorImportSource, error: unknown) => void;
}): Promise<number> {
  const candidates = await listEvaluatorImportRecoveryCandidates(options.pool, options.limit);
  let recovered = 0;
  for (const candidate of candidates) {
    const claimed = await claimImportRun(
      options.pool,
      candidate.projectId,
      candidate.source,
      `import_recovery_${ulid()}`
    );
    if (!claimed?.runToken) continue;
    try {
      recovered += await recoverPendingEvaluatorImportSnapshots({
        pool: options.pool,
        clickhouse: options.clickhouse,
        projectId: candidate.projectId,
        source: candidate.source,
        runToken: claimed.runToken,
        onEnvironmentRegistryOverflow: options.onEnvironmentRegistryOverflow
      });
      await markImportRunIdle(
        options.pool,
        candidate.projectId,
        candidate.source,
        claimed.runToken
      );
    } catch (error) {
      await markImportRunFailed(
        options.pool,
        candidate.projectId,
        candidate.source,
        claimed.runToken,
        error instanceof Error ? error.message : String(error)
      );
      options.onError?.(candidate.projectId, candidate.source, error);
    }
  }
  return recovered;
}
