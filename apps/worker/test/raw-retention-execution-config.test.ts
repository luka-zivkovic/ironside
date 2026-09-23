import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("raw retention execution configuration", () => {
  it("is enabled by default, and any value other than the literal string true disables it", () => {
    expect(loadConfig({}).rawRetentionExecutionEnabled).toBe(true);
    expect(loadConfig({ RAW_RETENTION_EXECUTION_ENABLED: "true" }).rawRetentionExecutionEnabled).toBe(true);
    expect(loadConfig({ RAW_RETENTION_EXECUTION_ENABLED: "false" }).rawRetentionExecutionEnabled).toBe(false);
    expect(loadConfig({ RAW_RETENTION_EXECUTION_ENABLED: "TRUE" }).rawRetentionExecutionEnabled).toBe(false);
    expect(loadConfig({ RAW_RETENTION_EXECUTION_ENABLED: "1" }).rawRetentionExecutionEnabled).toBe(false);
    expect(loadConfig({ RAW_RETENTION_EXECUTION_ENABLED: "" }).rawRetentionExecutionEnabled).toBe(false);
  });

  it("passes the enabled default through every shipped worker Compose service, overridable without editing the file", async () => {
    const read = (path: string) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
    const workerService = (compose: string) => compose.split("\n  worker:")[1]?.split("\n  web:")[0];

    expect(workerService(await read("docker-compose.yml"))).toContain(
      "RAW_RETENTION_EXECUTION_ENABLED: ${RAW_RETENTION_EXECUTION_ENABLED:-true}"
    );
    expect(workerService(await read("deploy/self-host/compose.yaml"))).toContain(
      "RAW_RETENTION_EXECUTION_ENABLED: ${IRONSIDE_RAW_RETENTION_ENABLED:-true}"
    );
    expect(workerService(await read("deploy/coolify.yaml"))).toContain(
      "RAW_RETENTION_EXECUTION_ENABLED: ${RAW_RETENTION_EXECUTION_ENABLED:-true}"
    );
  });
});
