import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClickHouseClient } from "@clickhouse/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createClickHouseClient } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { insertTraces } from "../src/rows.js";

const connection = {
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.CLICKHOUSE_USER ?? "ironside",
  password: process.env.CLICKHOUSE_PASSWORD ?? "ironside"
};
const admin = createClickHouseClient({ ...connection, database: process.env.CLICKHOUSE_DB ?? "ironside" });
const shippedMigrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

// No ClickHouse migration has shipped after the baseline yet, so upgrades are
// exercised with a synthetic 0002 written the way the migration rules require.
const SYNTHETIC_UPGRADE = `
-- Synthetic upgrade used only by migrate-upgrade.test.ts.
alter table traces add column if not exists upgrade_probe Nullable(String);
create table if not exists upgrade_probe_events
(
    id String
)
engine = MergeTree
order by id;
`;

function migrationsDir(options: { withUpgrade: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "ironside-ch-migrations-"));
  copyFileSync(join(shippedMigrationsDir, "0001_baseline.sql"), join(dir, "0001_baseline.sql"));
  if (options.withUpgrade) writeFileSync(join(dir, "0002_upgrade_probe.sql"), SYNTHETIC_UPGRADE);
  return dir;
}

// Each test gets its own database so synthetic ledger rows never reach the
// shared test database.
const scratch: { name: string; client: ClickHouseClient }[] = [];

async function scratchDatabase(): Promise<ClickHouseClient> {
  const name = `ironside_upgrade_${randomUUID().replaceAll("-", "")}`;
  await admin.command({ query: `create database ${name}` });
  const client = createClickHouseClient({ ...connection, database: name });
  scratch.push({ name, client });
  return client;
}

async function appliedIds(client: ClickHouseClient): Promise<string[]> {
  const result = await client.query({
    query: "select id from ironside_migrations final order by id",
    format: "JSONEachRow"
  });
  return (await result.json<{ id: string }>()).map((row) => row.id);
}

afterEach(async () => {
  for (const { name, client } of scratch.splice(0)) {
    await client.close();
    await admin.command({ query: `drop database if exists ${name}` });
  }
});

afterAll(() => admin.close());

describe("ClickHouse upgrades", () => {
  it("upgrades a v0.3.0 database in place, applying later migrations and keeping its data", async () => {
    const client = await scratchDatabase();
    await runMigrations(client, { migrationsDir: migrationsDir({ withUpgrade: false }) });
    await insertTraces(
      client,
      [
        {
          id: "trace_1",
          projectId: "proj_1",
          timestamp: "2026-09-23T10:00:00.000Z",
          name: "kept",
          tags: [],
          metadata: {}
        }
      ],
      { eventTs: "2026-09-23T10:00:00.000Z" }
    );

    const upgrade = migrationsDir({ withUpgrade: true });
    await runMigrations(client, { migrationsDir: upgrade });
    await runMigrations(client, { migrationsDir: upgrade });

    expect(await appliedIds(client)).toEqual(["0001_baseline", "0002_upgrade_probe"]);
    const traces = await client.query({
      query: "select id, name, upgrade_probe from traces final",
      format: "JSONEachRow"
    });
    expect(await traces.json()).toEqual([{ id: "trace_1", name: "kept", upgrade_probe: null }]);
  });

  it("finishes a migration that failed partway, since ClickHouse DDL is not transactional", async () => {
    const client = await scratchDatabase();
    await runMigrations(client, { migrationsDir: migrationsDir({ withUpgrade: false }) });
    // The first statement ran, then the process died before the ledger row.
    await client.command({
      query: "alter table traces add column if not exists upgrade_probe Nullable(String)"
    });

    await runMigrations(client, { migrationsDir: migrationsDir({ withUpgrade: true }) });

    expect(await appliedIds(client)).toEqual(["0001_baseline", "0002_upgrade_probe"]);
  });

  it("applies an upgrade without errors when api and worker start at the same time", async () => {
    const client = await scratchDatabase();
    await runMigrations(client, { migrationsDir: migrationsDir({ withUpgrade: false }) });

    const upgrade = migrationsDir({ withUpgrade: true });
    await Promise.all(Array.from({ length: 4 }, () => runMigrations(client, { migrationsDir: upgrade })));

    expect(await appliedIds(client)).toEqual(["0001_baseline", "0002_upgrade_probe"]);
  });

  it("refuses to start on a schema a newer release migrated, naming the unknown migration", async () => {
    const client = await scratchDatabase();
    await runMigrations(client, { migrationsDir: migrationsDir({ withUpgrade: true }) });

    await expect(
      runMigrations(client, { migrationsDir: migrationsDir({ withUpgrade: false }) })
    ).rejects.toThrow(/migrated by a newer Ironside release \(0002_upgrade_probe\)/);
  });
});
