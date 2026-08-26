import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

// __dirname is dist/src at runtime; migrations are copied to dist/migrations
// by the build script (they are data, not TS, so tsc won't emit them).
const __dirname = dirname(fileURLToPath(import.meta.url));

// Arbitrary fixed lock id that serializes concurrent Ironside startup.
const MIGRATION_LOCK_ID = 427193856;

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    await ensureMigrationsTable(client);

    const migrationsDir = join(__dirname, "..", "migrations");
    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const migrationIds = new Set(files.map((file) => file.replace(/\.sql$/, "")));
    const applied = await client.query<{ id: string }>("select id from ironside_migrations");
    const obsolete = applied.rows
      .map((row) => row.id)
      .filter((id) => !migrationIds.has(id));
    if (obsolete.length > 0) {
      throw new Error(
        `obsolete pre-production schema history detected (${obsolete.join(", ")}); reset Postgres before starting Ironside`
      );
    }

    for (const file of files) {
      const id = file.replace(/\.sql$/, "");
      const sql = await readFile(join(migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "select checksum from ironside_migrations where id = $1",
        [id]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(
            `pre-production baseline ${id} changed; reset Postgres before starting Ironside`
          );
        }
        continue;
      }

      await client.query(sql);
      await client.query(
        "insert into ironside_migrations (id, checksum) values ($1, $2)",
        [id, checksum]
      );
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists ironside_migrations (
      id text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}
