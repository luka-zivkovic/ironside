import { listStoredRowKeys, type ClickHouseClient, type StoredRowKey } from "@ironside/clickhouse";
import type { Observation, Score, Trace } from "@ironside/shared";
import { instant, utcDay } from "./langfuse-merge.js";

// A trace's, observation's or score's ClickHouse sort key includes the day of
// its timestamp (start time for observations). ReplacingMergeTree replaces a
// row only under the same key, so a record written again with a timestamp on
// another day would otherwise be stored twice. Before a batch is written,
// each record's stored rows under other days are either deleted, when this
// batch's row is at least as new, or win, when a stored row is newer and this
// batch's row is stale. LangFuse-compatible rows are merged field by field
// instead and handle a move in langfuse-merge.ts.
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
  /** The rows to write: stale rows, whose record is stored newer under another day, are left out. */
  traces: Trace[];
  observations: Observation[];
  scores: Score[];
  /** Stored rows of these records under another day, to write as deletions with this batch's version. */
  deletions: MovedRowDeletions;
}

export async function resolveMovedRows(
  clickhouse: ClickHouseClient,
  input: { projectId: string; receivedAt: string; traces: Trace[]; observations: Observation[]; scores: Score[] }
): Promise<ResolvedRows> {
  const { projectId } = input;
  const version = instant(input.receivedAt);
  const stored = await listStoredRowKeys(clickhouse, projectId, {
    traceIds: input.traces.map((trace) => trace.id),
    observations: input.observations.map((observation) => ({ traceId: observation.traceId, id: observation.id })),
    scores: input.scores.map((score) => ({ traceId: score.traceId, id: score.id }))
  });
  const byRecord = new Map<string, StoredRowKey[]>();
  for (const row of stored) {
    const key = recordKey(row.kind, row.trace_id, row.id);
    byRecord.set(key, [...(byRecord.get(key) ?? []), row]);
  }

  const deletions: MovedRowDeletions = { traces: [], observations: [], scores: [] };
  /** The stored rows under another day to delete, or null when a stored row is newer than this batch. */
  const otherDays = (key: string, sortTime: string): StoredRowKey[] | null => {
    const rows = byRecord.get(key) ?? [];
    const day = utcDay(sortTime);
    const moved = rows.filter((row) => utcDay(row.sort_time) !== day);
    return moved.some((row) => instant(row.event_ts) > version) ? null : moved;
  };

  const traces = input.traces.filter((trace) => {
    const moved = otherDays(recordKey("trace", "", trace.id), trace.timestamp);
    for (const row of moved ?? []) deletions.traces.push({ projectId, id: row.id, timestamp: row.sort_time });
    return moved !== null;
  });
  const observations = input.observations.filter((observation) => {
    const moved = otherDays(recordKey("observation", observation.traceId, observation.id), observation.startTime);
    for (const row of moved ?? []) {
      deletions.observations.push({ projectId, id: row.id, traceId: row.trace_id, startTime: row.sort_time });
    }
    return moved !== null;
  });
  const scores = input.scores.filter((score) => {
    const moved = otherDays(recordKey("score", score.traceId, score.id), score.timestamp ?? input.receivedAt);
    for (const row of moved ?? []) {
      deletions.scores.push({ projectId, id: row.id, traceId: row.trace_id, timestamp: row.sort_time });
    }
    return moved !== null;
  });
  return { traces, observations, scores, deletions };
}

function recordKey(kind: StoredRowKey["kind"], traceId: string, id: string): string {
  return `${kind}\u0000${traceId}\u0000${id}`;
}
