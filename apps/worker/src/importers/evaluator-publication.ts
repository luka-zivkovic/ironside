import { createHash } from "node:crypto";
import {
  insertObservations,
  insertScores,
  insertTraces,
  recordExpiredEvaluatorTraceId,
  tombstoneImportedScores,
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
  withEvaluatorDataWriteFence,
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

/** Stable identity for the complete provider-owned import snapshot. */
export function importedTraceContentHash(
  trace: Trace,
  observations: Observation[],
  scores: EvaluatorImportTraceSnapshot["scores"]
): string {
  const snapshot = {
    trace,
    observations: [...observations].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    scores: [...scores].sort((a, b) => {
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      const aTimestamp = a.timestamp ?? "";
      const bTimestamp = b.timestamp ?? "";
      return aTimestamp < bTimestamp ? -1 : aTimestamp > bTimestamp ? 1 : 0;
    })
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)))
    .digest("hex");
}

/** Identity of the trace tree exposed through the evaluator protocol. */
export function importedEvaluatorTraceContentHash(
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
  scores: EvaluatorImportTraceSnapshot["scores"]
): EvaluatorImportTraceSnapshot {
  return validateSnapshot({
    trace,
    observations: observations.filter((observation) => observation.traceId === trace.id),
    scores: scores.filter((score) => score.traceId === trace.id)
  });
}

function validateSnapshot(
  snapshot: EvaluatorImportTraceSnapshot,
  expected?: { projectId: string; traceId: string }
): EvaluatorImportTraceSnapshot {
  const trace = traceSchema.parse(snapshot.trace);
  const observations = snapshot.observations.map((observation) => observationSchema.parse(observation));
  const scores = snapshot.scores.map((score) => {
    const parsed = scoreSchema.parse(score);
    // ClickHouse's score key includes toDate(timestamp). Provider feedback
    // timestamps are optional, so letting the database choose now() would
    // create a second logical key when a durable retry crosses UTC midnight.
    // The parent trace timestamp is stable, source-derived, and already part
    // of this durable snapshot.
    return parsed.timestamp ? parsed : { ...parsed, timestamp: trace.timestamp };
  });
  if (
    (expected && (trace.id !== expected.traceId || trace.projectId !== expected.projectId)) ||
    observations.some((observation) => observation.traceId !== trace.id) ||
    scores.some((score) => score.traceId !== trace.id) ||
    observations.some((observation) => observation.projectId !== trace.projectId) ||
    scores.some((score) => score.projectId !== trace.projectId)
  ) {
    throw new Error(`imported evaluator snapshot mixes trace identities: ${trace.id}`);
  }
  return { trace, observations, scores };
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
  await withEvaluatorDataWriteFence(options.pool, async () => {
    await renewImportRunLease(options.pool, options.projectId, state.source, options.runToken);
    const snapshot = validateSnapshot(state.snapshot, {
      projectId: options.projectId,
      traceId: state.traceId
    });
    const discardIfExpired = async (): Promise<boolean> => {
      const cutoff = await getEvaluatorImportRetentionCutoff(options.pool, options.projectId);
      if (!cutoff) {
        throw new Error(`evaluator import retention cutoff is not initialized: ${options.projectId}`);
      }
      if (Date.parse(snapshot.trace.timestamp) >= Date.parse(cutoff)) return false;
      // A prior attempt may have written ClickHouse and then lost the cutoff
      // race at the fenced PG publication. Tombstone idempotently before
      // clearing the durable recovery barrier even when this attempt itself has
      // not written yet.
      // Persist the exact expired parent first. A concurrent/delayed score can
      // arrive after this tombstone; the retention marker lets every later
      // sweep remove such orphan children even though the parent is gone.
      await recordExpiredEvaluatorTraceId(
        options.clickhouse,
        options.projectId,
        state.traceId
      );
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
    if (!state.publishRequired) {
      await tombstoneImportedScores(
        options.clickhouse,
        options.projectId,
        state.traceId,
        state.sourceActivityAt,
        state.source
      );
      await insertScores(options.clickhouse, snapshot.scores, {
        eventTs: state.sourceActivityAt,
        importSource: state.source
      });
      if (await discardIfExpired()) return;
      // This transaction clears the durable pending snapshot but, because PG
      // recorded publish_required=false, leaves the evaluator feed/version
      // unchanged. Provider annotations never reopen a trace.
      await publishEvaluatorTraceActivities(options.pool, {
        projectId: options.projectId,
        traceIds: [state.traceId],
        sourceActivityAt: state.sourceActivityAt,
        activityId: state.activityId,
        importSource: state.source,
        importRunToken: options.runToken,
        importTraceTimestamp: snapshot.trace.timestamp
      });
      return;
    }
    await tombstoneImportedTraceSnapshot(
      options.clickhouse,
      options.projectId,
      state.traceId,
      state.sourceActivityAt,
      state.source
    );
    await Promise.all([
      insertTraces(options.clickhouse, [snapshot.trace], { eventTs: state.sourceActivityAt }),
      insertObservations(options.clickhouse, snapshot.observations, {
        eventTs: state.sourceActivityAt
      }),
      insertScores(options.clickhouse, snapshot.scores, {
        // Use the monotonic generation allocated by Postgres, not the wall
        // clock captured before staging. Two changed snapshots can otherwise
        // share a millisecond (or the clock can move backwards), leaving the
        // generation tombstone newer than the replacement score rows.
        eventTs: state.sourceActivityAt,
        importSource: state.source
      })
    ]);
    const cutoffAfterWrite = await getEvaluatorImportRetentionCutoff(
      options.pool,
      options.projectId
    );
    if (!cutoffAfterWrite) {
      throw new Error(`evaluator import retention cutoff disappeared: ${options.projectId}`);
    }
    if (
      Date.parse(snapshot.trace.timestamp) < Date.parse(cutoffAfterWrite)
    ) {
      await recordExpiredEvaluatorTraceId(
        options.clickhouse,
        options.projectId,
        state.traceId
      );
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
    await withEvaluatorDataWriteFence(options.pool, async () => {
      await renewImportRunLease(options.pool, options.projectId, state.source, options.runToken);
      await tombstoneExpiredImportedTraceSnapshot(
        options.clickhouse,
        options.projectId,
        state.traceId,
        state.sourceActivityAt,
        state.source
      );
      await deleteLegacyPendingEvaluatorImport(options.pool, {
        projectId: options.projectId,
        source: state.source,
        traceId: state.traceId,
        activityId: state.activityId,
        runToken: options.runToken
      });
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
