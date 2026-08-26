import type { ObservationNode } from "@ironside/shared";
import { describe, expect, it } from "vitest";
import { mapTraceToOtlpExportRequest } from "../src/forwarders/otlp-mapper.js";

function observation(overrides: Partial<ObservationNode> = {}): ObservationNode {
  return {
    id: "obs_1",
    parentObservationId: null,
    type: "span",
    name: "handle-request",
    startTime: "2026-07-12T00:00:00.000Z",
    endTime: "2026-07-12T00:00:01.000Z",
    level: "default",
    statusMessage: null,
    model: null,
    modelParameters: {},
    input: null,
    output: null,
    usageDetails: {},
    costDetails: {},
    completionStartTime: null,
    metadata: {},
    children: [],
    ...overrides
  };
}

function getResourceSpans(request: unknown) {
  return (request as { resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[] })
    .resourceSpans;
}

describe("mapTraceToOtlpExportRequest", () => {
  it("produces trace/span ids satisfying the OTLP spec's exact byte-length constraint (32/16 hex chars, verified against the actual proto requirement, not assumed)", () => {
    const request = mapTraceToOtlpExportRequest({
      id: "trace_01ABCXYZ",
      timestamp: "2026-07-12T00:00:00.000Z",
      name: "checkout",
      observations: [observation()]
    });
    const spans = getResourceSpans(request)[0]!.scopeSpans[0]!.spans;
    const span = spans[0]!;
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("the same Ironside trace/observation id always maps to the same OTLP id (stable across repeated forwarding runs)", () => {
    const first = mapTraceToOtlpExportRequest({
      id: "trace_stable",
      timestamp: "2026-07-12T00:00:00.000Z",
      name: null,
      observations: [observation({ id: "obs_stable" })]
    });
    const second = mapTraceToOtlpExportRequest({
      id: "trace_stable",
      timestamp: "2026-07-12T00:00:00.000Z",
      name: null,
      observations: [observation({ id: "obs_stable" })]
    });
    const spanA = getResourceSpans(first)[0]!.scopeSpans[0]!.spans[0]!;
    const spanB = getResourceSpans(second)[0]!.scopeSpans[0]!.spans[0]!;
    expect(spanA.traceId).toBe(spanB.traceId);
    expect(spanA.spanId).toBe(spanB.spanId);
  });

  it("different source ids never collide onto the same OTLP id (spot check, not a formal proof)", () => {
    const request = mapTraceToOtlpExportRequest({
      id: "trace_1",
      timestamp: "2026-07-12T00:00:00.000Z",
      name: null,
      observations: [observation({ id: "obs_a" }), observation({ id: "obs_b" })]
    });
    const spans = getResourceSpans(request)[0]!.scopeSpans[0]!.spans;
    expect(spans[0]!.spanId).not.toBe(spans[1]!.spanId);
  });

  it("preserves parent/child span relationships via parentSpanId", () => {
    const child = observation({ id: "obs_child", parentObservationId: "obs_root" });
    const root = observation({ id: "obs_root", children: [child] });
    const request = mapTraceToOtlpExportRequest({
      id: "trace_1",
      timestamp: "2026-07-12T00:00:00.000Z",
      name: null,
      observations: [root]
    });
    const spans = getResourceSpans(request)[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(2);
    const rootSpan = spans.find((s) => s.name === "handle-request" && !s.parentSpanId);
    const childSpan = spans.find((s) => s.parentSpanId);
    expect(rootSpan).toBeDefined();
    expect(childSpan?.parentSpanId).toBe(rootSpan?.spanId);
  });

  it("re-emits gen_ai.* attributes for observations carrying a model and usage", () => {
    const gen = observation({
      type: "generation",
      model: "gpt-4o",
      usageDetails: { input_tokens: 10, output_tokens: 20 }
    });
    const request = mapTraceToOtlpExportRequest({
      id: "trace_1",
      timestamp: "2026-07-12T00:00:00.000Z",
      name: null,
      observations: [gen]
    });
    const span = getResourceSpans(request)[0]!.scopeSpans[0]!.spans[0]!;
    const attrs = span.attributes as { key: string; value: Record<string, string> }[];
    const modelAttr = attrs.find((a) => a.key === "gen_ai.request.model");
    const inputAttr = attrs.find((a) => a.key === "gen_ai.usage.input_tokens");
    expect(modelAttr?.value.stringValue).toBe("gpt-4o");
    expect(inputAttr?.value.intValue).toBe("10");
  });

  it("marks an error-level observation with OTLP status code 2 (STATUS_CODE_ERROR, verified against the proto spec)", () => {
    const request = mapTraceToOtlpExportRequest({
      id: "trace_1",
      timestamp: "2026-07-12T00:00:00.000Z",
      name: null,
      observations: [observation({ level: "error", statusMessage: "boom" })]
    });
    const span = getResourceSpans(request)[0]!.scopeSpans[0]!.spans[0]!;
    expect((span.status as { code: number }).code).toBe(2);
    expect((span.status as { message: string }).message).toBe("boom");
  });

  it("a trace with zero observations still emits one synthetic root span, not an empty/dropped export", () => {
    const request = mapTraceToOtlpExportRequest({
      id: "trace_1",
      timestamp: "2026-07-12T00:00:00.000Z",
      name: "empty-trace",
      observations: []
    });
    const spans = getResourceSpans(request)[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("empty-trace");
  });

  it("converts ISO timestamps to correct unix-nanosecond strings", () => {
    const request = mapTraceToOtlpExportRequest({
      id: "trace_1",
      timestamp: "2026-07-12T00:00:00.000Z",
      name: null,
      observations: [observation({ startTime: "2023-11-14T22:13:20.000Z", endTime: "2023-11-14T22:13:21.500Z" })]
    });
    const span = getResourceSpans(request)[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.startTimeUnixNano).toBe("1700000000000000000");
    expect(span.endTimeUnixNano).toBe("1700000001500000000");
  });
});
