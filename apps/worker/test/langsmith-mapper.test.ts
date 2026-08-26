import { describe, expect, it } from "vitest";
import { mapLangsmithFeedback, mapLangsmithObservation, mapLangsmithRun } from "../src/importers/langsmith-mapper.js";
import type { LangsmithFeedback, LangsmithRun } from "../src/importers/langsmith-client.js";

function sourceRun(overrides: Partial<LangsmithRun> = {}): LangsmithRun {
  return {
    id: "run_1",
    start_time: "2026-07-12T00:00:00.000Z",
    ...overrides
  };
}

describe("mapLangsmithRun", () => {
  it("prefers trace_id over id when present (a root run's trace_id is the canonical trace identity)", () => {
    const trace = mapLangsmithRun("proj_x", sourceRun({ id: "run_1", trace_id: "trace_1" }));
    expect(trace.id).toBe("trace_1");
  });

  it("falls back to id when trace_id is absent", () => {
    const trace = mapLangsmithRun("proj_x", sourceRun({ id: "run_1" }));
    expect(trace.id).toBe("run_1");
  });

  it("maps core fields and tags the trace as imported", () => {
    const trace = mapLangsmithRun(
      "proj_x",
      sourceRun({ name: "checkout", session_id: "s1", tags: ["prod"] })
    );
    expect(trace).toMatchObject({ projectId: "proj_x", name: "checkout", sessionId: "s1" });
    expect(trace.tags).toEqual(["prod", "imported:langsmith"]);
  });

  it("normalizes non-string extra values to JSON strings for metadata", () => {
    const trace = mapLangsmithRun(
      "proj_x",
      sourceRun({ extra: { plan: "pro", nested: { a: 1 } } })
    );
    expect(trace.metadata).toEqual({ plan: "pro", nested: "{\"a\":1}" });
  });

  it("maps inputs/outputs to input/output", () => {
    const trace = mapLangsmithRun(
      "proj_x",
      sourceRun({ inputs: { q: "hi" }, outputs: { a: "there" } })
    );
    expect(trace.input).toEqual({ q: "hi" });
    expect(trace.output).toEqual({ a: "there" });
  });

  it("omits input/output entirely when absent, rather than storing null", () => {
    const trace = mapLangsmithRun("proj_x", sourceRun());
    expect(trace.input).toBeUndefined();
    expect(trace.output).toBeUndefined();
  });
});

describe("mapLangsmithObservation", () => {
  it("maps run_type 'llm' to generation, everything else to span, preserving the original run_type in metadata", () => {
    const llm = mapLangsmithObservation("proj_x", "trace_1", sourceRun({ run_type: "llm" }));
    expect(llm.type).toBe("generation");
    expect(llm.metadata["langsmith:runType"]).toBe("llm");

    const tool = mapLangsmithObservation("proj_x", "trace_1", sourceRun({ run_type: "tool" }));
    expect(tool.type).toBe("span");
    expect(tool.metadata["langsmith:runType"]).toBe("tool");
  });

  it("sets level 'error' when status is error OR an error message is present, 'default' otherwise", () => {
    expect(mapLangsmithObservation("proj_x", "trace_1", sourceRun({ status: "error" })).level).toBe("error");
    expect(mapLangsmithObservation("proj_x", "trace_1", sourceRun({ error: "boom" })).level).toBe("error");
    expect(mapLangsmithObservation("proj_x", "trace_1", sourceRun({ status: "success" })).level).toBe("default");
  });

  it("parses decimal-STRING costs to numbers, keyed input/output/total", () => {
    const obs = mapLangsmithObservation(
      "proj_x",
      "trace_1",
      sourceRun({ prompt_cost: "0.0012", completion_cost: "0.0034", total_cost: "0.0046" })
    );
    expect(obs.costDetails).toEqual({ input: 0.0012, output: 0.0034, total: 0.0046 });
  });

  it("drops a malformed cost string rather than propagating NaN", () => {
    const obs = mapLangsmithObservation("proj_x", "trace_1", sourceRun({ prompt_cost: "not-a-number", total_cost: "0.01" }));
    expect(obs.costDetails).toEqual({ total: 0.01 });
  });

  it("maps token counts to usageDetails keyed input/output/total, rounding fractional values", () => {
    const obs = mapLangsmithObservation(
      "proj_x",
      "trace_1",
      sourceRun({ prompt_tokens: 10.4, completion_tokens: 20, total_tokens: 30.6 })
    );
    expect(obs.usageDetails).toEqual({ input_tokens: 10, output_tokens: 20, total_tokens: 31 });
  });

  it("preserves an explicit null output — recorded data, not an absent field", () => {
    const obs = mapLangsmithObservation("proj_x", "trace_1", sourceRun({ outputs: null }));
    expect("output" in obs).toBe(true);
    expect(obs.output).toBeNull();
  });

  it("prefers the error message over the raw status string for statusMessage when both are present", () => {
    const obs = mapLangsmithObservation("proj_x", "trace_1", sourceRun({ status: "error", error: "rate limited" }));
    expect(obs.statusMessage).toBe("rate limited");
  });
});

