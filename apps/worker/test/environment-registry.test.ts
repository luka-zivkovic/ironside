import {
  createClickHouseClient,
  insertTraces,
  runMigrations as runClickHouseMigrations
} from "@ironside/clickhouse";
import {
  claimEnvironmentRegistryRebuild,
  listProjectEnvironments,
  observeProjectEnvironments,
  runMigrations as runPostgresMigrations,
  scheduleEnvironmentRegistryRebuild,
  setProjectEnvironmentHidden
} from "@ironside/db";
import type { Trace } from "@ironside/shared";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runEnvironmentRegistryRebuildChunk } from "../src/environments/environment-registry.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);
const orgId = `org_env_rebuild_${ulid()}`;
const projectId = `proj_env_rebuild_${ulid()}`;

beforeAll(async () => {
  await Promise.all([runPostgresMigrations(pool), runClickHouseMigrations(clickhouse)]);
  await pool.query("insert into organizations (id, name) values ($1, $2)", [orgId, orgId]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, projectId]
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [orgId]);
  await pool.end();
  await clickhouse.close();
});

describe("environment registry rebuild", () => {
  it("rebuilds from retained FINAL traces, preserving retained visibility and removing stale names", async () => {
    const eventTs = new Date().toISOString();
    const traces: Trace[] = [
      {
        id: `trace_${ulid()}`,
        projectId,
        timestamp: "2026-08-20T00:00:00.000Z",
        environment: "production",
        tags: [],
        metadata: {}
      },
      {
        id: `trace_${ulid()}`,
        projectId,
        timestamp: "2026-08-21T00:00:00.000Z",
        environment: "staging",
        tags: [],
        metadata: {}
      }
    ];
    await insertTraces(clickhouse, traces, { eventTs });
    await observeProjectEnvironments(pool, projectId, [
      { environment: "production", traceTimestamp: traces[0]!.timestamp },
      { environment: "removed-by-retention", traceTimestamp: "2025-01-01T00:00:00.000Z" }
    ]);
    await setProjectEnvironmentHidden(pool, projectId, "production", true);

    await scheduleEnvironmentRegistryRebuild(pool, projectId);
    const claim = await claimEnvironmentRegistryRebuild(pool, projectId);
    const result = await runEnvironmentRegistryRebuildChunk({
      pool,
      clickhouse,
      claim: claim!
    });
    expect(result.status).toBe("complete");
    const registry = await listProjectEnvironments(pool, projectId);
    expect(registry.environments.map((environment) => environment.name).sort()).toEqual([
      "production",
      "staging"
    ]);
    expect(registry.environments.find((environment) => environment.name === "production")?.hidden).toBe(true);
    expect(registry.lastRebuiltAt).not.toBeNull();
  });

  it("stops discovery at the 101st distinct value and records overflow without losing trace truth", async () => {
    const overflowProject = `proj_env_rebuild_overflow_${ulid()}`;
    await pool.query(
      "insert into projects (id, organization_id, name) values ($1, $2, $3)",
      [overflowProject, orgId, overflowProject]
    );
    const traces: Trace[] = Array.from({ length: 101 }, (_, index) => ({
      id: `trace_${ulid()}`,
      projectId: overflowProject,
      timestamp: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
      environment: `preview-${index.toString().padStart(3, "0")}`,
      tags: [],
      metadata: {}
    }));
    await insertTraces(clickhouse, traces, { eventTs: new Date().toISOString() });
    await scheduleEnvironmentRegistryRebuild(pool, overflowProject);
    const claim = await claimEnvironmentRegistryRebuild(pool, overflowProject);
    const result = await runEnvironmentRegistryRebuildChunk({ pool, clickhouse, claim: claim! });
    expect(result).toMatchObject({ status: "complete", environmentCount: 100, overflowed: true });
    const registry = await listProjectEnvironments(pool, overflowProject);
    expect(registry.environments).toHaveLength(100);
    expect(registry.overflowed).toBe(true);
  });

  it("checkpoints and resumes a scan larger than one bounded page", async () => {
    const pagedProject = `proj_env_rebuild_paged_${ulid()}`;
    await pool.query(
      "insert into projects (id, organization_id, name) values ($1, $2, $3)",
      [pagedProject, orgId, pagedProject]
    );
    const traces: Trace[] = Array.from({ length: 2_001 }, (_, index) => ({
      id: `trace_${ulid()}`,
      projectId: pagedProject,
      timestamp: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
      environment: "production",
      tags: [],
      metadata: {}
    }));
    await insertTraces(clickhouse, traces, { eventTs: new Date().toISOString() });
    await scheduleEnvironmentRegistryRebuild(pool, pagedProject);

    const firstClaim = await claimEnvironmentRegistryRebuild(pool, pagedProject);
    const first = await runEnvironmentRegistryRebuildChunk({
      pool,
      clickhouse,
      claim: firstClaim!
    });
    expect(first).toMatchObject({
      status: "checkpointed",
      rowsScanned: 2_000,
      environmentCount: 1,
      overflowed: false
    });

    const resumedClaim = await claimEnvironmentRegistryRebuild(pool, pagedProject);
    expect(resumedClaim?.startedAt.toISOString()).toBe(firstClaim?.startedAt.toISOString());
    expect(resumedClaim?.cursor).not.toBeNull();
    expect(resumedClaim?.candidates).toEqual(["production"]);
    const second = await runEnvironmentRegistryRebuildChunk({
      pool,
      clickhouse,
      claim: resumedClaim!
    });
    expect(second).toMatchObject({
      status: "complete",
      rowsScanned: 1,
      environmentCount: 1,
      overflowed: false
    });
    expect((await listProjectEnvironments(pool, pagedProject)).environments).toEqual([
      expect.objectContaining({ name: "production" })
    ]);
  });
});
