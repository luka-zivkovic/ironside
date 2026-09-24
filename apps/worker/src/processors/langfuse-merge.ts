import {
  listObservationsByIds,
  listTracesByIds,
  type ClickHouseClient,
  type StoredObservationRow,
  type StoredTraceRow
} from "@ironside/clickhouse";
import {
  getLangfuseFieldSentAt,
  langfuseEntityKey,
  type LangfuseEntityKind,
  type LangfuseFieldSentAt
} from "@ironside/db";
import type { MappedLangfuseRows } from "@ironside/mappers";
import {
  COST_MODEL_METADATA_KEY,
  COST_SOURCE_METADATA_KEY,
  COST_TABLE_METADATA_KEY
} from "@ironside/pricing";
import type { Observation, Trace } from "@ironside/shared";
import type { Pool } from "pg";
import { observationFromStoredRow, traceFromStoredRow } from "../lib/stored-rows.js";

const COST_METADATA_KEYS = [COST_SOURCE_METADATA_KEY, COST_MODEL_METADATA_KEY, COST_TABLE_METADATA_KEY];

// LangFuse SDKs send each record as a create followed by partial updates and
// flush on a timer, so a record's events arrive in separate requests, and the
// worker can process those batches in any order: concurrently (4 jobs at a
// time), or reversed when an earlier batch fails and is retried. Rows are
// whole-row upserts, so the worker merges each incoming row into the stored
// one field by field (spec/langfuse-compat-v1.md):
//
// - The caller holds a merge lock per record (withLangfuseMergeLocks) from
//   before these reads until the merged rows are written and their field
//   times recorded, so two batches for one record never merge concurrently.
// - langfuse_field_provenance records when each field was last sent. A field
//   both sides sent takes the value from the later-received batch; a field
//   only one side sent takes that side's value; a field neither sent keeps
//   the stored placeholder. This also tells a real start time from the one an
//   update-only row was given.
// - A merged row whose stored version is newer than this batch is written
//   with the stored version. ReplacingMergeTree keeps the most recently
//   inserted row on a tie, so the merged row wins, and the trace's latest
//   activity (the evaluator feed's settlement clock) does not move.

export interface LangfuseMergeResult {
  traces: Trace[];
  observations: Observation[];
  /** Version overrides for rows whose stored version is newer than this batch (InsertOptions.rowEventTs). */
  rowEventTs: { traces: Map<string, string>; observations: Map<string, string> };
  /** Field times to record once the rows are written (recordLangfuseFieldSentAt). */
  sentAt: { kind: LangfuseEntityKind; id: string; sentAt: LangfuseFieldSentAt }[];
  /**
   * Stored rows the merge moved to another day. The day is part of the
   * ClickHouse sort key, so the merged row does not replace the stored one;
   * these are written as deletions of the old key (deleteMovedTraceRows).
   */
  moved: {
    traces: { projectId: string; id: string; timestamp: string }[];
    observations: { projectId: string; id: string; traceId: string; startTime: string }[];
  };
}

/** Combines a batch's LangFuse requests; a record in more than one takes later requests' sent fields. */
export function foldLangfuseRows(mapped: MappedLangfuseRows[]): MappedLangfuseRows {
  const folded: MappedLangfuseRows = {
    traces: [],
    observations: [],
    scores: [],
    providedFields: { traces: new Map(), observations: new Map() }
  };
  for (const rows of mapped) {
    foldInto(folded.traces, folded.providedFields.traces, rows.traces, rows.providedFields.traces);
    foldInto(
      folded.observations,
      folded.providedFields.observations,
      rows.observations,
      rows.providedFields.observations
    );
    folded.scores.push(...rows.scores);
  }
  return folded;
}

function foldInto<Row extends { id: string }>(
  target: Row[],
  targetProvided: Map<string, ReadonlySet<keyof Row>>,
  rows: Row[],
  provided: Map<string, ReadonlySet<keyof Row>>
): void {
  for (const row of rows) {
    const index = target.findIndex((existing) => existing.id === row.id);
    const sent = provided.get(row.id) ?? new Set<keyof Row>();
    if (index === -1) {
      target.push(row);
      targetProvided.set(row.id, sent);
      continue;
    }
    const merged = { ...target[index]! };
    for (const key of sent) merged[key] = row[key];
    target[index] = merged;
    targetProvided.set(row.id, new Set([...(targetProvided.get(row.id) ?? []), ...sent]));
  }
}

export function langfuseEntities(rows: MappedLangfuseRows): { kind: LangfuseEntityKind; id: string }[] {
  return [
    ...rows.traces.map((trace) => ({ kind: "trace" as const, id: trace.id })),
    ...rows.observations.map((observation) => ({ kind: "observation" as const, id: observation.id }))
  ];
}

