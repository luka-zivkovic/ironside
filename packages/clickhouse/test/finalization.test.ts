import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClient } from "../src/client.js";
import { exportTraces, getTrace, listTracePage } from "../src/queries.js";
import { markProjectDataDeletedOlderThan } from "../src/retention.js";
import { runMigrations } from "../src/migrate.js";
import { insertObservations, insertScores, insertTraces } from "../src/rows.js";

const clickhouse = createClickHouseClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.CLICKHOUSE_USER ?? "ironside",
  password: process.env.CLICKHOUSE_PASSWORD ?? "ironside",
  database: process.env.CLICKHOUSE_DB ?? "ironside"
});

beforeAll(() => runMigrations(clickhouse));
afterAll(() => clickhouse.close());

describe("quiet-period trace finalization", () => {
  it("settles from trace/observation activity, reopens on late observations, and ignores downstream scores", async () => {
    const projectId = `proj_finalization_${randomUUID()}`;
    const traceId = `trace_${randomUUID()}`;
    const marker = `finalization_${randomUUID()}`;
    const base = Date.now();
    const initialActivity = new Date(base - 10 * 60_000).toISOString();
    const firstWatermark = new Date(base - 5 * 60_000).toISOString();

    await insertTraces(
      clickhouse,
      [
        {
          id: traceId,
          projectId,
          timestamp: initialActivity,
          tags: [marker],
          metadata: {}
        }
      ],
      { eventTs: initialActivity }
    );

    const initiallySettled = await exportTraces(clickhouse, {
      projectId,
      tags: [marker],
      settledBefore: firstWatermark
    });
    expect(initiallySettled.map((row) => row.id)).toEqual([traceId]);
    expect(new Date(initiallySettled[0]!.last_activity_at).getTime()).toBe(
      new Date(initialActivity).getTime()
    );
    expect(await getTrace(clickhouse, projectId, traceId, firstWatermark)).not.toBeNull();

    const observationActivity = new Date(base).toISOString();
    await insertObservations(
      clickhouse,
      [
        {
          id: `obs_${randomUUID()}`,
          traceId,
          projectId,
          type: "generation",
          startTime: observationActivity,
          level: "default",
          metadata: {}
        }
      ],
      { eventTs: observationActivity }
    );

    // A late child write reopens the trace even though the trace row itself
    // did not change. Both bulk and point reads honor the same watermark.
    expect(
      await exportTraces(clickhouse, {
        projectId,
        tags: [marker],
        settledBefore: firstWatermark
      })
    ).toEqual([]);
    expect(await getTrace(clickhouse, projectId, traceId, firstWatermark)).toBeNull();
    const reopenedPage = await listTracePage(clickhouse, {
      projectId,
      page: 1,
      limit: 10,
      order: "asc",
      settledBefore: firstWatermark
    });
    expect(reopenedPage.totalItems).toBe(0);

    const secondWatermark = new Date(base + 5 * 60_000).toISOString();
    const settledAgain = await exportTraces(clickhouse, {
      projectId,
      tags: [marker],
      settledBefore: secondWatermark
    });
    expect(settledAgain.map((row) => row.id)).toEqual([traceId]);
    expect(new Date(settledAgain[0]!.last_activity_at).getTime()).toBe(
      new Date(observationActivity).getTime()
    );

    const scoreActivity = new Date(base + 10 * 60_000).toISOString();
    await insertScores(
      clickhouse,
      [
        {
          id: `score_${randomUUID()}`,
          projectId,
          traceId,
          name: "late-verdict",
          dataType: "numeric",
          value: 1,
          source: "eval",
          metadata: {}
        }
      ],
      { eventTs: scoreActivity }
    );

    const afterScore = await exportTraces(clickhouse, {
      projectId,
      tags: [marker],
      settledBefore: secondWatermark
    });
    expect(afterScore.map((row) => row.id)).toEqual([traceId]);
    expect(new Date(afterScore[0]!.last_activity_at).getTime()).toBe(
      new Date(observationActivity).getTime()
    );

    // Retention writes engine-native tombstones with a fresh event_ts. A
    // tombstone is deletion state, not ingest activity: it must remove the
    // trace from settled consumers instead of creating a deliverable version.
    await markProjectDataDeletedOlderThan(
      clickhouse,
      "traces",
      projectId,
      new Date(base - 5 * 60_000)
    );
    const afterRetention = await exportTraces(clickhouse, {
      projectId,
      tags: [marker],
      settledBefore: new Date(base + 60 * 60_000).toISOString()
    });
    expect(afterRetention).toEqual([]);
    expect(
      await getTrace(
        clickhouse,
        projectId,
        traceId,
        new Date(base + 60 * 60_000).toISOString()
      )
    ).toBeNull();
  });
});
