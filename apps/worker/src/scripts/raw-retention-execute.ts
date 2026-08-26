import { createClickHouseClient } from "@ironside/clickhouse";
import { createIngestQueue } from "@ironside/queue";
import { createObjectStorage } from "@ironside/storage";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { executeRawRetentionIntents } from "../retention/raw-retention-intent-executor.js";

const projectId = process.env.RAW_RETENTION_PROJECT_ID;
if (!projectId) throw new Error("RAW_RETENTION_PROJECT_ID is required");

const encodedIntentIds = process.env.RAW_RETENTION_INTENT_IDS_JSON;
if (!encodedIntentIds) throw new Error("RAW_RETENTION_INTENT_IDS_JSON is required");
const parsedIntentIds: unknown = JSON.parse(encodedIntentIds);
if (
  !Array.isArray(parsedIntentIds) ||
  parsedIntentIds.some((intentId) => typeof intentId !== "string")
) {
  throw new Error("RAW_RETENTION_INTENT_IDS_JSON must be a JSON array of strings");
}

const config = loadConfig();
if (!config.rawRetentionExecutionEnabled) {
  throw new Error("RAW_RETENTION_EXECUTION_ENABLED must be exactly true");
}
const confirmation = process.argv.includes("--execute") ? "execute" : "missing";
if (confirmation !== "execute") {
  throw new Error("raw retention execution requires the explicit --execute flag");
}

const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

try {
  const result = await executeRawRetentionIntents({
    pool,
    clickhouse,
    storage,
    queue,
    projectId,
    intentIds: parsedIntentIds,
    defaultRetentionDays: config.defaultRetentionDays,
    executionEnabled: config.rawRetentionExecutionEnabled,
    confirmation
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.lockAcquired || result.blocked.length > 0) process.exitCode = 2;
} finally {
  await queue.close();
  await pool.end();
  await clickhouse.close();
  storage.close();
}