/** Merges a batch's LangFuse rows into the stored ones. Call while holding their merge locks. */
export async function mergeLangfuseRows(
  deps: { pool: Pool; clickhouse: ClickHouseClient },
  input: { projectId: string; receivedAt: string; rows: MappedLangfuseRows }
): Promise<LangfuseMergeResult> {
  const { projectId, rows } = input;
  const receivedAt = instant(input.receivedAt);
  const [storedTraces, storedObservations, sentAtByEntity] = await Promise.all([
    listTracesByIds(deps.clickhouse, projectId, rows.traces.map((trace) => trace.id)),
    listObservationsByIds(
      deps.clickhouse,
      projectId,
      rows.observations.map((observation) => ({ id: observation.id, traceId: observation.traceId }))
    ),
    getLangfuseFieldSentAt(deps.pool, projectId, langfuseEntities(rows))
  ]);
  const tracesById = new Map(storedTraces.map((row) => [row.id, row]));
  const observationsById = new Map(storedObservations.map((row) => [row.id, row]));

  const result: LangfuseMergeResult = {
    traces: [],
    observations: [],
    rowEventTs: { traces: new Map(), observations: new Map() },
    sentAt: [],
    moved: { traces: [], observations: [] }
  };
  for (const trace of rows.traces) {
    const stored = tracesById.get(trace.id);
    const merged = mergeByRecency(
      trace,
      rows.providedFields.traces.get(trace.id) ?? new Set(),
      receivedAt,
      stored && {
        row: traceFromStoredRow(projectId, stored),
        version: instant(stored.event_ts),
        sentAt: sentAtByEntity.get(langfuseEntityKey("trace", trace.id))
      }
    );
    result.traces.push(merged.row);
    result.sentAt.push({ kind: "trace", id: trace.id, sentAt: merged.sentAt });
    if (stored && utcDay(stored.timestamp) !== utcDay(merged.row.timestamp)) {
      result.moved.traces.push({ projectId, id: trace.id, timestamp: stored.timestamp });
    }
    const override = versionOverride(stored, receivedAt);
    if (override) result.rowEventTs.traces.set(trace.id, override);
  }
  for (const observation of rows.observations) {
    const candidate = observationsById.get(observation.id);
    // An id reused under another trace is a different record.
    const stored = candidate?.trace_id === observation.traceId ? candidate : undefined;
    const merged = mergeObservationByRecency(
      observation,
      rows.providedFields.observations.get(observation.id) ?? new Set(),
      receivedAt,
      stored && {
        row: observationFromStoredRow(projectId, stored),
        version: instant(stored.event_ts),
        sentAt: sentAtByEntity.get(langfuseEntityKey("observation", observation.id))
      }
    );
    result.observations.push(merged.row);
    result.sentAt.push({ kind: "observation", id: observation.id, sentAt: merged.sentAt });
    if (stored && utcDay(stored.start_time) !== utcDay(merged.row.startTime)) {
      result.moved.observations.push({
        projectId,
        id: observation.id,
        traceId: stored.trace_id,
        startTime: stored.start_time
      });
    }
    const override = versionOverride(stored, receivedAt);
    if (override) result.rowEventTs.observations.set(observation.id, override);
  }
  return result;
}

/** The UTC day of an ISO timestamp: the day ClickHouse's sort key (toDate) puts a row under. */
function utcDay(timestamp: string): string {
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? timestamp : new Date(time).toISOString().slice(0, 10);
}

/** The stored version when it is newer than this batch, in ClickHouse's own rendering. */
function versionOverride(
  stored: StoredTraceRow | StoredObservationRow | undefined,
  receivedAt: string
): string | undefined {
  return stored && instant(stored.event_ts) > receivedAt ? stored.event_ts : undefined;
}

export interface StoredForMerge<Row> {
  row: Row;
  /** The stored row's version, normalized with instant(). */
  version: string;
  /** Recorded field times, or undefined for a row written before they were recorded. */
  sentAt: LangfuseFieldSentAt | undefined;
}

export interface MergedRow<Row> {
  row: Row;
  sentAt: LangfuseFieldSentAt;
  /** Fields whose value came from the incoming row. */
  fromIncoming: ReadonlySet<keyof Row>;
}

/**
 * Field-by-field merge by recency. `receivedAt` and every time involved are
 * normalized with instant(), so they compare as strings.
 */
