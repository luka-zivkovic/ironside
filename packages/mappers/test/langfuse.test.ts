import { langfuseIngestionRequestSchema, type LangfuseBatchEvent } from "@ironside/shared";
import { describe, expect, it } from "vitest";
import { mapLangfuseIngestionRequest } from "../src/langfuse.js";

function batchEvent(overrides: Partial<LangfuseBatchEvent> = {}): LangfuseBatchEvent {
  return {
    id: "evt_1",
    timestamp: "2026-07-12T00:00:00.000Z",
    type: "trace-create",
    body: { id: "trace_1", name: "checkout" },
    ...overrides
  };
}

function request(batch: LangfuseBatchEvent[]) {
  return langfuseIngestionRequestSchema.parse({ batch });
}

describe("langfuseIngestionRequestSchema", () => {
  it("parses a realistic multi-event batch", () => {
    const parsed = request([
      batchEvent(),
      batchEvent({ id: "evt_2", type: "generation-create", body: { traceId: "trace_1" } })
    ]);
    expect(parsed.batch).toHaveLength(2);
  });
});

describe("mapLangfuseIngestionRequest — explicit null fields", () => {
  it("accepts explicit null for optional observation fields instead of rejecting the event — regression: a live conformance run captured the real langfuse npm SDK sending parentObservationId: null on a root generation-create; a plain z.string().optional() schema rejects null (only undefined), which failed the whole event as invalid", () => {
    const { rows, response } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({
          type: "generation-create",
          body: {
            id: "obs_1",
            traceId: "trace_1",
            parentObservationId: null,
            name: "llm-call",
            statusMessage: null,
            model: "gpt-4o"
          }
        })
      ])
    );
    expect(response.errors).toEqual([]);
    expect(rows.observations).toHaveLength(1);
    expect(rows.observations[0]?.name).toBe("llm-call");
    expect(rows.observations[0]?.parentObservationId).toBeUndefined();
  });

  it("accepts explicit null for optional trace fields", () => {
    const { response, rows } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({
          body: { id: "trace_1", name: "checkout", userId: null, sessionId: null }
        })
      ])
    );
    expect(response.errors).toEqual([]);
    expect(rows.traces[0]?.name).toBe("checkout");
  });
});

