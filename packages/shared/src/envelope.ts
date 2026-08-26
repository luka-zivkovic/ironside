import { z } from "zod";

// Trace envelope v1 — see spec/trace-envelope-v1.md.
// Every ingest path (native JSON, OTLP, LangFuse-compat, importers) converges
// on this envelope. The API validates only the envelope, persists batches to
// object storage verbatim, and queues a reference; workers own interpretation
// of the source-shaped `body`.

export const INGEST_SCHEMA_VERSION = 1;

/** Hard cap on events per batch; larger client batches must be split. */
export const MAX_EVENTS_PER_BATCH = 500;

export const ingestEventTypeSchema = z.enum([
  "trace-upsert",
  "observation-upsert",
  "score-upsert",
  /** body is a raw OTLP ExportTraceServiceRequest, exploded by the worker's OTLP mapper into many trace/observation rows. */
  "otlp-export",
  /** body is a raw LangFuse ingestion batch ({batch, metadata}), exploded by the worker's LangFuse mapper. */
  "langfuse-ingestion"
]);
export type IngestEventType = z.infer<typeof ingestEventTypeSchema>;

export const ingestSourceSchema = z.enum([
  "native",
  "otlp",
  "langfuse",
  "import-langfuse",
  "import-langsmith"
]);
export type IngestSource = z.infer<typeof ingestSourceSchema>;

export const ingestEventSchema = z.object({
  /** ULID, generated at the edge if the client did not supply one. */
  id: z.string().min(1),
  type: ingestEventTypeSchema,
  source: ingestSourceSchema,
  schemaVersion: z.literal(INGEST_SCHEMA_VERSION),
  /** Client-provided key or SHA-256 content hash of `body`. */
  idempotencyKey: z.string().min(1),
  /** Source-shaped payload; the worker mapper owns interpretation. */
  body: z.unknown()
});
export type IngestEvent = z.infer<typeof ingestEventSchema>;

/** Unit of storage and queueing: one object in the raw event log. */
export const ingestBatchSchema = z.object({
  batchId: z.string().min(1),
  /** Resolved from the machine credential server-side, never client-trusted. */
  projectId: z.string().min(1),
  /** ISO 8601, API clock. */
  receivedAt: z.iso.datetime(),
  events: z.array(ingestEventSchema).min(1).max(MAX_EVENTS_PER_BATCH)
});
export type IngestBatch = z.infer<typeof ingestBatchSchema>;

/**
 * Queue message referencing a stored batch. Payloads never enter Redis —
 * workers fetch the batch from object storage by key.
 */
export const queueMessageSchema = z.object({
  batchId: z.string().min(1),
  projectId: z.string().min(1),
  objectKey: z.string().min(1),
  eventCount: z.number().int().positive(),
  /** API acceptance time used to bound restart-safe recovery scan cycles. */
  intentCreatedAt: z.iso.datetime().optional()
});
export type QueueMessage = z.infer<typeof queueMessageSchema>;

/** Durable terminal-failure sidecar written after BullMQ exhausts retries. */
export const failedIngestDiagnosticSchema = queueMessageSchema.extend({
  failedAt: z.iso.datetime(),
  attemptsMade: z.number().int().nonnegative(),
  reason: z.string().min(1).max(2_000)
});
export type FailedIngestDiagnostic = z.infer<typeof failedIngestDiagnosticSchema>;

/**
 * Day prefix of the raw event log: raw/{projectId}/{yyyy}/{mm}/{dd}/ (UTC).
 * Single source of truth for the key layout — rawObjectKey builds on it,
 * and readers (the raw-events lookup) scan by it, so the two can never
 * drift apart.
 */
export function rawDayPrefix(projectId: string, date: Date): string {
  const yyyy = date.getUTCFullYear().toString().padStart(4, "0");
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = date.getUTCDate().toString().padStart(2, "0");
  return `raw/${projectId}/${yyyy}/${mm}/${dd}/`;
}

/** Object storage key for a raw batch: raw/{projectId}/{yyyy}/{mm}/{dd}/{batchId}.json */
export function rawObjectKey(
  projectId: string,
  receivedAt: Date,
  batchId: string
): string {
  return `${rawDayPrefix(projectId, receivedAt)}${batchId}.json`;
}

export interface ParsedRawObjectKey {
  projectId: string;
  day: string;
  batchId: string;
}

/** Strict parser for the canonical raw/{project}/{yyyy}/{mm}/{dd}/{batch}.json layout. */
export function parseRawObjectKey(rawKey: string): ParsedRawObjectKey | null {
  const match = /^raw\/([^/]+)\/(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)\.json$/.exec(rawKey);
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) return null;
  const day = `${match[2]}-${match[3]}-${match[4]}`;
  const parsedDay = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day) {
    return null;
  }
  return { projectId: match[1], day, batchId: match[5] };
}

/** Prefix containing durable queue intents that have not completed materialization yet. */
export const PENDING_INGEST_PREFIX = "pending-ingest/";
export const FAILED_INGEST_PREFIX = "failed-ingest/";
/** Reserved recovery bookkeeping; never contains ingest intents. */
export const PENDING_INGEST_INTERNAL_PREFIX = `${PENDING_INGEST_PREFIX}.internal/`;
export const PENDING_INGEST_CURSOR_KEY = `${PENDING_INGEST_INTERNAL_PREFIX}cursor.json`;
export const PENDING_INGEST_PROBE_PREFIX = `${PENDING_INGEST_INTERNAL_PREFIX}probes/`;

/**
 * Durable queue-intent key for a stored batch. The API writes this object
 * before enqueueing; the worker deletes it only after ClickHouse and
 * dead-letter bookkeeping have finished. A reconciler can therefore rebuild
 * lost Redis work without scanning the immutable raw event log.
 */
export function pendingIngestObjectKey(
  batchId: string
): string {
  return `${PENDING_INGEST_PREFIX}${batchId}.json`;
}

/** Derives the exact durable queue-intent key from its raw object key. */
export function pendingIngestObjectKeyForRaw(rawKey: string): string {
  const parsed = parseRawObjectKey(rawKey);
  if (!parsed) {
    throw new Error(`invalid raw object key ${rawKey}`);
  }
  return pendingIngestObjectKey(parsed.batchId);
}

/** Durable diagnostic for a batch that exhausted BullMQ's finite retries. */
export function failedIngestObjectKey(batchId: string): string {
  return `${FAILED_INGEST_PREFIX}${batchId}.json`;
}
