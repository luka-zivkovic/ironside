import { afterAll, describe, expect, it } from "vitest";
import { createClickHouseClient } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";

const client = createClickHouseClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.CLICKHOUSE_USER ?? "ironside",
  password: process.env.CLICKHOUSE_PASSWORD ?? "ironside",
  database: process.env.CLICKHOUSE_DB ?? "ironside"
});

describe("runMigrations (clickhouse)", () => {
  afterAll(() => client.close());

  it("applies migrations once across concurrent starts and is idempotent on re-run", async () => {
    await Promise.all(Array.from({ length: 4 }, () => runMigrations(client)));
    await runMigrations(client);

    const result = await client.query({
      query: "select name from system.tables where database = currentDatabase()",
      format: "JSONEachRow"
    });
    const rows = await result.json<{ name: string }>();
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual([
      "evaluator_trace_retention",
      "ironside_migrations",
      "observations",
      "raw_event_refs",
      "raw_event_trace_retention",
      "scores",
      "traces"
    ]);

    const applied = await client.query({
      query: "select id, checksum from ironside_migrations final order by id",
      format: "JSONEachRow"
    });
    expect(await applied.json()).toEqual([
      {
        id: "0001_baseline",
        checksum: "ae18071157ef24c3102aba2d89ae34df489f189f12ede77824c02d88ff8c49bc"
      }
    ]);

    const traceIndex = await client.query({
      query: `
        select name
          from system.data_skipping_indices
         where database = currentDatabase() and table = 'traces'
           and name = 'idx_trace_id'
      `,
      format: "JSONEachRow"
    });
    expect(await traceIndex.json()).toEqual([{ name: "idx_trace_id" }]);
  });

  it("round-trips a trace row through the Map metadata column", async () => {
    await runMigrations(client);
    // Unique id per run: the compose volumes persist between test runs, and
    // ReplacingMergeTree dedups lazily, so fixed ids accumulate versions.
    const traceId = `trace_${crypto.randomUUID()}`;
    await client.insert({
      table: "traces",
      values: [
        {
          project_id: "proj_test",
          id: traceId,
          timestamp: "2026-07-11 12:00:00.000",
          name: "test-trace",
          tags: ["a", "b"],
          metadata: { env: "test", arbitrary_key: "arbitrary_value" }
        }
      ],
      format: "JSONEachRow"
    });

    const result = await client.query({
      query: "select * from traces final where id = {id:String}",
      query_params: { id: traceId },
      format: "JSONEachRow"
    });
    const rows = await result.json<{ metadata: Record<string, string>; tags: string[] }>();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({
      env: "test",
      arbitrary_key: "arbitrary_value"
    });
    expect(rows[0]?.tags).toEqual(["a", "b"]);
  });
});
