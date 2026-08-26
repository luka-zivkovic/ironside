import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";
import {
  getRawObjectRefSnapshot,
  getRetentionExpiredTraceIds,
  getRetentionVisibleTraceIds,
  getTraceRawIndex,
  insertRawEventRefs,
  markRawObjectRefsRetentionExpired,
  recordTraceRawRetentionExpired
} from "../src/raw-events.js";

function result(rows: unknown[]) {
  return { json: async () => rows };
}

describe("raw-event index queries", () => {
  it("deduplicates refs for the same trace/object before inserting", async () => {
    const insert = vi.fn(async (_args: unknown) => undefined);
    const client = { insert } as unknown as ClickHouseClient;
    const ref = {
      projectId: "project_1",
      traceId: "trace_1",
      objectKey: "raw/project_1/2026/08/17/batch.json",
      receivedAt: "2026-08-17T12:00:00.000Z"
    };

    await insertRawEventRefs(client, [ref, ref], ref.receivedAt);

    expect(insert).toHaveBeenCalledOnce();
    const call = insert.mock.calls[0]?.[0] as { table: string; values: unknown[] };
    expect(call.table).toBe("raw_event_refs");
    expect(call.values).toHaveLength(1);
    expect(call.values[0]).toMatchObject({
      project_id: ref.projectId,
      trace_id: ref.traceId,
      object_key: ref.objectKey,
      applied: 1
    });
  });

  it("writes monotonic retention tombstones in the original ref partition", async () => {
    const insert = vi.fn(async (_args: unknown) => undefined);
    const client = { insert } as unknown as ClickHouseClient;

    await markRawObjectRefsRetentionExpired(
      client,
      [
        {
          projectId: "project_1",
          traceId: "trace_1",
          objectKey: "raw/project_1/2026/01/02/batch.json",
          receivedAt: "2026-01-02T03:04:05.000Z"
        }
      ],
      "2026-08-21T12:00:00.000Z"
    );

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        table: "raw_event_refs",
        values: [
          expect.objectContaining({
            trace_id: "trace_1",
            received_at: "2026-01-02 03:04:05.000",
            applied: 2
          })
        ]
      })
    );
  });

  it("returns ordered indexed keys", async () => {
    const query = vi.fn(async (_args: unknown) => result([]));
    query
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([{ object_key: "raw/first.json" }, { object_key: "raw/second.json" }])
      );
    const client = { query } as unknown as ClickHouseClient;

    const index = await getTraceRawIndex(client, "project_1", "trace_1", 500);

    expect(index).toEqual({
      objectKeys: ["raw/first.json", "raw/second.json"],
      hasPendingRefs: false,
      retentionExpired: false
    });
    const refsQuery = query.mock.calls[1]?.[0] as {
      query: string;
      query_params: { limit: number };
    };
    expect(refsQuery.query_params.limit).toBe(501);
  });

  it("reports an in-flight pending ref", async () => {
    const query = vi.fn(async (_args: unknown) => result([]));
    query
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ object_key: "raw/applied.json" }]))
      .mockResolvedValueOnce(result([{ pending_count: "1" }]));
    const client = { query } as unknown as ClickHouseClient;

    const index = await getTraceRawIndex(client, "project_1", "trace_1", 500);

    expect(index).toEqual({
      objectKeys: ["raw/applied.json"],
      hasPendingRefs: true,
      retentionExpired: false
    });
  });

  it("keeps deliberate retention sticky", async () => {
    const insert = vi.fn(async (_args: unknown) => undefined);
    const query = vi.fn(async (_args: unknown) => result([]));
    query
      .mockResolvedValueOnce(result([{ trace_id: "trace_1" }]))
      .mockResolvedValueOnce(result([{ object_key: "raw/current.json" }]))
      .mockResolvedValueOnce(result([{ pending_count: 0 }]));
    const client = { insert, query } as unknown as ClickHouseClient;

    await recordTraceRawRetentionExpired(client, [
      {
        projectId: "project_1",
        traceId: "trace_1",
        expiredAt: "2026-08-17T12:00:00.000Z"
      }
    ]);
    const index = await getTraceRawIndex(client, "project_1", "trace_1", 500);

    expect((insert.mock.calls[0]?.[0] as { table: string }).table).toBe(
      "raw_event_trace_retention"
    );
    expect(index).toEqual({
      objectKeys: ["raw/current.json"],
      hasPendingRefs: false,
      retentionExpired: true
    });
  });

  it("caps one raw object's ref snapshot with a limit-plus-one sentinel", async () => {
    const query = vi.fn(async (_args: unknown) =>
      result([
        { trace_id: "trace_1", applied: "1", received_at: "2026-01-01 00:00:00.000" },
        { trace_id: "trace_2", applied: "0", received_at: "2026-01-02 00:00:00.000" }
      ])
    );
    const client = { query } as unknown as ClickHouseClient;

    const snapshot = await getRawObjectRefSnapshot(
      client,
      "project_1",
      "raw/project_1/2026/01/01/batch.json",
      1
    );

    expect(snapshot).toEqual({
      refs: [
        { traceId: "trace_1", applied: 1, receivedAt: "2026-01-01T00:00:00.000Z" }
      ],
      truncated: true
    });
    const args = query.mock.calls[0]?.[0] as { query_params: { limit: number } };
    expect(args.query_params.limit).toBe(2);
    expect(query.mock.calls[0]?.[0]).toMatchObject({
      clickhouse_settings: {
        max_execution_time: 30,
        max_threads: 2,
        max_rows_to_read: "5000000",
        read_overflow_mode: "throw"
      }
    });
  });

  it("checks all retention candidates in one bounded visibility query", async () => {
    const query = vi.fn(async (_args: unknown) => result([{ trace_id: "trace_2" }]));
    const client = { query } as unknown as ClickHouseClient;

    const visible = await getRetentionVisibleTraceIds(client, "project_1", [
      "trace_1",
      "trace_2"
    ]);

    expect(visible).toEqual(new Set(["trace_2"]));
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toMatchObject({
      query_params: { projectId: "project_1", traceIds: ["trace_1", "trace_2"], limit: 3 },
      clickhouse_settings: {
        max_execution_time: 30,
        max_threads: 2,
        max_rows_to_read: "5000000",
        read_overflow_mode: "throw"
      }
    });
  });

  it("verifies sticky retention markers with fixed query limits", async () => {
    const query = vi.fn(async (_args: unknown) => result([{ trace_id: "trace_1" }]));
    const client = { query } as unknown as ClickHouseClient;

    expect(
      await getRetentionExpiredTraceIds(client, "project_1", ["trace_1", "trace_2"])
    ).toEqual(new Set(["trace_1"]));
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: {
          projectId: "project_1",
          traceIds: ["trace_1", "trace_2"],
          limit: 3
        },
        clickhouse_settings: expect.objectContaining({
          max_execution_time: 30,
          max_rows_to_read: "5000000",
          read_overflow_mode: "throw"
        })
      })
    );
  });

});
