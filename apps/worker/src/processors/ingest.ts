import type { ClickHouseClient } from "@ironside/clickhouse";
import {
  hasPendingRawObjectRefs,
  insertObservations,
  insertRawEventRefs,
  insertScores,
  insertTraces
} from "@ironside/clickhouse";
import {
  getRawRetentionIntent,
  listEvaluatorPublishedTraceIdsForActivity,
  publishEvaluatorTraceActivities,
  recordIngestFailures,
  withRawRetentionObjectLock,
  type RecordIngestFailureInput
} from "@ironside/db";
import { mapLangfuseIngestionRequest, mapNativeEvents, mapOtlpTraceRequest } from "@ironside/mappers";
import type { IngestBatch, Observation, QueueMessage, Score, Trace } from "@ironside/shared";
import {
  ingestBatchSchema,
  langfuseIngestionRequestSchema,
  otlpExportTraceServiceRequestSchema,
  pendingIngestObjectKeyForRaw
} from "@ironside/shared";
import type { ObjectStorage } from "@ironside/storage";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import { ulid } from "ulid";
import { observeTraceEnvironments } from "../environments/environment-registry.js";

export interface IngestProcessorDeps {
  storage: ObjectStorage;
  clickhouse: ClickHouseClient;
  pool: Pool;
  /** Enables the Postgres coordination/tombstone guard only during an intentional raw-retention rollout. */
  retentionExecutionEnabled?: boolean;
  /** Metrics hook — called once per batch that dead-lettered anything, with the count. */
  onDeadLetter?: (count: number) => void;
  /** Bounded-cardinality metric hook; values/project ids are never labels. */
  onEnvironmentRegistryOverflow?: (count: number) => void;
}

/**
 * A job can fail after its evaluator publication committed but before the
 * final raw-ref acknowledgement. The worker failure hook calls this recovery
 * step so an exhausted post-publication retry cannot leave the feed blocked.
 */
export async function settlePublishedEvaluatorTraceRefs(
  deps: Pick<IngestProcessorDeps, "storage" | "clickhouse" | "pool">,
  message: QueueMessage
): Promise<number> {
  const traceIds = await listEvaluatorPublishedTraceIdsForActivity(deps.pool, {
    projectId: message.projectId,
    activityId: message.batchId
  });
  if (traceIds.length === 0) return 0;
  const batch = ingestBatchSchema.parse(await deps.storage.getJson(message.objectKey));
  await insertRawEventRefs(
    deps.clickhouse,
    traceIds.map((traceId) => ({
      projectId: message.projectId,
      traceId,
      objectKey: message.objectKey,
      receivedAt: batch.receivedAt
    })),
    batch.receivedAt,
    true
  );
  return traceIds.length;
}

/**
 * Terminal jobs with an evaluator publication can safely settle and move to
 * diagnostics. A pre-publication job that already wrote a pending snapshot
 * ref must instead be retried: quarantining its durable intent would strand
 * the trace behind that marker forever.
 */
export async function recoverTerminalEvaluatorTraceRefs(
  deps: Pick<IngestProcessorDeps, "storage" | "clickhouse" | "pool">,
  message: QueueMessage
): Promise<"quarantine" | "retry"> {
  if (await settlePublishedEvaluatorTraceRefs(deps, message) > 0) {
    return "quarantine";
  }
  return await hasPendingRawObjectRefs(
    deps.clickhouse,
    message.projectId,
    message.objectKey
  ) ? "retry" : "quarantine";
}

