import { otlpExportTraceServiceRequestSchema } from "@ironside/shared";
import { describe, expect, it } from "vitest";
import { mapOtlpTraceRequest } from "../src/otlp.js";

// Realistic OTLP/HTTP+JSON payload shape per the wire spec: camelCase
// fields, hex trace/span ids (not base64), stringified int64 nanosecond
// timestamps, attribute values as a {stringValue|intValue|...} oneof.
function otlpRequest(overrides: { resourceAttrs?: object[]; rootAttrs?: object[]; childAttrs?: object[] } = {}) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: overrides.resourceAttrs ?? [{ key: "service.name", value: { stringValue: "checkout-api" } }]
        },
        scopeSpans: [
          {
            scope: { name: "test-instrumentation" },
            spans: [
              {
                traceId: "5b8efff798038103d269b633813fc60",
                spanId: "eee19b7ec3c1b174",
                name: "handle-checkout",
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000001500000000",
                attributes: overrides.rootAttrs ?? [],
                status: { code: 1 }
              },
              {
                traceId: "5b8efff798038103d269b633813fc60",
                spanId: "a1b2c3d4e5f60718",
                parentSpanId: "eee19b7ec3c1b174",
                name: "chat gpt-4o",
                startTimeUnixNano: "1700000000200000000",
                endTimeUnixNano: "1700000001400000000",
                attributes: overrides.childAttrs ?? [
                  { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                  { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
                  { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: "120" } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: "340" } }
                ],
                status: { code: 1 }
              }
            ]
          }
        ]
      }
    ]
  };
}

describe("otlpExportTraceServiceRequestSchema", () => {
  it("parses a realistic OTLP/HTTP+JSON payload", () => {
    const parsed = otlpExportTraceServiceRequestSchema.parse(otlpRequest());
    expect(parsed.resourceSpans[0]?.scopeSpans[0]?.spans).toHaveLength(2);
  });

  it("accepts an empty export (no resourceSpans)", () => {
    expect(otlpExportTraceServiceRequestSchema.parse({}).resourceSpans).toEqual([]);
  });
});

