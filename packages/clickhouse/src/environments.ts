import type { ClickHouseClient } from "@clickhouse/client";
import { normalizeEnvironment } from "@ironside/shared";
import { fromClickHouseDateTime, toClickHouseDateTime } from "./datetime.js";

export interface EnvironmentScanCursor {
  timestamp: string;
  id: string;
}

export interface EnvironmentTracePage {
  environments: string[];
  nextCursor: EnvironmentScanCursor | null;
  exhausted: boolean;
  rowsScanned: number;
}

interface EnvironmentTraceRow {
  id: string;
  timestamp: string;
  environment: string | null;
}

/**
 * One bounded keyset page for the exceptional rebuild lane. This avoids a
 * high-cardinality DISTINCT/GROUP BY over attacker-controlled values.
 */
export async function scanEnvironmentTracePage(
  client: ClickHouseClient,
  input: {
    projectId: string;
    pageSize: number;
    cursor?: EnvironmentScanCursor;
  }
): Promise<EnvironmentTracePage> {
  const result = await client.query({
    query: `
      select id, timestamp, environment
      from traces final
      where project_id = {projectId:String}
        and environment is not null
        ${input.cursor ? "and (timestamp, id) < ({cursorTimestamp:DateTime64(3)}, {cursorId:String})" : ""}
      order by timestamp desc, id desc
      limit {pageSize:UInt32}
    `,
    query_params: {
      projectId: input.projectId,
      pageSize: input.pageSize,
      ...(input.cursor && {
        cursorTimestamp: toClickHouseDateTime(input.cursor.timestamp),
        cursorId: input.cursor.id
      })
    },
    clickhouse_settings: {
      max_execution_time: 30,
      max_threads: 2,
      max_result_rows: String(input.pageSize),
      result_overflow_mode: "throw"
    },
    format: "JSONEachRow"
  });
  const rows = await result.json<EnvironmentTraceRow>();
  const environments: string[] = [];
  for (const row of rows) {
    const normalized = normalizeEnvironment(row.environment);
    // Forward-only normalization: never pretend an old noncanonical stored
    // value can be queried by its canonical spelling.
    if (normalized !== null && normalized === row.environment) environments.push(normalized);
  }
  const last = rows.at(-1);
  return {
    environments,
    nextCursor:
      last && rows.length === input.pageSize
        ? { timestamp: fromClickHouseDateTime(last.timestamp), id: last.id }
        : null,
    exhausted: rows.length < input.pageSize,
    rowsScanned: rows.length
  };
}

export interface RetainedEnvironmentStats {
  name: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface EnvironmentStatsRow {
  environment: string;
  first_seen_at: string;
  last_seen_at: string;
}

/** Exact retained-trace timestamps for an already bounded candidate set. */
export async function getRetainedEnvironmentStats(
  client: ClickHouseClient,
  projectId: string,
  environments: string[]
): Promise<RetainedEnvironmentStats[]> {
  if (environments.length === 0) return [];
  const result = await client.query({
    query: `
      select environment, min(timestamp) as first_seen_at, max(timestamp) as last_seen_at
      from traces final
      where project_id = {projectId:String}
        and environment in {environments:Array(String)}
      group by environment
    `,
    query_params: { projectId, environments },
    clickhouse_settings: {
      max_execution_time: 30,
      max_threads: 2,
      max_rows_to_group_by: String(environments.length),
      group_by_overflow_mode: "throw"
    },
    format: "JSONEachRow"
  });
  const rows = await result.json<EnvironmentStatsRow>();
  return rows.map((row) => ({
    name: row.environment,
    firstSeenAt: fromClickHouseDateTime(row.first_seen_at),
    lastSeenAt: fromClickHouseDateTime(row.last_seen_at)
  }));
}
