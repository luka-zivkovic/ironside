import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClient } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { MAX_PARAM_BYTES, chunkByParamBytes } from "../src/params.js";
import { listObservationsByIds, listStoredRowKeys, listTracesByIds } from "../src/queries.js";
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
      expect(chunk.reduce((bytes, id) => bytes + Buffer.byteLength(id) + 4, 0)).toBeLessThanOrEqual(MAX_PARAM_BYTES);
    }
  });

  it("budgets each parameter separately and counts nothing for an empty value", () => {
    const items = Array.from({ length: 300 }, (_, index) => ({ a: "x".repeat(300), b: index % 2 === 0 ? "" : "y" }));
    const chunks = chunkByParamBytes(items, [(item) => item.a, (item) => item.b]);
    expect(chunks.length).toBe(2);
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
