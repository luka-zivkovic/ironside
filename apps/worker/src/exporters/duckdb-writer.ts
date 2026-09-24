import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { ExportFormat } from "@ironside/db";
import type { Score } from "@ironside/shared";
import type { ExportedTrace } from "./exported-traces.js";

// Stages exported traces on local disk while a run pages through the feed,
// so memory stays bounded by one page, then produces the files to upload.
//
// - jsonl: native ingest events, one per line — trace-upsert, then that
//   trace's observation-upserts and score-upserts. Bodies are domain objects
//   without projectId, so lines POST straight back to /api/v1/ingest
//   ({"events": [...]}, up to 500 per request) on any Ironside; the API
//   ignores each line's extra traceVersion, which orders snapshots.
// - parquet: one file per table under traces/, observations/, and scores/,
//   so a warehouse external table can point at each folder. Columns use
//   explicit DuckDB types rather than inference, so every run writes the same
//   schema; input/output stay JSON text because they are schemaless.

type Table = "traces" | "observations" | "scores";

const TABLE_COLUMNS: Record<Table, Record<string, string>> = {
  traces: {
    id: "VARCHAR",
    timestamp: "TIMESTAMPTZ",
    name: "VARCHAR",
    user_id: "VARCHAR",
    session_id: "VARCHAR",
    environment: "VARCHAR",
    release: "VARCHAR",
    version: "VARCHAR",
    tags: "VARCHAR[]",
    metadata: "MAP(VARCHAR, VARCHAR)",
    input: "VARCHAR",
    output: "VARCHAR",
    trace_version: "TIMESTAMPTZ"
  },
  observations: {
    id: "VARCHAR",
    trace_id: "VARCHAR",
    parent_observation_id: "VARCHAR",
    type: "VARCHAR",
    name: "VARCHAR",
    start_time: "TIMESTAMPTZ",
    end_time: "TIMESTAMPTZ",
    completion_start_time: "TIMESTAMPTZ",
    level: "VARCHAR",
    status_message: "VARCHAR",
    model: "VARCHAR",
    model_parameters: "MAP(VARCHAR, VARCHAR)",
    input: "VARCHAR",
    output: "VARCHAR",
    // ClickHouse stores usage as UInt64; BIGINT would reject values above 2^63.
    usage_details: "MAP(VARCHAR, UBIGINT)",
    cost_details: "MAP(VARCHAR, DOUBLE)",
    metadata: "MAP(VARCHAR, VARCHAR)",
    trace_version: "TIMESTAMPTZ"
  },
  scores: {
    id: "VARCHAR",
    trace_id: "VARCHAR",
    observation_id: "VARCHAR",
    name: "VARCHAR",
    data_type: "VARCHAR",
    value: "DOUBLE",
    string_value: "VARCHAR",
    source: "VARCHAR",
    comment: "VARCHAR",
    timestamp: "TIMESTAMPTZ",
    metadata: "MAP(VARCHAR, VARCHAR)",
    trace_version: "TIMESTAMPTZ"
  }
};

const TABLES: readonly Table[] = ["traces", "observations", "scores"];

export interface StagedExportFile {
  /** Object name relative to the destination prefix. */
  name: string;
  path: string;
  contentType: string;
}

export class ExportStaging {
  private readonly rowCounts: Record<Table, number> = { traces: 0, observations: 0, scores: 0 };

  private constructor(
    private readonly format: ExportFormat,
    private readonly dir: string
  ) {}

  static async create(format: ExportFormat): Promise<ExportStaging> {
    return new ExportStaging(format, await mkdtemp(join(tmpdir(), "ironside-export-")));
  }

  async append(traces: ExportedTrace[]): Promise<void> {
    if (traces.length === 0) return;
    if (this.format === "jsonl") {
      await appendFile(this.stagedPath("events"), traces.flatMap(ingestEventLines).join(""));
      return;
    }
    const lines: Record<Table, string[]> = { traces: [], observations: [], scores: [] };
    for (const exported of traces) {
      lines.traces.push(jsonLine(traceRow(exported)));
      lines.observations.push(...exported.observations.map((o) => jsonLine(observationRow(o, exported))));
      lines.scores.push(...exported.scores.map((s) => jsonLine(scoreRow(s, exported.traceVersion))));
    }
    for (const table of TABLES) {
      if (lines[table].length === 0) continue;
      await appendFile(this.stagedPath(table), lines[table].join(""));
      this.rowCounts[table] += lines[table].length;
    }
  }

