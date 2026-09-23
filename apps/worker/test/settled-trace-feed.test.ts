import {
  createClickHouseClient,
  insertObservations,
  insertRawEventRefs,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import { publishEvaluatorTraceActivities, runMigrations as runPgMigrations } from "@ironside/db";
import type { Trace } from "@ironside/shared";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { readSettledTraceFeed } from "../src/exporters/settled-trace-feed.js";
import { insertPublishedTrace } from "./support/published-traces.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);
const ORG_NAME = "settled-trace-feed-test-org";
let orgId: string;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  orgId = `org_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [orgId, ORG_NAME]);
});

afterAll(async () => {
  await pool.query("delete from organizations where name = $1", [ORG_NAME]);
  await pool.end();
  await clickhouse.close();
});

async function newProject(): Promise<string> {
  const projectId = `proj_${ulid()}`;
  await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
    projectId,
    orgId,
    "settled-trace-feed-test"
  ]);
  return projectId;
}

function trace(projectId: string): Trace {
  return { id: `trace_${ulid()}`, projectId, timestamp: new Date().toISOString(), tags: [], metadata: {} };
}

function read(projectId: string) {
  return readSettledTraceFeed(
    { pool, clickhouse },
    { projectId, cursor: null, settledBefore: new Date().toISOString(), limit: 10 }
  );
}

describe("readSettledTraceFeed", () => {
  it("stops at a trace whose batch is still being written, instead of skipping it", async () => {
    const projectId = await newProject();
    const pending = trace(projectId);
    const receivedAt = await insertPublishedTrace({ pool, clickhouse }, { trace: pending });
    await insertRawEventRefs(
      clickhouse,
      [{ projectId, traceId: pending.id, objectKey: `raw/${projectId}/pending.json`, receivedAt }],
      receivedAt,
      false
    );
    await insertPublishedTrace({ pool, clickhouse }, { trace: trace(projectId) });

    const page = await read(projectId);

    expect(page).toEqual({ entries: [], blocked: true, hasMore: false });
  });

  it("steps over a trace retention removed after it was published", async () => {
    const projectId = await newProject();
    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: ["trace_removed_by_retention"],
      sourceActivityAt: new Date(Date.now() - 1_000).toISOString(),
      activityId: `batch_${ulid()}`
    });
    const kept = trace(projectId);
    await insertPublishedTrace({ pool, clickhouse }, { trace: kept });

    const page = await read(projectId);

    expect(page.blocked).toBe(false);
    expect(page.entries.map((entry) => [entry.cursor.traceId, entry.trace?.id])).toEqual([
      ["trace_removed_by_retention", undefined],
      [kept.id, kept.id]
    ]);
  });

  it("waits when ClickHouse already holds a newer snapshot than the feed has published", async () => {
    const projectId = await newProject();
    const current = trace(projectId);
    await insertPublishedTrace(
      { pool, clickhouse },
      { trace: current, receivedAt: new Date(Date.now() - 2_000).toISOString() }
    );
    // The worker wrote a newer batch but has not published it yet.
    await insertObservations(
      clickhouse,
      [
        {
          id: `obs_${ulid()}`,
          traceId: current.id,
          projectId,
          type: "span",
          startTime: new Date().toISOString(),
          level: "default",
          metadata: {}
        }
      ],
      { eventTs: new Date(Date.now() - 1_000).toISOString() }
    );

    expect(await read(projectId)).toEqual({ entries: [], blocked: true, hasMore: false });
  });
});