export function mergeByRecency<Row extends object>(
  incoming: Row,
  provided: ReadonlySet<keyof Row>,
  receivedAt: string,
  stored: StoredForMerge<Row> | undefined
): MergedRow<Row> {
  if (!stored) {
    return {
      row: incoming,
      sentAt: Object.fromEntries([...provided].map((field) => [field, receivedAt])),
      fromIncoming: new Set(Object.keys(incoming) as (keyof Row)[])
    };
  }
  const storedSentAt =
    stored.sentAt ??
    (stored.version === receivedAt
      ? // An earlier attempt of this same batch wrote the row and failed before
        // recording field times: it sent only `provided`, and counting its
        // placeholders (an update's start time) as sent would let them beat a
        // create processed later.
        Object.fromEntries([...provided].map((field) => [field as string, receivedAt]))
      : implicitSentAt(stored.row, stored.version));
  const merged = { ...incoming };
  const sentAt: LangfuseFieldSentAt = { ...storedSentAt };
  const fromIncoming = new Set<keyof Row>();
  const fields = new Set([...Object.keys(incoming), ...Object.keys(stored.row)] as (keyof Row)[]);
  for (const field of fields) {
    const incomingAt = provided.has(field) ? receivedAt : undefined;
    const storedAt = storedSentAt[field as string];
    if (incomingAt !== undefined && (storedAt === undefined || incomingAt >= storedAt)) {
      merged[field] = incoming[field];
      sentAt[field as string] = incomingAt;
      fromIncoming.add(field);
    } else if (storedAt !== undefined || stored.row[field] !== undefined) {
      // Sent earlier or later than this batch, or neither side sent it and
      // the stored placeholder is kept rather than replaced by a new one.
      merged[field] = stored.row[field];
    } else {
      fromIncoming.add(field);
    }
  }
  return { row: merged, sentAt, fromIncoming };
}

/** Recency merge plus the rules that keep a derived cost consistent with the usage and model it came from. */
export function mergeObservationByRecency(
  incoming: Observation,
  provided: ReadonlySet<keyof Observation>,
  receivedAt: string,
  stored: StoredForMerge<Observation> | undefined
): MergedRow<Observation> {
  const merged = mergeByRecency(incoming, provided, receivedAt, stored);
  if (!stored) return merged;
  const { row, sentAt, fromIncoming } = merged;
  if (fromIncoming.has("costDetails") && provided.has("costDetails")) {
    // A client-sent cost replaces the stored one. Stored metadata carried
    // forward may still label a cost as derived, which would let a later
    // usage update recompute it; drop those labels.
    if (!fromIncoming.has("metadata")) row.metadata = withoutCostProvenance(row.metadata);
    return merged;
  }
  const storedCostWasDerived =
    stored.row.costDetails !== undefined && stored.row.metadata[COST_SOURCE_METADATA_KEY] !== undefined;
  if (!storedCostWasDerived || row.costDetails !== stored.row.costDetails) return merged;
  if (fromIncoming.has("usageDetails") || fromIncoming.has("model")) {
    // Derived from the old usage/model; cost enrichment derives it again.
    delete row.costDetails;
    delete sentAt.costDetails;
    row.metadata = withoutCostProvenance(row.metadata);
  } else if (fromIncoming.has("metadata")) {
    // New metadata replaced the stored map; keep the carried cost's provenance.
    for (const key of COST_METADATA_KEYS) {
      const value = stored.row.metadata[key];
      if (value !== undefined) row.metadata = { ...row.metadata, [key]: value };
    }
  }
  return merged;
}

/**
 * Field times for a stored row written before they were recorded: every
 * field with a value counts as sent at the stored version. Empty tags and
 * metadata are mapper defaults, not values anyone sent.
 */
function implicitSentAt<Row extends object>(row: Row, version: string): LangfuseFieldSentAt {
  return Object.fromEntries(
    (Object.entries(row) as [string, unknown][])
      .filter(([, value]) => value !== undefined && !isEmptyContainer(value))
      .map(([field]) => [field, version])
  );
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return value !== null && typeof value === "object" && Object.keys(value).length === 0;
}

function withoutCostProvenance(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !COST_METADATA_KEYS.includes(key)));
}

/**
 * A comparable instant: ISO 8601 (the API's receive time) or ClickHouse
 * DateTime64 text, normalized to microseconds as YYYY-MM-DDTHH:MM:SS.ffffffZ
 * so later instants sort later as plain strings.
 */
export function instant(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/.exec(value);
  if (match) return `${match[1]}T${match[2]}.${(match[3] ?? "").padEnd(6, "0")}Z`;
  return new Date(value).toISOString().replace(/Z$/, "000Z");
}
