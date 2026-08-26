import { describe, expect, it } from "vitest";
import {
  mapLangfuseListTrace,
  mapLangfuseTraceDetail,
  mapLangfuseObservation,
  mapLangfuseScore
} from "../src/importers/langfuse-mapper.js";
import type { LangfuseListTrace, LangfuseObservation, LangfuseScore, LangfuseTraceDetail } from "../src/importers/langfuse-client.js";

function sourceTrace(overrides: Partial<LangfuseListTrace> = {}): LangfuseListTrace {
  return {
    id: "trace_1",
    timestamp: "2026-07-12T00:00:00.000Z",
    ...overrides
  };
}

describe("mapLangfuseListTrace", () => {
  it("maps core fields and tags the trace as imported", () => {
    const trace = mapLangfuseListTrace(
      "proj_x",
      sourceTrace({ name: "checkout", userId: "u1", sessionId: "s1", tags: ["prod"] })
    );
    expect(trace).toMatchObject({
      id: "trace_1",
      projectId: "proj_x",
      name: "checkout",
      userId: "u1",
      sessionId: "s1"
    });
    expect(trace.tags).toEqual(["prod", "imported:langfuse"]);
  });

  it("tags an untagged source trace with imported:langfuse alone", () => {
    const trace = mapLangfuseListTrace("proj_x", sourceTrace());
    expect(trace.tags).toEqual(["imported:langfuse"]);
  });

  it("normalizes non-string metadata values to JSON strings", () => {
    const trace = mapLangfuseListTrace(
      "proj_x",
      sourceTrace({ metadata: { plan: "pro", nested: { a: 1 } } })
    );
    expect(trace.metadata).toEqual({ plan: "pro", nested: "{\"a\":1}" });
  });

  it("passes through input/output when present", () => {
    const trace = mapLangfuseListTrace(
      "proj_x",
      sourceTrace({ input: { q: "hi" }, output: { a: "there" } })
    );
    expect(trace.input).toEqual({ q: "hi" });
    expect(trace.output).toEqual({ a: "there" });
  });

  it("omits input/output entirely when absent, rather than storing null", () => {
    const trace = mapLangfuseListTrace("proj_x", sourceTrace());
    expect(trace.input).toBeUndefined();
    expect(trace.output).toBeUndefined();
  });
});

describe("mapLangfuseTraceDetail", () => {
  it("normalizes a supplied historical environment and omits an invalid one", () => {
    const detail = { ...sourceTrace(), environment: " production " } as LangfuseTraceDetail;
    expect(mapLangfuseTraceDetail("proj_x", detail).environment).toBe("production");
    const invalid = { ...sourceTrace(), environment: "x".repeat(65) } as LangfuseTraceDetail;
    expect(mapLangfuseTraceDetail("proj_x", invalid).environment).toBeUndefined();
  });
});

function sourceObservation(overrides: Partial<LangfuseObservation> = {}): LangfuseObservation {
  return {
    id: "obs_1",
    type: "GENERATION",
    startTime: "2026-07-12T00:00:00.000Z",
    ...overrides
  };
}

