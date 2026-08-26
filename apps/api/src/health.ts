import type { ClickHouseClient } from "@ironside/clickhouse";
import type { ObjectStorage } from "@ironside/storage";
import type { Redis } from "ioredis";
import type { Pool } from "pg";

export type StoreStatus = "ok" | "error";

export interface HealthReport {
  status: StoreStatus;
  stores: {
    postgres: StoreStatus;
    clickhouse: StoreStatus;
    redis: StoreStatus;
    objectStorage: StoreStatus;
  };
}

export interface HealthDeps {
  pgPool: Pool;
  clickhouse: ClickHouseClient;
  redis: Redis;
  storage: ObjectStorage;
}

async function checkStore(check: () => Promise<unknown>): Promise<StoreStatus> {
  try {
    await check();
    return "ok";
  } catch {
    return "error";
  }
}

export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  const [postgres, clickhouse, redis, objectStorage] = await Promise.all([
    checkStore(() => deps.pgPool.query("select 1")),
    checkStore(() => deps.clickhouse.query({ query: "select 1", format: "JSONEachRow" })),
    checkStore(() => deps.redis.ping()),
    checkStore(() => deps.storage.healthCheck())
  ]);

  const stores = { postgres, clickhouse, redis, objectStorage };
  const status: StoreStatus = Object.values(stores).every((s) => s === "ok")
    ? "ok"
    : "error";

  return { status, stores };
}
