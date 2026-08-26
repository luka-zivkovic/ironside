import { z } from "zod";
import { ingestEventSchema } from "./envelope.js";
import { environmentNameSchema } from "./environment.js";

// Contract for the project-explicit native trace list/filter and related query endpoints.

export const listTracesQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  environment: environmentNameSchema.optional(),
  tags: z.array(z.string()).optional(),
  /** Matches traces whose metadata has this exact key/value pair. */
  metadataKey: z.string().optional(),
  metadataValue: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Opaque keyset cursor from the previous page's `nextCursor`. */
  cursor: z.string().optional()
});
export type ListTracesQuery = z.infer<typeof listTracesQuerySchema>;

export const traceSummarySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  name: z.string().nullable(),
  userId: z.string().nullable(),
  sessionId: z.string().nullable(),
  environment: z.string().nullable(),
  tags: z.array(z.string()),
  metadata: z.record(z.string(), z.string())
});
export type TraceSummary = z.infer<typeof traceSummarySchema>;

export const listTracesResponseSchema = z.object({
  traces: z.array(traceSummarySchema),
  nextCursor: z.string().nullable()
});
export type ListTracesResponse = z.infer<typeof listTracesResponseSchema>;

// Project-explicit trace detail — the full trace with its observation tree, nested
// by parentObservationId. coeval's poller flattens this depth-first into
// TraceStep[] (see spec/trace-envelope-v1.md); the API returns a tree
// rather than pre-flattening so other consumers aren't forced into that
// specific shape.
export const observationNodeSchema: z.ZodType<ObservationNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    parentObservationId: z.string().nullable(),
    type: z.enum(["span", "generation", "event"]),
    name: z.string().nullable(),
    startTime: z.string(),
    endTime: z.string().nullable(),
    level: z.string(),
    statusMessage: z.string().nullable(),
    model: z.string().nullable(),
    /** Sampling parameters recorded at ingest (temperature, max_tokens, ...), values stringified like metadata. */
    modelParameters: z.record(z.string(), z.string()),
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
    usageDetails: z.record(z.string(), z.number()),
    costDetails: z.record(z.string(), z.number()),
    /** First-token time for streaming generations (TTFT). */
    completionStartTime: z.string().nullable(),
    metadata: z.record(z.string(), z.string()),
    children: z.array(observationNodeSchema)
  })
);
export interface ObservationNode {
  id: string;
  parentObservationId: string | null;
  type: "span" | "generation" | "event";
  name: string | null;
  startTime: string;
  endTime: string | null;
  level: string;
  statusMessage: string | null;
  model: string | null;
  modelParameters: Record<string, string>;
  input: unknown;
  output: unknown;
  usageDetails: Record<string, number>;
  costDetails: Record<string, number>;
  completionStartTime: string | null;
  metadata: Record<string, string>;
  children: ObservationNode[];
}

export const traceTreeResponseSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  name: z.string().nullable(),
  userId: z.string().nullable(),
  sessionId: z.string().nullable(),
  environment: z.string().nullable(),
  release: z.string().nullable(),
  version: z.string().nullable(),
  tags: z.array(z.string()),
  metadata: z.record(z.string(), z.string()),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  observations: z.array(observationNodeSchema)
});
export type TraceTreeResponse = z.infer<typeof traceTreeResponseSchema>;

// Project-explicit trace aggregates — same filter surface as list, no
// pagination (cursor/limit are meaningless for an aggregate).
export const aggregatesQuerySchema = listTracesQuerySchema.omit({
  limit: true,
  cursor: true
});
export type AggregatesQuery = z.infer<typeof aggregatesQuerySchema>;

export const aggregatesResponseSchema = z.object({
  traceCount: z.number().int().nonnegative(),
  /** Sum per usage_details key across all observations of matched traces (e.g. input_tokens, output_tokens). Absent key = no observation reported it, not zero. */
  tokenTotals: z.record(z.string(), z.number()),
  /** Sum per cost_details key across all observations of matched traces, in USD. */
  costTotals: z.record(z.string(), z.number()),
  /**
   * Trace duration percentiles in milliseconds: max(observation.end_time)
   * - min(observation.start_time) per trace. Traces with no observations
   * (or none with an end_time) are excluded, not treated as 0ms.
   */
  latencyMsPercentiles: z.object({
    p50: z.number().nullable(),
    p95: z.number().nullable(),
    p99: z.number().nullable()
  })
});
export type AggregatesResponse = z.infer<typeof aggregatesResponseSchema>;

// Project-explicit raw-events route — the immutable raw-log slice of one
// trace: every ingest envelope event that produced (or may have produced)
// rows for it, straight from object storage.
export const rawEventEntrySchema = z.object({
  /** Batch the event arrived in. */
  batchId: z.string(),
  /** Object storage key of the raw batch — raw/{projectId}/{yyyy}/{mm}/{dd}/{batchId}.json. */
  objectKey: z.string(),
  /** Server-side receive time of the batch (ISO 8601). */
  receivedAt: z.string(),
  /** The envelope event, verbatim from the raw log. */
  event: ingestEventSchema,
  /**
   * Honesty marker: true when the event's body shape didn't allow
   * extracting a trace id (possible for multi-trace compat batches —
   * otlp-export / langfuse-ingestion), so the event is included because it
   * MIGHT belong to this trace, not because it provably does.
   */
  containingBatch: z.boolean()
});
export type RawEventEntry = z.infer<typeof rawEventEntrySchema>;

/**
 * Why a successful response may be incomplete (`truncated: true`):
 * - `scan_object_cap`: the index held more raw objects than the
 *   per-lookup object cap; scanning stopped at the cap.
 * - `scan_bytes_budget`: the raw objects fetched so far exhausted the
 *   per-lookup byte budget; scanning stopped there.
 * - `response_bytes_cap`: the matched events exceeded the response size
 *   cap; events found after the cap are omitted.
 * - `raw_index_pending`: the durable history is complete, but at least one
 *   newly mapped raw batch is still applying its domain rows.
 * - `retention_expired`: at least one indexed raw object was deliberately
 *   removed by Ironside's retention executor.
 */
export const rawEventsTruncationReasonSchema = z.enum([
  "scan_object_cap",
  "scan_bytes_budget",
  "response_bytes_cap",
  "raw_index_pending",
  "retention_expired"
]);
export type RawEventsTruncationReason = z.infer<typeof rawEventsTruncationReasonSchema>;

export const traceRawEventsResponseSchema = z.object({
  traceId: z.string(),
  events: z.array(rawEventEntrySchema),
  /** Indexed raw objects fetched and inspected. */
  scannedObjects: z.number().int().nonnegative(),
  /**
   * True when the scan stopped early (object cap, byte budget,
   * or response size cap) — `events` is then the partial set found before
   * the stop, and `truncationReason` says which limit was hit first.
   * A `truncated: false` response is complete.
   */
  truncated: z.boolean(),
  /** Sticky, independent signal that deliberate raw retention shortened history. */
  retentionExpired: z.boolean(),
  /** Present exactly when `truncated` is true. */
  truncationReason: rawEventsTruncationReasonSchema.optional()
});
export type TraceRawEventsResponse = z.infer<typeof traceRawEventsResponseSchema>;