  /** Scores re-sent on their own because they changed after their trace was exported. */
  async appendScores(entries: { scores: Score[]; traceVersion: string }[]): Promise<void> {
    const lines = entries.flatMap(({ scores, traceVersion }) =>
      scores.map((score) =>
        this.format === "jsonl"
          ? jsonLine({ type: "score-upsert", body: withoutProjectId(score), traceVersion })
          : jsonLine(scoreRow(score, traceVersion))
      )
    );
    if (lines.length === 0) return;
    const target = this.format === "jsonl" ? "events" : "scores";
    await appendFile(this.stagedPath(target), lines.join(""));
    if (target === "scores") this.rowCounts.scores += lines.length;
  }

  /** Produces the files to upload; `runName` is unique per run, such as export-<timestamp>. */
  async finish(runName: string): Promise<StagedExportFile[]> {
    if (this.format === "jsonl") {
      return [{ name: `${runName}.jsonl`, path: this.stagedPath("events"), contentType: "application/x-ndjson" }];
    }
    const files: StagedExportFile[] = [];
    const instance = await DuckDBInstance.create(":memory:");
    try {
      const connection = await instance.connect();
      try {
        for (const table of TABLES) {
          if (this.rowCounts[table] === 0) continue;
          const path = join(this.dir, `${table}.parquet`);
          const columns = Object.entries(TABLE_COLUMNS[table])
            .map(([name, type]) => `'${name}': '${type}'`)
            .join(", ");
          await connection.run(
            `copy (select * from read_json('${sqlLiteral(this.stagedPath(table))}',
                     format = 'newline_delimited', columns = {${columns}}))
               to '${sqlLiteral(path)}' (format parquet)`
          );
          files.push({ name: `${table}/${runName}.parquet`, path, contentType: "application/vnd.apache.parquet" });
        }
      } finally {
        connection.disconnectSync();
      }
    } finally {
      instance.closeSync();
    }
    return files;
  }

  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  private stagedPath(name: Table | "events"): string {
    return join(this.dir, name === "events" ? "events.jsonl" : `${name}.ndjson`);
  }
}

function ingestEventLines({ trace, observations, scores, traceVersion }: ExportedTrace): string[] {
  return [
    jsonLine({ type: "trace-upsert", body: withoutProjectId(trace), traceVersion }),
    ...observations.map((o) => jsonLine({ type: "observation-upsert", body: withoutProjectId(o), traceVersion })),
    ...scores.map((s) => jsonLine({ type: "score-upsert", body: withoutProjectId(s), traceVersion }))
  ];
}

function withoutProjectId<Row extends { projectId: string }>(row: Row): Omit<Row, "projectId"> {
  const { projectId: _projectId, ...body } = row;
  return body;
}

function traceRow({ trace, traceVersion }: ExportedTrace): Record<string, unknown> {
  return {
    id: trace.id,
    timestamp: trace.timestamp,
    name: trace.name ?? null,
    user_id: trace.userId ?? null,
    session_id: trace.sessionId ?? null,
    environment: trace.environment ?? null,
    release: trace.release ?? null,
    version: trace.version ?? null,
    tags: trace.tags,
    metadata: trace.metadata,
    input: jsonText(trace.input),
    output: jsonText(trace.output),
    trace_version: traceVersion
  };
}

function observationRow(
  observation: ExportedTrace["observations"][number],
  { traceVersion }: ExportedTrace
): Record<string, unknown> {
  return {
    id: observation.id,
    trace_id: observation.traceId,
    parent_observation_id: observation.parentObservationId ?? null,
    type: observation.type,
    name: observation.name ?? null,
    start_time: observation.startTime,
    end_time: observation.endTime ?? null,
    completion_start_time: observation.completionStartTime ?? null,
    level: observation.level,
    status_message: observation.statusMessage ?? null,
    model: observation.model ?? null,
    model_parameters: Object.fromEntries(
      Object.entries(observation.modelParameters ?? {}).map(([key, value]) => [
        key,
        value === null ? null : String(value)
      ])
    ),
    input: jsonText(observation.input),
    output: jsonText(observation.output),
    usage_details: observation.usageDetails ?? {},
    cost_details: observation.costDetails ?? {},
    metadata: observation.metadata,
    trace_version: traceVersion
  };
}

function scoreRow(score: Score, traceVersion: string): Record<string, unknown> {
  return {
    id: score.id,
    trace_id: score.traceId,
    observation_id: score.observationId ?? null,
    name: score.name,
    data_type: score.dataType,
    value: score.value ?? null,
    string_value: score.stringValue ?? null,
    source: score.source,
    comment: score.comment ?? null,
    timestamp: score.timestamp ?? null,
    metadata: score.metadata,
    trace_version: traceVersion
  };
}

function jsonText(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Paths are server-generated temp paths, never user input; escaping is defense in depth. */
function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
