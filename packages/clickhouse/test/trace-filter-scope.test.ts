import { randomUUID } from "node:crypto";
import type { Observation, Trace } from "@ironside/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClient } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { getAggregates, listTraces, type TraceFilter } from "../src/queries.js";
import { deleteMovedObservationRows, insertObservations, insertTraces } from "../src/rows.js";

const clickhouse = createClickHouseClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.CLICKHOUSE_USER ?? "ironside",
  password: process.env.CLICKHOUSE_PASSWORD ?? "ironside",
  database: process.env.CLICKHOUSE_DB ?? "ironside"
});

// The observation filters read only the traces the trace-level conditions
// select (a PREWHERE on trace_id). Observations are keyed by their own start
// time, which can lie on another day or month than their trace's timestamp,
// and a later version of an observation can change or delete it: the results
// must be exactly those of reading every observation.
const projectId = `proj_scope_${randomUUID()}`;
const june = { from: "2026-06-01T00:00:00.000Z", to: "2026-06-30T23:59:59.999Z" };
const ids = {
  startedMonthsBefore: `trace_before_${randomUUID()}`,
  startedMonthsAfter: `trace_after_${randomUUID()}`,
  outsideRange: `trace_outside_${randomUUID()}`,
  changed: `trace_changed_${randomUUID()}`,
  deleted: `trace_deleted_${randomUUID()}`,
  moved: `trace_moved_${randomUUID()}`
};

function trace(id: string, timestamp: string, userId?: string): Trace {
  return { id, projectId, timestamp, tags: [], metadata: {}, ...(userId && { userId }) };
}

/** An observation matching every filter below: model, level, search, duration and cost. */
function matching(traceId: string, startTime: string, overrides: Partial<Observation> = {}): Observation {
  return {
    id: `obs_${randomUUID()}`,
    traceId,
    projectId,
    type: "generation",
    name: "call",
    startTime,
    endTime: new Date(Date.parse(startTime) + 90_000).toISOString(),
    level: "error",
    model: "m-scope",
    output: "found the NEEDLE here",
    costDetails: { total: 5 },
    metadata: {},
    ...overrides
  };
}

const unmatched: Partial<Observation> = {
  level: "default",
  model: "other",
  output: "nothing",
  endTime: undefined,
  costDetails: {}
};

beforeAll(async () => {
  await runMigrations(clickhouse);
  const t1 = "2026-07-01T00:00:00.000Z";
  const t2 = "2026-07-02T00:00:00.000Z";
  await insertTraces(
    clickhouse,
    [
      trace(ids.startedMonthsBefore, "2026-06-15T12:00:00.000Z", "u-scope"),
      trace(ids.startedMonthsAfter, "2026-06-20T12:00:00.000Z"),
      trace(ids.outsideRange, "2026-05-01T12:00:00.000Z", "u-scope"),
      trace(ids.changed, "2026-06-10T12:00:00.000Z"),
      trace(ids.deleted, "2026-06-11T12:00:00.000Z"),
      trace(ids.moved, "2026-06-12T12:00:00.000Z")
    ],
    { eventTs: t1 }
  );

  const changed = matching(ids.changed, "2026-06-10T12:00:01.000Z");
  const deleted = matching(ids.deleted, "2026-06-11T12:00:01.000Z");
  const moved = matching(ids.moved, "2026-06-12T12:00:01.000Z");
  await insertObservations(
    clickhouse,
    [
      // In another month's partition than the trace, before and after the range.
      matching(ids.startedMonthsBefore, "2026-03-02T08:00:00.000Z"),
      matching(ids.startedMonthsAfter, "2026-09-10T08:00:00.000Z"),
      // Inside the range, but its trace is not.
      matching(ids.outsideRange, "2026-06-15T08:00:00.000Z"),
      changed,
      deleted,
      moved
    ],
    { eventTs: t1 }
  );
  // Later versions: one no longer matches, one is deleted, one moved to another day without matching.
  await insertObservations(clickhouse, [{ ...changed, ...unmatched }, { ...moved, startTime: "2026-04-01T08:00:00.000Z", ...unmatched }], {
    eventTs: t2
  });
  await deleteMovedObservationRows(
    clickhouse,
    [
      { projectId, id: deleted.id, traceId: deleted.traceId, startTime: deleted.startTime },
      { projectId, id: moved.id, traceId: moved.traceId, startTime: moved.startTime }
    ],
    { eventTs: t2 }
  );
});

afterAll(() => clickhouse.close());

describe("observation filters limited to the traces the trace-level conditions select", () => {
  const filters: [string, Partial<TraceFilter>][] = [
    ["model", { model: "m-scope" }],
    ["level", { level: "error" }],
    ["search", { search: "needle" }],
    ["minimum duration", { minDurationMs: 60_000 }],
    ["minimum cost", { minCost: 5 }]
  ];

  it.each(filters)("%s: matches traces whose observations start in other months, and only their latest versions", async (_name, filter) => {
    const inJune = await listTraces(clickhouse, { projectId, ...june, ...filter, limit: 100 });
    expect(inJune.map((row) => row.id)).toEqual([ids.startedMonthsAfter, ids.startedMonthsBefore]);
    expect((await getAggregates(clickhouse, { projectId, ...june, ...filter })).trace_count).toBe(2);

    // Another trace-level condition limits them the same way.
    const byUser = await listTraces(clickhouse, { projectId, userId: "u-scope", ...filter, limit: 100 });
    expect(byUser.map((row) => row.id)).toEqual([ids.startedMonthsBefore, ids.outsideRange]);

    // Without any, every trace in the project is considered.
    const all = await listTraces(clickhouse, { projectId, ...filter, limit: 100 });
    expect(all.map((row) => row.id)).toEqual([ids.startedMonthsAfter, ids.startedMonthsBefore, ids.outsideRange]);
  });

  it("combines several observation filters within the range", async () => {
    const rows = await listTraces(clickhouse, {
      projectId,
      ...june,
      model: "m-scope",
      level: "error",
      search: "needle",
      minDurationMs: 60_000,
      minCost: 5,
      limit: 100
    });
    expect(rows.map((row) => row.id)).toEqual([ids.startedMonthsAfter, ids.startedMonthsBefore]);
  });
});
