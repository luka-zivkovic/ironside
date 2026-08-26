import type { ClickHouseClient } from "@ironside/clickhouse";
import type { ObjectStorage } from "@ironside/storage";
import type { Queue } from "bullmq";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { executeRawRetentionIntents } from "../src/retention/raw-retention-intent-executor.js";

const forbidden = new Proxy(
  {},
  {
    get() {
      throw new Error("a disabled executor touched a dependency");
    }
  }
);

function options() {
  return {
    pool: forbidden as Pool,
    clickhouse: forbidden as ClickHouseClient,
    storage: forbidden as ObjectStorage,
    queue: forbidden as Queue,
    projectId: "proj_1",
    intentIds: ["rti_1"],
    defaultRetentionDays: 90,
    executionEnabled: false,
    confirmation: "missing" as const
  };
}

describe("raw retention intent executor gates", () => {
  it("touches no dependency while the shipped feature flag is disabled", async () => {
    await expect(executeRawRetentionIntents(options())).rejects.toThrow(
      "raw retention execution is disabled"
    );
  });

  it("still requires the explicit execute confirmation after feature enablement", async () => {
    await expect(
      executeRawRetentionIntents({ ...options(), executionEnabled: true })
    ).rejects.toThrow("requires the explicit --execute flag");
  });
});
