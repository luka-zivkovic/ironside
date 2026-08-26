import type {
  IngestBatch,
  IngestEvent,
  RawEventEntry,
  RawEventsTruncationReason
} from "@ironside/shared";
import { ingestBatchSchema } from "@ironside/shared";
import type { ObjectStorage } from "@ironside/storage";

// Logic behind the project-explicit raw-events route, extracted from the route
// so the prefix-window computation, event filtering, and the capped scan
// loop are unit testable without real object storage or ClickHouse.

export type RawEventMatch =
  | { matches: false }
  | {
      matches: true;
      /** True when the body shape made trace-id extraction impossible, so membership is possible but unproven. */
      containingBatch: boolean;
    };

const NO_MATCH: RawEventMatch = { matches: false };
const EXACT_MATCH: RawEventMatch = { matches: true, containingBatch: false };
const POSSIBLE_MATCH: RawEventMatch = { matches: true, containingBatch: true };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Decides whether an envelope event belongs to `traceId`.
 *
 * Single-trace event types (native/importer-shaped bodies) carry the trace
 * id directly: trace-upsert in `body.id`, observation-upsert and
 * score-upsert in `body.traceId`. Multi-trace compat batches (otlp-export,
 * langfuse-ingestion) are walked for every trace id they reference; when a
 * body shape defeats extraction, the event is included with
 * `containingBatch: true` rather than silently dropped or dishonestly
 * claimed as a proven match — the worker's mappers are more lenient than
 * this read-side walk, so "can't tell" must not become "doesn't belong".
 */
export function classifyEventForTrace(event: IngestEvent, traceId: string): RawEventMatch {
  const body = asRecord(event.body);
  switch (event.type) {
    case "trace-upsert":
      return body?.id === traceId ? EXACT_MATCH : NO_MATCH;
    case "observation-upsert":
    case "score-upsert":
      return body?.traceId === traceId ? EXACT_MATCH : NO_MATCH;
    case "otlp-export":
      return classifyOtlpExport(body, traceId);
    case "langfuse-ingestion":
      return classifyLangfuseIngestion(body, traceId);
  }
}

/** body is a raw OTLP ExportTraceServiceRequest: resourceSpans[].scopeSpans[].spans[].traceId. */
function classifyOtlpExport(body: Record<string, unknown> | null, traceId: string): RawEventMatch {
  if (!body || !Array.isArray(body.resourceSpans)) return POSSIBLE_MATCH;

  let anyUnextractable = false;
  for (const resourceSpan of body.resourceSpans) {
    const scopeSpans = asRecord(resourceSpan)?.scopeSpans;
    if (!Array.isArray(scopeSpans)) {
      anyUnextractable = true;
      continue;
    }
    for (const scopeSpan of scopeSpans) {
      const spans = asRecord(scopeSpan)?.spans;
      if (!Array.isArray(spans)) {
        anyUnextractable = true;
        continue;
      }
      for (const span of spans) {
        const spanTraceId = asRecord(span)?.traceId;
        if (typeof spanTraceId !== "string") anyUnextractable = true;
        else if (spanTraceId === traceId) return EXACT_MATCH;
      }
    }
  }
  return anyUnextractable ? POSSIBLE_MATCH : NO_MATCH;
}

/**
 * body is a raw LangFuse ingestion request: batch[] of typed items whose
 * own body carries `traceId` (observations/scores) or `id` (trace-create).
 * An item without either is NOT safe to rule out — LangFuse *-update
 * events omit traceId (the create carried it), yet still belong to a trace.
 */
function classifyLangfuseIngestion(
  body: Record<string, unknown> | null,
  traceId: string
): RawEventMatch {
  if (!body || !Array.isArray(body.batch)) return POSSIBLE_MATCH;

  let anyUnextractable = false;
  for (const item of body.batch) {
    const itemRecord = asRecord(item);
    const itemBody = asRecord(itemRecord?.body);
    if (!itemRecord || !itemBody) {
      anyUnextractable = true;
      continue;
    }
    if (itemBody.traceId === traceId) return EXACT_MATCH;
    const isTraceItem = typeof itemRecord.type === "string" && itemRecord.type.startsWith("trace");
    if (isTraceItem && itemBody.id === traceId) return EXACT_MATCH;
    if (typeof itemBody.traceId !== "string" && !(isTraceItem && typeof itemBody.id === "string")) {
      anyUnextractable = true;
    }
  }
  return anyUnextractable ? POSSIBLE_MATCH : NO_MATCH;
}

export interface MatchedRawEvent {
  event: IngestEvent;
  containingBatch: boolean;
}

