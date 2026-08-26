import {
  getRawObjectRefSnapshot,
  getRetentionVisibleTraceIds,
  getRetentionExpiredTraceIds,
  markRawObjectRefsRetentionExpired,
  recordTraceRawRetentionExpired,
  type ClickHouseClient,
  type RawObjectRefSnapshot
} from "@ironside/clickhouse";
import {
  claimRawRetentionIntentExecution,
  completeRawRetentionIntent,
  deleteIngestFailuresForRetainedObject,
  getProject,
  getRawRetentionIntentsByIds,
  inspectIngestFailuresForObject,
  RAW_RETENTION_EXECUTION_MAX_INTENTS,
  RAW_RETENTION_PREPARATION_MAX_TRACE_ID_BYTES,
  RAW_RETENTION_PREPARATION_MAX_TRACE_IDS,
  recordRawRetentionIntentError,
  withRawRetentionExecutionLock,
  tryWithRawRetentionObjectLock,
  type RawRetentionIntent
} from "@ironside/db";
import {
  failedIngestObjectKey,
  parseRawObjectKey,
  pendingIngestObjectKey,
  type QueueMessage
} from "@ironside/shared";
import type { ObjectStorage } from "@ironside/storage";
import type { Queue } from "bullmq";
import type { Pool } from "pg";
import { verifyPendingIngestStorage } from "../recovery/storage-permissions.js";
import { readRawRetentionFailedDiagnostic } from "./raw-retention-intent-preparer.js";
import { verifyRawRetentionStorage } from "./storage-permissions.js";

const MAX_DIAGNOSTIC_ROWS_PER_INTENT = 1_000;

export type RawRetentionExecutionVeto =
  | "project_missing"
  | "object_lock_unavailable"
  | "policy_changed"
  | "invalid_object_key"
  | "pending_ingest"
  | "queue_not_terminal"
  | "queue_classification_conflict"
  | "raw_object_missing"
  | "raw_object_changed"
  | "failed_diagnostic_invalid"
  | "failed_diagnostic_conflict"
  | "failed_diagnostic_inside_retention_window"
  | "diagnostic_inside_retention_window"
  | "diagnostic_count_increased"
  | "diagnostic_row_cap"
  | "trace_refs_changed"
  | "trace_ref_state_invalid"
  | "query_visible_trace_rows"
  | "no_authoritative_trace_refs"
  | "incomplete_durable_tombstone";

export interface RawRetentionExecutionResult {
  version: 1;
  mode: "execute-prepared-intents";
  destructiveActionsEnabled: true;
  lockAcquired: boolean;
  projectId: string;
  requestedIntentIds: string[];
  completed: { intentId: string; objectKey: string; objectSizeBytes: number }[];
  alreadyComplete: { intentId: string; objectKey: string }[];
  blocked: { intentId: string; objectKey: string; reason: RawRetentionExecutionVeto }[];
}

export interface RawRetentionIntentExecutorOptions {
  pool: Pool;
  clickhouse: ClickHouseClient;
  storage: ObjectStorage;
  queue: Queue<QueueMessage>;
  projectId: string;
  intentIds: string[];
  defaultRetentionDays: number;
  executionEnabled: boolean;
  confirmation: "execute" | "missing";
  now?: Date;
}

class RetentionVetoError extends Error {
  constructor(readonly reason: RawRetentionExecutionVeto) {
    super(reason);
    this.name = "RetentionVetoError";
  }
}

/**
 * Executes only explicitly named durable intents. There is intentionally no
 * discovery, lifecycle-manifest input, scheduler hook, or all-project mode.
 */
