import { listStoredRowKeys, type ClickHouseClient, type StoredRowKey } from "@ironside/clickhouse";
import type { Observation, Score, Trace } from "@ironside/shared";
import { instant, utcDay } from "./langfuse-merge.js";

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
//
// Deletions carry the batch's version and never share a key with a row the
// batch writes. LangFuse-compatible rows are merged field by field instead
// and handle a move in langfuse-merge.ts.
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
  /** The rows to write: one per record, leaving out stale rows. */
  traces: Trace[];
  observations: Observation[];
  scores: Score[];
  /** Stored rows these writes replace, to write as deletions with this batch's version before the rows. */
  deletions: MovedRowDeletions;
}

export async function resolveMovedRows(
  clickhouse: ClickHouseClient,
  input: { projectId: string; receivedAt: string; traces: Trace[]; observations: Observation[]; scores: Score[] }
): Promise<ResolvedRows> {
  const { projectId } = input;
  const version = instant(input.receivedAt);
  const traces = lastPerRecord(input.traces, (trace) => recordKey("trace", "", trace.id));
  const observations = lastPerRecord(input.observations, (row) => recordKey("observation", row.traceId, row.id));
  const scores = lastPerRecord(input.scores, (score) => recordKey("score", score.traceId, score.id));

  const stored = await listStoredRowKeys(clickhouse, projectId, {
    traceIds: traces.map((trace) => trace.id),
    observations: observations.map((observation) => ({ traceId: observation.traceId, id: observation.id })),
    scores: scores.map((score) => ({ traceId: score.traceId, id: score.id }))
  });
  const byRecord = new Map<string, StoredRowKey[]>();
  for (const row of stored) {
    const key = recordKey(row.kind, row.trace_id, row.id);
    byRecord.set(key, [...(byRecord.get(key) ?? []), row]);
  }

  /** Whether the batch's row is written, and which stored rows it replaces. */
  const resolve = (key: string, sortTime: string): { write: boolean; replaced: StoredRowKey[] } => {
    const rows = byRecord.get(key) ?? [];
    if (rows.some((row) => instant(row.event_ts) > version)) {
      return { write: false, replaced: rows.filter((row) => instant(row.event_ts) < version) };
    }
    const day = utcDay(sortTime);
    return { write: true, replaced: rows.filter((row) => utcDay(row.sort_time) !== day) };
  };

  const deletions: MovedRowDeletions = { traces: [], observations: [], scores: [] };
  const writtenTraces = traces.filter((trace) => {
    const { write, replaced } = resolve(recordKey("trace", "", trace.id), trace.timestamp);
    for (const row of replaced) deletions.traces.push({ projectId, id: row.id, timestamp: row.sort_time });
    return write;
  });
  const writtenObservations = observations.filter((observation) => {
    const { write, replaced } = resolve(
      recordKey("observation", observation.traceId, observation.id),
      observation.startTime
    );
    for (const row of replaced) {
      deletions.observations.push({ projectId, id: row.id, traceId: row.trace_id, startTime: row.sort_time });
    }
    return write;
  });
  const writtenScores = scores.filter((score) => {
    const { write, replaced } = resolve(
      recordKey("score", score.traceId, score.id),
      score.timestamp ?? input.receivedAt
    );
    for (const row of replaced) {
      deletions.scores.push({ projectId, id: row.id, traceId: row.trace_id, timestamp: row.sort_time });
    }
    return write;
  });
  return { traces: writtenTraces, observations: writtenObservations, scores: writtenScores, deletions };
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
