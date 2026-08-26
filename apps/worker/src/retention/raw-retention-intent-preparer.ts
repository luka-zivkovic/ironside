import {
  getRawObjectRefSnapshot,
  getRetentionVisibleTraceIds,
  type ClickHouseClient
} from "@ironside/clickhouse";
import {
  createRawRetentionIntents,
  getProject,
  inspectIngestFailuresForObject,
  RAW_RETENTION_INTENT_MAX_TRACE_IDS,
  RAW_RETENTION_PREPARATION_MAX_BYTES,
  RAW_RETENTION_PREPARATION_MAX_OBJECTS,
  RAW_RETENTION_PREPARATION_MAX_TRACE_ID_BYTES,
  RAW_RETENTION_PREPARATION_MAX_TRACE_IDS,
  type CreateRawRetentionIntentInput,
  type RawRetentionClassification
} from "@ironside/db";
import {
  failedIngestDiagnosticSchema,
  failedIngestObjectKey,
  parseRawObjectKey,
  pendingIngestObjectKey,
  type FailedIngestDiagnostic,
  type QueueMessage
} from "@ironside/shared";
import {
  InvalidJsonObjectError,
  isObjectNotFoundError,
  ObjectTooLargeError,
  type ObjectStorage,
  type StoredObject
} from "@ironside/storage";
import type { Queue } from "bullmq";
import type { Pool } from "pg";
import { ulid } from "ulid";

export const RAW_RETENTION_PREPARE_MAX_OBJECTS = RAW_RETENTION_PREPARATION_MAX_OBJECTS;
export const RAW_RETENTION_PREPARE_MAX_BYTES = RAW_RETENTION_PREPARATION_MAX_BYTES;
export const RAW_RETENTION_PREPARE_MAX_TRACE_REFS = RAW_RETENTION_INTENT_MAX_TRACE_IDS;
export const RAW_RETENTION_FAILED_DIAGNOSTIC_MAX_BYTES = 64 * 1024;
export const RAW_RETENTION_DIAGNOSTIC_MAX_ROWS_PER_OBJECT = 1_000;
export const RAW_RETENTION_DIAGNOSTIC_MAX_ROWS_PER_PREPARATION = 10_000;

export type RawRetentionSkipReason =
  | "invalid_object_key"
  | "wrong_project"
  | "inside_retention_window"
  | "object_not_found"
  | "already_prepared"
  | "pending_ingest"
  | "queue_not_terminal"
  | "failed_diagnostic_invalid"
  | "failed_diagnostic_conflict"
  | "failed_diagnostic_inside_retention_window"
  | "diagnostic_inside_retention_window"
  | "diagnostic_row_cap"
  | "trace_ref_state_invalid"
  | "pending_trace_refs"
  | "no_authoritative_trace_refs"
  | "query_visible_trace_rows";

export interface RawRetentionIntentPreparationResult {
  version: 1;
  mode: "prepare-only";
  destructiveActionsEnabled: false;
  preparationId: string;
  projectId: string;
  cutoffDay: string;
  effectiveRetentionDays: number;
  requestedObjects: number;
  examinedBytes: number;
  examinedDiagnosticBytes: number;
  examinedTraceRefs: number;
  examinedDiagnosticRows: number;
  prepared: { intentId: string; objectKey: string; classification: RawRetentionClassification }[];
  skipped: { objectKey: string; reason: RawRetentionSkipReason }[];
}

export interface RawRetentionIntentPreparerOptions {
  pool: Pool;
  clickhouse: ClickHouseClient;
  storage: ObjectStorage;
  queue: Queue<QueueMessage>;
  projectId: string;
  objectKeys: string[];
  defaultRetentionDays: number;
  now?: Date;
  preparationId?: string;
}

interface CandidateObject {
  objectKey: string;
  batchId: string;
  metadata: StoredObject;
}

interface EligibleCandidate {
  candidate: CandidateObject;
  traceIds: string[];
  classification: RawRetentionClassification;
  diagnosticCount: number;
}

/**
 * Converts an explicit, exact-project object list into durable prepared work.
 * This function has no delete or mutation access outside Postgres intent
 * creation. Every uncertainty is a skip or a thrown dependency error.
 */
