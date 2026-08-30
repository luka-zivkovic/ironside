import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { runMigrations } from "../src/migrate.js";
import { createProject } from "../src/projects.js";

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://ironside:ironside@localhost:5433/ironside";

describe("runMigrations (postgres)", () => {
  const pool = new Pool({ connectionString });
  afterAll(() => pool.end());

  it("applies migrations once across concurrent starts and is idempotent on re-run", async () => {
    await Promise.all(Array.from({ length: 4 }, () => runMigrations(pool)));
    await runMigrations(pool);

    const tables = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = current_schema() and table_name in
       ('organizations', 'projects', 'ironside_migrations', 'raw_retention_intents',
        'owner_principals', 'owner_auth_challenges', 'owner_sessions', 'auth_audit_events',
        'machine_credentials', 'project_environments', 'project_environment_registry_state',
        'evaluator_trace_feed', 'evaluator_import_trace_state')`
    );
    const names = tables.rows.map((r) => r.table_name).sort();
    expect(names).toEqual([
      "auth_audit_events",
      "evaluator_import_trace_state",
      "evaluator_trace_feed",
      "ironside_migrations",
      "machine_credentials",
      "organizations",
      "owner_auth_challenges",
      "owner_principals",
      "owner_sessions",
      "project_environment_registry_state",
      "project_environments",
      "projects",
      "raw_retention_intents"
    ]);

    const applied = await pool.query("select id, checksum from ironside_migrations order by id");
    expect(applied.rows).toEqual([
      {
        id: "0001_baseline",
        checksum: "54309d8feec00b2eabaf677c3fcb4acac8047a477151bc7b37c23fe1c5ce8d86"
      },
      {
        id: "0002_evaluator_trace_feed",
        checksum: "f7b353407f3aafb291afe18136cef499a658c8748355f13410125d5e47b184b2"
      },
      {
        id: "0003_evaluator_import_materialization",
        checksum: "2bc6bd96cef21f9536a8fad76e4d51d868e04063c93e092d82b95bf6791499ba"
      },
      {
        id: "0004_evaluator_recovery_leases",
        checksum: "12f2134728d088b4f8f0f26901a770619a6fcc376ac5d04c6483fda42c67968d"
      }
    ]);
    expect((await pool.query("select to_regclass('api_keys') as table_name")).rows).toEqual([
      { table_name: null }
    ]);
  });

  it("enforces referential integrity project -> organization", async () => {
    await runMigrations(pool);
    await expect(
      pool.query(
        "insert into projects (id, organization_id, name) values ('proj_x', 'org_missing', 'x')"
      )
    ).rejects.toThrow();
  });

  it("initializes environment discovery when current code creates a project", async () => {
    await runMigrations(pool);
    const organizationId = `org_migrate_env_${ulid()}`;
    const projectId = `proj_migrate_env_${ulid()}`;
    try {
      await pool.query("insert into organizations (id, name) values ($1, $2)", [
        organizationId,
        organizationId
      ]);
      await createProject(pool, { id: projectId, organizationId, name: projectId });
      const state = await pool.query<{ due: boolean }>(
        `select next_rebuild_at <= now() as due
           from project_environment_registry_state
          where project_id = $1`,
        [projectId]
      );
      expect(state.rows).toEqual([{ due: true }]);
    } finally {
      await pool.query("delete from organizations where id = $1", [organizationId]);
    }
  });
});
