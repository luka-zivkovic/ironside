import type { ObservationNode } from "@ironside/shared";
import { toOtlpSpanId, toOtlpTraceId } from "@ironside/shared";

// Converts a stored trace + its observation tree back into an OTLP
// ExportTraceServiceRequest JSON body — the inverse of packages/mappers/
// src/otlp.ts's ingest-side mapping. gen_ai.* attributes are re-emitted
// for observations that carry a model, so a downstream OTel-native system
// (Jaeger, an otel-collector, another gen_ai-semconv-aware backend) sees
// the same shape a real instrumentation SDK would have produced.

export interface ForwardableTrace {
  id: string;
  timestamp: string;
  name: string | null;
  observations: ObservationNode[];
}

function unixNanoFromIso(iso: string): string {
  return String(BigInt(Date.parse(iso)) * 1_000_000n);
}

interface OtlpAttribute {
  key: string;
  value: { stringValue: string } | { intValue: string };
}

function attributesFromMetadata(metadata: Record<string, string>): OtlpAttribute[] {
  return Object.entries(metadata).map(([key, value]) => ({ key, value: { stringValue: value } }));
}

function mapObservation(
  otlpTraceId: string,
  node: ObservationNode,
  parentOtlpSpanId: string | undefined
): unknown[] {
  const otlpSpanId = toOtlpSpanId(node.id);
  const attributes = attributesFromMetadata(node.metadata);
  if (node.model) {
    attributes.push({ key: "gen_ai.request.model", value: { stringValue: node.model } });
  }
  const inputTokens = node.usageDetails.input_tokens;
  const outputTokens = node.usageDetails.output_tokens;
  if (inputTokens !== undefined) {
    attributes.push({
      key: "gen_ai.usage.input_tokens",
      value: { intValue: String(inputTokens) }
    });
  }
  if (outputTokens !== undefined) {
    attributes.push({
      key: "gen_ai.usage.output_tokens",
      value: { intValue: String(outputTokens) }
    });
  }

  const span: Record<string, unknown> = {
    traceId: otlpTraceId,
    spanId: otlpSpanId,
    ...(parentOtlpSpanId && { parentSpanId: parentOtlpSpanId }),
    name: node.name ?? node.id,
    startTimeUnixNano: unixNanoFromIso(node.startTime),
    ...(node.endTime && { endTimeUnixNano: unixNanoFromIso(node.endTime) }),
    attributes,
    status: {
      code: node.level === "error" ? 2 : 1,
      ...(node.statusMessage && { message: node.statusMessage })
    }
  };

  const childSpans = node.children.flatMap((child) =>
    mapObservation(otlpTraceId, child, otlpSpanId)
  );
  return [span, ...childSpans];
}

/**
 * Maps a trace + its observation tree into one OTLP
 * ExportTraceServiceRequest. If the trace has no observations, a single
 * synthetic root span (spanning the trace's own timestamp) is emitted so
 * the trace isn't silently dropped from the export — an OTLP export with
 * zero spans for an otherwise-real trace would look like data loss to a
 * downstream consumer, not an intentional "nothing to forward" signal.
 */
export function mapTraceToOtlpExportRequest(trace: ForwardableTrace): unknown {
  const otlpTraceId = toOtlpTraceId(trace.id);

  const spans =
    trace.observations.length > 0
      ? trace.observations.flatMap((node) => mapObservation(otlpTraceId, node, undefined))
      : [
          {
            traceId: otlpTraceId,
            spanId: toOtlpSpanId(trace.id),
            name: trace.name ?? trace.id,
            startTimeUnixNano: unixNanoFromIso(trace.timestamp),
            attributes: [],
            status: { code: 1 }
          }
        ];

  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "ironside" } }] },
        scopeSpans: [{ scope: { name: "ironside-forwarder" }, spans }]
      }
    ]
  };
}
