import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClient } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { MAX_PARAM_LENGTH, chunkByParamBytes, encodedParamLength } from "../src/params.js";
import { listObservationsByIds, listStoredRowKeys, listTracesByIds } from "../src/queries.js";
import { getRetentionExpiredTraceIds, getRetentionVisibleTraceIds } from "../src/raw-events.js";
import { insertObservations, insertScores, insertTraces } from "../src/rows.js";

const clickhouse = createClickHouseClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.CLICKHOUSE_USER ?? "ironside",
  password: process.env.CLICKHOUSE_PASSWORD ?? "ironside",
  database: process.env.CLICKHOUSE_DB ?? "ironside"
});

beforeAll(() => runMigrations(clickhouse));
afterAll(() => clickhouse.close());

describe("chunkByParamBytes", () => {
  it("keeps small lists in one chunk and splits large ones by size, in order", () => {
    expect(chunkByParamBytes(["a", "b"], [(id) => id])).toEqual([["a", "b"]]);
    expect(chunkByParamBytes([], [(id: string) => id])).toEqual([]);

    const ids = Array.from({ length: 2_000 }, (_, index) => `${index}`.padStart(500, "x"));
    const chunks = chunkByParamBytes(ids, [(id) => id]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(ids);
    for (const chunk of chunks) {
      expect(chunk.reduce((length, id) => length + encodedParamLength(id), 0)).toBeLessThanOrEqual(MAX_PARAM_LENGTH);
    }
  });

  it("budgets each parameter separately, counting a repeated value once and an empty one not at all", () => {
    // Many observations of one trace: the shared 2,000-character trace id is sent once.
    const shared = "t".repeat(2_000);
    const items = Array.from({ length: 600 }, (_, index) => ({ a: `${index}`.padStart(300, "x"), b: index % 2 === 0 ? "" : shared }));
    const chunks = chunkByParamBytes(items, [(item) => item.a, (item) => item.b]);
    // Only the 300-character values fill a parameter: about 320 of them fit in 96 KiB.
    // Counting the shared id at every repeat would need a chunk per 48 items.
    expect(chunks.length).toBe(2);
  });

  it("counts a value's length as sent, URL-encoded after the client escapes it", () => {
    // Both quotes and the comma are percent-encoded.
    expect(encodedParamLength("abc")).toBe("'abc',".length + 6);
    // A two-byte letter is six characters once encoded, an escaped quote six.
    expect(encodedParamLength("д")).toBe(encodedParamLength("a") + 5);
    expect(encodedParamLength("'")).toBe(encodedParamLength("a") + 5);
  });
});

describe("stored row lookups with more ids than one query parameter holds", () => {
  it("finds the stored rows among the 8,192 spans of a default OpenTelemetry Collector batch", async () => {
    const projectId = `proj_keys_${randomUUID()}`;
    const traceId = `trace_${randomUUID()}`;
    const eventTs = new Date().toISOString();
    const stored = { id: `obs_${randomUUID()}`, traceId, projectId, type: "span" as const, startTime: eventTs, level: "default" as const, metadata: {} };
    await insertTraces(clickhouse, [{ id: traceId, projectId, timestamp: eventTs, tags: [], metadata: {} }], { eventTs });
    await insertObservations(clickhouse, [stored], { eventTs });
    await insertScores(
      clickhouse,
      [{ id: `score_${randomUUID()}`, projectId, traceId, name: "helpful", dataType: "numeric", value: 1, source: "api", metadata: {}, timestamp: eventTs }],
      { eventTs }
    );

    // Span ids as 36-character UUIDs: about 330 KiB of ids in one list.
    const spans: { traceId: string; id: string }[] = Array.from({ length: 8_192 }, () => ({ traceId, id: randomUUID() }));
    spans[4_000] = { traceId, id: stored.id };
    const keys = await listStoredRowKeys(clickhouse, projectId, {
      traceIds: [traceId, ...spans.map(() => randomUUID())],
      observations: spans,
      scores: spans.map((span) => ({ traceId, id: span.id }))
    });

    expect(keys.map((key) => [key.kind, key.id]).sort()).toEqual(
      [
        ["observation", stored.id],
        ["trace", traceId]
      ].sort()
    );
    expect(await listTracesByIds(clickhouse, projectId, [traceId, ...spans.map((span) => span.id)])).toHaveLength(1);
    expect(await listObservationsByIds(clickhouse, projectId, spans)).toHaveLength(1);
  });
});

describe("stored row lookups with ids that grow when URL-encoded", () => {
  const projectId = `proj_keys_encoded_${randomUUID()}`;

  it("handles a full native batch of long non-ASCII or escape-heavy ids", async () => {
    // 500 ids of 100 Cyrillic letters: about 100 KiB raw, 300 KiB encoded.
    const cyrillic = Array.from({ length: 500 }, (_, index) => `${index}`.padStart(100, "д"));
    await expect(
      listStoredRowKeys(clickhouse, projectId, { traceIds: cyrillic, observations: [], scores: [] })
    ).resolves.toEqual([]);
    const backslashes = Array.from({ length: 500 }, (_, index) => `${index}${"\\".repeat(60)}'`);
    await expect(
      listStoredRowKeys(clickhouse, projectId, {
        traceIds: [],
        observations: backslashes.map((id) => ({ traceId: id, id })),
        scores: []
      })
    ).resolves.toEqual([]);
    const cjk = Array.from({ length: 200 }, (_, index) => `${index}`.padStart(160, "漢"));
    await expect(listTracesByIds(clickhouse, projectId, cjk)).resolves.toEqual([]);
  });

  it("checks raw retention for thousands of short non-ASCII trace ids", async () => {
    const traceIds = Array.from({ length: 3_000 }, (_, index) => `заказ-${String(index).padStart(6, "0")}`);
    await expect(getRetentionVisibleTraceIds(clickhouse, projectId, traceIds)).resolves.toEqual(new Set());
    await expect(getRetentionExpiredTraceIds(clickhouse, projectId, traceIds)).resolves.toEqual(new Set());
  });
});
