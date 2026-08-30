import type { Observation, Score, Trace } from "@ironside/shared";
import type { ClickHouseClient } from "@clickhouse/client";
import { toClickHouseDateTime } from "./datetime.js";

/**
 * `event_ts` (the ReplacingMergeTree version column) must be deterministic
 * per source event, not wall-clock-at-insert-time — otherwise retrying a
 * failed job produces a strictly newer version on every attempt, so the
 * "retry is a no-op" property that BullMQ's retry-on-throw behavior relies
 * on would not hold. Callers pass the batch's `receivedAt` so all rows from
 * one batch (including across retries of the same job) share one version.
 *
 * Note this only dedups eventually: ReplacingMergeTree collapses duplicate
 * keys during background merges, not synchronously on insert. Readers that
 * need a correct count/result immediately after insert must use `FINAL` or
 * an explicit `argMax(*, event_ts)` / `GROUP BY` — a plain `SELECT` can see
 * duplicate rows until the next merge runs. The baseline table engines use
 * this version column for deterministic replacement.
 */
export interface InsertOptions {
  eventTs: string;
}

/**
 * Full-snapshot pull imports must remove rows omitted by the new snapshot and
 * old sort-key variants whose source timestamp changed. Write engine-native
 * tombstones one microsecond before the new live generation so a retry of the
 * same generation remains a no-op and the live rows deterministically win.
 */
export async function tombstoneImportedTraceSnapshot(
  client: ClickHouseClient,
  projectId: string,
  traceId: string,
  eventTs: string,
  importSource: "langfuse" | "langsmith"
): Promise<void> {
  const settings = {
    max_execution_time: 30,
    max_threads: 2,
    max_memory_usage: String(256 * 1024 * 1024),
    max_rows_to_read: "5000000",
    read_overflow_mode: "throw" as const
  };
  await Promise.all([
    client.command({
      query: `
        insert into traces (project_id, id, timestamp, event_ts, is_deleted)
        select project_id, id, timestamp,
               subtractMicroseconds({eventTs:DateTime64(6)}, 1), 1
          from traces final
         where project_id = {projectId:String} and id = {traceId:String}
      `,
      query_params: { projectId, traceId, eventTs: toClickHouseDateTime(eventTs) },
      clickhouse_settings: settings
    }),
    client.command({
      query: `
        insert into observations
          (project_id, id, trace_id, start_time, event_ts, is_deleted)
        select project_id, id, trace_id, start_time,
               subtractMicroseconds({eventTs:DateTime64(6)}, 1), 1
         from observations final
         where project_id = {projectId:String} and trace_id = {traceId:String}
      `,
      query_params: { projectId, traceId, eventTs: toClickHouseDateTime(eventTs) },
      clickhouse_settings: settings
    }),
    tombstoneImportedScores(client, projectId, traceId, eventTs, importSource)
  ]);
}

/** Reconciles only feedback owned by one pull provider. */
export async function tombstoneImportedScores(
  client: ClickHouseClient,
  projectId: string,
  traceId: string,
  eventTs: string,
  importSource: "langfuse" | "langsmith"
): Promise<void> {
  await client.command({
    query: `
      insert into scores
        (project_id, id, trace_id, timestamp, import_source, event_ts, is_deleted)
      select project_id, id, trace_id, timestamp, import_source,
             subtractMicroseconds({eventTs:DateTime64(6)}, 1), 1
        from scores final
       where project_id = {projectId:String} and trace_id = {traceId:String}
         and import_source = {importSource:String}
    `,
    query_params: { projectId, traceId, eventTs: toClickHouseDateTime(eventTs), importSource },
    clickhouse_settings: {
      max_execution_time: 30,
      max_threads: 2,
      max_memory_usage: String(256 * 1024 * 1024),
      max_rows_to_read: "5000000",
      read_overflow_mode: "throw"
    }
  });
}

/**
 * A retention cutoff can advance while a staged import is writing. In that
 * race, write tombstones one microsecond after the attempted generation so
 * the just-restored rows cannot survive the cutoff that already won in PG.
 */