/**
 * Consumes one queued batch reference: fetch the raw envelope from object
 * storage, map each source's events to domain rows, and batch-insert into
 * ClickHouse. Unmappable individual events are dead-lettered (persisted to
 * ingest_event_failures with a pointer to the raw batch object) and
 * skipped rather than failing the whole batch — one malformed event must
 * not block the rest of a project's traces. The LangFuse compat route's
 * 207 response still optimistically reports every event accepted once the
 * outer envelope parses (the API edge can't see this worker-side mapping
 * outcome — see spec/langfuse-compat-v1.md); the dead-letter table is now
 * the queryable record of what was actually dropped and why.
 *
 * Dead-letter persistence is best-effort: a failure writing the failure
 * rows themselves must never fail the batch (the trace data DID insert) —
 * it logs and falls back to the old log-only behavior for that batch.
 *
 * A storage/ClickHouse failure throws so BullMQ retries the whole job.
 * Retries are safe *for the same batch* because domain rows and raw-event
 * refs use the batch's fixed receivedAt (not wall-clock time) and their
 * ReplacingMergeTree keys eventually collapse duplicates. Dead-letter rows use a per-attempt ulid
 * id, so a retried batch CAN record the same event's failure twice — accepted:
 * duplicates in a diagnostics table are better than inventing a cross-retry
 * idempotency scheme for rows whose whole purpose is "look at me".
 */
