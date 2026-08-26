import type { IngestBatch, IngestEvent } from "@ironside/shared";
import { describe, expect, it } from "vitest";
import {
  RawLogUnavailableError,
  classifyEventForTrace,
  filterBatchEvents,
  scanRawEvents,
  type RawScanCaps
} from "../src/lib/raw-events.js";

// Infra-free coverage for the raw-events lookup (replay R-01): the pure
// window/filter helpers plus the capped scan loop against a stubbed
// storage — no object storage, ClickHouse, or docker required.

function event(overrides: Partial<IngestEvent> & Pick<IngestEvent, "type" | "body">): IngestEvent {
  return {
    id: "evt_1",
    source: "native",
    schemaVersion: 1,
    idempotencyKey: "ik_1",
    ...overrides
  };
}

describe("classifyEventForTrace — single-trace event types", () => {
  it("matches a trace-upsert by body.id", () => {
    const e = event({ type: "trace-upsert", body: { id: "trace_a", name: "checkout" } });
    expect(classifyEventForTrace(e, "trace_a")).toEqual({ matches: true, containingBatch: false });
    expect(classifyEventForTrace(e, "trace_b")).toEqual({ matches: false });
  });

  it("matches observation-upsert and score-upsert by body.traceId", () => {
    const obs = event({ type: "observation-upsert", body: { id: "obs_1", traceId: "trace_a" } });
    const score = event({ type: "score-upsert", body: { id: "sc_1", traceId: "trace_a" } });
    expect(classifyEventForTrace(obs, "trace_a")).toEqual({ matches: true, containingBatch: false });
    expect(classifyEventForTrace(score, "trace_a")).toEqual({ matches: true, containingBatch: false });
    expect(classifyEventForTrace(obs, "trace_b")).toEqual({ matches: false });
    expect(classifyEventForTrace(score, "trace_b")).toEqual({ matches: false });
  });

  it("does not match single-trace events whose body is not an object", () => {
    const e = event({ type: "trace-upsert", body: "not-an-object" });
    expect(classifyEventForTrace(e, "trace_a")).toEqual({ matches: false });
  });
});

describe("classifyEventForTrace — otlp-export (multi-trace batch)", () => {
  const otlpBody = (traceIds: string[]) => ({
    resourceSpans: [
      {
        scopeSpans: [
          { spans: traceIds.map((traceId, i) => ({ traceId, spanId: `span_${i}` })) }
        ]
      }
    ]
  });

  it("matches exactly when a span in the request carries the trace id", () => {
    const e = event({ type: "otlp-export", source: "otlp", body: otlpBody(["aaa", "bbb"]) });
    expect(classifyEventForTrace(e, "bbb")).toEqual({ matches: true, containingBatch: false });
  });

  it("excludes when every span is extractable and none matches", () => {
    const e = event({ type: "otlp-export", source: "otlp", body: otlpBody(["aaa", "bbb"]) });
    expect(classifyEventForTrace(e, "ccc")).toEqual({ matches: false });
  });

  it("includes with containingBatch when the body shape defeats extraction", () => {
    const e = event({ type: "otlp-export", source: "otlp", body: { unexpected: true } });
    expect(classifyEventForTrace(e, "aaa")).toEqual({ matches: true, containingBatch: true });
  });

  it("includes with containingBatch when some spans lack a string traceId and none of the rest match", () => {
    const body = {
      resourceSpans: [
        { scopeSpans: [{ spans: [{ spanId: "no-trace-id" }, { traceId: "other" }] }] }
      ]
    };
    const e = event({ type: "otlp-export", source: "otlp", body });
    expect(classifyEventForTrace(e, "aaa")).toEqual({ matches: true, containingBatch: true });
    // ...but a definitive span match still wins over the unextractable one.
    expect(classifyEventForTrace(e, "other")).toEqual({ matches: true, containingBatch: false });
  });
});

