import { DuckDBInstance } from "@duckdb/node-api";
import type { ExportTraceRow } from "@ironside/clickhouse";
import { readFile, unlink } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyExportError, writeExportFile } from "../src/exporters/duckdb-writer.js";

// This is the actual M6 DoD verification: write a Parquet file, then read
// it back with a FRESH DuckDB instance (not just trust that "DuckDB wrote
// it, so it must be readable by DuckDB") and confirm exact row count and
// field fidelity, including the nested tags/metadata types DuckDB infers.

function traceRow(overrides: Partial<ExportTraceRow> = {}): ExportTraceRow {
  return {
    id: "trace_1",
    timestamp: "2026-07-12T00:00:00.000Z",
    name: "checkout",
    user_id: "user_1",
    session_id: null,
    tags: ["prod", "checkout"],
    metadata: { plan: "pro" },
    input: JSON.stringify({ q: "hi" }),
    output: JSON.stringify({ a: "there" }),
    last_activity_at: "2026-07-12T00:00:01.000Z",
    ...overrides
  };
}

let writtenFiles: string[] = [];

afterEach(async () => {
  await Promise.all(writtenFiles.map((f) => unlink(f).catch(() => {})));
  writtenFiles = [];
});

async function readBackWithDuckDB(filePath: string, format: "parquet" | "jsonl") {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const readFn = format === "parquet" ? "read_parquet" : "read_ndjson_auto";
    const result = await connection.runAndReadAll(
      `select * from ${readFn}('${filePath.replace(/'/g, "''")}') order by id`
    );
    return result.getRowObjectsJson();
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

describe("writeExportFile — Parquet, verified readable by a fresh DuckDB instance", () => {
  it("round-trips row count and core fields exactly", async () => {
    const rows = [
      traceRow({ id: "trace_1" }),
      traceRow({ id: "trace_2", name: "support", tags: ["support"] }),
      traceRow({ id: "trace_3", name: null, user_id: null, tags: [] })
    ];

    const { filePath, rowCount } = await writeExportFile(rows, "parquet");
    writtenFiles.push(filePath);
    expect(rowCount).toBe(3);

    const readBack = (await readBackWithDuckDB(filePath, "parquet")) as Array<{
      id: string;
      name: string | null;
      tags: string[];
    }>;
    expect(readBack).toHaveLength(3);
    expect(readBack.map((r) => r.id)).toEqual(["trace_1", "trace_2", "trace_3"]);
    expect(readBack[1]?.name).toBe("support");
    expect(readBack[1]?.tags).toEqual(["support"]);
    expect(readBack[2]?.name).toBeNull();
  });

  it("preserves the metadata map and array-typed tags through the Parquet round trip", async () => {
    const rows = [traceRow({ metadata: { plan: "enterprise", region: "us-east" } })];
    const { filePath } = await writeExportFile(rows, "parquet");
    writtenFiles.push(filePath);

    const readBack = (await readBackWithDuckDB(filePath, "parquet")) as Array<{
      metadata: Record<string, string>;
      tags: string[];
    }>;
    expect(readBack[0]?.metadata).toEqual({ plan: "enterprise", region: "us-east" });
    expect(readBack[0]?.tags).toEqual(["prod", "checkout"]);
  });

  it("throws EmptyExportError for a zero-row export instead of producing an unreadable/empty file", async () => {
    await expect(writeExportFile([], "parquet")).rejects.toThrow(EmptyExportError);
  });
});

describe("writeExportFile — JSONL", () => {
  it("writes valid NDJSON readable line-by-line and by DuckDB's own reader", async () => {
    const rows = [traceRow({ id: "trace_1" }), traceRow({ id: "trace_2" })];
    const { filePath, rowCount } = await writeExportFile(rows, "jsonl");
    writtenFiles.push(filePath);
    expect(rowCount).toBe(2);

    const text = await readFile(filePath, "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();

    const readBack = await readBackWithDuckDB(filePath, "jsonl");
    expect(readBack).toHaveLength(2);
  });
});
