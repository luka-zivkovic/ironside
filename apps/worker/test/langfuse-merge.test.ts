import type { ObservationRow } from "@ironside/clickhouse";
import type { Observation, Trace } from "@ironside/shared";
import { describe, expect, it } from "vitest";
import { observationFromStoredRow } from "../src/lib/stored-rows.js";
import {
  instant,
  mergeByRecency,
  mergeObservationByRecency
} from "../src/processors/langfuse-merge.js";

const EARLIER = instant("2026-09-23T10:00:00.000Z");
const LATER = instant("2026-09-23T10:00:03.000Z");

const DERIVED_COST_METADATA = {
  "ironside:cost_source": "table",
  "ironside:cost_model": "gpt-4o",
  "ironside:cost_table": "2026-09-11"
};

/** The row a create maps to: everything a generation starts with. */
function createRow(overrides: Partial<Observation> = {}): Observation {
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

/** The row an update-only request maps to: its start time is a placeholder (the update's time). */
function updateRow(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "obs_1",
    traceId: "trace_1",
    projectId: "proj_x",
    type: "generation",
    startTime: "2026-09-23T10:00:03.000Z",
    endTime: "2026-09-23T10:00:03.000Z",
    level: "default",
    metadata: {},
    output: { text: "hello" },
    usageDetails: { input_tokens: 5, output_tokens: 2 },
    ...overrides
  };
}

const CREATE_SENT = new Set<keyof Observation>(["id", "traceId", "projectId", "type", "name", "model", "startTime", "input", "metadata"]);
const UPDATE_SENT = new Set<keyof Observation>(["id", "traceId", "projectId", "type", "endTime", "output", "usageDetails"]);

function sentAt(fields: Iterable<keyof Observation>, at: string): Record<string, string> {
  return Object.fromEntries([...fields].map((field) => [field, at]));
}

describe("mergeByRecency", () => {
  it("fills an update's missing fields from an older create processed after it, keeping the update's values", () => {
    const merged = mergeObservationByRecency(createRow(), CREATE_SENT, EARLIER, {
      row: updateRow(),
      version: LATER,
      sentAt: sentAt(UPDATE_SENT, LATER)
    });

    expect(merged.row).toMatchObject({
      name: "llm-call",
      model: "gpt-4o",
      input: [{ role: "user", content: "hi" }],
      // The create's real start time replaces the update's placeholder.
      startTime: "2026-09-23T10:00:00.000Z",
      endTime: "2026-09-23T10:00:03.000Z",
      output: { text: "hello" },
      usageDetails: { input_tokens: 5, output_tokens: 2 },
      metadata: { team: "sales" }
    });
    expect(merged.sentAt).toMatchObject({ startTime: EARLIER, name: EARLIER, output: LATER });
  });

  it("gives a field both batches sent the value from the later-received batch, whichever is processed last", () => {
    const later = updateRow({ metadata: { team: "support" } });
    const laterSent = new Set<keyof Observation>([...UPDATE_SENT, "metadata"]);

    const olderProcessedLast = mergeObservationByRecency(createRow(), CREATE_SENT, EARLIER, {
      row: later,
      version: LATER,
      sentAt: sentAt(laterSent, LATER)
    });
    const newerProcessedLast = mergeObservationByRecency(later, laterSent, LATER, {
      row: createRow(),
      version: EARLIER,
      sentAt: sentAt(CREATE_SENT, EARLIER)
    });

    expect(olderProcessedLast.row.metadata).toEqual({ team: "support" });
    expect(newerProcessedLast.row.metadata).toEqual({ team: "support" });
    expect(olderProcessedLast.row).toEqual(newerProcessedLast.row);
  });

  it("counts a stored row's non-empty fields as sent at its version when no field times were recorded", () => {
    const stored: Trace = {
      id: "trace_1",
      projectId: "proj_x",
      timestamp: "2026-09-23T10:00:00.000Z",
      name: "checkout",
      tags: [],
      metadata: {},
      output: { answer: "old" }
    };
    const olderIncoming: Trace = { ...stored, name: "renamed", tags: ["prod"], output: { answer: "older" } };

    const merged = mergeByRecency(olderIncoming, new Set<keyof Trace>(["id", "projectId", "name", "tags", "output"]), EARLIER, {
      row: stored,
      version: LATER,
      sentAt: undefined
    });

    // Stored values win as the later ones; empty tags are a default, so the incoming ones fill them.
    expect(merged.row).toMatchObject({ name: "checkout", output: { answer: "old" }, tags: ["prod"] });
  });

  it("does not count a retried batch's own placeholders as sent when its field times were never recorded", () => {
    // The update's first attempt wrote its row, then failed before recording field times.
    const retried = mergeObservationByRecency(updateRow(), UPDATE_SENT, LATER, {
      row: updateRow(),
      version: LATER,
      sentAt: undefined
    });
    expect(retried.sentAt.startTime).toBeUndefined();
    expect(retried.sentAt.level).toBeUndefined();

    const withCreate = mergeObservationByRecency(createRow(), CREATE_SENT, EARLIER, {
      row: retried.row,
      version: LATER,
      sentAt: retried.sentAt
    });
    expect(withCreate.row.startTime).toBe("2026-09-23T10:00:00.000Z");
    expect(withCreate.row.name).toBe("llm-call");
  });

  it("keeps a stored placeholder when neither side sent the field", () => {
    const merged = mergeObservationByRecency(updateRow({ startTime: "2026-09-23T10:00:09.000Z" }), UPDATE_SENT, LATER, {
      row: updateRow(),
      version: EARLIER,
      sentAt: sentAt(UPDATE_SENT, EARLIER)
    });
    expect(merged.row.startTime).toBe("2026-09-23T10:00:03.000Z");
    expect(merged.sentAt.startTime).toBeUndefined();
  });
});

