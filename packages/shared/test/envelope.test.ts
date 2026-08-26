import { describe, expect, it } from "vitest";
import {
  MAX_EVENTS_PER_BATCH,
  PENDING_INGEST_CURSOR_KEY,
  PENDING_INGEST_PROBE_PREFIX,
  failedIngestObjectKey,
  ingestBatchSchema,
  ingestEventSchema,
  observationSchema,
  pendingIngestObjectKey,
  parseRawObjectKey,
  rawObjectKey,
  scoreSchema,
  traceSchema
} from "../src/index.js";

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "01JZC0000000000000000000001",
    type: "trace-upsert",
    source: "native",
    schemaVersion: 1,
    idempotencyKey: "abc123",
    body: { anything: "goes", nested: { deeply: true } },
    ...overrides
  };
}

function validBatch(overrides: Record<string, unknown> = {}) {
  return {
    batchId: "01JZC0000000000000000000B01",
    projectId: "proj_test",
    receivedAt: "2026-07-11T12:00:00Z",
    events: [validEvent()],
    ...overrides
  };
}

describe("ingestEventSchema", () => {
  it("accepts a valid event and passes body through untouched", () => {
    const parsed = ingestEventSchema.parse(validEvent());
    expect(parsed.body).toEqual({ anything: "goes", nested: { deeply: true } });
  });

  it("rejects unknown schema versions", () => {
    expect(() =>
      ingestEventSchema.parse(validEvent({ schemaVersion: 2 }))
    ).toThrow();
  });

  it("rejects unknown event types and sources", () => {
    expect(() => ingestEventSchema.parse(validEvent({ type: "nope" }))).toThrow();
    expect(() =>
      ingestEventSchema.parse(validEvent({ source: "nope" }))
    ).toThrow();
  });
});

describe("ingestBatchSchema", () => {
  it("accepts a valid batch", () => {
    expect(ingestBatchSchema.parse(validBatch()).events).toHaveLength(1);
  });

  it("rejects empty batches", () => {
    expect(() => ingestBatchSchema.parse(validBatch({ events: [] }))).toThrow();
  });

  it("rejects batches above the event cap", () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () =>
      validEvent()
    );
    expect(() => ingestBatchSchema.parse(validBatch({ events }))).toThrow();
  });

  it("rejects non-ISO receivedAt", () => {
    expect(() =>
      ingestBatchSchema.parse(validBatch({ receivedAt: "yesterday" }))
    ).toThrow();
  });
});

describe("rawObjectKey", () => {
  it("formats the dated key with zero padding", () => {
    const key = rawObjectKey(
      "proj_x",
      new Date("2026-01-05T03:04:05Z"),
      "batch1"
    );
    expect(key).toBe("raw/proj_x/2026/01/05/batch1.json");
  });

  it("uses UTC for the date path", () => {
    // 23:30 UTC-5 is the next day in UTC
    const key = rawObjectKey(
      "proj_x",
      new Date("2026-01-05T23:30:00-05:00"),
      "b"
    );
    expect(key).toBe("raw/proj_x/2026/01/06/b.json");
  });
});

describe("parseRawObjectKey", () => {
  it("accepts only canonical keys with a real UTC calendar day", () => {
    expect(parseRawObjectKey("raw/proj_1/2026/02/28/batch.json")).toEqual({
      projectId: "proj_1",
      day: "2026-02-28",
      batchId: "batch"
    });
    expect(parseRawObjectKey("raw/proj_1/2026/02/30/batch.json")).toBeNull();
    expect(parseRawObjectKey("raw/proj_1/2026/02/28/nested/batch.json")).toBeNull();
  });
});

describe("pendingIngestObjectKey", () => {
  it("uses the globally ordered batch id under the durable pending prefix", () => {
    expect(
      pendingIngestObjectKey("batch1")
    ).toBe("pending-ingest/batch1.json");
  });

  it("keeps terminal failure diagnostics out of the hot pending prefix", () => {
    expect(failedIngestObjectKey("batch1")).toBe("failed-ingest/batch1.json");
  });

  it("reserves internal keys outside the intent key shape", () => {
    expect(PENDING_INGEST_CURSOR_KEY).toBe("pending-ingest/.internal/cursor.json");
    expect(PENDING_INGEST_PROBE_PREFIX).toBe("pending-ingest/.internal/probes/");
  });
});

describe("domain schemas", () => {
  it("defaults trace tags and metadata", () => {
    const trace = traceSchema.parse({
      id: "t1",
      projectId: "proj_x",
      timestamp: "2026-07-11T12:00:00Z"
    });
    expect(trace.tags).toEqual([]);
    expect(trace.metadata).toEqual({});
  });

  it("accepts an observation without usage (unavailable = absent, never zero)", () => {
    const obs = observationSchema.parse({
      id: "o1",
      traceId: "t1",
      projectId: "proj_x",
      type: "generation",
      startTime: "2026-07-11T12:00:00Z"
    });
    expect(obs.usageDetails).toBeUndefined();
    expect(obs.level).toBe("default");
  });

  it("rejects negative usage counts", () => {
    expect(() =>
      observationSchema.parse({
        id: "o1",
        traceId: "t1",
        projectId: "proj_x",
        type: "generation",
        startTime: "2026-07-11T12:00:00Z",
        usageDetails: { input_tokens: -1 }
      })
    ).toThrow();
  });

  it("requires a value or stringValue on scores", () => {
    expect(() =>
      scoreSchema.parse({
        id: "s1",
        projectId: "proj_x",
        traceId: "t1",
        name: "accuracy",
        dataType: "numeric",
        source: "api"
      })
    ).toThrow();
    const ok = scoreSchema.parse({
      id: "s1",
      projectId: "proj_x",
      traceId: "t1",
      name: "accuracy",
      dataType: "numeric",
      source: "api",
      value: 0.9
    });
    expect(ok.value).toBe(0.9);
  });
});
