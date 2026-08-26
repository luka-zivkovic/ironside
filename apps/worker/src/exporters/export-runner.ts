import { unlink } from "node:fs/promises";
import { exportTraces, type ClickHouseClient } from "@ironside/clickhouse";
import { recordExportRun, type ExportConfig } from "@ironside/db";
import { createObjectStorage } from "@ironside/storage";
import { traceSettledBefore } from "@ironside/shared";
import type { Pool } from "pg";
import { writeExportFile } from "./duckdb-writer.js";

export interface RunExportOptions {
  pool: Pool;
  clickhouse: ClickHouseClient;
  config: ExportConfig;
  /** Decrypted destination secret key — decrypting is the API layer's job (has the encryption secret); the worker only ever handles a config with this already resolved. */
  destinationSecretAccessKey: string;
  /** Project-effective quiet period used to exclude in-flight traces. */
  traceQuietPeriodSeconds: number;
}

export interface ExportRunResult {
  rowCount: number;
  objectKey: string;
}

/**
 * Runs one export: fetch matching traces from ClickHouse, write them to a
 * local Parquet/JSONL file via DuckDB, upload to the config's destination
 * bucket, record the outcome on the config row. An empty result set (no
 * matching traces) is treated as a successful no-op run, not an error —
 * a filter that currently matches nothing isn't a failure.
 */
export async function runExport(options: RunExportOptions): Promise<ExportRunResult | null> {
  const { pool, clickhouse, config } = options;

  const rows = await exportTraces(clickhouse, {
    projectId: config.projectId,
    ...config.filter,
    settledBefore: traceSettledBefore(options.traceQuietPeriodSeconds)
  });

  if (rows.length === 0) {
    await recordExportRun(pool, config.id, { status: "success", rowCount: 0 });
    return null;
  }

  const { filePath, rowCount } = await writeExportFile(rows, config.format);

  const destination = createObjectStorage({
    endpoint: config.destinationEndpoint,
    region: config.destinationRegion,
    accessKeyId: config.destinationAccessKeyId,
    secretAccessKey: options.destinationSecretAccessKey,
    bucket: config.destinationBucket
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const extension = config.format === "parquet" ? "parquet" : "jsonl";
  const objectKey = `${config.destinationPrefix}${config.destinationPrefix && !config.destinationPrefix.endsWith("/") ? "/" : ""}export-${timestamp}.${extension}`;
  const contentType = config.format === "parquet" ? "application/octet-stream" : "application/x-ndjson";

  try {
    await destination.putFile(objectKey, filePath, contentType);
    await recordExportRun(pool, config.id, { status: "success", rowCount });
    return { rowCount, objectKey };
  } catch (error) {
    await recordExportRun(pool, config.id, {
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    destination.close();
    await unlink(filePath).catch(() => {});
  }
}