export async function executeRawRetentionIntents(
  options: RawRetentionIntentExecutorOptions
): Promise<RawRetentionExecutionResult> {
  if (options.executionEnabled !== true) {
    throw new Error("raw retention execution is disabled");
  }
  if (options.confirmation !== "execute") {
    throw new Error("raw retention execution requires the explicit --execute flag");
  }
  if (!Number.isInteger(options.defaultRetentionDays) || options.defaultRetentionDays < 1) {
    throw new Error("defaultRetentionDays must be a positive integer");
  }
  const intentIds = [...new Set(options.intentIds)];
  if (intentIds.length !== options.intentIds.length) {
    throw new Error("raw retention execution intent ids must be unique");
  }
  if (intentIds.length === 0 || intentIds.length > RAW_RETENTION_EXECUTION_MAX_INTENTS) {
    throw new Error(
      `raw retention execution requires between 1 and ${RAW_RETENTION_EXECUTION_MAX_INTENTS} intent ids`
    );
  }

  const base: RawRetentionExecutionResult = {
    version: 1,
    mode: "execute-prepared-intents",
    destructiveActionsEnabled: true,
    lockAcquired: false,
    projectId: options.projectId,
    requestedIntentIds: intentIds,
    completed: [],
    alreadyComplete: [],
    blocked: []
  };

  const locked = await withRawRetentionExecutionLock(options.pool, async () => {
    const intents = await getRawRetentionIntentsByIds(
      options.pool,
      options.projectId,
      intentIds
    );
    const byId = new Map(intents.map((intent) => [intent.id, intent]));
    const missing = intentIds.filter((intentId) => !byId.has(intentId));
    if (missing.length > 0) {
      throw new Error(`raw retention intents not found for exact project: ${missing.join(", ")}`);
    }
    assertAggregateIntentBudget(intents);

    const result = { ...base, lockAcquired: true };
    const preflight = { sidecarsVerified: false };
    for (const intentId of intentIds) {
      const intent = byId.get(intentId);
      if (!intent) throw new Error(`raw retention intent ${intentId} disappeared`);
      if (intent.state === "complete") {
        result.alreadyComplete.push({ intentId: intent.id, objectKey: intent.objectKey });
        continue;
      }

      const objectLock = await tryWithRawRetentionObjectLock(
        options.pool,
        intent.projectId,
        intent.objectKey,
        async () => {
          const outcome = await executeOne(options, intent, preflight);
          if (outcome === "complete") {
            result.completed.push({
              intentId: intent.id,
              objectKey: intent.objectKey,
              objectSizeBytes: intent.objectSizeBytes
            });
          } else {
            result.blocked.push({
              intentId: intent.id,
              objectKey: intent.objectKey,
              reason: outcome.reason
            });
          }
        }
      );
      if (!objectLock.acquired) {
        await recordRawRetentionIntentError(
          options.pool,
          intent.projectId,
          intent.id,
          "object_lock_unavailable"
        );
        result.blocked.push({
          intentId: intent.id,
          objectKey: intent.objectKey,
          reason: "object_lock_unavailable"
        });
      }
    }
    return result;
  });

  return locked.acquired ? locked.value : base;
}

