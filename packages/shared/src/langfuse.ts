import { z } from "zod";
import { identifierSchema } from "./domain.js";

// LangFuse /api/public/ingestion compat — verified against LangFuse's Fern
// API definition (github.com/langfuse/langfuse fern/apis/server/definition/
// ingestion.yml) and their JS SDK source (langfuse-js, v3-stable branch),
// not narrative docs. Targets the LEGACY langfuse npm package (still
// published, batches to this endpoint) — the current v4+/v5 @langfuse/*
// packages send OTLP instead, covered by Ironside's /v1/otel/traces (M3).
// See spec/langfuse-compat-v1.md.

export const langfuseEventTypeSchema = z.enum([
  "trace-create",
  "span-create",
  "span-update",
  "generation-create",
  "generation-update",
  "event-create",
  "score-create",
  "observation-create",
  "observation-update",
  "sdk-log"
]);
export type LangfuseEventType = z.infer<typeof langfuseEventTypeSchema>;

export const langfuseBatchEventSchema = z.object({
  id: z.string(),
  timestamp: z.string().optional(),
  type: langfuseEventTypeSchema,
  body: z.unknown(),
  metadata: z.unknown().optional()
});
export type LangfuseBatchEvent = z.infer<typeof langfuseBatchEventSchema>;

export const langfuseIngestionRequestSchema = z.object({
  batch: z.array(langfuseBatchEventSchema).min(1),
  metadata: z.unknown().optional()
});
export type LangfuseIngestionRequest = z.infer<typeof langfuseIngestionRequestSchema>;

// LangFuse always responds 207 with per-event outcomes, even for
// validation errors on individual events (never a bare 4xx for the whole
// batch) — the SDK's own response handling expects this shape.
export const langfuseIngestionResponseSchema = z.object({
  successes: z.array(z.object({ id: z.string(), status: z.number() })),
  errors: z.array(
    z.object({
      id: z.string(),
      status: z.number(),
      message: z.string().optional(),
      error: z.unknown().optional()
    })
  )
});
export type LangfuseIngestionResponse = z.infer<typeof langfuseIngestionResponseSchema>;

// Body shapes for the event types this compat layer actually maps to
// domain rows (trace-create, {span,generation,observation}-{create,update},
// event-create, score-create). Deliberately permissive (fields optional
// AND nullable, unknown extras allowed) — LangFuse's own body shapes have
// accreted several historical variants (see usage/usageDetails below), and
// verified in a live conformance run that the real SDK sends explicit
// `null` for unset fields (e.g. parentObservationId: null on a root
// generation), not just omission — a plain .optional() schema silently
// rejects `null` and would fail the whole event as "invalid ... body".
// `.nullable()` on every optional field closes that gap generally, rather
// than patching field-by-field as more nulled fields are discovered.
const opt = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional();

export const langfuseTraceBodySchema = z.object({
  id: opt(identifierSchema),
  timestamp: opt(z.string()),
  name: opt(z.string()),
  userId: opt(z.string()),
  sessionId: opt(z.string()),
  environment: opt(z.string()),
  release: opt(z.string()),
  version: opt(z.string()),
  tags: opt(z.array(z.string())),
  metadata: z.unknown().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional()
});

const langfuseUsageDetailsShape = z.union([
  // Plain map<string, int> — Ironside's own shape.
  z.record(z.string(), z.number()),
  // Legacy LangFuse shape.
  z.object({
    input: opt(z.number()),
    output: opt(z.number()),
    total: opt(z.number())
  }),
  // OpenAI-shaped usage, as some LangFuse SDK versions pass it through.
  z.object({
    promptTokens: opt(z.number()),
    completionTokens: opt(z.number()),
    totalTokens: opt(z.number())
  })
]);

export const langfuseObservationBodySchema = z.object({
  id: opt(identifierSchema),
  traceId: opt(identifierSchema),
  parentObservationId: opt(identifierSchema),
  name: opt(z.string()),
  startTime: opt(z.string()),
  endTime: opt(z.string()),
  metadata: z.unknown().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  level: opt(z.enum(["DEBUG", "DEFAULT", "WARNING", "ERROR"])),
  statusMessage: opt(z.string()),
  model: opt(z.string()),
  modelParameters: opt(z.record(z.string(), z.unknown())),
  usage: z.union([langfuseUsageDetailsShape, z.null()]).optional(),
  usageDetails: z.union([langfuseUsageDetailsShape, z.null()]).optional(),
  costDetails: opt(z.record(z.string(), z.number()))
});

export const langfuseScoreBodySchema = z.object({
  id: opt(identifierSchema),
  traceId: identifierSchema,
  observationId: opt(identifierSchema),
  name: z.string(),
  value: opt(z.union([z.number(), z.string()])),
  dataType: opt(z.enum(["NUMERIC", "CATEGORICAL", "BOOLEAN"])),
  comment: opt(z.string())
});
