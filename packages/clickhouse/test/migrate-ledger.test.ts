import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/migrate.js";

function jsonRows<T>(rows: T[]) {
  return { json: async () => rows };
}

describe("runMigrations ClickHouse ledger validation", () => {
  it("rejects a non-current disposable ledger before querying unsupported columns", async () => {
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
      "ClickHouse migration ledger is incompatible with this clean-install release; recreate the disposable database"
    );
    expect(queries).toHaveLength(1);
    expect(queries[0]?.toLowerCase()).not.toContain(" final");
  });
});