async function executeOne(
  options: RawRetentionIntentExecutorOptions,
  intent: RawRetentionIntent,
  preflight: { sidecarsVerified: boolean }
): Promise<"complete" | { reason: RawRetentionExecutionVeto }> {
  let irreversible = intent.state === "executing";
  try {
    const now = options.now ?? new Date();
    const parsed = parseRawObjectKey(intent.objectKey);
    if (
      !parsed ||
      parsed.projectId !== intent.projectId ||
      parsed.batchId !== intent.ingestBatchId
    ) {
      throw new RetentionVetoError("invalid_object_key");
    }
    if (intent.traceIds.length === 0) {
      throw new RetentionVetoError("no_authoritative_trace_refs");
    }

    const rawObject = await options.storage.stat(intent.objectKey);
    if (!rawObject && irreversible) {
      await convergePostDelete(options, intent);
      return "complete";
    }
    if (!rawObject) {
      throw new RetentionVetoError("raw_object_missing");
    }
    if (rawObject.sizeBytes !== intent.objectSizeBytes) {
      throw new RetentionVetoError("raw_object_changed");
    }

    // Destructive permission probes belong only on the raw-present path. An
    // executing intent whose raw object is already absent must be able to
    // converge from durable tombstones even if credentials later change.
    await verifyRawRetentionStorage(options.storage, [intent.objectKey]);
    if (!preflight.sidecarsVerified) {
      await verifyPendingIngestStorage(options.storage);
      preflight.sidecarsVerified = true;
    }

    const cutoff = await validatePolicy(options, intent, now);
    if (await options.storage.exists(pendingIngestObjectKey(intent.ingestBatchId))) {
      throw new RetentionVetoError("pending_ingest");
    }
    await validateQueue(options.queue, intent);

    const failedDiagnostic = await readRawRetentionFailedDiagnostic(
      options.storage,
      intent.projectId,
      intent.objectKey,
      intent.ingestBatchId
    );
    if (failedDiagnostic === "invalid") {
      throw new RetentionVetoError("failed_diagnostic_invalid");
    }
    if (intent.classification === "applied" && failedDiagnostic !== null) {
      throw new RetentionVetoError("failed_diagnostic_conflict");
    }
    if (intent.classification === "terminal_failed" && failedDiagnostic === null && !irreversible) {
      throw new RetentionVetoError("failed_diagnostic_conflict");
    }
    if (failedDiagnostic && Date.parse(failedDiagnostic.failedAt) >= cutoff.getTime()) {
      throw new RetentionVetoError("failed_diagnostic_inside_retention_window");
    }

    const diagnostics = await inspectIngestFailuresForObject(
      options.pool,
      intent.projectId,
      intent.objectKey,
      MAX_DIAGNOSTIC_ROWS_PER_INTENT
    );
    if (diagnostics.truncated) throw new RetentionVetoError("diagnostic_row_cap");
    if (diagnostics.count > intent.diagnosticCount) {
      throw new RetentionVetoError("diagnostic_count_increased");
    }
    if (diagnostics.newestCreatedAt && diagnostics.newestCreatedAt >= cutoff) {
      throw new RetentionVetoError("diagnostic_inside_retention_window");
    }

    let refs = await getExactIntentRefs(options.clickhouse, intent);
    if (!irreversible && refs.refs.some((ref) => ref.applied === 2)) {
      throw new RetentionVetoError("trace_ref_state_invalid");
    }
    if (
      !irreversible &&
      intent.classification === "applied" &&
      refs.refs.some((ref) => ref.applied !== 1)
    ) {
      throw new RetentionVetoError("trace_ref_state_invalid");
    }
    if (refs.refs.some((ref) => ![0, 1, 2].includes(ref.applied))) {
      throw new RetentionVetoError("trace_ref_state_invalid");
    }
    if (refs.refs.some((ref) => !ref.receivedAt)) {
      throw new RetentionVetoError("trace_refs_changed");
    }
    const visible = await getRetentionVisibleTraceIds(
      options.clickhouse,
      intent.projectId,
      intent.traceIds
    );
    if (visible.size > 0) throw new RetentionVetoError("query_visible_trace_rows");

    const existingMarkers = await getRetentionExpiredTraceIds(
      options.clickhouse,
      intent.projectId,
      intent.traceIds
    );
    const claimed = await claimRawRetentionIntentExecution(
      options.pool,
      intent.projectId,
      intent.id
    );
    if (!claimed) throw new Error(`raw retention intent ${intent.id} could not be claimed`);
    irreversible = true;

    const expiredAt = now.toISOString();
    await recordTraceRawRetentionExpired(
      options.clickhouse,
      intent.traceIds.filter((traceId) => !existingMarkers.has(traceId)).map((traceId) => ({
        projectId: intent.projectId,
        traceId,
        expiredAt
      }))
    );
    const markers = await getRetentionExpiredTraceIds(
      options.clickhouse,
      intent.projectId,
      intent.traceIds
    );
    if (!allMarkersPresent(intent, markers)) {
      throw new Error("raw retention marker verification failed");
    }

    await markRawObjectRefsRetentionExpired(
      options.clickhouse,
      refs.refs.filter((ref) => ref.applied !== 2).map((ref) => ({
        projectId: intent.projectId,
        traceId: ref.traceId,
        objectKey: intent.objectKey,
        receivedAt: ref.receivedAt!
      })),
      expiredAt
    );
    refs = await getExactIntentRefs(options.clickhouse, intent);
    if (refs.refs.some((ref) => ref.applied !== 2)) {
      throw new Error("raw retention ref tombstone verification failed");
    }

    await deleteIngestFailuresForRetainedObject(
      options.pool,
      intent.projectId,
      intent.objectKey,
      MAX_DIAGNOSTIC_ROWS_PER_INTENT
    );

    const failedKey = failedIngestObjectKey(intent.ingestBatchId);
    if (await options.storage.exists(failedKey)) {
      await options.storage.delete(failedKey);
      if (await options.storage.exists(failedKey)) {
        throw new Error("raw retention failed-sidecar deletion verification failed");
      }
    }

    if (await options.storage.exists(pendingIngestObjectKey(intent.ingestBatchId))) {
      throw new RetentionVetoError("pending_ingest");
    }
    await validateQueue(options.queue, intent);

    if (await options.storage.exists(intent.objectKey)) {
      await options.storage.delete(intent.objectKey);
    }
    if (await options.storage.exists(intent.objectKey)) {
      throw new Error("raw retention raw-object deletion verification failed");
    }
    if (!(await completeRawRetentionIntent(options.pool, intent.projectId, intent.id))) {
      throw new Error(`raw retention intent ${intent.id} could not be completed`);
    }
    return "complete";
  } catch (error) {
    if (error instanceof RetentionVetoError) {
      await recordRawRetentionIntentError(
        options.pool,
        intent.projectId,
        intent.id,
        error.reason
      );
      return { reason: error.reason };
    }
    if (irreversible) {
      await recordRawRetentionIntentError(
        options.pool,
        intent.projectId,
        intent.id,
        error instanceof Error ? error.message : "unknown raw retention execution error"
      );
    }
    throw error;
  }
}