describe("mapOtlpTraceRequest", () => {
  it("promotes the parentless span's traceId to a Trace, and maps every span to an Observation", () => {
    const request = otlpExportTraceServiceRequestSchema.parse(otlpRequest());
    const { traces, observations } = mapOtlpTraceRequest("proj_x", request);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      id: "5b8efff798038103d269b633813fc60",
      projectId: "proj_x",
      name: "handle-checkout"
    });
    // Resource attributes land on the trace's metadata.
    expect(traces[0]?.metadata["service.name"]).toBe("checkout-api");

    expect(observations).toHaveLength(2);
    const root = observations.find((o) => o.id === "eee19b7ec3c1b174");
    const child = observations.find((o) => o.id === "a1b2c3d4e5f60718");
    expect(root?.parentObservationId).toBeUndefined();
    expect(child?.parentObservationId).toBe("eee19b7ec3c1b174");
  });

  it("maps gen_ai.* attributes to model/usage on generation-type observations", () => {
    const request = otlpExportTraceServiceRequestSchema.parse(otlpRequest());
    const { observations } = mapOtlpTraceRequest("proj_x", request);
    const generation = observations.find((o) => o.id === "a1b2c3d4e5f60718");

    expect(generation?.type).toBe("generation");
    expect(generation?.model).toBe("gpt-4o");
    expect(generation?.usageDetails).toEqual({ input_tokens: 120, output_tokens: 340 });
    expect(generation?.metadata["gen_ai.provider.name"]).toBe("openai");
  });

  it("maps the modern deployment environment, with legacy fallback only when modern is absent", () => {
    const modern = otlpExportTraceServiceRequestSchema.parse(
      otlpRequest({
        resourceAttrs: [
          { key: "deployment.environment.name", value: { stringValue: " production " } },
          { key: "deployment.environment", value: { stringValue: "legacy" } }
        ]
      })
    );
    expect(mapOtlpTraceRequest("proj_x", modern).traces[0]?.environment).toBe("production");

    const legacy = otlpExportTraceServiceRequestSchema.parse(
      otlpRequest({
        resourceAttrs: [
          { key: "deployment.environment", value: { stringValue: "staging" } }
        ]
      })
    );
    expect(mapOtlpTraceRequest("proj_x", legacy).traces[0]?.environment).toBe("staging");

    const invalidModern = otlpExportTraceServiceRequestSchema.parse(
      otlpRequest({
        resourceAttrs: [
          { key: "deployment.environment.name", value: { stringValue: "x".repeat(65) } },
          { key: "deployment.environment", value: { stringValue: "legacy" } }
        ]
      })
    );
    expect(mapOtlpTraceRequest("proj_x", invalidModern).traces[0]?.environment).toBeUndefined();
  });

  it("maps JSON-string GenAI message attributes to observation input and output", () => {
    const input = JSON.stringify([
      { role: "user", parts: [{ type: "text", content: "Weather in Paris?" }] }
    ]);
    const output = JSON.stringify([
      { role: "assistant", parts: [{ type: "text", content: "Rainy." }], finish_reason: "stop" }
    ]);
    const request = otlpExportTraceServiceRequestSchema.parse(
      otlpRequest({
        childAttrs: [
          { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
          { key: "gen_ai.input.messages", value: { stringValue: input } },
          { key: "gen_ai.output.messages", value: { stringValue: output } }
        ]
      })
    );

    const generation = mapOtlpTraceRequest("proj_x", request).observations.find(
      (observation) => observation.id === "a1b2c3d4e5f60718"
    );
    expect(generation?.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "Weather in Paris?" }] }
    ]);
    expect(generation?.output).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "Rainy." }], finish_reason: "stop" }
    ]);
    expect(generation?.metadata["gen_ai.input.messages"]).toBe(input);
    expect(generation?.metadata["gen_ai.output.messages"]).toBe(output);
  });

  it("unwraps structured AnyValue message attributes without rounding int64 values", () => {
    const request = otlpExportTraceServiceRequestSchema.parse(
      otlpRequest({
        childAttrs: [
          { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
          {
            key: "gen_ai.input.messages",
            value: {
              arrayValue: {
                values: [
                  {
                    kvlistValue: {
                      values: [
                        { key: "role", value: { stringValue: "user" } },
                        {
                          key: "parts",
                          value: {
                            arrayValue: {
                              values: [
                                {
                                  kvlistValue: {
                                    values: [
                                      { key: "type", value: { stringValue: "tool_call" } },
                                      { key: "name", value: { stringValue: "lookup" } },
                                      { key: "id", value: { intValue: "9007199254740993" } }
                                    ]
                                  }
                                }
                              ]
                            }
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            }
          }
        ]
      })
    );

    const generation = mapOtlpTraceRequest("proj_x", request).observations.find(
      (observation) => observation.id === "a1b2c3d4e5f60718"
    );
    expect(generation?.input).toEqual([
      { role: "user", parts: [{ type: "tool_call", name: "lookup", id: "9007199254740993" }] }
    ]);
  });

  it("keeps unsafe JSON integers exact in the derived message projection", () => {
    const input = '[{"role":"user","parts":[{"type":"tool_call","name":"lookup","id":9007199254740993}]}]';
    const request = otlpExportTraceServiceRequestSchema.parse(
      otlpRequest({
        childAttrs: [{ key: "gen_ai.input.messages", value: { stringValue: input } }]
      })
    );

    const generation = mapOtlpTraceRequest("proj_x", request).observations.find(
      (observation) => observation.id === "a1b2c3d4e5f60718"
    );
    expect(generation?.input).toEqual([
      { role: "user", parts: [{ type: "tool_call", name: "lookup", id: "9007199254740993" }] }
    ]);
    expect(generation?.metadata["gen_ai.input.messages"]).toBe(input);
  });

  it("does not project malformed or non-array message JSON", () => {
    const request = otlpExportTraceServiceRequestSchema.parse(
      otlpRequest({
        childAttrs: [
          { key: "gen_ai.input.messages", value: { stringValue: "not json" } },
          { key: "gen_ai.output.messages", value: { stringValue: "[0,1,2]" } }
        ]
      })
    );

    const generation = mapOtlpTraceRequest("proj_x", request).observations.find(
      (observation) => observation.id === "a1b2c3d4e5f60718"
    );
    expect(generation?.input).toBeUndefined();
    expect(generation?.output).toBeUndefined();
    expect(generation?.metadata["gen_ai.input.messages"]).toBe("not json");
    expect(generation?.metadata["gen_ai.output.messages"]).toBe("[0,1,2]");
  });

  it("does not project oversized or compact high-node JSON strings", () => {
    const oversized = JSON.stringify([
      { role: "user", parts: [{ type: "text", content: "x".repeat(132_000) }] }
    ]);
    const highNode = JSON.stringify([
      {
        role: "user",
        parts: [{ type: "custom", values: Array.from({ length: 10_100 }, () => 0) }],
        finish_reason: "stop"
      }
    ]);
    const request = otlpExportTraceServiceRequestSchema.parse(
      otlpRequest({
        childAttrs: [
          { key: "gen_ai.input.messages", value: { stringValue: oversized } },
          { key: "gen_ai.output.messages", value: { stringValue: highNode } }
        ]
      })
    );

    const generation = mapOtlpTraceRequest("proj_x", request).observations.find(
      (observation) => observation.id === "a1b2c3d4e5f60718"
    );
    expect(generation?.input).toBeUndefined();
    expect(generation?.output).toBeUndefined();
    expect(generation?.metadata["gen_ai.input.messages"]).toBe(oversized);
    expect(generation?.metadata["gen_ai.output.messages"]).toBe(highNode);
  });

  it("does not copy a structured AnyValue projection beyond the node budget", () => {
    const request = otlpExportTraceServiceRequestSchema.parse(
      otlpRequest({
        childAttrs: [
          {
            key: "gen_ai.input.messages",
            value: {
              arrayValue: {
                values: [
                  {
                    kvlistValue: {
                      values: [
                        { key: "role", value: { stringValue: "user" } },
                        {
                          key: "parts",
                          value: {
                            arrayValue: {
                              values: [
                                {
                                  kvlistValue: {
                                    values: [
                                      { key: "type", value: { stringValue: "custom" } },
                                      {
                                        key: "values",
                                        value: {
                                          arrayValue: {
                                            values: Array.from({ length: 10_100 }, () => ({ intValue: "0" }))
                                          }
                                        }
                                      }
                                    ]
                                  }
                                }
                              ]
                            }
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            }
          }
        ]
      })
    );

    const generation = mapOtlpTraceRequest("proj_x", request).observations.find(
      (observation) => observation.id === "a1b2c3d4e5f60718"
    );
    expect(generation?.input).toBeUndefined();
    expect(generation?.metadata["gen_ai.input.messages"]).toContain('"arrayValue"');
  });

  it("accepts the message and aggregate-part boundary and rejects the next message", () => {
    const atLimit = Array.from({ length: 200 }, (_, index) => ({
      role: "user",
      parts: [{ type: "text", content: String(index) }]
    }));
    const overLimit = Array.from({ length: 201 }, () => ({
      role: "assistant",
      parts: [],
      finish_reason: "stop"
    }));
    const request = otlpExportTraceServiceRequestSchema.parse(
      otlpRequest({
        childAttrs: [
          { key: "gen_ai.input.messages", value: { stringValue: JSON.stringify(atLimit) } },
          { key: "gen_ai.output.messages", value: { stringValue: JSON.stringify(overLimit) } }
        ]
      })
    );

    const generation = mapOtlpTraceRequest("proj_x", request).observations.find(
      (observation) => observation.id === "a1b2c3d4e5f60718"
    );
    expect(generation?.input).toEqual(atLimit);
    expect(generation?.output).toBeUndefined();
  });

  it("bounds message projection cumulatively across spans and both directions", () => {
    const input = JSON.stringify([
      {
        role: "user",
        parts: [{ type: "custom", values: Array.from({ length: 1_000 }, () => 0) }]
      }
    ]);
    const output = JSON.stringify([
      {
        role: "assistant",
        parts: [{ type: "custom", values: Array.from({ length: 1_000 }, () => 0) }],
        finish_reason: "stop"
      }
    ]);
    const raw = otlpRequest();
    const spans = raw.resourceSpans[0]!.scopeSpans[0]!.spans as Array<Record<string, unknown>>;
    const root = spans[0]!;
    const children = Array.from({ length: 30 }, (_, index) => ({
      traceId: root.traceId,
      spanId: (index + 1).toString(16).padStart(16, "0"),
      parentSpanId: root.spanId,
      name: `chat-${index}`,
      startTimeUnixNano: "1700000000200000000",
      endTimeUnixNano: "1700000001400000000",
      attributes: [
        { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
        { key: "gen_ai.input.messages", value: { stringValue: input } },
        { key: "gen_ai.output.messages", value: { stringValue: output } }
      ],
      status: { code: 1 }
    }));
    spans.splice(1, spans.length - 1, ...children);

    const request = otlpExportTraceServiceRequestSchema.parse(raw);
    const { observations } = mapOtlpTraceRequest("proj_x", request);
    const projectedFieldCount = observations.reduce(
      (count, observation) => count + Number(observation.input !== undefined) + Number(observation.output !== undefined),
      0
    );
    const skipped = observations.find(
      (observation) => observation.id !== root.spanId &&
        (observation.input === undefined || observation.output === undefined)
    );

    expect(projectedFieldCount).toBeGreaterThan(0);
    expect(projectedFieldCount).toBeLessThan(children.length * 2);
    expect(skipped?.metadata["gen_ai.input.messages"]).toBe(input);
    expect(skipped?.metadata["gen_ai.output.messages"]).toBe(output);
  });

  it("falls back to gen_ai.system for provider name when gen_ai.provider.name is absent (legacy spec)", () => {
    const request = otlpExportTraceServiceRequestSchema.parse(
      otlpRequest({
        childAttrs: [
          { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
          { key: "gen_ai.system", value: { stringValue: "anthropic" } },
          { key: "gen_ai.request.model", value: { stringValue: "claude" } }
        ]
      })
    );
    const { observations } = mapOtlpTraceRequest("proj_x", request);
    const generation = observations.find((o) => o.id === "a1b2c3d4e5f60718");
    expect(generation?.metadata["gen_ai.provider.name"]).toBe("anthropic");
    // The raw legacy key is also preserved verbatim, not overwritten.
    expect(generation?.metadata["gen_ai.system"]).toBe("anthropic");
  });

  it("maps gen_ai.request.* sampling parameters to modelParameters", () => {
    const request = otlpExportTraceServiceRequestSchema.parse(
      otlpRequest({
        childAttrs: [
          { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
          { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
          { key: "gen_ai.request.temperature", value: { doubleValue: 0.7 } },
          { key: "gen_ai.request.max_tokens", value: { intValue: "512" } },
          { key: "gen_ai.request.top_p", value: { doubleValue: 0.9 } },
          { key: "gen_ai.request.seed", value: { intValue: "42" } }
        ]
      })
    );
    const { observations } = mapOtlpTraceRequest("proj_x", request);
    const generation = observations.find((o) => o.id === "a1b2c3d4e5f60718");
    expect(generation?.modelParameters).toEqual({
      temperature: 0.7,
      max_tokens: 512,
      top_p: 0.9,
      seed: 42
    });
  });

  it("omits modelParameters entirely when no gen_ai.request.* sampling attributes are present", () => {
    const request = otlpExportTraceServiceRequestSchema.parse(otlpRequest());
    const { observations } = mapOtlpTraceRequest("proj_x", request);
    const generation = observations.find((o) => o.id === "a1b2c3d4e5f60718");
    expect(generation?.modelParameters).toBeUndefined();
  });

  it("classifies a plain (non-gen_ai) span as type=span, not generation", () => {
    const request = otlpExportTraceServiceRequestSchema.parse(otlpRequest());
    const { observations } = mapOtlpTraceRequest("proj_x", request);
    const root = observations.find((o) => o.id === "eee19b7ec3c1b174");
    expect(root?.type).toBe("span");
    expect(root?.model).toBeUndefined();
  });

  it("marks a span with STATUS_CODE_ERROR (2) as level=error", () => {
    const raw = otlpRequest();
    (raw.resourceSpans[0]!.scopeSpans[0]!.spans[0] as { status: { code: number } }).status = {
      code: 2
    };
    const request = otlpExportTraceServiceRequestSchema.parse(raw);
    const { observations } = mapOtlpTraceRequest("proj_x", request);
    const root = observations.find((o) => o.id === "eee19b7ec3c1b174");
    expect(root?.level).toBe("error");
  });

  it("preserves unknown, non-gen_ai attributes in metadata rather than dropping them", () => {
    const request = otlpExportTraceServiceRequestSchema.parse(
      otlpRequest({
        childAttrs: [{ key: "custom.experiment.flag", value: { boolValue: true } }]
      })
    );
    const { observations } = mapOtlpTraceRequest("proj_x", request);
    const child = observations.find((o) => o.id === "a1b2c3d4e5f60718");
    expect(child?.metadata["custom.experiment.flag"]).toBe("true");
  });

  it("converts unix-nano string timestamps to correct ISO-8601 milliseconds", () => {
    const request = otlpExportTraceServiceRequestSchema.parse(otlpRequest());
    const { observations } = mapOtlpTraceRequest("proj_x", request);
    const root = observations.find((o) => o.id === "eee19b7ec3c1b174");
    // 1700000000000000000 ns = 1700000000000 ms = 2023-11-14T22:13:20.000Z
    expect(root?.startTime).toBe("2023-11-14T22:13:20.000Z");
    expect(root?.endTime).toBe("2023-11-14T22:13:21.500Z");
  });

  it("handles an export with zero spans", () => {
    const request = otlpExportTraceServiceRequestSchema.parse({ resourceSpans: [] });
    const { traces, observations } = mapOtlpTraceRequest("proj_x", request);
    expect(traces).toEqual([]);
    expect(observations).toEqual([]);
  });
});
