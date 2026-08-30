import { z } from "zod";
import { environmentNameSchema } from "./environment.js";

// Domain model — the worker's output shape, persisted to ClickHouse.
// See spec/trace-envelope-v1.md. Conventions:
// - upsert semantics: same id twice = update (ReplacingMergeTree dedups)
// - usage/cost unavailable = null/absent, never zero
// - metadata values are stringified for the ClickHouse Map column; the
//   original value survives in the raw envelope

/** ISO 8601 timestamp with optional offset. */
const timestampSchema = z.iso.datetime({ offset: true });
const utf8 = new TextEncoder();
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
export const identifierSchema = z.string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), "identifier must not contain NUL")
  .refine((value) => !hasUnpairedSurrogate(value), "identifier must be valid Unicode")
  .refine(
    (value) => utf8.encode(value).byteLength <= 512,
    "identifier must not exceed 512 UTF-8 bytes"
  );

/** Arbitrary key/value metadata, values stringified. */
export const metadataSchema = z.record(z.string(), z.string());
export type Metadata = z.infer<typeof metadataSchema>;

export const traceSchema = z.object({
  id: identifierSchema,
  projectId: identifierSchema,
  timestamp: timestampSchema,
  name: z.string().optional(),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  environment: environmentNameSchema.optional(),
  release: z.string().optional(),
  version: z.string().optional(),
  tags: z.array(z.string()).default([]),
  metadata: metadataSchema.default({}),
  input: z.unknown().optional(),
  output: z.unknown().optional()
});
export type Trace = z.infer<typeof traceSchema>;

export const observationTypeSchema = z.enum(["span", "generation", "event"]);
export type ObservationType = z.infer<typeof observationTypeSchema>;

export const observationLevelSchema = z.enum([
  "debug",
  "default",
  "warning",
  "error"
]);
export type ObservationLevel = z.infer<typeof observationLevelSchema>;

export const observationSchema = z.object({
  id: identifierSchema,
  traceId: identifierSchema,
  projectId: identifierSchema,
  parentObservationId: identifierSchema.optional(),
  type: observationTypeSchema,
  name: z.string().optional(),
  startTime: timestampSchema,
  endTime: timestampSchema.optional(),
  level: observationLevelSchema.default("default"),
  statusMessage: z.string().optional(),
  model: z.string().optional(),
  modelParameters: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  /** e.g. { input_tokens: 12, output_tokens: 340 }; absent when unknown, never zero-filled. */
  usageDetails: z.record(z.string(), z.number().int().nonnegative()).optional(),
  /** USD by cost component, e.g. { input: 0.0012, output: 0.034, total: 0.0352 }. */
  costDetails: z.record(z.string(), z.number().nonnegative()).optional(),
  /** First token time for streaming generations (TTFT). */
  completionStartTime: timestampSchema.optional(),
  metadata: metadataSchema.default({})
});
export type Observation = z.infer<typeof observationSchema>;

export const scoreDataTypeSchema = z.enum(["numeric", "categorical", "boolean"]);
export type ScoreDataType = z.infer<typeof scoreDataTypeSchema>;

export const scoreSourceSchema = z.enum(["api", "eval", "annotation"]);
export type ScoreSource = z.infer<typeof scoreSourceSchema>;

// Split into a plain object schema + a refined wrapper so consumers that
// need .omit()/.pick() (zod v4 disallows those on refined schemas) can
// derive from scoreObjectSchema. Note: anything built on scoreObjectSchema
// (e.g. @ironside/mappers) must re-apply the value/stringValue invariant
// itself — omitting from scoreSchema is not possible, so the check does not
// travel automatically.
export const scoreObjectSchema = z.object({
  id: identifierSchema,
  projectId: identifierSchema,
  traceId: identifierSchema,
  observationId: identifierSchema.optional(),
  name: z.string().min(1),
  dataType: scoreDataTypeSchema,
  value: z.number().optional(),
  stringValue: z.string().optional(),
  source: scoreSourceSchema,
  comment: z.string().optional(),
  /** When the score was originally created. Absent → the ClickHouse column defaults to insert time, which is wrong for backfilled/imported scores — importers must pass the source's own timestamp. */
  timestamp: timestampSchema.optional(),
  metadata: metadataSchema.default({})
});

export const scoreSchema = scoreObjectSchema.refine(
  (s) => s.value !== undefined || s.stringValue !== undefined,
  { message: "score requires value or stringValue" }
);
export type Score = z.infer<typeof scoreSchema>;