/**
 * After the raw delete succeeds, mutable policy/queue/domain state can no
 * longer veto audit convergence. Only immutable identity plus already-written
 * trace/ref tombstones prove this is a resumable post-delete state.
 */
async function convergePostDelete(
  options: RawRetentionIntentExecutorOptions,
  intent: RawRetentionIntent
): Promise<void> {
  const refs = await getExactIntentRefs(options.clickhouse, intent);
  if (refs.refs.some((ref) => ref.applied !== 2 || !ref.receivedAt)) {
    throw new RetentionVetoError("incomplete_durable_tombstone");
  }
  const markers = await getRetentionExpiredTraceIds(
    options.clickhouse,
    intent.projectId,
    intent.traceIds
  );
  if (!allMarkersPresent(intent, markers)) {
    throw new RetentionVetoError("incomplete_durable_tombstone");
  }
  if (!(await completeRawRetentionIntent(options.pool, intent.projectId, intent.id))) {
    throw new Error(`raw retention intent ${intent.id} could not be completed`);
  }
}

async function validatePolicy(
  options: RawRetentionIntentExecutorOptions,
  intent: RawRetentionIntent,
  now: Date
): Promise<Date> {
  const project = await getProject(options.pool, intent.projectId);
  if (!project) throw new RetentionVetoError("project_missing");
  const retentionDays = project.retentionDays ?? options.defaultRetentionDays;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new RetentionVetoError("policy_changed");
  }
  const cutoffDay = new Date(
    now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  ).toISOString().slice(0, 10);
  const parsed = parseRawObjectKey(intent.objectKey);
  if (!parsed || parsed.day >= cutoffDay) {
    throw new RetentionVetoError("policy_changed");
  }
  return new Date(`${cutoffDay}T00:00:00.000Z`);
}

async function validateQueue(
  queue: Queue<QueueMessage>,
  intent: RawRetentionIntent
): Promise<void> {
  const job = await queue.getJob(intent.ingestBatchId);
  const state = job ? await job.getState() : "absent";
  if (state !== "absent" && state !== "completed" && state !== "failed") {
    throw new RetentionVetoError("queue_not_terminal");
  }
  if (
    (intent.classification === "applied" && state === "failed") ||
    (intent.classification === "terminal_failed" && state === "completed")
  ) {
    throw new RetentionVetoError("queue_classification_conflict");
  }
}

async function getExactIntentRefs(
  clickhouse: ClickHouseClient,
  intent: RawRetentionIntent
): Promise<RawObjectRefSnapshot> {
  const snapshot = await getRawObjectRefSnapshot(
    clickhouse,
    intent.projectId,
    intent.objectKey,
    Math.max(intent.traceIds.length, 1)
  );
  const expected = [...intent.traceIds].sort();
  const actual = snapshot.refs.map((ref) => ref.traceId).sort();
  if (
    snapshot.truncated ||
    actual.length !== expected.length ||
    actual.some((traceId, index) => traceId !== expected[index])
  ) {
    throw new RetentionVetoError("trace_refs_changed");
  }
  return snapshot;
}

function allMarkersPresent(
  intent: RawRetentionIntent,
  markers: Set<string>
): boolean {
  return intent.traceIds.every((traceId) => markers.has(traceId));
}

function assertAggregateIntentBudget(intents: RawRetentionIntent[]): void {
  let traceIds = 0;
  let traceIdBytes = 0;
  for (const intent of intents) {
    traceIds += intent.traceIds.length;
    traceIdBytes += 2;
    for (const traceId of intent.traceIds) {
      traceIdBytes += Buffer.byteLength(JSON.stringify(traceId), "utf8") + 2;
    }
  }
  if (traceIds > RAW_RETENTION_PREPARATION_MAX_TRACE_IDS) {
    throw new Error(
      `raw retention execution exceeds the ${RAW_RETENTION_PREPARATION_MAX_TRACE_IDS} aggregate trace-id cap`
    );
  }
  if (traceIdBytes > RAW_RETENTION_PREPARATION_MAX_TRACE_ID_BYTES) {
    throw new Error(
      `raw retention execution exceeds the ${RAW_RETENTION_PREPARATION_MAX_TRACE_ID_BYTES} aggregate trace-id byte cap`
    );
  }
}
