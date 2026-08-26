import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("raw retention execution configuration", () => {
  it("is disabled by default and accepts only the literal string true", () => {
    expect(loadConfig({}).rawRetentionExecutionEnabled).toBe(false);
    expect(loadConfig({ RAW_RETENTION_EXECUTION_ENABLED: "TRUE" }).rawRetentionExecutionEnabled).toBe(false);
    expect(loadConfig({ RAW_RETENTION_EXECUTION_ENABLED: "1" }).rawRetentionExecutionEnabled).toBe(false);
    expect(loadConfig({ RAW_RETENTION_EXECUTION_ENABLED: "true" }).rawRetentionExecutionEnabled).toBe(true);
  });

  it("passes the disabled default through the standard worker Compose service", async () => {
    const compose = await readFile(new URL("../../../docker-compose.yml", import.meta.url), "utf8");
    const worker = compose.split("\n  worker:")[1]?.split("\n  web:")[0];

    expect(worker).toContain(
      "RAW_RETENTION_EXECUTION_ENABLED: ${RAW_RETENTION_EXECUTION_ENABLED:-false}"
    );
  });
});
