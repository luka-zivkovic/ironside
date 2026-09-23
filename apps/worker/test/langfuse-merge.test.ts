import type { ObservationRow } from "@ironside/clickhouse";
import type { Observation, Trace } from "@ironside/shared";
import { describe, expect, it } from "vitest";
import {
  fillUnprovidedObservationFields,
  fillUnprovidedTraceFields,
  observationFromStoredRow
} from "../src/processors/langfuse-merge.js";

const DERIVED_COST_METADATA = {
  "ironside:cost_source": "table",
  "ironside:cost_model": "gpt-4o",
  "ironside:cost_table": "2026-09-11"
};

function storedGeneration(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "obs_1",
    traceId: "trace_1",
    projectId: "proj_x",
    type: "generation",
    name: "llm-call",
    model: "gpt-4o",
    startTime: "2026-09-23T10:00:00.000Z",
    level: "default",
    input: [{ role: "user", content: "hi" }],
    metadata: { team: "sales" },
    ...overrides
  };
}

describe("fillUnprovidedTraceFields", () => {
  it("takes every field the update did not send from the stored trace, and keeps what it did send", () => {
    const stored: Trace = {
      id: "trace_1",
      projectId: "proj_x",
      timestamp: "2026-09-23T10:00:00.000Z",
      name: "checkout",
      userId: "user_1",
      tags: ["prod"],
      metadata: { team: "sales" },
      input: { question: "hi" },
      output: { answer: "old" }
    };
    const incoming: Trace = {
      id: "trace_1",
      projectId: "proj_x",
      timestamp: "2026-09-23T10:00:03.000Z",
      tags: [],
      metadata: {},
      output: { answer: "new" }
    };
    const merged = fillUnprovidedTraceFields(incoming, new Set(["id", "projectId", "output"]), stored);
    expect(merged).toEqual({ ...stored, output: { answer: "new" } });
  });
});

describe("fillUnprovidedObservationFields", () => {
  it("restores name, model, input, and start time an update did not send", () => {
    const incoming: Observation = {
      id: "obs_1",
      traceId: "trace_1",
      projectId: "proj_x",
      type: "generation",
      startTime: "2026-09-23T10:00:03.000Z",
      endTime: "2026-09-23T10:00:03.000Z",
      level: "default",
      metadata: {},
      output: { text: "hello" }
    };
    const merged = fillUnprovidedObservationFields(
      incoming,
      new Set(["id", "traceId", "projectId", "type", "endTime", "output"]),
      storedGeneration()
    );
    expect(merged).toMatchObject({
      name: "llm-call",
      model: "gpt-4o",
      startTime: "2026-09-23T10:00:00.000Z",
      endTime: "2026-09-23T10:00:03.000Z",
      input: [{ role: "user", content: "hi" }],
      output: { text: "hello" },
      metadata: { team: "sales" }
    });
  });

  it("drops a derived cost and its provenance when the update sends new usage, so cost is derived again", () => {
    const stored = storedGeneration({
      usageDetails: { input_tokens: 5, output_tokens: 2 },
      costDetails: { input: 0.0000125, output: 0.00002, total: 0.0000325 },
      metadata: { team: "sales", ...DERIVED_COST_METADATA }
    });
    const incoming: Observation = {
      ...storedGeneration(),
      usageDetails: { input_tokens: 50, output_tokens: 20 },
      metadata: {}
    };
    const merged = fillUnprovidedObservationFields(
      incoming,
      new Set(["id", "traceId", "projectId", "type", "usageDetails"]),
      stored
    );
    expect(merged.usageDetails).toEqual({ input_tokens: 50, output_tokens: 20 });
    expect(merged.costDetails).toBeUndefined();
    expect(merged.metadata).toEqual({ team: "sales" });
  });

  it("keeps a derived cost and restores its provenance when the update only replaces metadata", () => {
    const stored = storedGeneration({
      usageDetails: { input_tokens: 5, output_tokens: 2 },
      costDetails: { total: 0.0000325 },
      metadata: { team: "sales", ...DERIVED_COST_METADATA }
    });
    const incoming: Observation = { ...storedGeneration(), metadata: { team: "support" } };
    const merged = fillUnprovidedObservationFields(
      incoming,
      new Set(["id", "traceId", "projectId", "type", "metadata"]),
      stored
    );
    expect(merged.costDetails).toEqual({ total: 0.0000325 });
    expect(merged.metadata).toEqual({ team: "support", ...DERIVED_COST_METADATA });
  });

  it("carries a client-sent cost forward unchanged even when usage changes — only derived costs are recomputed", () => {
    const stored = storedGeneration({
      usageDetails: { input_tokens: 5 },
      costDetails: { total: 1.5 }
    });
    const incoming: Observation = { ...storedGeneration(), usageDetails: { input_tokens: 50 } };
    const merged = fillUnprovidedObservationFields(
      incoming,
      new Set(["id", "traceId", "projectId", "type", "usageDetails"]),
      stored
    );
    expect(merged.costDetails).toEqual({ total: 1.5 });
  });
});

describe("observationFromStoredRow", () => {
  it("reads empty stored maps back as absent and parses stored JSON payloads", () => {
    const row: ObservationRow = {
      id: "obs_1",
      trace_id: "trace_1",
      parent_observation_id: null,
      type: "generation",
      name: "llm-call",
      start_time: "2026-09-23T10:00:00.000Z",
      end_time: null,
      level: "default",
      status_message: null,
      model: "gpt-4o",
      model_parameters: {},
      input: '[{"role":"user","content":"hi"}]',
      output: null,
      usage_details: {},
      cost_details: {},
      completion_start_time: null,
      metadata: {}
    };
    expect(observationFromStoredRow("proj_x", row)).toEqual({
      id: "obs_1",
      traceId: "trace_1",
      projectId: "proj_x",
      type: "generation",
      name: "llm-call",
      model: "gpt-4o",
      startTime: "2026-09-23T10:00:00.000Z",
      level: "default",
      metadata: {},
      input: [{ role: "user", content: "hi" }]
    });
  });
});