export async function tombstoneExpiredImportedTraceSnapshot(
  client: ClickHouseClient,
  projectId: string,
  traceId: string,
  eventTs: string,
  importSource?: "langfuse" | "langsmith"
): Promise<void> {
  const settings = {
    max_execution_time: 30,
    max_threads: 2,
    max_memory_usage: String(256 * 1024 * 1024),
    max_rows_to_read: "5000000",
    read_overflow_mode: "throw" as const
  };
  await Promise.all([
    client.command({
      query: `
        insert into traces (project_id, id, timestamp, event_ts, is_deleted)
        select project_id, id, timestamp,
               addMicroseconds({eventTs:DateTime64(6)}, 1), 1
          from traces final
         where project_id = {projectId:String} and id = {traceId:String}
      `,
      query_params: { projectId, traceId, eventTs: toClickHouseDateTime(eventTs) },
      clickhouse_settings: settings
    }),
    client.command({
      query: `
        insert into observations
          (project_id, id, trace_id, start_time, event_ts, is_deleted)
        select project_id, id, trace_id, start_time,
               addMicroseconds({eventTs:DateTime64(6)}, 1), 1
         from observations final
         where project_id = {projectId:String} and trace_id = {traceId:String}
      `,
      query_params: { projectId, traceId, eventTs: toClickHouseDateTime(eventTs) },
      clickhouse_settings: settings
    }),
    client.command({
      query: `
        insert into scores
          (project_id, id, trace_id, timestamp, import_source, event_ts, is_deleted)
        select project_id, id, trace_id, timestamp, import_source,
               addMicroseconds({eventTs:DateTime64(6)}, 1), 1
         from scores final
         where project_id = {projectId:String} and trace_id = {traceId:String}
           ${importSource ? "and import_source = {importSource:String}" : ""}
      `,
      query_params: {
        projectId,
        traceId,
        eventTs: toClickHouseDateTime(eventTs),
        ...(importSource ? { importSource } : {})
      },
      clickhouse_settings: settings
    })
  ]);
}

export async function insertTraces(
  client: ClickHouseClient,
  traces: Trace[],
  options: InsertOptions
): Promise<void> {
  if (traces.length === 0) return;
  const eventTs = toClickHouseDateTime(options.eventTs);
  await client.insert({
    table: "traces",
    values: traces.map((t) => ({
      project_id: t.projectId,
      id: t.id,
      timestamp: toClickHouseDateTime(t.timestamp),
      name: t.name ?? null,
      user_id: t.userId ?? null,
      session_id: t.sessionId ?? null,
      environment: t.environment ?? null,
      release: t.release ?? null,
      version: t.version ?? null,
      tags: t.tags,
      metadata: t.metadata,
      input: t.input !== undefined ? JSON.stringify(t.input) : null,
      output: t.output !== undefined ? JSON.stringify(t.output) : null,
      event_ts: eventTs
    })),
    format: "JSONEachRow"
  });
}

export async function insertObservations(
  client: ClickHouseClient,
  observations: Observation[],
  options: InsertOptions
): Promise<void> {
  if (observations.length === 0) return;
  const eventTs = toClickHouseDateTime(options.eventTs);
  await client.insert({
    table: "observations",
    values: observations.map((o) => ({
      project_id: o.projectId,
      id: o.id,
      trace_id: o.traceId,
      parent_observation_id: o.parentObservationId ?? null,
      type: o.type,
      name: o.name ?? null,
      start_time: toClickHouseDateTime(o.startTime),
      end_time: o.endTime ? toClickHouseDateTime(o.endTime) : null,
      level: o.level,
      status_message: o.statusMessage ?? null,
      model: o.model ?? null,
      model_parameters: stringifyMap(o.modelParameters),
      input: o.input !== undefined ? JSON.stringify(o.input) : null,
      output: o.output !== undefined ? JSON.stringify(o.output) : null,
      usage_details: o.usageDetails ?? {},
      cost_details: o.costDetails ?? {},
      completion_start_time: o.completionStartTime
        ? toClickHouseDateTime(o.completionStartTime)
        : null,
      metadata: o.metadata,
      event_ts: eventTs
    })),
    format: "JSONEachRow"
  });
}

export async function insertScores(
  client: ClickHouseClient,
  scores: Score[],
  options: InsertOptions & { importSource?: "langfuse" | "langsmith" }
): Promise<void> {
  if (scores.length === 0) return;
  const eventTs = toClickHouseDateTime(options.eventTs);
  await client.insert({
    table: "scores",
    values: scores.map((s) => ({
      project_id: s.projectId,
      id: s.id,
      trace_id: s.traceId,
      observation_id: s.observationId ?? null,
      name: s.name,
      data_type: s.dataType,
      value: s.value ?? null,
      string_value: s.stringValue ?? null,
      source: s.source,
      import_source: options.importSource ?? null,
      comment: s.comment ?? null,
      metadata: s.metadata,
      // Omit when absent so the column DEFAULT (insert time) applies —
      // correct for live-ingested scores; importers pass the source's
      // original timestamp so backfilled scores keep their history.
      ...(s.timestamp && { timestamp: toClickHouseDateTime(s.timestamp) }),
      event_ts: eventTs
    })),
    format: "JSONEachRow"
  });
}

function stringifyMap(
  values: Record<string, string | number | boolean | null> | undefined
): Record<string, string> {
  if (!values) return {};
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, v === null ? "" : String(v)])
  );
}
