import { z } from "zod";

// OTLP/HTTP+JSON trace export request — hand-written against the wire spec
// rather than depending on @opentelemetry/otlp-transformer (that package is
// documented as "internal use only" for the OTel JS SDK's own exporters, no
// semver guarantees). See spec/otlp-ingest-v1.md.
//
// Field casing is camelCase (standard protobuf JSON mapping). traceId/spanId
// are hex strings (OTLP overrides the base64 default for these two fields
// specifically); start/endTimeUnixNano are stringified int64 nanoseconds.
// gen_ai.* attributes are still "Development" stability upstream and have
// already renamed once (gen_ai.system -> gen_ai.provider.name), so this
// schema is deliberately permissive on unknown attribute keys rather than
// an allowlist.

// arrayValue/kvlistValue make AnyValue self-referential, and OTLP places no
// depth limit on nesting. A body size cap alone (see apps/api's bodyLimit
// middleware) doesn't bound this: a tiny payload can still nest thousands
// of levels deep. Zod's recursive validation would walk that full depth,
// risking a stack overflow that crashes the process on a public,
// authenticated-but-untrusted ingest endpoint. MAX_ATTRIBUTE_VALUE_DEPTH
// caps it; anything past that is rejected as a plain unknown-shape object
// rather than recursed into further — a real OTel exporter never emits
// remotely this deep, so the cap is generous, not merely defensive-in-name.
const MAX_ATTRIBUTE_VALUE_DEPTH = 32;

function buildAnyValueSchema(depthRemaining: number): z.ZodType<unknown> {
  if (depthRemaining <= 0) {
    // Depth exhausted: still accept a well-formed leaf value, just refuse
    // to recurse into another arrayValue/kvlistValue level.
    return z.union([
      z.object({ stringValue: z.string() }),
      z.object({ intValue: z.union([z.string(), z.number()]) }),
      z.object({ doubleValue: z.number() }),
      z.object({ boolValue: z.boolean() }),
      z.object({ bytesValue: z.string() })
    ]);
  }
  const child = z.lazy(() => buildAnyValueSchema(depthRemaining - 1));
  return z.union([
    z.object({ stringValue: z.string() }),
    z.object({ intValue: z.union([z.string(), z.number()]) }),
    z.object({ doubleValue: z.number() }),
    z.object({ boolValue: z.boolean() }),
    z.object({ bytesValue: z.string() }),
    z.object({ arrayValue: z.object({ values: z.array(child).optional() }) }),
    z.object({
      kvlistValue: z.object({
        values: z.array(z.object({ key: z.string(), value: child })).optional()
      })
    })
  ]);
}

const anyValueSchema = buildAnyValueSchema(MAX_ATTRIBUTE_VALUE_DEPTH);

const otlpAttributeSchema = z.object({
  key: z.string(),
  value: anyValueSchema.optional()
});

const otlpStatusSchema = z.object({
  code: z.number().optional(),
  message: z.string().optional()
});

const otlpEventSchema = z.object({
  timeUnixNano: z.string().optional(),
  name: z.string().optional(),
  attributes: z.array(otlpAttributeSchema).optional()
});

export const otlpSpanSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string().optional(),
  kind: z.number().optional(),
  startTimeUnixNano: z.string(),
  endTimeUnixNano: z.string().optional(),
  attributes: z.array(otlpAttributeSchema).optional(),
  status: otlpStatusSchema.optional(),
  events: z.array(otlpEventSchema).optional()
});
export type OtlpSpan = z.infer<typeof otlpSpanSchema>;

export const otlpScopeSpansSchema = z.object({
  scope: z.object({ name: z.string().optional() }).optional(),
  spans: z.array(otlpSpanSchema).default([])
});

export const otlpResourceSpansSchema = z.object({
  resource: z
    .object({ attributes: z.array(otlpAttributeSchema).optional() })
    .optional(),
  scopeSpans: z.array(otlpScopeSpansSchema).default([])
});

export const otlpExportTraceServiceRequestSchema = z.object({
  resourceSpans: z.array(otlpResourceSpansSchema).default([])
});
export type OtlpExportTraceServiceRequest = z.infer<
  typeof otlpExportTraceServiceRequestSchema
>;

/** Flattens an ExportTraceServiceRequest into a plain span list with resource attributes attached to each span for the mapper's convenience. */
export function flattenOtlpSpans(
  request: OtlpExportTraceServiceRequest
): Array<{ span: OtlpSpan; resourceAttributes: z.infer<typeof otlpAttributeSchema>[] }> {
  const flattened: Array<{
    span: OtlpSpan;
    resourceAttributes: z.infer<typeof otlpAttributeSchema>[];
  }> = [];
  for (const resourceSpans of request.resourceSpans) {
    const resourceAttributes = resourceSpans.resource?.attributes ?? [];
    for (const scopeSpans of resourceSpans.scopeSpans) {
      for (const span of scopeSpans.spans) {
        flattened.push({ span, resourceAttributes });
      }
    }
  }
  return flattened;
}

/** Reads a string-valued OTLP attribute by key, or undefined if absent/non-string. */
export function getAttributeString(
  attributes: z.infer<typeof otlpAttributeSchema>[] | undefined,
  key: string
): string | undefined {
  const attr = attributes?.find((a) => a.key === key);
  const value = attr?.value as { stringValue?: string } | undefined;
  return value && "stringValue" in value ? value.stringValue : undefined;
}

/** Reads a numeric-valued OTLP attribute (int or double) by key, or undefined. */
export function getAttributeNumber(
  attributes: z.infer<typeof otlpAttributeSchema>[] | undefined,
  key: string
): number | undefined {
  const attr = attributes?.find((a) => a.key === key);
  const value = attr?.value as { intValue?: string | number; doubleValue?: number } | undefined;
  if (!value) return undefined;
  if ("doubleValue" in value && value.doubleValue !== undefined) return value.doubleValue;
  if ("intValue" in value && value.intValue !== undefined) return Number(value.intValue);
  return undefined;
}

/**
 * Converts an OTLP unix-nanosecond timestamp (stringified int64 — JS
 * numbers can't hold nanosecond precision safely) to ISO-8601 milliseconds.
 * Uses BigInt division so large timestamps don't silently lose precision
 * through float arithmetic before truncation. BigInt division truncates
 * toward zero, not floors — for a (schema-legal, if never realistically
 * emitted by an OTel exporter) negative/pre-1970 nanosecond value that
 * differs from a floor by up to 1ms; floor explicitly here so the rounding
 * direction is correct for both signs, not just positive timestamps.
 */
export function unixNanoToIso(unixNano: string): string {
  const nanos = BigInt(unixNano);
  const millis = floorDiv(nanos, 1_000_000n);
  return new Date(Number(millis)).toISOString();
}

function floorDiv(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  const remainder = a % b;
  return remainder !== 0n && (remainder < 0n) !== (b < 0n) ? quotient - 1n : quotient;
}

/** Renders any OTLP attribute value to a display string, for the flexible metadata map. */
export function attributeValueToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  const v = value as Record<string, unknown>;
  if ("stringValue" in v) return String(v.stringValue);
  if ("intValue" in v) return String(v.intValue);
  if ("doubleValue" in v) return String(v.doubleValue);
  if ("boolValue" in v) return String(v.boolValue);
  // arrayValue / kvlistValue / bytesValue: preserve as JSON so no
  // information is lost even though it's not a flat scalar.
  return JSON.stringify(value);
}
