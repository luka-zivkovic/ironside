import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { ExportTraceRow } from "@ironside/clickhouse";
import type { ExportFormat } from "@ironside/db";

// Writes trace rows to a local Parquet or JSONL file via DuckDB. Verified
// against @duckdb/node-api@1.5.4-r.1's documented pattern: DuckDB has no
// direct "insert array of JS objects" API, so rows are staged as an NDJSON
// temp file and loaded with read_ndjson_auto(), which natively infers
// nested types (tags array, metadata map) — this sidesteps hand-authoring
// a Parquet schema for those fields entirely. DuckDB's own Parquet writer
// is the reference implementation, so "readable by DuckDB afterward" (the
// M6 DoD) is trivially satisfied by construction.
//
// input/output are stored as JSON strings in ClickHouse already
// (packages/clickhouse inserts them via JSON.stringify); passed through
// as-is rather than re-parsed, so the export file's input/output columns
// contain the original JSON text, not a DuckDB-inferred nested structure
// (deliberate: those fields are arbitrary/schemaless, unlike tags/metadata).

export interface WriteExportFileResult {
  /** Local filesystem path of the written file; caller uploads and cleans it up. */
  filePath: string;
  rowCount: number;
}

/** Thrown when there are zero matching rows — read_ndjson_auto has no schema to infer from an empty file, and an empty export isn't a real failure the caller should retry. */
export class EmptyExportError extends Error {
  constructor() {
    super("no rows matched the export filter");
    this.name = "EmptyExportError";
  }
}

export async function writeExportFile(
  rows: ExportTraceRow[],
  format: ExportFormat
): Promise<WriteExportFileResult> {
  if (rows.length === 0) {
    throw new EmptyExportError();
  }

  const runId = randomUUID();
  const ndjsonPath = join(tmpdir(), `ironside-export-${runId}.ndjson`);
  const outputPath = join(
    tmpdir(),
    `ironside-export-${runId}.${format === "parquet" ? "parquet" : "jsonl"}`
  );

  await writeFile(ndjsonPath, rows.map((row) => JSON.stringify(row)).join("\n"));

  // instance/connection creation is inside the try too — if either throws
  // (native binding failure, DuckDB init issue), the finally below must
  // still run to delete the NDJSON temp file written above, or a
  // persistent failure mode leaks one temp file per export invocation.
  type DuckDBInstanceHandle = Awaited<ReturnType<typeof DuckDBInstance.create>>;
  type DuckDBConnectionHandle = Awaited<ReturnType<DuckDBInstanceHandle["connect"]>>;
  let instance: DuckDBInstanceHandle | undefined;
  let connection: DuckDBConnectionHandle | undefined;
  try {
    instance = await DuckDBInstance.create(":memory:");
    connection = await instance.connect();
    await connection.run(
      `create table export_rows as select * from read_ndjson_auto('${escapeSqlLiteral(ndjsonPath)}')`
    );
    if (format === "parquet") {
      await connection.run(
        `copy export_rows to '${escapeSqlLiteral(outputPath)}' (format parquet)`
      );
    } else {
      await connection.run(
        `copy export_rows to '${escapeSqlLiteral(outputPath)}' (format json, array false)`
      );
    }
  } finally {
    connection?.disconnectSync();
    instance?.closeSync();
    await unlink(ndjsonPath).catch(() => {});
  }

  return { filePath: outputPath, rowCount: rows.length };
}

/** Rows never contain attacker-controlled SQL (they're written via a params-free path relying on file paths only), but the temp path itself is server-generated from randomUUID(), not user input — this exists as defense in depth against a single-quote appearing in an unexpected path. */
function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