describe("mapLangfuseObservation", () => {
  it("normalizes uppercase type/level to Ironside's lowercase enums", () => {
    const obs = mapLangfuseObservation("proj_x", "trace_1", sourceObservation({ type: "EVENT", level: "ERROR" }));
    expect(obs.type).toBe("event");
    expect(obs.level).toBe("error");
  });

  it("falls back to span/default for unrecognized type/level instead of dropping the row", () => {
    const obs = mapLangfuseObservation(
      "proj_x",
      "trace_1",
      sourceObservation({ type: "SOMETHING_NEW", level: "CRITICAL" })
    );
    expect(obs.type).toBe("span");
    expect(obs.level).toBe("default");
  });

  it("preserves an explicit null input/output — it's recorded data, not an absent field", () => {
    const obs = mapLangfuseObservation("proj_x", "trace_1", sourceObservation({ input: null, output: null }));
    expect("input" in obs).toBe(true);
    expect(obs.input).toBeNull();
    expect(obs.output).toBeNull();
  });

  it("falls back to legacy calculated*Cost fields when the modern costDetails record is absent", () => {
    const obs = mapLangfuseObservation(
      "proj_x",
      "trace_1",
      sourceObservation({ calculatedInputCost: 0.001, calculatedOutputCost: 0.002, calculatedTotalCost: 0.003 })
    );
    expect(obs.costDetails).toEqual({ input: 0.001, output: 0.002, total: 0.003 });
  });

  it("prefers modern costDetails over the legacy fields when both exist", () => {
    const obs = mapLangfuseObservation(
      "proj_x",
      "trace_1",
      sourceObservation({ costDetails: { total: 0.9 }, calculatedTotalCost: 0.1 })
    );
    expect(obs.costDetails).toEqual({ total: 0.9 });
  });

  it("rounds fractional usage values to satisfy the integer domain constraint, and drops negatives", () => {
    const obs = mapLangfuseObservation(
      "proj_x",
      "trace_1",
      sourceObservation({ usageDetails: { input: 11.6, output: 34, weird: -5 } })
    );
    expect(obs.usageDetails).toEqual({ input_tokens: 12, output_tokens: 34 });
  });

  it("preserves prompt linkage as langfuse:* metadata keys", () => {
    const obs = mapLangfuseObservation(
      "proj_x",
      "trace_1",
      sourceObservation({ promptName: "greet", promptVersion: 7, metadata: { own: "kept" } })
    );
    expect(obs.metadata).toEqual({ own: "kept", "langfuse:promptName": "greet", "langfuse:promptVersion": "7" });
  });
});

function sourceScore(overrides: Partial<LangfuseScore> = {}): LangfuseScore {
  return {
    id: "score_1",
    traceId: "trace_1",
    name: "quality",
    ...overrides
  };
}

describe("mapLangfuseScore", () => {
  it("maps a BOOLEAN score keeping BOTH the 0/1 value and the True/False stringValue", () => {
    const score = mapLangfuseScore("proj_x", sourceScore({ dataType: "BOOLEAN", value: 1, stringValue: "True" }));
    expect(score.dataType).toBe("boolean");
    expect(score.value).toBe(1);
    expect(score.stringValue).toBe("True");
  });

  it("keeps value 0 — meaningful data, not falsy noise", () => {
    const score = mapLangfuseScore("proj_x", sourceScore({ dataType: "NUMERIC", value: 0 }));
    expect(score.value).toBe(0);
  });

  it("falls back to a value-derived dataType and 'api' source for unknown enum values", () => {
    const numeric = mapLangfuseScore("proj_x", sourceScore({ dataType: "FANCY_NEW", value: 3, source: "WEBHOOK" }));
    expect(numeric.dataType).toBe("numeric");
    expect(numeric.source).toBe("api");

    const categorical = mapLangfuseScore("proj_x", sourceScore({ dataType: "FANCY_NEW", stringValue: "good" }));
    expect(categorical.dataType).toBe("categorical");
  });

  it("normalizes known source values (EVAL/ANNOTATION) to Ironside's lowercase enum", () => {
    expect(mapLangfuseScore("proj_x", sourceScore({ value: 1, source: "EVAL" })).source).toBe("eval");
    expect(mapLangfuseScore("proj_x", sourceScore({ value: 1, source: "ANNOTATION" })).source).toBe("annotation");
  });

  it("preserves the original timestamp when present and omits it when absent", () => {
    const withTs = mapLangfuseScore("proj_x", sourceScore({ value: 1, timestamp: "2026-05-21T14:31:42.769Z" }));
    expect(withTs.timestamp).toBe("2026-05-21T14:31:42.769Z");

    const withoutTs = mapLangfuseScore("proj_x", sourceScore({ value: 1 }));
    expect(withoutTs.timestamp).toBeUndefined();
  });
});