export async function prepareRawRetentionIntents(
  options: RawRetentionIntentPreparerOptions
): Promise<RawRetentionIntentPreparationResult> {
  const uniqueObjectKeys = [...new Set(options.objectKeys)];
  if (uniqueObjectKeys.length === 0) {
    throw new Error("raw retention preparation requires at least one object key");
  }
  if (uniqueObjectKeys.length > RAW_RETENTION_PREPARE_MAX_OBJECTS) {
    throw new Error(
      `raw retention preparation is capped at ${RAW_RETENTION_PREPARE_MAX_OBJECTS} objects`
    );
  }
  if (!Number.isInteger(options.defaultRetentionDays) || options.defaultRetentionDays < 1) {
    throw new Error("defaultRetentionDays must be a positive integer");
  }

  const project = await getProject(options.pool, options.projectId);
  if (!project) throw new Error(`project ${options.projectId} does not exist`);
  const effectiveRetentionDays = project.retentionDays ?? options.defaultRetentionDays;
  if (!Number.isInteger(effectiveRetentionDays) || effectiveRetentionDays < 1) {
    throw new Error(`project ${options.projectId} has an invalid retention policy`);
  }
  const now = options.now ?? new Date();
  const cutoffDay = new Date(
    now.getTime() - effectiveRetentionDays * 24 * 60 * 60 * 1000
  ).toISOString().slice(0, 10);
  const cutoffInstant = new Date(`${cutoffDay}T00:00:00.000Z`);
  const preparationId = options.preparationId ?? `rtp_${ulid()}`;
  const skipped: RawRetentionIntentPreparationResult["skipped"] = [];
  const candidates: CandidateObject[] = [];
  let examinedBytes = 0;
  let examinedDiagnosticBytes = 0;
  let examinedTraceRefs = 0;
  let examinedTraceIdBytes = 0;
  let examinedDiagnosticRows = 0;

  // Preflight every exact object and the aggregate byte cap before writing a
  // single intent. A too-large request therefore cannot partially prepare.
  for (const objectKey of uniqueObjectKeys) {
    const parsed = parseRawObjectKey(objectKey);
    if (!parsed) {
      skipped.push({ objectKey, reason: "invalid_object_key" });
      continue;
    }
    if (parsed.projectId !== options.projectId) {
      skipped.push({ objectKey, reason: "wrong_project" });
      continue;
    }
    if (parsed.day >= cutoffDay) {
      skipped.push({ objectKey, reason: "inside_retention_window" });
      continue;
    }
    const metadata = await options.storage.stat(objectKey);
    if (!metadata) {
      skipped.push({ objectKey, reason: "object_not_found" });
      continue;
    }
    examinedBytes += metadata.sizeBytes;
    if (examinedBytes > RAW_RETENTION_PREPARE_MAX_BYTES) {
      throw new Error(
        `raw retention preparation exceeds the ${RAW_RETENTION_PREPARE_MAX_BYTES} byte cap`
      );
    }
    candidates.push({ objectKey, batchId: parsed.batchId, metadata });
  }

  const eligible: EligibleCandidate[] = [];
  for (const candidate of candidates) {
    if (await options.storage.exists(pendingIngestObjectKey(candidate.batchId))) {
      skipped.push({ objectKey: candidate.objectKey, reason: "pending_ingest" });
      continue;
    }

    const failedDiagnostic = await readRawRetentionFailedDiagnostic(
      options.storage,
      options.projectId,
      candidate.objectKey,
      candidate.batchId
    );
    if (failedDiagnostic === "invalid") {
      skipped.push({ objectKey: candidate.objectKey, reason: "failed_diagnostic_invalid" });
      continue;
    }
    if (failedDiagnostic !== null) {
      examinedDiagnosticBytes += failedDiagnostic.sizeBytes;
    }
    if (
      failedDiagnostic !== null &&
      Date.parse(failedDiagnostic.failedAt) >= cutoffInstant.getTime()
    ) {
      skipped.push({
        objectKey: candidate.objectKey,
        reason: "failed_diagnostic_inside_retention_window"
      });
      continue;
    }

    const job = await options.queue.getJob(candidate.batchId);
    const jobState = job ? await job.getState() : "absent";
    if (jobState !== "absent" && jobState !== "completed" && jobState !== "failed") {
      skipped.push({ objectKey: candidate.objectKey, reason: "queue_not_terminal" });
      continue;
    }
    if (
      (jobState === "failed" && failedDiagnostic === null) ||
      (jobState === "completed" && failedDiagnostic !== null)
    ) {
      skipped.push({ objectKey: candidate.objectKey, reason: "failed_diagnostic_conflict" });
      continue;
    }

    const classification: RawRetentionClassification | null =
      failedDiagnostic !== null && (jobState === "failed" || jobState === "absent")
        ? "terminal_failed"
        : jobState === "completed" || jobState === "absent"
          ? "applied"
          : null;
    if (!classification) {
      skipped.push({ objectKey: candidate.objectKey, reason: "queue_not_terminal" });
      continue;
    }

    const remainingTraceRefBudget =
      RAW_RETENTION_PREPARATION_MAX_TRACE_IDS - examinedTraceRefs;
    if (remainingTraceRefBudget < 1) {
      throw new Error(
        `raw retention preparation reached the ${RAW_RETENTION_PREPARATION_MAX_TRACE_IDS} aggregate trace-id cap`
      );
    }
    const refQueryLimit = Math.min(
      RAW_RETENTION_PREPARE_MAX_TRACE_REFS,
      remainingTraceRefBudget
    );
    const refs = await getRawObjectRefSnapshot(
      options.clickhouse,
      options.projectId,
      candidate.objectKey,
      refQueryLimit
    );
    examinedTraceRefs += refs.refs.length + (refs.truncated ? 1 : 0);
    examinedTraceIdBytes += 2;
    for (const ref of refs.refs) {
      examinedTraceIdBytes += Buffer.byteLength(JSON.stringify(ref.traceId), "utf8") + 2;
    }
    if (examinedTraceRefs > RAW_RETENTION_PREPARATION_MAX_TRACE_IDS) {
      throw new Error(
        `raw retention preparation exceeds the ${RAW_RETENTION_PREPARATION_MAX_TRACE_IDS} aggregate trace-id cap`
      );
    }
    if (examinedTraceIdBytes > RAW_RETENTION_PREPARATION_MAX_TRACE_ID_BYTES) {
      throw new Error(
        `raw retention preparation exceeds the ${RAW_RETENTION_PREPARATION_MAX_TRACE_ID_BYTES} aggregate trace-id byte cap`
      );
    }
    if (refs.truncated) {
      throw new Error(
        `raw retention object ${candidate.objectKey} exceeds the remaining ${refQueryLimit}-ref preparation budget`
      );
    }
    if (refs.refs.some((ref) => ref.applied !== 0 && ref.applied !== 1)) {
      skipped.push({ objectKey: candidate.objectKey, reason: "trace_ref_state_invalid" });
      continue;
    }
    if (classification === "applied" && refs.refs.some((ref) => ref.applied === 0)) {
      skipped.push({ objectKey: candidate.objectKey, reason: "pending_trace_refs" });
      continue;
    }
    if (refs.refs.length === 0) {
      skipped.push({ objectKey: candidate.objectKey, reason: "no_authoritative_trace_refs" });
      continue;
    }

    const traceIds = [...new Set(refs.refs.map((ref) => ref.traceId))];

    const remainingDiagnosticRowBudget =
      RAW_RETENTION_DIAGNOSTIC_MAX_ROWS_PER_PREPARATION - examinedDiagnosticRows;
    if (remainingDiagnosticRowBudget < 1) {
      throw new Error(
        `raw retention preparation reached the ${RAW_RETENTION_DIAGNOSTIC_MAX_ROWS_PER_PREPARATION} aggregate diagnostic-row cap`
      );
    }
    const diagnosticQueryLimit = Math.min(
      RAW_RETENTION_DIAGNOSTIC_MAX_ROWS_PER_OBJECT,
      remainingDiagnosticRowBudget
    );
    const diagnostics = await inspectIngestFailuresForObject(
      options.pool,
      options.projectId,
      candidate.objectKey,
      diagnosticQueryLimit
    );
    examinedDiagnosticRows += diagnostics.count + (diagnostics.truncated ? 1 : 0);
    if (examinedDiagnosticRows > RAW_RETENTION_DIAGNOSTIC_MAX_ROWS_PER_PREPARATION) {
      throw new Error(
        `raw retention preparation exceeds the ${RAW_RETENTION_DIAGNOSTIC_MAX_ROWS_PER_PREPARATION} aggregate diagnostic-row cap`
      );
    }
    if (diagnostics.truncated) {
      skipped.push({ objectKey: candidate.objectKey, reason: "diagnostic_row_cap" });
      continue;
    }
    if (diagnostics.newestCreatedAt && diagnostics.newestCreatedAt >= cutoffInstant) {
      skipped.push({
        objectKey: candidate.objectKey,
        reason: "diagnostic_inside_retention_window"
      });
      continue;
    }

    eligible.push({
      candidate,
      traceIds,
      classification,
      diagnosticCount: diagnostics.count
    });
  }

  // One aggregate, resource-bounded three-table FINAL check replaces up to
  // 100 independent scans. A limit/timeout/availability error aborts before
  // any intent write.
  const visibilityTraceIds = [...new Set(eligible.flatMap((entry) => entry.traceIds))];
  const visibleTraceIds = await getRetentionVisibleTraceIds(
    options.clickhouse,
    options.projectId,
    visibilityTraceIds
  );
  const preparedInputs: CreateRawRetentionIntentInput[] = [];
  for (const entry of eligible) {
    if (entry.traceIds.some((traceId) => visibleTraceIds.has(traceId))) {
      skipped.push({ objectKey: entry.candidate.objectKey, reason: "query_visible_trace_rows" });
      continue;
    }
    preparedInputs.push({
      id: `rti_${ulid()}`,
      preparationId,
      projectId: options.projectId,
      ingestBatchId: entry.candidate.batchId,
      objectKey: entry.candidate.objectKey,
      objectSizeBytes: entry.candidate.metadata.sizeBytes,
      retentionCutoffDay: cutoffDay,
      effectiveRetentionDays,
      traceIds: entry.traceIds,
      classification: entry.classification,
      diagnosticCount: entry.diagnosticCount
    });
  }

  const inserted = await createRawRetentionIntents(options.pool, preparedInputs);
  const insertedByKey = new Map(inserted.map((intent) => [intent.objectKey, intent]));
  for (const input of preparedInputs) {
    if (!insertedByKey.has(input.objectKey)) {
      skipped.push({ objectKey: input.objectKey, reason: "already_prepared" });
    }
  }
  const requestedOrder = new Map(uniqueObjectKeys.map((objectKey, index) => [objectKey, index]));
  skipped.sort(
    (left, right) =>
      (requestedOrder.get(left.objectKey) ?? Number.MAX_SAFE_INTEGER) -
      (requestedOrder.get(right.objectKey) ?? Number.MAX_SAFE_INTEGER)
  );

  return {
    version: 1,
    mode: "prepare-only",
    destructiveActionsEnabled: false,
    preparationId,
    projectId: options.projectId,
    cutoffDay,
    effectiveRetentionDays,
    requestedObjects: uniqueObjectKeys.length,
    examinedBytes,
    examinedDiagnosticBytes,
    examinedTraceRefs,
    examinedDiagnosticRows,
    prepared: inserted.map((intent) => ({
      intentId: intent.id,
      objectKey: intent.objectKey,
      classification: intent.classification
    })),
    skipped
  };
}

