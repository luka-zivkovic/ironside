import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/migrate.js";

function jsonRows<T>(rows: T[]) {
  return { json: async () => rows };
}

describe("runMigrations ClickHouse ledger compatibility", () => {
  it("rejects the historical ledger with reset guidance before querying unsupported columns", async () => {
    const queries: string[] = [];
    const client = {
      command: vi.fn(async () => undefined),
      query: vi.fn(async ({ query }: { query: string }) => {
        queries.push(query);
        if (query.includes("system.columns")) {
          return jsonRows([{ name: "id" }, { name: "applied_at" }]);
        }
        throw new Error(`unexpected query: ${query}`);
      }),
      insert: vi.fn(async () => undefined)
    } as unknown as ClickHouseClient;

    await expect(runMigrations(client)).rejects.toThrow(
      "obsolete pre-production schema history detected; reset ClickHouse before starting Ironside"
    );
    expect(queries).toHaveLength(1);
    expect(queries[0]?.toLowerCase()).not.toContain(" final");
  });
});