function sourceFeedback(overrides: Partial<LangsmithFeedback> = {}): LangsmithFeedback {
  return {
    id: "fb_1",
    key: "quality",
    ...overrides
  };
}

describe("mapLangsmithFeedback", () => {
  it("keeps a numeric score of 0 — meaningful data, not falsy noise", () => {
    const score = mapLangsmithFeedback("proj_x", "trace_1", sourceFeedback({ score: 0 }));
    expect(score?.dataType).toBe("numeric");
    expect(score?.value).toBe(0);
  });

  it("stringifies a non-string categorical value", () => {
    const score = mapLangsmithFeedback("proj_x", "trace_1", sourceFeedback({ value: { label: "good" } }));
    expect(score?.dataType).toBe("categorical");
    expect(score?.stringValue).toBe('{"label":"good"}');
  });

  it("preserves BOTH a numeric score and a categorical value when present together — neither implies the absence of the other", () => {
    const score = mapLangsmithFeedback("proj_x", "trace_1", sourceFeedback({ score: 1, value: "thumbs_up" }));
    expect(score?.dataType).toBe("numeric");
    expect(score?.value).toBe(1);
    expect(score?.stringValue).toBe("thumbs_up"); // must NOT be dropped just because score is also numeric
  });

  it("returns null (not an invalid Score) when feedback has neither a score nor a value", () => {
    const score = mapLangsmithFeedback("proj_x", "trace_1", sourceFeedback({ comment: "left a note, no rating" }));
    expect(score).toBeNull();
  });

  it("omits observationId when feedback is on the trace's OWN root run, but sets it for a child run — using the resolved traceId, not feedback.trace_id", () => {
    const onRoot = mapLangsmithFeedback("proj_x", "trace_1", sourceFeedback({ run_id: "trace_1", trace_id: "trace_1", score: 1 }));
    expect(onRoot?.observationId).toBeUndefined();

    const onChild = mapLangsmithFeedback("proj_x", "trace_1", sourceFeedback({ run_id: "run_child", trace_id: "trace_1", score: 1 }));
    expect(onChild?.observationId).toBe("run_child");

    // feedback.trace_id absent/mismatched must NOT cause root-run
    // feedback to be misclassified as child-observation feedback — the
    // comparison is against the traceId PARAMETER (the importer's
    // resolved trace id), not feedback.trace_id.
    const rootWithoutTraceIdField = mapLangsmithFeedback(
      "proj_x",
      "trace_1",
      sourceFeedback({ run_id: "trace_1", score: 1 }) // trace_id deliberately omitted
    );
    expect(rootWithoutTraceIdField?.observationId).toBeUndefined();
  });

  it("preserves the original created_at as the score's timestamp", () => {
    const score = mapLangsmithFeedback("proj_x", "trace_1", sourceFeedback({ score: 1, created_at: "2026-05-01T00:00:00.000Z" }));
    expect(score?.timestamp).toBe("2026-05-01T00:00:00.000Z");
  });
});
