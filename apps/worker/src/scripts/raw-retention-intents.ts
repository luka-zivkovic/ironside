import { createClickHouseClient } from "@ironside/clickhouse";
import { createIngestQueue } from "@ironside/queue";
import { createObjectStorage } from "@ironside/storage";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { prepareRawRetentionIntents } from "../retention/raw-retention-intent-preparer.js";

const projectId = process.env.RAW_RETENTION_PROJECT_ID;
if (!projectId) throw new Error("RAW_RETENTION_PROJECT_ID is required");

const encodedKeys = process.env.RAW_RETENTION_OBJECT_KEYS_JSON;
if (!encodedKeys) throw new Error("RAW_RETENTION_OBJECT_KEYS_JSON is required");
const parsedKeys: unknown = JSON.parse(encodedKeys);
if (!Array.isArray(parsedKeys) || parsedKeys.some((key) => typeof key !== "string")) {
  throw new Error("RAW_RETENTION_OBJECT_KEYS_JSON must be a JSON array of strings");
}

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

try {
  const result = await prepareRawRetentionIntents({
    pool,
    clickhouse,
    storage,
    queue,
    projectId,
    objectKeys: parsedKeys,
    defaultRetentionDays: config.defaultRetentionDays
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await queue.close();
  await pool.end();
  await clickhouse.close();
  storage.close();
}
