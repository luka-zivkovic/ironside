import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DuckDBInstance } from "@duckdb/node-api";
import { createClickHouseClient, runMigrations as runChMigrations } from "@ironside/clickhouse";
import {
  createExportConfig,
  getExportConfig,
  recordExportRun,
  runMigrations as runPgMigrations,
  type ExportConfig,
  type ExportFilter,
  type ExportFormat
} from "@ironside/db";
import type { Observation, Trace } from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runExport } from "../src/exporters/export-runner.js";
import { insertPublishedScores, insertPublishedTrace } from "./support/published-traces.js";

// End-to-end: traces published to the durable feed -> runExport -> real
// DuckDB/JSONL files -> real MinIO upload -> downloaded back and read with a
// fresh DuckDB instance, not trusted from the writer.

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);
const BUCKET = "ironside-export-test";
const destination = createObjectStorage({
  endpoint: config.storage.endpoint,
  region: config.storage.region,
  accessKeyId: config.storage.accessKeyId,
  secretAccessKey: config.storage.secretAccessKey,
  bucket: BUCKET
});
const s3 = new S3Client({
  endpoint: config.storage.endpoint,
  region: config.storage.region,
  credentials: { accessKeyId: config.storage.accessKeyId, secretAccessKey: config.storage.secretAccessKey },
  forcePathStyle: true
});
const ORG_NAME = "export-runner-test-org";
let orgId: string;
let scratchDir: string;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await destination.ensureBucket();
  orgId = `org_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [orgId, ORG_NAME]);
  scratchDir = await mkdtemp(join(tmpdir(), "export-runner-test-"));
});

afterAll(async () => {
  await pool.query("delete from organizations where name = $1", [ORG_NAME]);
  await pool.end();
  await clickhouse.close();
  destination.close();
  s3.destroy();
  await rm(scratchDir, { recursive: true, force: true });
});

/** Each test gets its own project, and so its own feed. */
async function newProject(): Promise<string> {
  const projectId = `proj_${ulid()}`;
  await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
    projectId,
    orgId,
    "export-runner-test"
  ]);
  return projectId;
}

async function newExportConfig(
  projectId: string,
  options: { format?: ExportFormat; filter?: ExportFilter; accessKeyId?: string } = {}
): Promise<ExportConfig> {
  return createExportConfig(pool, {
    id: `export_${ulid()}`,
    projectId,
    name: "test export",
    format: options.format ?? "parquet",
    filter: options.filter ?? {},
    destinationBucket: BUCKET,
    destinationPrefix: `runs/${projectId}`,
    destinationEndpoint: config.storage.endpoint,
    destinationRegion: config.storage.region,
    destinationAccessKeyId: options.accessKeyId ?? config.storage.accessKeyId,
    destinationSecretAccessKeyEncrypted: "unused-in-this-test"
  });
}

async function run(exportConfig: ExportConfig, quietPeriodSeconds = 0) {
  const current = (await getExportConfig(pool, exportConfig.projectId, exportConfig.id))!;
  return runExport({
    pool,
    clickhouse,
    config: current,
    destinationSecretAccessKey: config.storage.secretAccessKey,
    traceQuietPeriodSeconds: quietPeriodSeconds
  });
}

function trace(projectId: string, id: string, overrides: Partial<Trace> = {}): Trace {
  return {
    id,
    projectId,
    timestamp: "2026-09-23T10:00:00.000Z",
    name: "checkout",
    tags: [],
    metadata: {},
    input: { question: "hi" },
    ...overrides
  };
}

function generation(projectId: string, traceId: string, id: string): Observation {
  return {
    id,
    traceId,
    projectId,
    type: "generation",
    name: "llm-call",
    model: "gpt-4o",
    startTime: "2026-09-23T10:00:00.100Z",
    endTime: "2026-09-23T10:00:01.000Z",
    level: "default",
    usageDetails: { input_tokens: 5, output_tokens: 2 },
    metadata: {}
  };
}

async function download(key: string): Promise<string> {
  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const path = join(scratchDir, `${ulid()}-${key.split("/").pop()}`);
  await writeFile(path, Buffer.from(await object.Body!.transformToByteArray()));
  return path;
}

async function parquetRows(key: string, sql: string): Promise<Record<string, unknown>[]> {
  const path = await download(key);
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    return (
      await connection.runAndReadAll(sql.replace("{file}", `read_parquet('${path}')`))
    ).getRowObjectsJson() as Record<string, unknown>[];
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

describe("runExport", () => {
  it("exports complete traces as one Parquet file per table and records its feed position", async () => {
    const projectId = await newProject();
    for (let i = 0; i < 3; i += 1) {
      const traceId = `trace_${ulid()}`;
      await insertPublishedTrace(
        { pool, clickhouse },
        {
          trace: trace(projectId, traceId),
          observations: [generation(projectId, traceId, `gen_${ulid()}`)],
          scores: [
            {
              id: `score_${ulid()}`,
              projectId,
              traceId,
              name: "helpful",
              dataType: "numeric",
              value: 1,
              source: "api",
              timestamp: "2026-09-23T10:00:02.000Z",
              metadata: {}
            }
          ]
        }
      );
    }
    const exportConfig = await newExportConfig(projectId);

    const result = await run(exportConfig);

    expect(result?.rowCount).toBe(3);
    const keys = result!.objectKeys;
    expect(keys.map((key) => key.replace(/export-[^/]+\.parquet$/, "*"))).toEqual([
      `runs/${projectId}/traces/*`,
      `runs/${projectId}/observations/*`,
      `runs/${projectId}/scores/*`
    ]);
    expect(await parquetRows(keys[0]!, "select count(*) as n from {file}")).toEqual([{ n: "3" }]);
    expect(await parquetRows(keys[1]!, "select count(*) as n, min(model) as model from {file}")).toEqual([
      { n: "3", model: "gpt-4o" }
    ]);
    expect(await parquetRows(keys[2]!, "select count(*) as n from {file}")).toEqual([{ n: "3" }]);
    const recorded = await getExportConfig(pool, projectId, exportConfig.id);
    expect(recorded).toMatchObject({ lastRunStatus: "success", lastRunRowCount: 3 });
    expect(recorded?.feedCursor).not.toBeNull();
  });

  it("exports only traces published since the previous run", async () => {
    const projectId = await newProject();
    await insertPublishedTrace({ pool, clickhouse }, { trace: trace(projectId, `trace_${ulid()}`) });
    const exportConfig = await newExportConfig(projectId, { format: "jsonl" });
    expect((await run(exportConfig))?.rowCount).toBe(1);

    expect(await run(exportConfig)).toBeNull();

    const laterId = `trace_${ulid()}`;
    await insertPublishedTrace({ pool, clickhouse }, { trace: trace(projectId, laterId) });
    const result = await run(exportConfig);
    expect(result?.rowCount).toBe(1);
    const lines = (await (await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: result!.objectKeys[0]! })
    )).Body!.transformToString()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { type: "trace-upsert", body: expect.objectContaining({ id: laterId }), traceVersion: expect.any(String) }
    ]);
  });

  it("exports a trace again, as a higher version, when it gets new activity", async () => {
    const projectId = await newProject();
    const traceId = `trace_${ulid()}`;
    await insertPublishedTrace(
      { pool, clickhouse },
      { trace: trace(projectId, traceId), receivedAt: new Date(Date.now() - 60_000).toISOString() }
    );
    const exportConfig = await newExportConfig(projectId);
    const first = await run(exportConfig);

    await insertPublishedTrace(
      { pool, clickhouse },
      { trace: trace(projectId, traceId, { output: { answer: "later" } }) }
    );
    const second = await run(exportConfig);

    expect(second?.rowCount).toBe(1);
    const versionSql = "select id, output, epoch_us(trace_version) as version from {file}";
    const [before] = await parquetRows(first!.objectKeys[0]!, versionSql);
    const [after] = await parquetRows(second!.objectKeys[0]!, versionSql);
    expect(after).toMatchObject({ id: traceId, output: '{"answer":"later"}' });
    expect(BigInt(after!.version as string) > BigInt(before!.version as string)).toBe(true);
  });

  it("gives a late batch's re-export a higher version even though its receive time is older", async () => {
    const projectId = await newProject();
    const traceId = `trace_${ulid()}`;
    await insertPublishedTrace({ pool, clickhouse }, { trace: trace(projectId, traceId) });
    const exportConfig = await newExportConfig(projectId);
    const first = await run(exportConfig);

    // Received before the first batch, but written after it was exported.
    await insertPublishedTrace(
      { pool, clickhouse },
      {
        trace: trace(projectId, traceId),
        observations: [generation(projectId, traceId, `gen_${ulid()}`)],
        receivedAt: new Date(Date.now() - 3_600_000).toISOString()
      }
    );
    const second = await run(exportConfig);

    const versionSql = "select epoch_us(trace_version) as version from {file}";
    const [before] = await parquetRows(first!.objectKeys[0]!, versionSql);
    const [after] = await parquetRows(second!.objectKeys[0]!, versionSql);
    expect(BigInt(after!.version as string) > BigInt(before!.version as string)).toBe(true);
    const observationsKey = second!.objectKeys.find((key) => key.includes("/observations/"))!;
    expect(await parquetRows(observationsKey, "select count(*) as n from {file}")).toEqual([{ n: "1" }]);
  });

  it("sends a score added after its trace was exported, without re-sending the trace", async () => {
    const projectId = await newProject();
    const traceId = `trace_${ulid()}`;
    await insertPublishedTrace({ pool, clickhouse }, { trace: trace(projectId, traceId) });
    const exportConfig = await newExportConfig(projectId, { format: "jsonl" });
    await run(exportConfig);

    const scoreId = `score_${ulid()}`;
    await insertPublishedScores(
      { pool, clickhouse },
      {
        projectId,
        scores: [
          {
            id: scoreId,
            projectId,
            traceId,
            name: "evaluator-verdict",
            dataType: "numeric",
            value: 0.8,
            source: "eval",
            timestamp: new Date().toISOString(),
            metadata: {}
          }
        ]
      }
    );
    const result = await run(exportConfig);

    expect(result?.rowCount).toBe(1);
    const lines = (await (await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: result!.objectKeys[0]! })
    )).Body!.transformToString()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      {
        type: "score-upsert",
        body: expect.objectContaining({ id: scoreId, traceId, value: 0.8 }),
        traceVersion: expect.any(String)
      }
    ]);
    expect(await run(exportConfig)).toBeNull();
  });

  it("does not move a feed position back when a slower duplicate run records after a newer one", async () => {
    const projectId = await newProject();
    await insertPublishedTrace({ pool, clickhouse }, { trace: trace(projectId, `trace_${ulid()}`) });
    const exportConfig = await newExportConfig(projectId);
    await run(exportConfig);
    const advanced = (await getExportConfig(pool, projectId, exportConfig.id))!.feedCursor;

    // A second replica that claimed the same config earlier, starting from
    // the original position, finishes later with an older position.
    await recordExportRun(pool, exportConfig.id, {
      status: "success",
      rowCount: 0,
      feedCursor: { from: null, to: { publishedAt: "2000-01-01T00:00:00.000000Z", traceId: "stale" } }
    });

    expect((await getExportConfig(pool, projectId, exportConfig.id))?.feedCursor).toEqual(advanced);
  });

  it("still exports a batch the worker wrote after the previous run had passed its receive time", async () => {
    const projectId = await newProject();
    await insertPublishedTrace({ pool, clickhouse }, { trace: trace(projectId, `trace_${ulid()}`) });
    const exportConfig = await newExportConfig(projectId);
    await run(exportConfig);

    // Received an hour ago but only written now, as after a queue backlog or
    // a Redis job recovered by the reconciler.
    const lateId = `trace_${ulid()}`;
    await insertPublishedTrace(
      { pool, clickhouse },
      { trace: trace(projectId, lateId), receivedAt: new Date(Date.now() - 3_600_000).toISOString() }
    );
    const result = await run(exportConfig);

    expect(result?.rowCount).toBe(1);
    expect(await parquetRows(result!.objectKeys[0]!, "select id from {file}")).toEqual([{ id: lateId }]);
  });

  it("keeps its feed position when the upload fails, so the next run sends the same traces", async () => {
    const projectId = await newProject();
    await insertPublishedTrace({ pool, clickhouse }, { trace: trace(projectId, `trace_${ulid()}`) });
    const failing = await newExportConfig(projectId, { accessKeyId: "wrong-key" });

    await expect(run(failing)).rejects.toThrow();

    const recorded = await getExportConfig(pool, projectId, failing.id);
    expect(recorded).toMatchObject({ lastRunStatus: "error", feedCursor: null });
  });

  it("advances past traces its filter does not match, without writing a file", async () => {
    const projectId = await newProject();
    await insertPublishedTrace(
      { pool, clickhouse },
      { trace: trace(projectId, `trace_${ulid()}`, { tags: ["other"] }) }
    );
    const exportConfig = await newExportConfig(projectId, { filter: { tags: ["wanted"] } });

    expect(await run(exportConfig)).toBeNull();

    const recorded = await getExportConfig(pool, projectId, exportConfig.id);
    expect(recorded).toMatchObject({ lastRunStatus: "success", lastRunRowCount: 0 });
    expect(recorded?.feedCursor).not.toBeNull();
  });

  it("waits for a trace still inside its quiet period instead of skipping it", async () => {
    const projectId = await newProject();
    const traceId = `trace_${ulid()}`;
    await insertPublishedTrace({ pool, clickhouse }, { trace: trace(projectId, traceId) });
    const exportConfig = await newExportConfig(projectId);

    expect(await run(exportConfig, 3_600)).toBeNull();
    expect((await getExportConfig(pool, projectId, exportConfig.id))?.feedCursor).toBeNull();

    const result = await run(exportConfig, 0);
    expect(await parquetRows(result!.objectKeys[0]!, "select id from {file}")).toEqual([{ id: traceId }]);
  });
});
