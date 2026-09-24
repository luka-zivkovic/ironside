import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://ironside:ironside@localhost:5433/ironside";
const shippedMigrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
/** Every migration this release ships, in order. */
const currentMigrationIds = readdirSync(shippedMigrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => file.replace(/\.sql$/, ""));

/** A migrations directory holding only the files a v0.3.0 install applied. */
function v030MigrationsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ironside-pg-migrations-"));
  copyFileSync(join(shippedMigrationsDir, "0001_baseline.sql"), join(dir, "0001_baseline.sql"));
  return dir;
}

// Each test gets its own database: upgrade tests write ledger rows the shared
// test database must never see.
const scratch: { name: string; pool: Pool }[] = [];
const admin = new Pool({ connectionString });

async function scratchDatabase(): Promise<Pool> {
  const name = `ironside_upgrade_${ulid().toLowerCase()}`;
  await admin.query(`create database ${name}`);
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  // The forced drop in afterEach can terminate a connection the pool is still
  // closing; that is expected teardown, not a test failure.
  pool.on("error", () => {});
  scratch.push({ name, pool });
  return pool;
}

afterEach(async () => {
  for (const { name, pool } of scratch.splice(0)) {
    await pool.end();
    await admin.query(`drop database if exists ${name} with (force)`);
  }
});

describe("Postgres upgrades", () => {
  it("upgrades a v0.3.0 database in place, applying later migrations and keeping its data", async () => {
    const pool = await scratchDatabase();
    await runMigrations(pool, { migrationsDir: v030MigrationsDir() });
    await pool.query("insert into organizations (id, name) values ('org_1', 'upgrade-org')");
    await pool.query(
      "insert into projects (id, organization_id, name) values ('proj_1', 'org_1', 'upgrade-project')"
    );

    await runMigrations(pool);
    await runMigrations(pool);

    const applied = await pool.query<{ id: string }>(
      `select id from ironside_migrations order by id collate "C"`
    );
    expect(applied.rows.map((row) => row.id)).toEqual(currentMigrationIds);
    const projects = await pool.query("select id, name from projects");
    expect(projects.rows).toEqual([{ id: "proj_1", name: "upgrade-project" }]);
    await pool.query(
      `insert into project_model_prices (id, project_id, position, pattern, input_cost_per_token)
       values ('price_1', 'proj_1', 0, '^gpt-', 0.000001)`
    );
  });

  it("marks webhook rules from before the trace feed so their earlier deliveries are not resent", async () => {
    const pool = await scratchDatabase();
    await runMigrations(pool, { migrationsDir: v030MigrationsDir() });
    await pool.query("insert into organizations (id, name) values ('org_1', 'upgrade-org')");
    await pool.query(
      "insert into projects (id, organization_id, name) values ('proj_1', 'org_1', 'upgrade-project')"
    );
    const insertRule = (id: string) =>
      pool.query(
        `insert into webhook_rules (id, project_id, name, destination_url, signing_secret_encrypted)
         values ($1, 'proj_1', $1, 'https://example.com/hook', 'ciphertext')`,
        [id]
      );
    await insertRule("webhook_before");

    await runMigrations(pool);
    await insertRule("webhook_after");

    const rules = await pool.query<{ id: string; marked: boolean; feed_cursor_trace_id: string | null }>(
      `select id, legacy_delivery_cutoff is not null as marked, feed_cursor_trace_id
       from webhook_rules order by id`
    );
    expect(rules.rows).toEqual([
      { id: "webhook_after", marked: false, feed_cursor_trace_id: null },
      { id: "webhook_before", marked: true, feed_cursor_trace_id: null }
    ]);
  });

  it("applies an upgrade exactly once when api and worker start at the same time", async () => {
    const pool = await scratchDatabase();
    await runMigrations(pool, { migrationsDir: v030MigrationsDir() });

    await Promise.all(Array.from({ length: 4 }, () => runMigrations(pool)));

    const applied = await pool.query<{ id: string }>("select id from ironside_migrations");
    expect(applied.rows.map((row) => row.id).sort()).toEqual(currentMigrationIds);
  });

  it("refuses to start on a schema a newer release migrated, naming the unknown migration", async () => {
    const pool = await scratchDatabase();
    await runMigrations(pool);
    await pool.query(
      "insert into ironside_migrations (id, checksum) values ('9999_from_a_newer_release', 'x')"
    );

    await expect(runMigrations(pool)).rejects.toThrow(
      /migrated by a newer Ironside release \(9999_from_a_newer_release\)/
    );
  });

  it("refuses to start when a migration this database applied was edited afterwards", async () => {
    const pool = await scratchDatabase();
    await runMigrations(pool);
    await pool.query("update ironside_migrations set checksum = 'edited' where id = '0001_baseline'");

    await expect(runMigrations(pool)).rejects.toThrow(/0001_baseline differs from the version/);
  });
});
