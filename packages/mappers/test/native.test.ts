import type { IngestEvent } from "@ironside/shared";
import { describe, expect, it } from "vitest";
import { mapNativeEvents } from "../src/native.js";

function event(overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    id: "evt_1",
    type: "trace-upsert",
    source: "native",
    schemaVersion: 1,
    idempotencyKey: "hash1",
    body: {
      id: "trace_1",
      timestamp: "2026-07-12T00:00:00Z",
      name: "checkout"
    },
    ...overrides
  };
}

describe("mapNativeEvents", () => {
  it("maps a valid trace-upsert event, injecting the server-resolved projectId", () => {
    const { rows, errors } = mapNativeEvents("proj_x", [event()]);
    expect(errors).toEqual([]);
    expect(rows.traces).toHaveLength(1);
    expect(rows.traces[0]).toMatchObject({
      id: "trace_1",
      projectId: "proj_x",
      name: "checkout"
    });
  });

  it("normalizes a valid environment and drops only invalid optional environment metadata", () => {
    const valid = mapNativeEvents("proj_x", [
      event({ body: { ...(event().body as object), environment: "  Produc\u0065\u0301tion  " } })
    ]);
    expect(valid.rows.traces[0]?.environment).toBe("Producétion");

    const invalid = mapNativeEvents("proj_x", [
      event({ body: { ...(event().body as object), environment: "x".repeat(65) } })
    ]);
    expect(invalid.errors).toEqual([]);
    expect(invalid.rows.traces[0]?.environment).toBeUndefined();
  });

  it("routes observation-upsert and score-upsert to their respective buckets", () => {
    const { rows, errors } = mapNativeEvents("proj_x", [
      event({
        id: "evt_obs",
        type: "observation-upsert",
        body: {
          id: "obs_1",
          traceId: "trace_1",
          type: "generation",
          startTime: "2026-07-12T00:00:00Z"
        }
      }),
      event({
        id: "evt_score",
        type: "score-upsert",
        body: {
          id: "score_1",
          traceId: "trace_1",
          name: "accuracy",
          dataType: "numeric",
          value: 0.9,
          source: "api"
        }
      })
    ]);
    expect(errors).toEqual([]);
    expect(rows.observations).toHaveLength(1);
    expect(rows.scores).toHaveLength(1);
  });

  it("skips a malformed event and reports it, without dropping the rest of the batch", () => {
    const { rows, errors } = mapNativeEvents("proj_x", [
      event({ id: "evt_bad", body: { name: "missing required fields" } }),
      event({ id: "evt_good" })
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.eventId).toBe("evt_bad");
    expect(rows.traces).toHaveLength(1);
    expect(rows.traces[0]?.id).toBe("trace_1");
  });

  it("ignores events from non-native sources", () => {
    const { rows, errors } = mapNativeEvents("proj_x", [event({ source: "otlp" })]);
    expect(errors).toEqual([]);
    expect(rows.traces).toEqual([]);
  });

  it("rejects a score with neither value nor stringValue (invariant survives the omit-based schema split)", () => {
    const { rows, errors } = mapNativeEvents("proj_x", [
      event({
        id: "evt_bad_score",
        type: "score-upsert",
        body: {
          id: "score_1",
          traceId: "trace_1",
          name: "accuracy",
          dataType: "numeric",
          source: "api"
        }
      })
    ]);
    expect(rows.scores).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/value or stringValue/);
  });

  it("canonicalizes observation usageDetails alias keys (M9-04) — a hand-rolled native client posting {input: 5} must not re-split token aggregates from the canonical input_tokens series; custom keys pass through", () => {
    const { rows } = mapNativeEvents("proj_x", [
      event({
        id: "evt_usage_alias",
        type: "observation-upsert",
        body: {
          id: "obs_alias",
          traceId: "trace_1",
          type: "generation",
          startTime: "2026-07-12T00:00:00.000Z",
          usageDetails: { input: 5, output: 3, my_custom_series: 7 }
        }
      })
    ]);
    expect(rows.observations[0]?.usageDetails).toEqual({
      input_tokens: 5,
      output_tokens: 3,
      my_custom_series: 7
    });
  });

  it("rejects a client-supplied projectId inside the body (server always wins)", () => {
    const { rows } = mapNativeEvents("proj_x", [
      event({ body: { ...(event().body as object), projectId: "proj_attacker" } })
    ]);
    expect(rows.traces[0]?.projectId).toBe("proj_x");
  });
});