describe("mergeObservationByRecency — cost", () => {
  it("drops a derived cost and its provenance when a later batch sends new usage, so cost is derived again", () => {
    const stored = createRow({
      usageDetails: { input_tokens: 5, output_tokens: 2 },
      costDetails: { total: 0.0000325 },
      metadata: { team: "sales", ...DERIVED_COST_METADATA }
    });
    const merged = mergeObservationByRecency(
      updateRow({ usageDetails: { input_tokens: 50, output_tokens: 20 } }),
      UPDATE_SENT,
      LATER,
      { row: stored, version: EARLIER, sentAt: sentAt([...CREATE_SENT, "usageDetails"], EARLIER) }
    );
    expect(merged.row.usageDetails).toEqual({ input_tokens: 50, output_tokens: 20 });
    expect(merged.row.costDetails).toBeUndefined();
    expect(merged.row.metadata).toEqual({ team: "sales" });
  });

  it("keeps a derived cost when the batch that sent other usage is older than the stored usage", () => {
    const stored = createRow({
      usageDetails: { input_tokens: 5, output_tokens: 2 },
      costDetails: { total: 0.0000325 },
      metadata: { team: "sales", ...DERIVED_COST_METADATA }
    });
    const merged = mergeObservationByRecency(
      updateRow({ usageDetails: { input_tokens: 1, output_tokens: 1 } }),
      UPDATE_SENT,
      EARLIER,
      { row: stored, version: LATER, sentAt: sentAt([...CREATE_SENT, "usageDetails"], LATER) }
    );
    expect(merged.row.usageDetails).toEqual({ input_tokens: 5, output_tokens: 2 });
    expect(merged.row.costDetails).toEqual({ total: 0.0000325 });
  });

  it("keeps a derived cost and restores its provenance when a later batch only replaces metadata", () => {
    const stored = createRow({
      usageDetails: { input_tokens: 5, output_tokens: 2 },
      costDetails: { total: 0.0000325 },
      metadata: { team: "sales", ...DERIVED_COST_METADATA }
    });
    const merged = mergeObservationByRecency(
      createRow({ metadata: { team: "support" } }),
      new Set<keyof Observation>(["id", "traceId", "projectId", "type", "metadata"]),
      LATER,
      { row: stored, version: EARLIER, sentAt: sentAt([...CREATE_SENT, "usageDetails"], EARLIER) }
    );
    expect(merged.row.costDetails).toEqual({ total: 0.0000325 });
    expect(merged.row.metadata).toEqual({ team: "support", ...DERIVED_COST_METADATA });
  });

  it("keeps a client-sent cost, and drops derived labels carried over from stored metadata, so later usage cannot replace it", () => {
    const derived = createRow({
      usageDetails: { input_tokens: 1000, output_tokens: 500 },
      costDetails: { total: 0.0075 },
      metadata: { team: "sales", ...DERIVED_COST_METADATA }
    });
    const clientCost = mergeObservationByRecency(
      updateRow({ costDetails: { total: 0.5 } }),
      new Set<keyof Observation>(["id", "traceId", "projectId", "type", "costDetails"]),
      LATER,
      { row: derived, version: EARLIER, sentAt: sentAt([...CREATE_SENT, "usageDetails"], EARLIER) }
    );
    expect(clientCost.row.costDetails).toEqual({ total: 0.5 });
    expect(clientCost.row.metadata).toEqual({ team: "sales" });

    const evenLater = instant("2026-09-23T10:00:09.000Z");
    const laterUsage = mergeObservationByRecency(
      updateRow({ usageDetails: { input_tokens: 1200, output_tokens: 600 } }),
      UPDATE_SENT,
      evenLater,
      { row: clientCost.row, version: LATER, sentAt: clientCost.sentAt }
    );
    expect(laterUsage.row.costDetails).toEqual({ total: 0.5 });
  });
});

describe("instant", () => {
  it("normalizes ISO and ClickHouse renderings to comparable microsecond strings", () => {
    expect(instant("2026-09-23T10:00:00.123Z")).toBe("2026-09-23T10:00:00.123000Z");
    expect(instant("2026-09-23 10:00:00.123456")).toBe("2026-09-23T10:00:00.123456Z");
    expect(instant("2026-09-23 10:00:00")).toBe("2026-09-23T10:00:00.000000Z");
    expect(instant("2026-09-23T10:00:00.123Z") < instant("2026-09-23 10:00:00.123001")).toBe(true);
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
