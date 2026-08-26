import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("lifecycle planning configuration", () => {
  it("parses the default retention window used by the planner", () => {
    expect(loadConfig({ DEFAULT_RETENTION_DAYS: "45" }).defaultRetentionDays).toBe(45);
  });

  it("passes retention and planner bounds through the standard worker Compose service", async () => {
    const compose = await readFile(new URL("../../../docker-compose.yml", import.meta.url), "utf8");
    const worker = compose.split("\n  worker:")[1]?.split("\n  web:")[0];

    expect(worker).toContain("DEFAULT_RETENTION_DAYS: ${DEFAULT_RETENTION_DAYS:-90}");
    expect(worker).toContain("RETENTION_INTERVAL_MS: ${RETENTION_INTERVAL_MS:-21600000}");
    expect(worker).toContain("LIFECYCLE_PLAN_SCAN_LIMIT: ${LIFECYCLE_PLAN_SCAN_LIMIT:-100000}");
    expect(worker).toContain("LIFECYCLE_PLAN_PROJECT_LIMIT: ${LIFECYCLE_PLAN_PROJECT_LIMIT:-1000}");
    expect(worker).toContain("LIFECYCLE_PLAN_PROJECT_ID: ${LIFECYCLE_PLAN_PROJECT_ID:-}");
  });
});
