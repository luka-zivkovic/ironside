import type { ClickHouseClient } from "@ironside/clickhouse";
import type { ObjectStorage } from "@ironside/storage";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { checkHealth } from "../src/health.js";

function mockDeps(overrides: {
  pgOk?: boolean;
  clickhouseOk?: boolean;
  redisOk?: boolean;
  storageOk?: boolean;
}) {
  const pgPool = {
    query: overrides.pgOk === false ? vi.fn().mockRejectedValue(new Error("down")) : vi.fn().mockResolvedValue({})
  } as unknown as Pool;

  const clickhouse = {
    query:
      overrides.clickhouseOk === false
        ? vi.fn().mockRejectedValue(new Error("down"))
        : vi.fn().mockResolvedValue({})
  } as unknown as ClickHouseClient;

  const redis = {
    ping: overrides.redisOk === false ? vi.fn().mockRejectedValue(new Error("down")) : vi.fn().mockResolvedValue("PONG")
  } as unknown as Redis;

  const storage = {
    healthCheck:
      overrides.storageOk === false
        ? vi.fn().mockRejectedValue(new Error("down"))
        : vi.fn().mockResolvedValue(undefined)
  } as unknown as ObjectStorage;

  return { pgPool, clickhouse, redis, storage };
}

describe("checkHealth", () => {
  it("reports ok when all stores respond", async () => {
    const report = await checkHealth(mockDeps({}));
    expect(report).toEqual({
      status: "ok",
      stores: {
        postgres: "ok",
        clickhouse: "ok",
        redis: "ok",
        objectStorage: "ok"
      }
    });
  });

  it("reports error status and pinpoints the failing store", async () => {
    const report = await checkHealth(mockDeps({ storageOk: false }));
    expect(report.status).toBe("error");
    expect(report.stores).toEqual({
      postgres: "ok",
      clickhouse: "ok",
      redis: "ok",
      objectStorage: "error"
    });
  });

  it("does not let one failing store block the others from being checked", async () => {
    const report = await checkHealth(
      mockDeps({ pgOk: false, clickhouseOk: false, redisOk: false, storageOk: false })
    );
    expect(report.stores).toEqual({
      postgres: "error",
      clickhouse: "error",
      redis: "error",
      objectStorage: "error"
    });
  });
});