export async function readRawRetentionFailedDiagnostic(
  storage: ObjectStorage,
  projectId: string,
  objectKey: string,
  batchId: string
): Promise<(FailedIngestDiagnostic & { sizeBytes: number }) | "invalid" | null> {
  const key = failedIngestObjectKey(batchId);
  const metadata = await storage.stat(key);
  if (!metadata) return null;
  if (metadata.sizeBytes > RAW_RETENTION_FAILED_DIAGNOSTIC_MAX_BYTES) return "invalid";
  let stored: unknown;
  try {
    stored = await storage.getJson(key, {
      maxBytes: RAW_RETENTION_FAILED_DIAGNOSTIC_MAX_BYTES
    });
  } catch (error) {
    if (isObjectNotFoundError(error)) return null;
    if (error instanceof InvalidJsonObjectError || error instanceof ObjectTooLargeError) {
      return "invalid";
    }
    throw error;
  }
  const parsed = failedIngestDiagnosticSchema.safeParse(stored);
  if (!parsed.success) return "invalid";
  if (
    parsed.data.batchId !== batchId ||
    parsed.data.projectId !== projectId ||
    parsed.data.objectKey !== objectKey
  ) {
    return "invalid";
  }
  return { ...parsed.data, sizeBytes: metadata.sizeBytes };
}
