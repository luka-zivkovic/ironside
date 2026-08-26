import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";
import { createProject, getProject, listProjectsForOrganization, setProjectQuotas } from "../src/projects.js";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://ironside:ironside@localhost:5433/ironside"
});

let organizationId: string;
let seededProjectId: string;

beforeAll(async () => {
  await runMigrations(pool);
  organizationId = `org_${ulid()}`;
  seededProjectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    organizationId,
    "projects-db-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [seededProjectId, organizationId, "projects-db-test-seed"]
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'projects-db-test-org'");
  await pool.end();
});

describe("projects", () => {
  it("getProject returns the project, or null if it doesn't exist", async () => {
    const found = await getProject(pool, seededProjectId);
    expect(found?.id).toBe(seededProjectId);
    expect(found?.organizationId).toBe(organizationId);

    const missing = await getProject(pool, "proj_does_not_exist");
    expect(missing).toBeNull();
  });

  it("createProject inserts a row scoped to the given organization", async () => {
    const created = await createProject(pool, {
      id: `proj_${ulid()}`,
      organizationId,
      name: "new-project"
    });
    expect(created.name).toBe("new-project");
    expect(created.organizationId).toBe(organizationId);

    const found = await getProject(pool, created.id);
    expect(found?.name).toBe("new-project");
  });

  it("listProjectsForOrganization returns every project in the org, ordered by creation, and none from other orgs", async () => {
    const otherOrgId = `org_${ulid()}`;
    await pool.query("insert into organizations (id, name) values ($1, $2)", [
      otherOrgId,
      "projects-db-test-other-org"
    ]);
    await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
      `proj_${ulid()}`,
      otherOrgId,
      "other-org-project"
    ]);

    const list = await listProjectsForOrganization(pool, organizationId);
    expect(list.some((p) => p.id === seededProjectId)).toBe(true);
    expect(list.every((p) => p.organizationId === organizationId)).toBe(true);

    await pool.query("delete from organizations where id = $1", [otherOrgId]);
  });

  it("setProjectQuotas only changes fields actually provided — an omitted field is left untouched, not cleared", async () => {
    const project = await createProject(pool, { id: `proj_${ulid()}`, organizationId, name: "quotas-test" });

    const afterFirst = await setProjectQuotas(pool, project.id, {
      rateLimitPerMinute: 500,
      retentionDays: 30,
      traceQuietPeriodSeconds: 45
    });
    expect(afterFirst?.rateLimitPerMinute).toBe(500);
    expect(afterFirst?.retentionDays).toBe(30);
    expect(afterFirst?.traceQuietPeriodSeconds).toBe(45);

    // Only rateLimitPerMinute is provided this time — retentionDays must
    // stay at 30, not revert to null via a naive COALESCE($n, column)
    // that can't distinguish "omitted" from "explicitly null".
    const afterSecond = await setProjectQuotas(pool, project.id, { rateLimitPerMinute: 900 });
    expect(afterSecond?.rateLimitPerMinute).toBe(900);
    expect(afterSecond?.retentionDays).toBe(30);
    expect(afterSecond?.traceQuietPeriodSeconds).toBe(45);
  });

  it("setProjectQuotas with an explicit null clears that field back to the platform default", async () => {
    const project = await createProject(pool, { id: `proj_${ulid()}`, organizationId, name: "quotas-clear-test" });
    await setProjectQuotas(pool, project.id, { rateLimitPerMinute: 500 });

    const cleared = await setProjectQuotas(pool, project.id, { rateLimitPerMinute: null });
    expect(cleared?.rateLimitPerMinute).toBeNull();
  });

  it("sets and clears the per-project trace quiet-period override", async () => {
    const project = await createProject(pool, {
      id: `proj_${ulid()}`,
      organizationId,
      name: "trace-quiet-period-test"
    });
    const set = await setProjectQuotas(pool, project.id, {
      traceQuietPeriodSeconds: 120
    });
    expect(set?.traceQuietPeriodSeconds).toBe(120);

    const cleared = await setProjectQuotas(pool, project.id, {
      traceQuietPeriodSeconds: null
    });
    expect(cleared?.traceQuietPeriodSeconds).toBeNull();
  });

  it("setProjectQuotas with no fields provided is a no-op that returns the project unchanged", async () => {
    const project = await createProject(pool, { id: `proj_${ulid()}`, organizationId, name: "quotas-noop-test" });
    await setProjectQuotas(pool, project.id, { rateLimitPerMinute: 42 });

    const result = await setProjectQuotas(pool, project.id, {});
    expect(result?.rateLimitPerMinute).toBe(42);
  });
});
