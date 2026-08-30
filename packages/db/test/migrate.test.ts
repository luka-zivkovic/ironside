import { readFile } from "node:fs/promises";
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

    const applied = await pool.query(
      `select id, checksum from ironside_migrations order by id collate "C"`
    );
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
        id: "0003a_evaluator_import_pending_handoff",
        checksum: "37e8623dd7aedf2abbd7649208b1487cc480f429086edf2507f121e040385e13"
      },
      {
        id: "0004_evaluator_recovery_leases",
        checksum: "12f2134728d088b4f8f0f26901a770619a6fcc376ac5d04c6483fda42c67968d"
      },
      {
        id: "0005_evaluator_import_retention_cutoffs",
        checksum: "c8749c4e17c33a49b87e8ece58151757585ff5ce10bb962f9d1c8f4c5d2e40f9"
      },
      {
        id: "0006_evaluator_import_publication_scope",
        checksum: "21ee419a99401f56b56853f1393f790839abde46a224b6e0eac57b117e7a67a4"
      }
    ]);
    expect((await pool.query("select to_regclass('api_keys') as table_name")).rows).toEqual([
      { table_name: null }
    ]);
  });

  it("hands a pre-lease pending import to fail-closed recovery before 0004", async () => {
    const schema = `migration_handoff_${ulid().toLowerCase()}`;
    const client = await pool.connect();
    try {
      await client.query(`create schema "${schema}"`);
      await client.query("begin");
      await client.query(`set local search_path to "${schema}"`);
      await client.query("create table projects (id text primary key)");
      await client.query(`
        create table import_checkpoints (
          id text primary key,
          project_id text not null,
          source text not null,
          status text not null,
          unique (project_id, source)
        )
      `);
      await client.query(`
        create table evaluator_score_receipts (
          project_id text not null,
          score_id text not null,
          ingest_batch_id text,
          ingest_staged_at timestamptz,
          primary key (project_id, score_id)
        )
      `);
      await client.query(`
        create table evaluator_import_trace_state (
          project_id text not null references projects(id) on delete cascade,
          trace_id text not null,
          source text not null,
          content_hash text not null,
          activity_id text not null,
          source_activity_at timestamptz not null,
          pending boolean not null default true,
          staged_at timestamptz not null default clock_timestamp(),
          primary key (project_id, trace_id, source)
        )
      `);
      await client.query("insert into projects (id) values ('project_legacy')");
      await client.query(`
        insert into evaluator_import_trace_state
          (project_id, trace_id, source, content_hash, activity_id, source_activity_at)
        values
          ('project_legacy', 'trace_partial', 'langfuse', $1, 'activity_legacy', '2026-08-29T00:00:00.000Z')
      `, ["a".repeat(64)]);

      const handoffSql = await readFile(
        new URL("../migrations/0003a_evaluator_import_pending_handoff.sql", import.meta.url),
        "utf8"
      );
      const leasesSql = await readFile(
        new URL("../migrations/0004_evaluator_recovery_leases.sql", import.meta.url),
        "utf8"
      );
      await client.query(handoffSql);
      expect((await client.query("select count(*)::int as count from evaluator_import_trace_state")).rows)
        .toEqual([{ count: 0 }]);
      expect((await client.query(`
        select project_id, trace_id, source, activity_id
          from evaluator_import_legacy_pending_recovery
      `)).rows).toEqual([{
        project_id: "project_legacy",
        trace_id: "trace_partial",
        source: "langfuse",
        activity_id: "activity_legacy"
      }]);
      await expect(client.query(leasesSql)).resolves.toBeDefined();
      await client.query("rollback");
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.query(`drop schema if exists "${schema}" cascade`);
      client.release();
    }
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
