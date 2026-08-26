import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";
import { summarizeIndexedLifecycleCandidates } from "../src/lifecycle.js";

describe("lifecycle inventory query limits", () => {
  it("bounds every exact FINAL count and prefilters recent rows", async () => {
    const query = vi.fn().mockResolvedValue({ json: async () => [] });
    const client = { query } as unknown as ClickHouseClient;

    await summarizeIndexedLifecycleCandidates(client, [
      { projectId: "proj_1", cutoff: new Date("2026-01-01T00:00:00.000Z") }
    ]);

    expect(query).toHaveBeenCalledTimes(4);
    for (const [request] of query.mock.calls) {
      expect(request.clickhouse_settings).toEqual({
        max_execution_time: 30,
        max_threads: 2,
        max_memory_usage: "536870912",
        max_rows_to_read: "50000000",
        read_overflow_mode: "throw"
      });
      expect(request.query).toContain("{latestCutoff:DateTime64(3, 'UTC')}");
    }
    expect(query.mock.calls[3]?.[0].query).toContain("and applied = 1");
  });
});