describe("mapLangfuseIngestionRequest", () => {
  it("rejects NUL and oversized domain identifiers as per-event errors", () => {
    const { rows, response } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({ id: "evt_nul", body: { id: "trace\0poison" } }),
        batchEvent({
          id: "evt_long",
          type: "generation-create",
          body: { id: "obs_1", traceId: "x".repeat(513) }
        })
      ])
    );
    expect(rows.traces).toEqual([]);
    expect(rows.observations).toEqual([]);
    expect(response.errors).toEqual([
      expect.objectContaining({ id: "evt_nul", status: 400 }),
      expect.objectContaining({ id: "evt_long", status: 400 })
    ]);
  });

  it("maps trace-create to a Trace row and reports success in the 207 response", () => {
    const { rows, response } = mapLangfuseIngestionRequest(
      "proj_x",
      request([batchEvent({ body: { id: "trace_1", name: "checkout", userId: "u1", tags: ["prod"] } })])
    );
    expect(rows.traces).toHaveLength(1);
    expect(rows.traces[0]).toMatchObject({
      id: "trace_1",
      projectId: "proj_x",
      name: "checkout",
      userId: "u1",
      tags: ["prod"]
    });
    expect(response.successes).toEqual([{ id: "evt_1", status: 201 }]);
    expect(response.errors).toEqual([]);
  });

  it("normalizes trace environment/release/version and drops an invalid environment only", () => {
    const { rows } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({
          body: {
            id: "trace_1",
            environment: " production ",
            release: "2026.08",
            version: "abc123"
          }
        })
      ])
    );
    expect(rows.traces[0]).toMatchObject({
      environment: "production",
      release: "2026.08",
      version: "abc123"
    });

    const invalid = mapLangfuseIngestionRequest(
      "proj_x",
      request([batchEvent({ body: { id: "trace_2", environment: "x".repeat(65) } })])
    );
    expect(invalid.response.errors).toEqual([]);
    expect(invalid.rows.traces[0]?.environment).toBeUndefined();
  });

  it("maps generation-create with legacy usage shape ({input, output}) to usageDetails", () => {
    const { rows } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({
          type: "generation-create",
          body: {
            id: "obs_1",
            traceId: "trace_1",
            model: "gpt-4",
            usage: { input: 10, output: 20, total: 30 }
          }
        })
      ])
    );
    expect(rows.observations[0]?.type).toBe("generation");
    // total is now preserved as total_tokens — previously silently dropped in the legacy-shape branch (fixed in M9-04)
    expect(rows.observations[0]?.usageDetails).toEqual({ input_tokens: 10, output_tokens: 20, total_tokens: 30 });
  });

  it("maps generation-create with OpenAI-shaped usage (promptTokens/completionTokens) to usageDetails", () => {
    const { rows } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({
          type: "generation-create",
          body: {
            id: "obs_1",
            traceId: "trace_1",
            usage: { promptTokens: 5, completionTokens: 15, totalTokens: 20 }
          }
        })
      ])
    );
    expect(rows.observations[0]?.usageDetails).toEqual({ input_tokens: 5, output_tokens: 15, total_tokens: 20 });
  });

  it("maps generation-create with a flat numeric usageDetails map through unchanged", () => {
    const { rows } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({
          type: "generation-create",
          body: {
            id: "obs_1",
            traceId: "trace_1",
            usageDetails: { input_tokens: 7, output_tokens: 13, cached_tokens: 2 }
          }
        })
      ])
    );
    expect(rows.observations[0]?.usageDetails).toEqual({
      input_tokens: 7,
      output_tokens: 13,
      cached_tokens: 2
    });
  });

  it("lowercases LangFuse's uppercase level to Ironside's lowercase enum", () => {
    const { rows } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({
          type: "span-create",
          body: { id: "obs_1", traceId: "trace_1", level: "ERROR", statusMessage: "boom" }
        })
      ])
    );
    expect(rows.observations[0]?.level).toBe("error");
    expect(rows.observations[0]?.statusMessage).toBe("boom");
  });

  it("maps score-create, inferring numeric vs categorical from the value type", () => {
    const { rows } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({ id: "evt_score_1", type: "score-create", body: { traceId: "trace_1", name: "accuracy", value: 0.9 } }),
        batchEvent({ id: "evt_score_2", type: "score-create", body: { traceId: "trace_1", name: "sentiment", value: "positive" } })
      ])
    );
    expect(rows.scores[0]).toMatchObject({ name: "accuracy", dataType: "numeric", value: 0.9 });
    expect(rows.scores[1]).toMatchObject({
      name: "sentiment",
      dataType: "categorical",
      stringValue: "positive"
    });
  });

  it("rejects a value-less score as a per-event error rather than mapping it into an invalid row — regression: the wire schema's value is optional, but the domain requires value OR stringValue; this used to map 'successfully' into a both-columns-NULL score, indistinguishable from data loss (same bug class M5-06 fixed in the LangSmith mapper)", () => {
    const { rows, response } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({ id: "evt_score_no_value", type: "score-create", body: { traceId: "trace_1", name: "broken" } })
      ])
    );
    expect(rows.scores).toEqual([]);
    expect(response.errors).toHaveLength(1);
    expect(response.errors[0]).toMatchObject({ id: "evt_score_no_value", status: 400 });
    expect(response.errors[0]?.message).toMatch(/score requires a value/);
  });

  it("rounds fractional usage and drops negatives — regression: the ClickHouse column is UInt64, and one bad value would fail the ENTIRE multi-source batch INSERT (not per-event dead-lettering); also ignores the legacy shape's non-numeric `unit` string", () => {
    const { rows } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({
          type: "generation-create",
          body: {
            id: "gen_frac",
            traceId: "trace_1",
            startTime: "2026-07-12T00:00:00.000Z",
            usage: { input: 11.6, output: -5, total: 12.4, unit: "TOKENS" }
          }
        })
      ])
    );
    expect(rows.observations[0]?.usageDetails).toEqual({
      input_tokens: 12,
      total_tokens: 12
      // output (-5) dropped; unit (string) ignored — neither leaks through
    });
  });

  it("accepts sdk-log events without storing anything, still reporting success", () => {
    const { rows, response } = mapLangfuseIngestionRequest(
      "proj_x",
      request([batchEvent({ type: "sdk-log", body: { log: "diagnostic" } })])
    );
    expect(rows.traces).toEqual([]);
    expect(rows.observations).toEqual([]);
    expect(rows.scores).toEqual([]);
    expect(response.successes).toHaveLength(1);
  });

  it("routes the deprecated observation-create/-update alias to a span observation", () => {
    const { rows } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({ type: "observation-create", body: { id: "obs_1", traceId: "trace_1" } })
      ])
    );
    expect(rows.observations[0]?.type).toBe("span");
  });

  it("records a malformed event in the 207 errors array without failing the rest of the batch", () => {
    const { rows, response } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        // generation-create with no traceId — required field missing.
        batchEvent({ id: "evt_bad", type: "generation-create", body: { id: "obs_1" } }),
        batchEvent({ id: "evt_good", type: "trace-create", body: { id: "trace_1" } })
      ])
    );
    expect(response.errors).toHaveLength(1);
    expect(response.errors[0]?.id).toBe("evt_bad");
    expect(response.successes).toHaveLength(1);
    expect(rows.traces).toHaveLength(1);
  });

  it("generates an id when the body omits one, matching LangFuse's optional-id semantics", () => {
    const { rows } = mapLangfuseIngestionRequest(
      "proj_x",
      request([batchEvent({ body: { name: "no-id-trace" } })])
    );
    expect(rows.traces[0]?.id).toBeTruthy();
  });

  it("merges generation-create + generation-update for the same id into ONE observation, not two, regardless of array order — regression: the real langfuse npm SDK's generation.end() call was captured emitting generation-update BEFORE generation-create for the same observation id in a live conformance test; mapping each independently silently lost name/model/input because both mapped to the same ClickHouse row with an undefined tie-break", () => {
    const observationId = "obs_merge_test";
    // update-before-create in array order, exactly as the real SDK sent it.
    const { rows } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({ type: "trace-create", body: { id: "trace_1" } }),
        batchEvent({
          id: "evt_update",
          type: "generation-update",
          body: {
            id: observationId,
            traceId: "trace_1",
            endTime: "2026-07-12T00:00:01.000Z",
            output: { text: "response" },
            usage: { promptTokens: 11, completionTokens: 22 }
          }
        }),
        batchEvent({
          id: "evt_create",
          type: "generation-create",
          body: {
            id: observationId,
            traceId: "trace_1",
            startTime: "2026-07-12T00:00:00.000Z",
            name: "llm-call",
            model: "gpt-4o",
            input: [{ role: "user", content: "hi" }]
          }
        })
      ])
    );

    // Exactly one merged observation, not two.
    expect(rows.observations).toHaveLength(1);
    const merged = rows.observations[0];
    // Fields from -create (which arrived SECOND in the array) survive.
    expect(merged?.name).toBe("llm-call");
    expect(merged?.model).toBe("gpt-4o");
    expect(merged?.input).toEqual([{ role: "user", content: "hi" }]);
    expect(merged?.startTime).toBe("2026-07-12T00:00:00.000Z");
    // Fields from -update (which arrived FIRST) also survive.
    expect(merged?.endTime).toBe("2026-07-12T00:00:01.000Z");
    expect(merged?.output).toEqual({ text: "response" });
    expect(merged?.usageDetails).toEqual({ input_tokens: 11, output_tokens: 22 });
  });

  it("an -update field wins over -create's value for the SAME field name, even when -update is positioned BEFORE -create in the array — proves merge order is create-then-update by TYPE, not naive array-position last-write-wins (the weaker test above uses disjoint field sets between create/update, so a naive array-order-only merge would pass it too; this one only passes under the correct type-partitioned merge)", () => {
    const { rows } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({ type: "trace-create", body: { id: "trace_1" } }),
        // -update FIRST in array, sets name to the "final" value.
        batchEvent({
          id: "evt_update",
          type: "generation-update",
          body: { id: "obs_overlap", traceId: "trace_1", name: "renamed-by-update" }
        }),
        // -create LAST in array, sets a DIFFERENT value for the SAME field.
        batchEvent({
          id: "evt_create",
          type: "generation-create",
          body: { id: "obs_overlap", traceId: "trace_1", name: "original-from-create" }
        })
      ])
    );

    expect(rows.observations).toHaveLength(1);
    // If the merge were naive last-write-wins-by-array-position, -create
    // (positioned last) would win here and this would be
    // "original-from-create" instead — that would be WRONG, since
    // -update always represents state applied after -create logically,
    // regardless of which happened to serialize later in the batch array.
    expect(rows.observations[0]?.name).toBe("renamed-by-update");
  });

  it("merges trace-create with a later partial update-like event for the same trace id into one trace row", () => {
    const { rows } = mapLangfuseIngestionRequest(
      "proj_x",
      request([
        batchEvent({
          id: "evt_1",
          type: "trace-create",
          body: { id: "trace_1", name: "checkout", userId: "u1" }
        }),
        batchEvent({
          id: "evt_2",
          type: "trace-create",
          body: { id: "trace_1", output: { total: 42 } }
        })
      ])
    );
    expect(rows.traces).toHaveLength(1);
    expect(rows.traces[0]).toMatchObject({ name: "checkout", userId: "u1", output: { total: 42 } });
  });
});
