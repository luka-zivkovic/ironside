import {
  createClickHouseClient,
  insertObservations,
  insertTraces,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import {
  publishEvaluatorTraceActivities,
  runMigrations as runPgMigrations,
  setProjectQuotas
} from "@ironside/db";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  runRetention,
  seedEvaluatorImportRetentionCutoffs
} from "../src/retention/retention-runner.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);

vi.setConfig({ testTimeout: 15_000 });

let organizationId: string;

async function seedProject(name: string, retentionDays: number | null): Promise<string> {
  const projectId = `proj_${ulid()}`;
  await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
    projectId,
    organizationId,
    name
  ]);
  if (retentionDays !== null) {
    await setProjectQuotas(pool, projectId, { retentionDays });
  }
  return projectId;
}

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  organizationId = `org_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [organizationId, "retention-runner-test-org"]);
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'retention-runner-test-org'");
  await pool.end();
  await clickhouse.close();
});

describe("runRetention", () => {
  it("seeds import cutoffs independently before the destructive retention sweep", async () => {
    const projectId = await seedProject("retention-runner-startup-cutoff", 30);
    const now = new Date("2026-08-30T12:00:00.000Z");
    await pool.query(
      "delete from evaluator_import_retention_cutoffs where project_id = $1",
      [projectId]
    );

    await seedEvaluatorImportRetentionCutoffs({
      pool,
      defaultRetentionDays: 90,
      now
    });

    const result = await pool.query<{ trace_timestamp_before: Date }>(
      `select trace_timestamp_before
         from evaluator_import_retention_cutoffs
        where project_id = $1`,
      [projectId]
    );
    expect(result.rows[0]?.trace_timestamp_before.toISOString())
      .toBe("2026-07-31T12:00:00.000Z");

    await seedEvaluatorImportRetentionCutoffs({
      pool,
      defaultRetentionDays: 90,
      now: new Date("2026-08-31T12:00:00.000Z")
    });
    const unchanged = await pool.query<{ trace_timestamp_before: Date }>(
      `select trace_timestamp_before
         from evaluator_import_retention_cutoffs
        where project_id = $1`,
      [projectId]
    );
    expect(unchanged.rows[0]?.trace_timestamp_before.toISOString())
      .toBe("2026-07-31T12:00:00.000Z");
  });

  it("drops a whole old partition at the global default when no project has a longer override", async () => {
    const projectId = await seedProject("retention-runner-default", null);
    const oldTraceId = `trace_${ulid()}`;
    await insertTraces(
      clickhouse,
      [{ id: oldTraceId, projectId, timestamp: "2020-03-10T00:00:00.000Z", tags: [], metadata: {} }],
      { eventTs: new Date().toISOString() }
    );
    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [oldTraceId],
      sourceActivityAt: new Date().toISOString(),
      activityId: `batch_${ulid()}`
    });

    const result = await runRetention({ pool, clickhouse, defaultRetentionDays: 90 });
    expect(result.droppedPartitions.traces).toContain("202003");
    expect(result.prunedEvaluatorTraceFeed).toBeGreaterThanOrEqual(1);

    const check = await clickhouse.query({
      query: "select id from traces where id = {id:String}",
      query_params: { id: oldTraceId },
      format: "JSONEachRow"
    });
    expect((await check.json()).length).toBe(0);
    expect((await pool.query(
      "select 1 from evaluator_trace_feed where project_id = $1 and trace_id = $2",
      [projectId, oldTraceId]
    )).rowCount).toBe(0);
  });

  it("does not drop the global floor's partition when a project override needs LONGER retention than the default", async () => {
    // A project with a 3000-day override forces the global floor to be at
    // least 3000 days, even though the platform default is much shorter —
    // otherwise a partition drop would violate this project's promise.
    const longRetentionProject = await seedProject("retention-runner-long-override", 3000);
    const recentTraceId = `trace_${ulid()}`;
    const oneYearAgo = new Date();
    oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);
    await insertTraces(
      clickhouse,
      [{ id: recentTraceId, projectId: longRetentionProject, timestamp: oneYearAgo.toISOString(), tags: [], metadata: {} }],
      { eventTs: new Date().toISOString() }
    );

    // A short default (30 days) would ordinarily drop a 1-year-old
    // partition, but the 3000-day override must win.
    await runRetention({ pool, clickhouse, defaultRetentionDays: 30 });

    const check = await clickhouse.query({
      query: "select id from traces where id = {id:String}",
      query_params: { id: recentTraceId },
      format: "JSONEachRow"
    });
    expect((await check.json()).length).toBe(1);
  });

  it("keeps a default-retention trace tree intact while a longer override raises the global floor", async () => {
    const defaultProject = await seedProject("retention-runner-default-under-raised-floor", null);
    await seedProject("retention-runner-floor-raising-neighbor", 365);
    const traceId = `trace_${ulid()}`;
    const observationId = `obs_${ulid()}`;
    const now = new Date("2026-08-30T12:00:00.000Z");
    const traceTimestamp = new Date(now);
    traceTimestamp.setUTCDate(traceTimestamp.getUTCDate() - 100);
    const eventTs = now.toISOString();

    await insertTraces(clickhouse, [{
      id: traceId,
      projectId: defaultProject,
      timestamp: traceTimestamp.toISOString(),
      tags: [],
      metadata: {}
    }], { eventTs });
    await insertObservations(clickhouse, [{
      id: observationId,
      traceId,
      projectId: defaultProject,
      type: "span",
      startTime: traceTimestamp.toISOString(),
      level: "default",
      metadata: {}
    }], { eventTs });

    await runRetention({ pool, clickhouse, defaultRetentionDays: 90, now });

    for (const [table, id] of [["traces", traceId], ["observations", observationId]] as const) {
      const remaining = await clickhouse.query({
        query: `select id from ${table} final
                 where project_id = {projectId:String} and id = {id:String}`,
        query_params: { projectId: defaultProject, id },
        format: "JSONEachRow"
      });
      expect(await remaining.json()).toHaveLength(1);
    }
  });

  it("applies row-level deletion for a project whose retention is SHORTER than the global floor, without touching other projects in the same partition", async () => {
    const shortRetentionProject = await seedProject("retention-runner-short-override", 30);
    const neighborProject = await seedProject("retention-runner-short-override-neighbor", null);

    // Keep both rows in the current physical partition so other files'
    // deliberate partition-drop tests cannot remove them concurrently.
    // Advance only this retention pass's clock to make them 60 days old.
    const traceTimestamp = new Date();
    const retentionNow = new Date(traceTimestamp);
    retentionNow.setUTCDate(retentionNow.getUTCDate() + 60);
    const shortProjectOldTraceId = `trace_${ulid()}`;
    const neighborTraceId = `trace_${ulid()}`;

    await insertTraces(
      clickhouse,
      [
        { id: shortProjectOldTraceId, projectId: shortRetentionProject, timestamp: traceTimestamp.toISOString(), tags: [], metadata: {} },
        { id: neighborTraceId, projectId: neighborProject, timestamp: traceTimestamp.toISOString(), tags: [], metadata: {} }
      ],
      { eventTs: new Date().toISOString() }
    );

    const result = await runRetention({
      pool,
      clickhouse,
      defaultRetentionDays: 365,
      now: retentionNow
    });
    expect(result.projectDeletes.map((d) => d.projectId)).toContain(shortRetentionProject);

    const shortProjectCheck = await clickhouse.query({
      query: "select id from traces final where id = {id:String}",
      query_params: { id: shortProjectOldTraceId },
      format: "JSONEachRow"
    });
    expect((await shortProjectCheck.json()).length).toBe(0); // marked deleted via FINAL exclusion

    const neighborCheck = await clickhouse.query({
      query: "select id from traces final where id = {id:String}",
      query_params: { id: neighborTraceId },
      format: "JSONEachRow"
    });
    expect((await neighborCheck.json()).length).toBe(1); // neighbor untouched — same partition, different project
  });
});