/** Filters a stored raw batch down to the events belonging (or possibly belonging) to `traceId`. */
export function filterBatchEvents(batch: IngestBatch, traceId: string): MatchedRawEvent[] {
  const matched: MatchedRawEvent[] = [];
  for (const event of batch.events) {
    const result = classifyEventForTrace(event, traceId);
    if (result.matches) {
      matched.push({ event, containingBatch: result.containingBatch });
    }
  }
  return matched;
}

export interface RawScanCaps {
  /** Max raw objects fetched per lookup — bounds S3 GET count and latency. */
  maxScannedObjects: number;
  /** Max accumulated bytes fetched from storage per lookup — bounds transfer cost even when individual objects are large. */
  maxScannedBytes: number;
  /** Max accumulated size of the matched events — bounds the response payload. */
  maxResponseBytes: number;
}

export type RawScanTruncationReason = Extract<
  RawEventsTruncationReason,
  "scan_object_cap" | "scan_bytes_budget" | "response_bytes_cap"
>;

export interface RawScanResult {
  events: RawEventEntry[];
  scannedObjects: number;
  /** Set when the scan stopped at a cap — `events` is then the partial set found before the stop. */
  truncationReason?: RawScanTruncationReason;
}

/** A raw object fetch failed for a reason other than the object being missing or unparsable — a real storage outage. */
export class RawLogUnavailableError extends Error {
  readonly objectKey: string;

  constructor(objectKey: string, cause: unknown) {
    super(`failed to fetch raw log object ${objectKey}`, { cause });
    this.name = "RawLogUnavailableError";
    this.objectKey = objectKey;
  }
}

/**
 * A missing object (deleted between LIST and GET) or one that is not JSON
 * (torn write, foreign object under the prefix) is safe to skip: it can't
 * contribute events but says nothing about storage health. Anything else —
 * network failure, credentials, throttling — must NOT be swallowed:
 * treating an S3 outage as "object contributed nothing" would misreport
 * the raw log as absent (404) or silently incomplete (200).
 */
function isMissingOrUnparsableObject(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  const shaped = error as { name?: string; Code?: string } | null;
  return shaped?.name === "NoSuchKey" || shaped?.Code === "NoSuchKey";
}

/**
 * Fetches the durable indexed object keys for `traceId`. Stops at whichever
 * cap is hit first and returns the partial
 * results found so far (truncation, not failure — everything found before a
 * cap is still real data). Throws RawLogUnavailableError on a genuine
 * storage failure.
 */
export async function scanRawEvents(
  storage: Pick<ObjectStorage, "getJson">,
  traceId: string,
  caps: RawScanCaps,
  indexedObjectKeys: Iterable<string>
): Promise<RawScanResult> {
  async function* objectKeys(): AsyncIterable<string> {
    const seen = new Set<string>();
    for (const objectKey of indexedObjectKeys) {
      if (seen.has(objectKey)) continue;
      seen.add(objectKey);
      yield objectKey;
    }
  }

  const events: RawEventEntry[] = [];
  let scannedObjects = 0;
  let scannedBytes = 0;
  let responseBytes = 0;

  for await (const objectKey of objectKeys()) {
    if (scannedObjects >= caps.maxScannedObjects) {
      return { events, scannedObjects, truncationReason: "scan_object_cap" };
    }
    scannedObjects += 1;

    let raw: unknown;
    try {
      raw = await storage.getJson(objectKey);
    } catch (error) {
      if (isMissingOrUnparsableObject(error)) continue;
      throw new RawLogUnavailableError(objectKey, error);
    }

    // getJson hands back the parsed value, so charge the byte budget on a
    // re-serialization — approximate (whitespace may differ from the
    // stored bytes) but the right order of magnitude, without changing
    // the storage API to expose raw byte counts.
    scannedBytes += Buffer.byteLength(JSON.stringify(raw), "utf8");

    // An object that isn't an ingest batch (foreign object under the
    // prefix) is counted as scanned but contributes no events.
    const parsed = ingestBatchSchema.safeParse(raw);
    if (parsed.success) {
      for (const match of filterBatchEvents(parsed.data, traceId)) {
        const entry: RawEventEntry = {
          batchId: parsed.data.batchId,
          objectKey,
          receivedAt: parsed.data.receivedAt,
          event: match.event,
          containingBatch: match.containingBatch
        };
        responseBytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
        if (responseBytes > caps.maxResponseBytes) {
          return { events, scannedObjects, truncationReason: "response_bytes_cap" };
        }
        events.push(entry);
      }
    }

    if (scannedBytes > caps.maxScannedBytes) {
      return { events, scannedObjects, truncationReason: "scan_bytes_budget" };
    }
  }

  return { events, scannedObjects };
}