describe("classifyEventForTrace — langfuse-ingestion (multi-trace batch)", () => {
  it("matches items by body.traceId", () => {
    const body = { batch: [{ type: "span-create", body: { id: "s1", traceId: "trace_a" } }] };
    const e = event({ type: "langfuse-ingestion", source: "langfuse", body });
    expect(classifyEventForTrace(e, "trace_a")).toEqual({ matches: true, containingBatch: false });
  });

  it("matches trace-create items by body.id", () => {
    const body = { batch: [{ type: "trace-create", body: { id: "trace_a" } }] };
    const e = event({ type: "langfuse-ingestion", source: "langfuse", body });
    expect(classifyEventForTrace(e, "trace_a")).toEqual({ matches: true, containingBatch: false });
  });

  it("excludes when every item is extractable and none matches", () => {
    const body = {
      batch: [
        { type: "trace-create", body: { id: "trace_x" } },
        { type: "score-create", body: { id: "sc", traceId: "trace_x" } }
      ]
    };
    const e = event({ type: "langfuse-ingestion", source: "langfuse", body });
    expect(classifyEventForTrace(e, "trace_a")).toEqual({ matches: false });
  });

  it("includes with containingBatch for update items that omit traceId (create carried it)", () => {
    const body = { batch: [{ type: "span-update", body: { id: "s1", endTime: "2026-07-12T00:00:00Z" } }] };
    const e = event({ type: "langfuse-ingestion", source: "langfuse", body });
    expect(classifyEventForTrace(e, "trace_a")).toEqual({ matches: true, containingBatch: true });
  });

  it("includes with containingBatch when the body has no batch array at all", () => {
    const e = event({ type: "langfuse-ingestion", source: "langfuse", body: null });
    expect(classifyEventForTrace(e, "trace_a")).toEqual({ matches: true, containingBatch: true });
  });
});

describe("filterBatchEvents", () => {
  it("keeps only the events belonging (or possibly belonging) to the trace, with per-event flags", () => {
    const batch: IngestBatch = {
      batchId: "batch_1",
      projectId: "proj_1",
      receivedAt: "2026-07-12T10:00:00.000Z",
      events: [
        event({ id: "e1", type: "trace-upsert", body: { id: "trace_a" } }),
        event({ id: "e2", type: "observation-upsert", body: { id: "o1", traceId: "trace_b" } }),
        event({ id: "e3", type: "score-upsert", body: { id: "s1", traceId: "trace_a" } }),
        event({ id: "e4", type: "otlp-export", source: "otlp", body: { broken: true } })
      ]
    };

    const matched = filterBatchEvents(batch, "trace_a");
    expect(matched.map((m) => m.event.id)).toEqual(["e1", "e3", "e4"]);
    expect(matched.map((m) => m.containingBatch)).toEqual([false, false, true]);
  });

  it("returns an empty array when nothing in the batch references the trace", () => {
    const batch: IngestBatch = {
      batchId: "batch_2",
      projectId: "proj_1",
      receivedAt: "2026-07-12T10:00:00.000Z",
      events: [event({ type: "trace-upsert", body: { id: "trace_x" } })]
    };
    expect(filterBatchEvents(batch, "trace_a")).toEqual([]);
  });
});