export function createIngestProcessor(deps: IngestProcessorDeps) {
  return async function processIngestBatch(job: Job<QueueMessage>): Promise<void> {
    const { projectId, objectKey } = job.data;
    const processUnlocked = async (): Promise<void> => {
      const batch = (await deps.storage.getJson(objectKey)) as IngestBatch;

    const failures: RecordIngestFailureInput[] = [];
    function deadLetter(eventId: string, source: string, eventType: string, error: string): void {
      console.error(`[ingest] batch=${job.data.batchId} event=${eventId} skipped: ${error}`);
      failures.push({
        id: `ingfail_${ulid()}`,
        projectId,
        batchId: batch.batchId,
        objectKey,
        eventId,
        source,
        eventType,
        error
      });
    }

    const { rows: nativeRows, errors } = mapNativeEvents(projectId, batch.events);
    const eventTypeById = new Map(batch.events.map((e) => [e.id, e.type]));
    for (const error of errors) {
      deadLetter(error.eventId, "native", eventTypeById.get(error.eventId) ?? "unknown", error.message);
    }

    const otlpTraces: Trace[] = [];
    const otlpObservations: Observation[] = [];
    const langfuseTraces: Trace[] = [];
    const langfuseObservations: Observation[] = [];
    const langfuseScores: Score[] = [];

    for (const event of batch.events) {
      if (event.source === "otlp" && event.type === "otlp-export") {
        const parsed = otlpExportTraceServiceRequestSchema.safeParse(event.body);
        if (!parsed.success) {
          deadLetter(event.id, "otlp", event.type, "invalid OTLP export body");
          continue;
        }
        const mapped = mapOtlpTraceRequest(projectId, parsed.data);
        otlpTraces.push(...mapped.traces);
        otlpObservations.push(...mapped.observations);
      } else if (event.source === "langfuse" && event.type === "langfuse-ingestion") {
        const parsed = langfuseIngestionRequestSchema.safeParse(event.body);
        if (!parsed.success) {
          deadLetter(event.id, "langfuse", event.type, "invalid LangFuse ingestion body");
          continue;
        }
        const { rows, response } = mapLangfuseIngestionRequest(projectId, parsed.data);
        for (const error of response.errors) {
          // LangFuse batches nest many SDK events inside ONE envelope
          // event; the failure's eventId is the inner LangFuse event's id
          // (what the SDK's 207 response would key on), the most useful
          // identifier for correlating with the raw payload.
          deadLetter(
            String(error.id),
            "langfuse",
            "langfuse-ingestion",
            error.message ?? "event failed LangFuse mapping (no detail provided)"
          );
        }
        langfuseTraces.push(...rows.traces);
        langfuseObservations.push(...rows.observations);
        langfuseScores.push(...rows.scores);
      }
    }

    const traces = [...nativeRows.traces, ...otlpTraces, ...langfuseTraces];
    const observations = [
      ...nativeRows.observations,
      ...otlpObservations,
      ...langfuseObservations
    ];
    const scores = [...nativeRows.scores, ...langfuseScores];
    const traceIds = [
      ...new Set([
        ...traces.map((trace) => trace.id),
        ...observations.map((observation) => observation.traceId),
        ...scores.map((score) => score.traceId)
      ])
    ];

    const rawRefs = traceIds.map((traceId) => ({
      projectId,
      traceId,
      objectKey,
      receivedAt: batch.receivedAt
    }));
    const snapshotTraceIds = new Set([
      ...traces.map((trace) => trace.id),
      ...observations.map((observation) => observation.traceId)
    ]);
    const snapshotRawRefs = rawRefs.filter((ref) => snapshotTraceIds.has(ref.traceId));
    const annotationOnlyRawRefs = rawRefs.filter((ref) => !snapshotTraceIds.has(ref.traceId));

    // Mark only snapshot-affecting refs pending before domain rows become
    // visible. Existing complete traces therefore become conservatively
    // incomplete during the short write window. Score-only refs start applied
    // because annotations never alter evaluator snapshots.
    await Promise.all([
      insertRawEventRefs(deps.clickhouse, snapshotRawRefs, batch.receivedAt, false),
      // Annotation-only rows never affect a trace snapshot, so their raw
      // references can be retention-visible immediately without making
      // evaluator reads wait for score materialization.
      insertRawEventRefs(deps.clickhouse, annotationOnlyRawRefs, batch.receivedAt, true)
    ]);

    const insertOptions = { eventTs: batch.receivedAt };
    await Promise.all([
      insertTraces(deps.clickhouse, traces, insertOptions),
      insertObservations(deps.clickhouse, observations, insertOptions),
      insertScores(deps.clickhouse, scores, insertOptions)
    ]);

    // Discovery is derived, but it is part of this job's durable materialize
    // step: a failure retries the idempotent ClickHouse writes rather than
    // silently leaving the picker stale until a future rebuild.
    await observeTraceEnvironments(
      deps.pool,
      projectId,
      traces,
      deps.onEnvironmentRegistryOverflow
    );

    // Publish only trace/observation activity after every ClickHouse row and
    // its pending raw reference is durable. Scores are downstream annotations
    // and must never reopen or republish an evaluator snapshot. The batch id
    // makes this publication idempotent if final cleanup later makes the job
    // retry. Keep the raw reference pending until after publication so exact
    // evaluator reads cannot observe changed ClickHouse rows under the prior
    // snapshot version.
    await publishEvaluatorTraceActivities(deps.pool, {
      projectId,
      traceIds: [
        ...snapshotTraceIds
      ],
      sourceActivityAt: batch.receivedAt,
      activityId: batch.batchId
    });

    // Applied refs are written last. Until this succeeds evaluator detail
    // reads return 409 and the feed cursor remains retryable. A retry repeats
    // ClickHouse writes but does not mint another feed version.
    await insertRawEventRefs(deps.clickhouse, snapshotRawRefs, batch.receivedAt, true);

    if (failures.length > 0) {
      deps.onDeadLetter?.(failures.length);
      try {
        await recordIngestFailures(deps.pool, failures);
      } catch (error) {
        // Best-effort only — the trace data inserted fine; a diagnostics
        // write must not fail the batch and trigger a full retry.
        console.error(
          `[ingest] batch=${job.data.batchId} failed to persist ${failures.length} dead-letter rows:`,
          error
        );
      }
    }

    // Removing the durable queue intent is the final commit point for this
    // batch. If deletion fails, let BullMQ retry: domain writes are
    // idempotent and leaving the marker behind correctly says recovery is
    // still required. S3 DeleteObject is itself idempotent.
      await deps.storage.delete(pendingIngestObjectKeyForRaw(objectKey));
    };

    if (deps.retentionExecutionEnabled !== true) {
      await processUnlocked();
      return;
    }

    await withRawRetentionObjectLock(deps.pool, projectId, objectKey, async () => {
      const retentionIntent = await getRawRetentionIntent(deps.pool, projectId, objectKey);
      if (retentionIntent?.state === "executing" || retentionIntent?.state === "complete") {
        // An executing intent has crossed the irreversible marker boundary;
        // a complete intent has deleted the raw object. Treat either as a
        // terminal no-op so a delayed/recovered queue job cannot resurrect
        // derived rows after retention. Pending cleanup remains idempotent.
        await deps.storage.delete(pendingIngestObjectKeyForRaw(objectKey));
        return;
      }
      await processUnlocked();
    });
  };
}
