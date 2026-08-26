import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("ingest recovery configuration", () => {
  it("parses explicit recovery settings", () => {
    const config = loadConfig({
      INGEST_RECOVERY_INTERVAL_MS: "1234",
      INGEST_RECOVERY_BATCH_SIZE: "57"
    });
    expect(config.ingestRecoveryIntervalMs).toBe(1234);
    expect(config.ingestRecoveryBatchSize).toBe(57);
  });

  it("passes both settings through the standard worker Compose service", async () => {
    const compose = await readFile(new URL("../../../docker-compose.yml", import.meta.url), "utf8");
    const worker = compose.split("\n  worker:")[1]?.split("\n  web:")[0];

    expect(worker).toContain(
      "INGEST_RECOVERY_INTERVAL_MS: ${INGEST_RECOVERY_INTERVAL_MS:-30000}"
    );
    expect(worker).toContain(
      "INGEST_RECOVERY_BATCH_SIZE: ${INGEST_RECOVERY_BATCH_SIZE:-1000}"
    );
  });
});