describe("scanRawEvents", () => {
  const CAPS: RawScanCaps = {
    maxScannedObjects: 500,
    maxScannedBytes: 256 * 1024 * 1024,
    maxResponseBytes: 10 * 1024 * 1024
  };

  function batch(batchId: string, events: IngestEvent[]): IngestBatch {
    return { batchId, projectId: "proj_1", receivedAt: "2026-07-12T10:00:00.000Z", events };
  }

  function traceBatch(batchId: string, traceId: string): IngestBatch {
    return batch(batchId, [event({ id: `evt_${batchId}`, type: "trace-upsert", body: { id: traceId } })]);
  }

  /** Stub storage: values are returned from getJson; an Error value is thrown instead. */
  function stubStorage(objects: Record<string, unknown>) {
    return {
      async getJson(key: string) {
        const value = objects[key];
        if (value instanceof Error) throw value;
        return value;
      }
    };
  }

  it("collects matching events across indexed objects and counts every fetch", async () => {
    const storage = stubStorage({
      "raw/p/2026/07/11/b1.json": traceBatch("b1", "trace_a"),
      "raw/p/2026/07/12/b2.json": traceBatch("b2", "trace_other"),
      "raw/p/2026/07/12/b3.json": traceBatch("b3", "trace_a")
    });

    const result = await scanRawEvents(
      storage,
      "trace_a",
      CAPS,
      [
        "raw/p/2026/07/11/b1.json",
        "raw/p/2026/07/12/b2.json",
        "raw/p/2026/07/12/b3.json"
      ]
    );
    expect(result.truncationReason).toBeUndefined();
    expect(result.scannedObjects).toBe(3);
    expect(result.events.map((e) => e.batchId)).toEqual(["b1", "b3"]);
    expect(result.events.every((e) => e.containingBatch === false)).toBe(true);
  });

  it("fetches durable indexed keys directly without listing a day prefix", async () => {
    const objectKey = "raw/p/2026/07/12/indexed.json";
    const storage = {
      async getJson(key: string) {
        expect(key).toBe(objectKey);
        return traceBatch("indexed", "trace_a");
      }
    };

    const result = await scanRawEvents(storage, "trace_a", CAPS, [objectKey]);
    expect(result.truncationReason).toBeUndefined();
    expect(result.scannedObjects).toBe(1);
    expect(result.events.map((entry) => entry.batchId)).toEqual(["indexed"]);
  });

  it("deduplicates repeated indexed keys", async () => {
    const objectKey = "raw/p/d/b1.json";
    const storage = stubStorage({ [objectKey]: traceBatch("b1", "trace_a") });

    const result = await scanRawEvents(storage, "trace_a", CAPS, [objectKey, objectKey]);
    expect(result.scannedObjects).toBe(1);
    expect(result.events.map((entry) => entry.batchId)).toEqual(["b1"]);
  });

  it("stops at the object cap and returns the partial results found so far", async () => {
    const storage = stubStorage({
      "raw/p/d/b1.json": traceBatch("b1", "trace_a"),
      "raw/p/d/b2.json": traceBatch("b2", "trace_a"),
      "raw/p/d/b3.json": traceBatch("b3", "trace_a")
    });

    const result = await scanRawEvents(
      storage,
      "trace_a",
      { ...CAPS, maxScannedObjects: 2 },
      ["raw/p/d/b1.json", "raw/p/d/b2.json", "raw/p/d/b3.json"]
    );
    expect(result.truncationReason).toBe("scan_object_cap");
    expect(result.scannedObjects).toBe(2);
    // Everything fetched before the cap is still returned — the cap
    // truncates, it does not discard paid-for results.
    expect(result.events.map((e) => e.batchId)).toEqual(["b1", "b2"]);
  });

  it("stops when the scanned-bytes budget is exhausted", async () => {
    const storage = stubStorage({
      "raw/p/d/b1.json": traceBatch("b1", "trace_a"),
      "raw/p/d/b2.json": traceBatch("b2", "trace_a")
    });

    // Budget smaller than the first object: the first is still processed
    // (its transfer already happened), then the scan stops.
    const result = await scanRawEvents(
      storage,
      "trace_a",
      { ...CAPS, maxScannedBytes: 10 },
      ["raw/p/d/b1.json", "raw/p/d/b2.json"]
    );
    expect(result.truncationReason).toBe("scan_bytes_budget");
    expect(result.scannedObjects).toBe(1);
    expect(result.events.map((e) => e.batchId)).toEqual(["b1"]);
  });

  it("stops when the accumulated response would exceed the response-bytes cap", async () => {
    const storage = stubStorage({
      "raw/p/d/b1.json": batch("b1", [
        event({ id: "e1", type: "trace-upsert", body: { id: "trace_a" } }),
        event({ id: "e2", type: "score-upsert", body: { id: "s1", traceId: "trace_a" } })
      ])
    });

    const first = await scanRawEvents(storage, "trace_a", CAPS, ["raw/p/d/b1.json"]);
    const firstEntryBytes = Buffer.byteLength(JSON.stringify(first.events[0]), "utf8");

    // Cap fits exactly one entry: the second matching event is dropped and
    // the result is marked truncated rather than failing outright.
    const result = await scanRawEvents(
      storage,
      "trace_a",
      { ...CAPS, maxResponseBytes: firstEntryBytes },
      ["raw/p/d/b1.json"]
    );
    expect(result.truncationReason).toBe("response_bytes_cap");
    expect(result.events.map((e) => e.event.id)).toEqual(["e1"]);
  });

  it("skips objects that are missing (NoSuchKey) or not valid JSON, without failing the scan", async () => {
    const noSuchKey = new Error("The specified key does not exist.");
    noSuchKey.name = "NoSuchKey";
    const storage = stubStorage({
      "raw/p/d/b1.json": noSuchKey, // deleted between LIST and GET
      "raw/p/d/b2.json": new SyntaxError("Unexpected token"), // torn write / not JSON
      "raw/p/d/b3.json": { foreign: "object" }, // JSON but not an ingest batch
      "raw/p/d/b4.json": traceBatch("b4", "trace_a")
    });

    const result = await scanRawEvents(
      storage,
      "trace_a",
      CAPS,
      ["raw/p/d/b1.json", "raw/p/d/b2.json", "raw/p/d/b3.json", "raw/p/d/b4.json"]
    );
    expect(result.truncationReason).toBeUndefined();
    expect(result.scannedObjects).toBe(4);
    expect(result.events.map((e) => e.batchId)).toEqual(["b4"]);
  });

  it("surfaces any other storage failure as RawLogUnavailableError instead of swallowing it", async () => {
    const outage = new Error("connect ETIMEDOUT");
    const storage = stubStorage({
      "raw/p/d/b1.json": traceBatch("b1", "trace_a"),
      "raw/p/d/b2.json": outage
    });

    const promise = scanRawEvents(
      storage,
      "trace_a",
      CAPS,
      ["raw/p/d/b1.json", "raw/p/d/b2.json"]
    );
    await expect(promise).rejects.toBeInstanceOf(RawLogUnavailableError);
    await expect(promise).rejects.toMatchObject({ objectKey: "raw/p/d/b2.json" });
  });
});
