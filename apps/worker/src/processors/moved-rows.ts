import {
  getServerTimezone,
  listStoredRowKeys,
  type ClickHouseClient,
  type StoredRowKey
} from "@ironside/clickhouse";
import type { Observation, Score, Trace } from "@ironside/shared";
import { instant } from "./langfuse-merge.js";

// A trace's, observation's or score's ClickHouse sort key includes the day of
// its timestamp (start time for observations). ReplacingMergeTree replaces a
// row only under the same key, so a record written again with a timestamp on
// another day would otherwise be stored twice. Before a batch is written:
//
// - A record that appears more than once in the batch keeps its last row, as
//   it would under one key. The batch then writes one row per record, and a
//   retry of the batch finds that row under the same key.
// - When no stored row of the record is newer than the batch, the batch's row
//   is written and the stored rows under other days are deleted.
// - When a stored row is newer, the batch's row is stale and is not written;
//   stored rows older than the batch are still deleted, since a newer row
//   replaces them either way.
// - LangFuse-compatible rows arrive already merged with the stored row
//   (langfuse-merge.ts) and are always written; their stored rows under
//   other days are deleted with the merged row's version.
//
// Deletions are written after the rows they make way for, so a failure in
// between leaves a duplicate, never a missing record; the retry, which finds
// the same stored rows, removes it. Deletions never share a key with a row the
// batch writes: days are compared only within the range of ClickHouse's Date
// type, which the sort key uses (see sortKeyDay), and only on a server whose
// timezone is UTC. Elsewhere toDate's day can differ from the UTC day (a
// daylight-saving jump at midnight moves a time to the previous day), so
// moved rows are not deleted there: a duplicate can remain, a record cannot
// be lost.
//
// Two batches writing the same record on different days at the same moment
// can both find nothing stored and both be written; the next write of that
// record removes the extra row.

export interface MovedRowDeletions {
  traces: { projectId: string; id: string; timestamp: string }[];
  observations: { projectId: string; id: string; traceId: string; startTime: string }[];
  scores: { projectId: string; id: string; traceId: string; timestamp: string }[];
}

export interface ResolvedRows {
  /** The whole-row upserts to write: one per record, leaving out stale rows. */
  traces: Trace[];
  observations: Observation[];
  scores: Score[];
  /** Stored rows the upserts replace, to write as deletions with this batch's version after the rows. */
  deletions: MovedRowDeletions;
  /** Stored rows the merged LangFuse rows replace, to write with each merged row's version (rowEventTs). */
  mergedDeletions: Omit<MovedRowDeletions, "scores">;
}

