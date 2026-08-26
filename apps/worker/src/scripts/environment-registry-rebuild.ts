import { createClickHouseClient, runMigrations as runClickHouseMigrations } from "@ironside/clickhouse";
import {
  claimEnvironmentRegistryRebuild,
  runMigrations as runPostgresMigrations,
  scheduleEnvironmentRegistryRebuild
} from "@ironside/db";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { runEnvironmentRegistryRebuildChunk } from "../environments/environment-registry.js";

const projectId = process.env.ENVIRONMENT_REGISTRY_PROJECT_ID;
if (!projectId) {
  throw new Error("ENVIRONMENT_REGISTRY_PROJECT_ID is required");
}

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);

try {
  await Promise.all([
    runPostgresMigrations(pool),
    runClickHouseMigrations(clickhouse)
  ]);
  await scheduleEnvironmentRegistryRebuild(pool, projectId);

  let chunks = 0;
  let rowsScanned = 0;
  let completed = false;
  while (chunks < 100_000) {
    const claim = await claimEnvironmentRegistryRebuild(pool, projectId);
    if (!claim) throw new Error(`project ${projectId} does not exist`);
    const result = await runEnvironmentRegistryRebuildChunk({ pool, clickhouse, claim });
    chunks += 1;
    rowsScanned += result.rowsScanned;
    if (result.status === "complete") {
      process.stdout.write(
        `${JSON.stringify({ projectId, chunks, rowsScanned, environmentCount: result.environmentCount, overflowed: result.overflowed }, null, 2)}\n`
      );
      completed = true;
      break;
    }
  }
  if (!completed) throw new Error("environment registry rebuild exceeded chunk budget");
} finally {
  await pool.end();
  await clickhouse.close();
}
