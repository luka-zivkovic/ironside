import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import {
  claimEnvironmentRegistryRebuild,
  finalizeEnvironmentRegistryRebuild,
  listProjectEnvironments,
  observeProjectEnvironments,
  runMigrations,
  scheduleEnvironmentRegistryRebuild,
  setProjectEnvironmentHidden
} from "../src/index.js";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://ironside:ironside@localhost:5433/ironside"
});
const orgId = `org_env_${ulid()}`;
const projectId = `proj_env_${ulid()}`;

async function createRegistryTestProject(id: string): Promise<void> {
  await pool.query(
    `with inserted as (
       insert into projects (id, organization_id, name) values ($1, $2, $1)
       returning id
     )
     insert into project_environment_registry_state (project_id, next_rebuild_at)
     select id, 'infinity'::timestamptz from inserted`,
    [id, orgId]
  );
}

beforeAll(async () => {
  await runMigrations(pool);
  await pool.query("insert into organizations (id, name) values ($1, $2)", [orgId, orgId]);
  await createRegistryTestProject(projectId);
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [orgId]);
  await pool.end();
});

describe("project environment registry", () => {
  it("merges retained trace timestamps and visibility without creating names manually", async () => {
    await observeProjectEnvironments(pool, projectId, [
      { environment: "production", traceTimestamp: "2026-08-20T00:00:00.000Z" },
      { environment: "production", traceTimestamp: "2026-08-22T00:00:00.000Z" },
      { environment: "staging", traceTimestamp: "2026-08-21T00:00:00.000Z" }
    ]);
    await observeProjectEnvironments(pool, projectId, [
      { environment: "production", traceTimestamp: "2026-08-19T00:00:00.000Z" }
    ]);

    const registry = await listProjectEnvironments(pool, projectId);
    const production = registry.environments.find((entry) => entry.name === "production");
    expect(production?.firstSeenAt.toISOString()).toBe("2026-08-19T00:00:00.000Z");
    expect(production?.lastSeenAt.toISOString()).toBe("2026-08-22T00:00:00.000Z");

    expect(await setProjectEnvironmentHidden(pool, projectId, "unknown", true)).toBeNull();
    expect((await setProjectEnvironmentHidden(pool, projectId, "production", true))?.hidden).toBe(true);
  });

  it("serializes concurrent admission at 100 while known names keep updating", async () => {
    const cappedProject = `proj_env_cap_${ulid()}`;
    await createRegistryTestProject(cappedProject);
    const values = Array.from({ length: 110 }, (_, index) => ({
      environment: `environment-${index.toString().padStart(3, "0")}`,
      traceTimestamp: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString()
    }));
    await Promise.all(
      Array.from({ length: 11 }, (_, chunk) =>
        observeProjectEnvironments(pool, cappedProject, values.slice(chunk * 10, chunk * 10 + 10))
      )
    );
    const registry = await listProjectEnvironments(pool, cappedProject);
    expect(registry.environments).toHaveLength(100);
    expect(registry.overflowed).toBe(true);

    const known = registry.environments[0]!;
    await observeProjectEnvironments(pool, cappedProject, [
      { environment: known.name, traceTimestamp: "2027-01-01T00:00:00.000Z" },
      { environment: "environment-overflow-new", traceTimestamp: "2027-01-02T00:00:00.000Z" }
    ]);
    const updated = await listProjectEnvironments(pool, cappedProject);
    expect(updated.environments).toHaveLength(100);
    expect(updated.environments.find((entry) => entry.name === known.name)?.lastSeenAt.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    );
  });

  it("atomically rebuilds retained rows, preserves visibility, and merges post-watermark observations", async () => {
    const rebuildProject = `proj_env_rebuild_${ulid()}`;
    await createRegistryTestProject(rebuildProject);
    await observeProjectEnvironments(pool, rebuildProject, [
      { environment: "production", traceTimestamp: "2026-08-20T00:00:00.000Z" },
      { environment: "staging", traceTimestamp: "2026-08-21T00:00:00.000Z" }
    ]);
    expect(
      (await setProjectEnvironmentHidden(pool, rebuildProject, "production", true))?.hidden
    ).toBe(true);

    await scheduleEnvironmentRegistryRebuild(pool, rebuildProject);
    const claim = await claimEnvironmentRegistryRebuild(pool, rebuildProject);
    expect(claim).not.toBeNull();
    await observeProjectEnvironments(pool, rebuildProject, [
      { environment: "new-during-scan", traceTimestamp: "2026-08-25T00:00:00.000Z" }
    ]);

    await finalizeEnvironmentRegistryRebuild(
      pool,
      claim!,
      async (postWatermarkNames) => {
        expect(postWatermarkNames).toEqual(["new-during-scan"]);
        return [
          {
            name: "production",
            firstSeenAt: new Date("2026-08-20T00:00:00.000Z"),
            lastSeenAt: new Date("2026-08-24T00:00:00.000Z")
          },
          {
            name: "new-during-scan",
            firstSeenAt: new Date("2026-08-25T00:00:00.000Z"),
            lastSeenAt: new Date("2026-08-25T00:00:00.000Z")
          }
        ];
      },
      false
    );
    const registry = await listProjectEnvironments(pool, rebuildProject);
    expect(registry.environments.map((entry) => entry.name).sort()).toEqual([
      "new-during-scan",
      "production"
    ]);
    expect(registry.environments.find((entry) => entry.name === "production")?.hidden).toBe(true);
    expect(registry.environments.some((entry) => entry.name === "staging")).toBe(false);
    expect(registry.lastRebuiltAt).not.toBeNull();
  });

  it("reserves capacity for a post-watermark observation even when its trace is older", async () => {
    const concurrentProject = `proj_env_rebuild_concurrent_${ulid()}`;
    await createRegistryTestProject(concurrentProject);
    await observeProjectEnvironments(
      pool,
      concurrentProject,
      Array.from({ length: 99 }, (_, index) => ({
        environment: `existing-${index.toString().padStart(3, "0")}`,
        traceTimestamp: "2026-08-20T00:00:00.000Z"
      }))
    );
    await scheduleEnvironmentRegistryRebuild(pool, concurrentProject);
    const claim = await claimEnvironmentRegistryRebuild(pool, concurrentProject);
    expect(claim).not.toBeNull();

    await observeProjectEnvironments(pool, concurrentProject, [
      {
        environment: "historical-import-during-scan",
        traceTimestamp: "2020-01-01T00:00:00.000Z"
      }
    ]);
    // pg returns timestamps as millisecond-precision JS Dates. Keep this
    // observation only half a millisecond after the claim to prove the
    // watermark comparison stays in Postgres instead of collapsing both
    // instants to equality in JavaScript.
    await pool.query(
      `update project_environments
          set updated_at = $3::timestamptz + interval '0.5 milliseconds'
        where project_id = $1 and name = $2`,
      [concurrentProject, "historical-import-during-scan", claim!.startedAt]
    );
    await finalizeEnvironmentRegistryRebuild(
      pool,
      claim!,
      async (postWatermarkNames) => {
        expect(postWatermarkNames).toEqual(["historical-import-during-scan"]);
        return [
          ...Array.from({ length: 100 }, (_, index) => ({
            name: `snapshot-${index.toString().padStart(3, "0")}`,
            firstSeenAt: new Date("2026-08-24T00:00:00.000Z"),
            lastSeenAt: new Date("2026-08-24T00:00:00.000Z")
          })),
          {
            name: "historical-import-during-scan",
            firstSeenAt: new Date("2020-01-01T00:00:00.000Z"),
            lastSeenAt: new Date("2020-01-01T00:00:00.000Z")
          }
        ];
      },
      false
    );

    const registry = await listProjectEnvironments(pool, concurrentProject);
    expect(registry.environments).toHaveLength(100);
    expect(
      registry.environments.some(
        (environment) => environment.name === "historical-import-during-scan"
      )
    ).toBe(true);
    expect(registry.overflowed).toBe(true);
  });

  it("preserves overflow observed after the rebuild watermark when no row can be admitted", async () => {
    const overflowRaceProject = `proj_env_rebuild_overflow_race_${ulid()}`;
    await createRegistryTestProject(overflowRaceProject);
    const snapshot = Array.from({ length: 100 }, (_, index) => ({
      name: `snapshot-${index.toString().padStart(3, "0")}`,
      firstSeenAt: new Date("2026-08-20T00:00:00.000Z"),
      lastSeenAt: new Date("2026-08-20T00:00:00.000Z")
    }));
    await observeProjectEnvironments(
      pool,
      overflowRaceProject,
      snapshot.map((environment) => ({
        environment: environment.name,
        traceTimestamp: environment.lastSeenAt
      }))
    );
    await scheduleEnvironmentRegistryRebuild(pool, overflowRaceProject);
    const claim = await claimEnvironmentRegistryRebuild(pool, overflowRaceProject);
    expect(claim).not.toBeNull();

    const concurrent = await observeProjectEnvironments(pool, overflowRaceProject, [
      {
        environment: "overflow-during-scan",
        traceTimestamp: "2026-08-25T00:00:00.000Z"
      }
    ]);
    expect(concurrent).toEqual({ admitted: 0, overflowed: 1 });
    expect((await listProjectEnvironments(pool, overflowRaceProject)).overflowed).toBe(true);

    const finalized = await finalizeEnvironmentRegistryRebuild(
      pool,
      claim!,
      async (postWatermarkNames) => {
        expect(postWatermarkNames).toEqual([]);
        return snapshot;
      },
      false
    );
    expect(finalized).toEqual({ count: 100, overflowed: true });
    const registry = await listProjectEnvironments(pool, overflowRaceProject);
    expect(registry.environments).toHaveLength(100);
    expect(registry.environments.some((environment) => environment.name === "overflow-during-scan")).toBe(false);
    expect(registry.overflowed).toBe(true);
    expect(registry.lastOverflowAt).not.toBeNull();
  });

  it("does not reintroduce expired timestamp history from a live cumulative row", async () => {
    const retainedRangeProject = `proj_env_rebuild_range_${ulid()}`;
    await createRegistryTestProject(retainedRangeProject);
    await observeProjectEnvironments(pool, retainedRangeProject, [
      { environment: "production", traceTimestamp: "2020-01-01T00:00:00.000Z" }
    ]);
    await scheduleEnvironmentRegistryRebuild(pool, retainedRangeProject);
    const claim = await claimEnvironmentRegistryRebuild(pool, retainedRangeProject);
    await observeProjectEnvironments(pool, retainedRangeProject, [
      { environment: "production", traceTimestamp: "2026-08-22T00:00:00.000Z" }
    ]);

    await finalizeEnvironmentRegistryRebuild(
      pool,
      claim!,
      async (postWatermarkNames) => {
        expect(postWatermarkNames).toEqual(["production"]);
        return [
          {
            name: "production",
            firstSeenAt: new Date("2026-08-20T00:00:00.000Z"),
            lastSeenAt: new Date("2026-08-24T00:00:00.000Z")
          }
        ];
      },
      false
    );
    const production = (await listProjectEnvironments(pool, retainedRangeProject)).environments[0];
    expect(production?.firstSeenAt.toISOString()).toBe("2026-08-20T00:00:00.000Z");
    expect(production?.lastSeenAt.toISOString()).toBe("2026-08-24T00:00:00.000Z");
  });

  it("serializes an observation that starts after exact stats so it applies after the swap", async () => {
    const lockedStatsProject = `proj_env_rebuild_locked_stats_${ulid()}`;
    await createRegistryTestProject(lockedStatsProject);
    await observeProjectEnvironments(pool, lockedStatsProject, [
      { environment: "production", traceTimestamp: "2026-08-20T00:00:00.000Z" }
    ]);
    await scheduleEnvironmentRegistryRebuild(pool, lockedStatsProject);
    const claim = await claimEnvironmentRegistryRebuild(pool, lockedStatsProject);
    let concurrentObservation: ReturnType<typeof observeProjectEnvironments> | null = null;

    await finalizeEnvironmentRegistryRebuild(
      pool,
      claim!,
      async () => {
        // The exact-stats loader runs under the project lock. This attempted
        // observation must wait and then update the rebuilt row after commit.
        concurrentObservation = observeProjectEnvironments(pool, lockedStatsProject, [
          { environment: "production", traceTimestamp: "2026-08-25T00:00:00.000Z" }
        ]);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return [
          {
            name: "production",
            firstSeenAt: new Date("2026-08-20T00:00:00.000Z"),
            lastSeenAt: new Date("2026-08-24T00:00:00.000Z")
          }
        ];
      },
      false
    );
    await concurrentObservation;
    const production = (await listProjectEnvironments(pool, lockedStatsProject)).environments[0];
    expect(production?.firstSeenAt.toISOString()).toBe("2026-08-20T00:00:00.000Z");
    expect(production?.lastSeenAt.toISOString()).toBe("2026-08-25T00:00:00.000Z");
  });

  it("does not let a visibility change reserve a rebuild slot for an expired name", async () => {
    const visibilityRaceProject = `proj_env_rebuild_visibility_${ulid()}`;
    await createRegistryTestProject(visibilityRaceProject);
    await observeProjectEnvironments(pool, visibilityRaceProject, [
      { environment: "expired-hidden-name", traceTimestamp: "2020-01-01T00:00:00.000Z" }
    ]);
    await scheduleEnvironmentRegistryRebuild(pool, visibilityRaceProject);
    const claim = await claimEnvironmentRegistryRebuild(pool, visibilityRaceProject);
    expect(await setProjectEnvironmentHidden(pool, visibilityRaceProject, "expired-hidden-name", true)).not.toBeNull();
    const snapshot = Array.from({ length: 100 }, (_, index) => ({
      name: `retained-${index.toString().padStart(3, "0")}`,
      firstSeenAt: new Date("2026-08-20T00:00:00.000Z"),
      lastSeenAt: new Date("2026-08-24T00:00:00.000Z")
    }));

    const finalized = await finalizeEnvironmentRegistryRebuild(
      pool,
      claim!,
      async (postWatermarkNames) => {
        expect(postWatermarkNames).toEqual([]);
        return snapshot;
      },
      false
    );
    expect(finalized).toEqual({ count: 100, overflowed: false });
    const registry = await listProjectEnvironments(pool, visibilityRaceProject);
    expect(registry.environments).toHaveLength(100);
    expect(registry.environments.some((environment) => environment.name === "expired-hidden-name")).toBe(false);
  });
});