export async function resolveMovedRows(
  clickhouse: ClickHouseClient,
  input: {
    projectId: string;
    receivedAt: string;
    /** Whole-row upserts: native and OTLP traces and observations, and every score. */
    traces: Trace[];
    observations: Observation[];
    scores: Score[];
    /** LangFuse-compatible rows merged with their stored rows, and the versions they are written with. */
    merged: {
      traces: Trace[];
      observations: Observation[];
      rowEventTs: { traces: ReadonlyMap<string, string>; observations: ReadonlyMap<string, string> };
    };
    /** The ClickHouse server's timezone; looked up once per client when omitted. */
    serverTimezone?: string;
  }
): Promise<ResolvedRows> {
  const { projectId, merged } = input;
  const compareDays = UTC_TIMEZONES.has(input.serverTimezone ?? (await serverTimezone(clickhouse)));
  const version = instant(input.receivedAt);
  const traces = lastPerRecord(input.traces, (trace) => recordKey("trace", "", trace.id));
  const observations = lastPerRecord(input.observations, (row) => recordKey("observation", row.traceId, row.id));
  const scores = lastPerRecord(input.scores, (score) => recordKey("score", score.traceId, score.id));

  const stored = await listStoredRowKeys(clickhouse, projectId, {
    traceIds: [...traces, ...merged.traces].map((trace) => trace.id),
    observations: [...observations, ...merged.observations].map((row) => ({ traceId: row.traceId, id: row.id })),
    scores: scores.map((score) => ({ traceId: score.traceId, id: score.id }))
  });
  const byRecord = new Map<string, StoredRowKey[]>();
  for (const row of stored) {
    const key = recordKey(row.kind, row.trace_id, row.id);
    byRecord.set(key, [...(byRecord.get(key) ?? []), row]);
  }

  /** Stored rows under another day than `sortTime`, at or below `rowVersion`. */
  const otherDays = (rows: StoredRowKey[], sortTime: string, rowVersion: string): StoredRowKey[] => {
    const day = compareDays ? sortKeyDay(sortTime) : undefined;
    if (day === undefined) return [];
    return rows.filter((row) => {
      const storedDay = sortKeyDay(row.sort_time);
      return storedDay !== undefined && storedDay !== day && instant(row.event_ts) <= rowVersion;
    });
  };
  /** Whether a whole-row upsert is written, and which stored rows it replaces. */
  const resolve = (key: string, sortTime: string): { write: boolean; replaced: StoredRowKey[] } => {
    const rows = byRecord.get(key) ?? [];
    if (rows.some((row) => instant(row.event_ts) > version)) {
      return { write: false, replaced: rows.filter((row) => instant(row.event_ts) < version) };
    }
    return { write: true, replaced: otherDays(rows, sortTime, version) };
  };

  const deletions: MovedRowDeletions = { traces: [], observations: [], scores: [] };
  const writtenTraces = traces.filter((trace) => {
    const { write, replaced } = resolve(recordKey("trace", "", trace.id), trace.timestamp);
    deletions.traces.push(...replaced.map((row) => traceDeletion(projectId, row)));
    return write;
  });
  const writtenObservations = observations.filter((observation) => {
    const { write, replaced } = resolve(
      recordKey("observation", observation.traceId, observation.id),
      observation.startTime
    );
    deletions.observations.push(...replaced.map((row) => observationDeletion(projectId, row)));
    return write;
  });
  const writtenScores = scores.filter((score) => {
    const { write, replaced } = resolve(
      recordKey("score", score.traceId, score.id),
      score.timestamp ?? input.receivedAt
    );
    deletions.scores.push(
      ...replaced.map((row) => ({ projectId, id: row.id, traceId: row.trace_id, timestamp: row.sort_time }))
    );
    return write;
  });

  const mergedDeletions: ResolvedRows["mergedDeletions"] = { traces: [], observations: [] };
  for (const trace of merged.traces) {
    const rowVersion = instant(merged.rowEventTs.traces.get(trace.id) ?? input.receivedAt);
    const rows = byRecord.get(recordKey("trace", "", trace.id)) ?? [];
    mergedDeletions.traces.push(...otherDays(rows, trace.timestamp, rowVersion).map((row) => traceDeletion(projectId, row)));
  }
  for (const observation of merged.observations) {
    const rowVersion = instant(merged.rowEventTs.observations.get(observation.id) ?? input.receivedAt);
    const rows = byRecord.get(recordKey("observation", observation.traceId, observation.id)) ?? [];
    mergedDeletions.observations.push(
      ...otherDays(rows, observation.startTime, rowVersion).map((row) => observationDeletion(projectId, row))
    );
  }

  return { traces: writtenTraces, observations: writtenObservations, scores: writtenScores, deletions, mergedDeletions };
}

const UTC_TIMEZONES = new Set(["UTC", "Etc/UTC", "UCT", "Etc/UCT", "Universal", "Etc/Universal", "Zulu", "Etc/Zulu"]);

const serverTimezones = new WeakMap<ClickHouseClient, Promise<string>>();

function serverTimezone(clickhouse: ClickHouseClient): Promise<string> {
  let timezone = serverTimezones.get(clickhouse);
  if (!timezone) {
    timezone = getServerTimezone(clickhouse);
    // A failed lookup is retried on the next batch rather than cached.
    timezone.catch(() => serverTimezones.delete(clickhouse));
    serverTimezones.set(clickhouse, timezone);
  }
  return timezone;
}

const DATE_MIN = Date.parse("1970-01-01T00:00:00.000Z");
const DATE_END = Date.parse("2149-06-07T00:00:00.000Z");

/**
 * The day a timestamp's row is keyed under, as ClickHouse's toDate computes
 * it, or undefined outside the Date type's range (1970-01-01 to 2149-06-06),
 * where toDate does not return the calendar day. Rows there are never
 * compared, so they are never deleted as moved.
 */
function sortKeyDay(timestamp: string): string | undefined {
  const time = Date.parse(timestamp);
  if (Number.isNaN(time) || time < DATE_MIN || time >= DATE_END) return undefined;
  return new Date(time).toISOString().slice(0, 10);
}

function traceDeletion(projectId: string, row: StoredRowKey): MovedRowDeletions["traces"][number] {
  return { projectId, id: row.id, timestamp: row.sort_time };
}

function observationDeletion(projectId: string, row: StoredRowKey): MovedRowDeletions["observations"][number] {
  return { projectId, id: row.id, traceId: row.trace_id, startTime: row.sort_time };
}

/** Each record's last row, in the order of those last rows. */
function lastPerRecord<Row>(rows: Row[], key: (row: Row) => string): Row[] {
  const last = new Map<string, Row>();
  for (const row of rows) {
    const recordId = key(row);
    last.delete(recordId);
    last.set(recordId, row);
  }
  return [...last.values()];
}

function recordKey(kind: StoredRowKey["kind"], traceId: string, id: string): string {
  return `${kind}\u0000${traceId}\u0000${id}`;
}
