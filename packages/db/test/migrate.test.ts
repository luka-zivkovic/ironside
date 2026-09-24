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
        'evaluator_trace_feed', 'evaluator_import_trace_state', 'project_model_prices')`
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
      "project_model_prices",
      "projects",
      "raw_retention_intents"
    ]);

    const applied = await pool.query(
      `select id, checksum from ironside_migrations order by id collate "C"`
    );
    expect(applied.rows).toEqual([
      {
        id: "0001_baseline",
        checksum: "ca0fe03d88db6c911b1c682303738c090b6351c192845b453781b7321d2b588b"
      },
      {
        id: "0002_project_model_prices",
        checksum: "7de46f83d3bcbb222ce23d4e34f3cd3a9ba764707c7b4961d7bbb4d63c42d4cb"
      },
      {
        id: "0003_destination_feed_cursors",
        checksum: "1a04d4dc1f00f2bf99a457fd59512708fc0e5503f8eb43820a1372247d0aeb2e"
      },
      {
        id: "0004_trace_score_feed_and_forward_status",
        checksum: "4e675fbf1e7b7122c27b66c35e1f1737e77670753865be50709e81265da2683e"
      },
      {
        id: "0005_langfuse_field_provenance",
        checksum: "98ad7a712c91f83c8167c80d509140a9f2b7e04a1d6d263b2b61ab6c82fbe771"
      },
      {
        id: "0006_webhook_feed_cursors",
        checksum: "feaec475385c6c79b0ef91b5a0e5c7c9cf6754532cb3d7cdacd059728f3b5b29"
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
