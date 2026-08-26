import { createClickHouseClient } from "@ironside/clickhouse";
import { createObjectStorage } from "@ironside/storage";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { createLifecyclePlan } from "../retention/lifecycle-plan.js";

const config = loadConfig();
const scanLimit = Number(process.env.LIFECYCLE_PLAN_SCAN_LIMIT ?? 100_000);
const projectLimit = Number(process.env.LIFECYCLE_PLAN_PROJECT_LIMIT ?? 1_000);
const projectId = process.env.LIFECYCLE_PLAN_PROJECT_ID;
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);

try {
  const plan = await createLifecyclePlan({
    pool,
    clickhouse,
    storage,
    defaultRetentionDays: config.defaultRetentionDays,
    scanLimit,
    projectLimit,
    ...(projectId && { projectId })
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} finally {
  await pool.end();
  await clickhouse.close();
  storage.close();
}
