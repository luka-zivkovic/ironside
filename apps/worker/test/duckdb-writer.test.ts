import { readFile } from "node:fs/promises";
import { DuckDBInstance } from "@duckdb/node-api";
import { mapNativeEvents } from "@ironside/mappers";
import { INGEST_SCHEMA_VERSION, type IngestEvent } from "@ironside/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ExportStaging } from "../src/exporters/duckdb-writer.js";
import type { ExportedTrace } from "../src/exporters/exported-traces.js";

// Files are read back with a fresh DuckDB instance or the real ingest mapper
// rather than trusting the writer.

function exportedTrace(id: string, overrides: Partial<ExportedTrace> = {}): ExportedTrace {
  return {
    trace: {
      id,
      projectId: "proj_export",
      timestamp: "2026-09-23T10:00:00.000Z",
      name: "checkout",
      userId: "user_1",
      environment: "production",
      tags: ["prod", "checkout"],
      metadata: { plan: "pro" },
      input: { question: "hi" },
      output: { answer: "hello" }
    },
    observations: [
      {
        id: `${id}_gen`,
        traceId: id,
        projectId: "proj_export",
        type: "generation",
        name: "llm-call",
        startTime: "2026-09-23T10:00:00.100Z",
        endTime: "2026-09-23T10:00:03.000Z",
        level: "default",
        model: "gpt-4o",
        modelParameters: { temperature: "0.2" },
        input: [{ role: "user", content: "hi" }],
        output: { text: "hello" },
        usageDetails: { input_tokens: 5, output_tokens: 2 },
        costDetails: { input: 0.0000125, output: 0.00002, total: 0.0000325 },
        metadata: { "ironside:cost_source": "table" }
      }
    ],
    scores: [
      {
        id: `${id}_score`,
        projectId: "proj_export",
        traceId: id,
        name: "helpful",
        dataType: "numeric",
        value: 1,
        source: "api",
        timestamp: "2026-09-23T10:00:04.000Z",
        metadata: {}
      }
    ],
    traceVersion: "2026-09-23T10:00:03.500Z",
    ...overrides
  };
}

const stagings: ExportStaging[] = [];
afterEach(async () => {
  await Promise.all(stagings.splice(0).map((staging) => staging.cleanup()));
});

async function staging(format: "jsonl" | "parquet"): Promise<ExportStaging> {
  const created = await ExportStaging.create(format);
  stagings.push(created);
  return created;
}

async function query(sql: string): Promise<Record<string, unknown>[]> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    return (await connection.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

describe("ExportStaging — JSONL", () => {
  it("writes native ingest events that map back to the exported traces unchanged", async () => {
    const first = exportedTrace("trace_a");
    const second = exportedTrace("trace_b", { scores: [] });
    const jsonl = await staging("jsonl");
    await jsonl.append([first]);
    await jsonl.append([second]);
    const [file] = await jsonl.finish("export-run");

    expect(file?.name).toBe("export-run.jsonl");
    const lines = (await readFile(file!.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual([
      "trace-upsert",
      "observation-upsert",
      "score-upsert",
      "trace-upsert",
      "observation-upsert"
    ]);
    expect(lines.every((line) => !("projectId" in line.body))).toBe(true);

    // Replaying the file into a project goes through the same mapper as
    // POST /api/v1/ingest.
    const events: IngestEvent[] = lines.map((line, index) => ({
      id: `evt_${index}`,
      type: line.type,
      source: "native",
      schemaVersion: INGEST_SCHEMA_VERSION,
      idempotencyKey: `key_${index}`,
      body: line.body
    }));
    const { rows, errors } = mapNativeEvents("proj_export", events);
    expect(errors).toEqual([]);
    expect(rows.traces).toEqual([first.trace, second.trace]);
    expect(rows.observations).toEqual([...first.observations, ...second.observations]);
    expect(rows.scores).toEqual(first.scores);
  });
});

describe("ExportStaging — Parquet", () => {
  it("writes one file per table under its own folder, with explicit column types", async () => {
    const parquet = await staging("parquet");
    await parquet.append([exportedTrace("trace_a"), exportedTrace("trace_b")]);
    const files = await parquet.finish("export-run");

    expect(files.map((file) => file.name)).toEqual([
      "traces/export-run.parquet",
      "observations/export-run.parquet",
      "scores/export-run.parquet"
    ]);
    const [traces, observations] = files;
    const traceTypes = await query(`describe select * from read_parquet('${traces!.path}')`);
    expect(Object.fromEntries(traceTypes.map((row) => [row.column_name, row.column_type]))).toMatchObject({
      timestamp: "TIMESTAMP WITH TIME ZONE",
      tags: "VARCHAR[]",
      metadata: "MAP(VARCHAR, VARCHAR)",
      input: "VARCHAR",
      trace_version: "TIMESTAMP WITH TIME ZONE"
    });
    const observationTypes = await query(`describe select * from read_parquet('${observations!.path}')`);
    expect(Object.fromEntries(observationTypes.map((row) => [row.column_name, row.column_type]))).toMatchObject({
      usage_details: "MAP(VARCHAR, BIGINT)",
      cost_details: "MAP(VARCHAR, DOUBLE)",
      model_parameters: "MAP(VARCHAR, VARCHAR)"
    });
  });

  it("round-trips values, including map lookups and UTC timestamps", async () => {
    const parquet = await staging("parquet");
    await parquet.append([exportedTrace("trace_a")]);
    const [traces, observations, scores] = await parquet.finish("export-run");

    expect(
      await query(`
        select id, metadata['plan'] as plan, tags, input,
               strftime(timestamp at time zone 'UTC', '%Y-%m-%dT%H:%M:%S.%g') as ts
        from read_parquet('${traces!.path}')`)
    ).toEqual([
      { id: "trace_a", plan: "pro", tags: ["prod", "checkout"], input: '{"question":"hi"}', ts: "2026-09-23T10:00:00.000" }
    ]);
    expect(
      await query(`
        select trace_id, usage_details['input_tokens'] as input_tokens,
               cost_details['total'] as total_cost, model
        from read_parquet('${observations!.path}')`)
    ).toEqual([{ trace_id: "trace_a", input_tokens: "5", total_cost: 0.0000325, model: "gpt-4o" }]);
    expect(await query(`select count(*) as n from read_parquet('${scores!.path}')`)).toEqual([{ n: "1" }]);
  });

  it("keeps the same schema when every map in a run is empty, and skips a table with no rows", async () => {
    const parquet = await staging("parquet");
    const bare = exportedTrace("trace_a", { scores: [] });
    bare.trace.metadata = {};
    bare.observations = bare.observations.map((observation) => ({ ...observation, metadata: {} }));
    await parquet.append([bare]);
    const files = await parquet.finish("export-run");

    expect(files.map((file) => file.name)).toEqual([
      "traces/export-run.parquet",
      "observations/export-run.parquet"
    ]);
    const types = await query(`describe select * from read_parquet('${files[0]!.path}')`);
    expect(types.find((row) => row.column_name === "metadata")?.column_type).toBe("MAP(VARCHAR, VARCHAR)");
  });
});
