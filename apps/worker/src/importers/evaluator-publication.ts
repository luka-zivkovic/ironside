import { createHash } from "node:crypto";
import {
  insertObservations,
  insertScores,
  insertTraces,
  tombstoneExpiredImportedTraceSnapshot,
  tombstoneImportedTraceSnapshot,
  type ClickHouseClient
} from "@ironside/clickhouse";
import {
  claimImportRun,
  claimPendingEvaluatorImportSnapshots,
  deleteLegacyPendingEvaluatorImport,
  discardPendingEvaluatorImportSnapshot,
  getEvaluatorImportRetentionCutoff,
  listEvaluatorImportRecoveryCandidates,
  listLegacyPendingEvaluatorImports,
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
  return validateSnapshot({
    trace,
    observations: observations.filter((observation) => observation.traceId === trace.id),
    scores: scores.filter((score) => score.traceId === trace.id),
    scoreActivityAt
  });
}

function validateSnapshot(
  snapshot: EvaluatorImportTraceSnapshot,
  expected?: { projectId: string; traceId: string }
): EvaluatorImportTraceSnapshot {
  const trace = traceSchema.parse(snapshot.trace);
  const observations = snapshot.observations.map((observation) => observationSchema.parse(observation));
  const scores = snapshot.scores.map((score) => scoreSchema.parse(score));
  if (
    (expected && (trace.id !== expected.traceId || trace.projectId !== expected.projectId)) ||
    observations.some((observation) => observation.traceId !== trace.id) ||
    scores.some((score) => score.traceId !== trace.id) ||
    observations.some((observation) => observation.projectId !== trace.projectId) ||
    scores.some((score) => score.projectId !== trace.projectId)
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
  const snapshot = validateSnapshot(state.snapshot, {
    projectId: options.projectId,
    traceId: state.traceId
  });
  const discardIfExpired = async (): Promise<boolean> => {
    const cutoff = await getEvaluatorImportRetentionCutoff(options.pool, options.projectId);
    if (!cutoff || Date.parse(snapshot.trace.timestamp) >= Date.parse(cutoff)) return false;
    // A prior attempt may have written ClickHouse and then lost the cutoff
    // race at the fenced PG publication. Tombstone idempotently before
    // clearing the durable recovery barrier even when this attempt itself has
    // not written yet.
    await tombstoneExpiredImportedTraceSnapshot(
      options.clickhouse,
      options.projectId,
      state.traceId,
      state.sourceActivityAt
    );
    await discardPendingEvaluatorImportSnapshot(options.pool, {
      projectId: options.projectId,
      source: state.source,
      traceId: state.traceId,
      activityId: state.activityId,
      sourceActivityAt: state.sourceActivityAt,
      runToken: options.runToken
    });
    return true;
  };
  if (await discardIfExpired()) return;
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
  const cutoffAfterWrite = await getEvaluatorImportRetentionCutoff(
    options.pool,
    options.projectId
  );
  if (
    cutoffAfterWrite &&
    Date.parse(snapshot.trace.timestamp) < Date.parse(cutoffAfterWrite)
  ) {
    await tombstoneExpiredImportedTraceSnapshot(
      options.clickhouse,
      options.projectId,
      state.traceId,
      state.sourceActivityAt
    );
    await discardPendingEvaluatorImportSnapshot(options.pool, {
      projectId: options.projectId,
      source: state.source,
      traceId: state.traceId,
      activityId: state.activityId,
      sourceActivityAt: state.sourceActivityAt,
      runToken: options.runToken
    });
    return;
  }
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
    importRunToken: options.runToken,
    importTraceTimestamp: snapshot.trace.timestamp
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
  const legacy = await listLegacyPendingEvaluatorImports(options.pool, options);
  for (const state of legacy) {
    await renewImportRunLease(options.pool, options.projectId, state.source, options.runToken);
    await tombstoneExpiredImportedTraceSnapshot(
      options.clickhouse,
      options.projectId,
      state.traceId,
      state.sourceActivityAt
    );
    await deleteLegacyPendingEvaluatorImport(options.pool, {
      projectId: options.projectId,
      source: state.source,
      traceId: state.traceId,
      activityId: state.activityId,
      runToken: options.runToken
    });
  }
  const pending = await claimPendingEvaluatorImportSnapshots(options.pool, options);
  for (const snapshot of pending) {
    await materializeEvaluatorImportSnapshot(options, snapshot);
  }
  return legacy.length + pending.length;
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
