import { serve } from "@hono/node-server";
import { createClickHouseClient, runMigrations as runClickHouseMigrations } from "@ironside/clickhouse";
import { runMigrations as runPgMigrations } from "@ironside/db";
import { createIngestQueue } from "@ironside/queue";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

const pgPool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

await runPgMigrations(pgPool);
await runClickHouseMigrations(clickhouse);
await storage.ensureBucket();

const app = createApp({
  pgPool,
  clickhouse,
  redis,
  storage,
  queue,
  webOrigins: config.webOrigins,
  authSecureCookies: config.authSecureCookies,
  authSessionIdleTtlSeconds: config.authSessionIdleTtlSeconds,
  authSessionAbsoluteTtlSeconds: config.authSessionAbsoluteTtlSeconds,
  authRateLimitPerWindow: config.authRateLimitPerWindow,
  authTrustProxy: config.authTrustProxy,
  defaultRateLimitPerMinute: config.defaultRateLimitPerMinute,
  defaultTraceQuietPeriodSeconds: config.defaultTraceQuietPeriodSeconds,
  metricsToken: config.metricsToken
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`ironside-api listening on :${info.port}`);
});
