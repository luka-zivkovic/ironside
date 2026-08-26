import { createHash } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// __dirname is dist/src at runtime; migrations are copied to dist/migrations
// by the build script (they are data, not TS, so tsc won't emit them).
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Applies the current pre-production ClickHouse baseline. Historical schema
 * ledgers fail with a reset instruction instead of carrying upgrade DDL.
 */
export async function runMigrations(client: ClickHouseClient): Promise<void> {
  await client.command({
    query: `
      create table if not exists ironside_migrations
      (
          id          String,
          checksum    String,
          applied_at  DateTime64(3) default now64(3)
      )
      engine = ReplacingMergeTree(applied_at)
      order by id
    `
  });

  // CREATE TABLE IF NOT EXISTS intentionally leaves an older ledger alone.
  // Inspect its shape before reading it so historical pre-production installs
  // get the reset instruction instead of an opaque missing-column/FINAL error.
  const ledgerColumnsResult = await client.query({
    query: `
      select name
      from system.columns
      where database = currentDatabase()
        and table = 'ironside_migrations'
    `,
    format: "JSONEachRow"
  });
  const ledgerColumns = new Set(
    (await ledgerColumnsResult.json<{ name: string }>()).map((row) => row.name)
  );
  const expectedLedgerColumns = ["id", "checksum", "applied_at"];
  if (expectedLedgerColumns.some((column) => !ledgerColumns.has(column))) {
    throw new Error(
      "obsolete pre-production schema history detected; reset ClickHouse before starting Ironside"
    );
  }

  const migrationsDir = join(__dirname, "..", "migrations");
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const migrationIds = new Set(files.map((file) => file.replace(/\.sql$/, "")));
  const appliedResult = await client.query({
    query: "select id from ironside_migrations",
    format: "JSONEachRow"
  });
  const appliedRows = await appliedResult.json<{ id: string }>();
  const obsolete = [...new Set(appliedRows.map((row) => row.id))]
    .filter((id) => !migrationIds.has(id));
  if (obsolete.length > 0) {
    throw new Error(
      `obsolete pre-production schema history detected (${obsolete.join(", ")}); reset ClickHouse before starting Ironside`
    );
  }

  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    const sql = await readFile(join(migrationsDir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const result = await client.query({
      query: "select checksum from ironside_migrations where id = {id:String}",
      query_params: { id },
      format: "JSONEachRow"
    });
    const rows = await result.json<{ checksum: string }>();
    if (rows.length > 0) {
      if (rows.some((row) => row.checksum !== checksum)) {
        throw new Error(
          `pre-production baseline ${id} changed; reset ClickHouse before starting Ironside`
        );
      }
      continue;
    }

    const withoutComments = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const statements = withoutComments
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await client.command({ query: statement });
    }

    await client.insert({
      table: "ironside_migrations",
      values: [{ id, checksum }],
      format: "JSONEachRow"
    });
  }
}
