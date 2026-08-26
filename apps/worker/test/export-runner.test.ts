import { createClickHouseClient, insertTraces, runMigrations as runChMigrations } from "@ironside/clickhouse";
import { createExportConfig, runMigrations as runPgMigrations } from "@ironside/db";
import { createObjectStorage } from "@ironside/storage";
import { DuckDBInstance } from "@duckdb/node-api";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runExport } from "../src/exporters/export-runner.js";
import { loadConfig } from "../src/config.js";

// End-to-end integration test: real ClickHouse traces -> real DuckDB
// Parquet write -> real MinIO upload -> download back -> real DuckDB read,
// verifying the exact row count survives the full pipeline. This is the
// literal M6 DoD ("output readable by DuckDB with expected row count").

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);
const destination = createObjectStorage({
  endpoint: config.storage.endpoint,
  region: config.storage.region,
  accessKeyId: config.storage.accessKeyId,
  secretAccessKey: config.storage.secretAccessKey,
  bucket: "ironside-export-test"
});

let projectId: string;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await destination.ensureBucket();
  const orgId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "export-runner-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, "export-runner-test"]
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'export-runner-test-org'");
  await pool.end();
  await clickhouse.close();
  destination.close();
});

async function countParquetRows(filePath: string): Promise<number> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const result = await connection.runAndReadAll(
      `select count(*) as n from read_parquet('${filePath.replace(/'/g, "''")}')`
    );
    const rows = result.getRowObjectsJson() as { n: string | number }[];
    return Number(rows[0]?.n ?? 0);
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

describe("runExport", () => {
  it("exports matching traces to Parquet in the destination bucket, verified readable with the exact row count by downloading it back", async () => {
    const marker = `export_e2e_${ulid()}`;
    const traces = Array.from({ length: 4 }, (_, i) => ({
      id: `trace_${marker}_${i}`,
      projectId,
      timestamp: new Date().toISOString(),
      tags: [marker],
      metadata: {}
    }));
    await insertTraces(clickhouse, traces, { eventTs: new Date().toISOString() });

    const exportConfig = await createExportConfig(pool, {
      id: `export_${ulid()}`,
      projectId,
      name: "test export",
      format: "parquet",
      filter: { tags: [marker] },
      destinationBucket: "ironside-export-test",
      destinationEndpoint: config.storage.endpoint,
      destinationRegion: config.storage.region,
      destinationAccessKeyId: config.storage.accessKeyId,
      destinationSecretAccessKeyEncrypted: "unused-in-this-test"
    });

    const result = await runExport({
      pool,
      clickhouse,
      config: exportConfig,
      destinationSecretAccessKey: config.storage.secretAccessKey,
      traceQuietPeriodSeconds: 0
    });

    expect(result?.rowCount).toBe(4);
    expect(result?.objectKey).toMatch(/^export-.*\.parquet$/);

    // Download the uploaded object and verify it's genuinely readable by
    // DuckDB with the exact row count — not just trusting the writer.
    // Parquet is binary, so a raw S3 client (not ObjectStorage.getJson,
    // which assumes JSON text) fetches the bytes for this verification.
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const rawClient = new S3Client({
      endpoint: config.storage.endpoint,
      region: config.storage.region,
      credentials: {
        accessKeyId: config.storage.accessKeyId,
        secretAccessKey: config.storage.secretAccessKey
      },
      forcePathStyle: true
    });
    const object = await rawClient.send(
      new GetObjectCommand({ Bucket: "ironside-export-test", Key: result!.objectKey })
    );
    const bytes = await object.Body?.transformToByteArray();
    expect(bytes).toBeDefined();
    const localPath = path.join(os.tmpdir(), `verify-${ulid()}.parquet`);
    await fs.writeFile(localPath, Buffer.from(bytes!));
    const rowCount = await countParquetRows(localPath);
    expect(rowCount).toBe(4);
    await fs.unlink(localPath);
    rawClient.destroy();
  });

  it("a filter matching zero traces is a successful no-op, not an error", async () => {
    const exportConfig = await createExportConfig(pool, {
      id: `export_${ulid()}`,
      projectId,
      name: "empty export",
      format: "jsonl",
      filter: { tags: ["__no_such_tag__"] },
      destinationBucket: "ironside-export-test",
      destinationEndpoint: config.storage.endpoint,
      destinationRegion: config.storage.region,
      destinationAccessKeyId: config.storage.accessKeyId,
      destinationSecretAccessKeyEncrypted: "unused-in-this-test"
    });

    const result = await runExport({
      pool,
      clickhouse,
      config: exportConfig,
      destinationSecretAccessKey: config.storage.secretAccessKey,
      traceQuietPeriodSeconds: 0
    });
    expect(result).toBeNull();
  });
});
