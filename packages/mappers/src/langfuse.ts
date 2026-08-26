import type { Observation, Score, Trace } from "@ironside/shared";
import {
  langfuseObservationBodySchema,
  langfuseScoreBodySchema,
  langfuseTraceBodySchema,
  type LangfuseBatchEvent,
  type LangfuseIngestionRequest,
  type LangfuseIngestionResponse
} from "@ironside/shared";
import { normalizeEnvironment } from "@ironside/shared";
import { ulid } from "ulid";
import { canonicalizeUsageKeys } from "./usage-keys.js";

// Maps a LangFuse /api/public/ingestion batch to Ironside's domain model.
// See spec/langfuse-compat-v1.md for the full type mapping table and field
// normalization rules.
//
// CRITICAL: the real LangFuse SDK sends *-create and *-update as separate,
// PARTIAL batch items for the same observation id, and does not guarantee
// -create arrives before -update in the batch array — confirmed by
// capturing a real payload from the official `langfuse` npm SDK during
// conformance testing: a single `generation.end()` call produced a
// `generation-update` batch item (endTime/output/usage only) BEFORE the
// `generation-create` item (id/startTime/name/model/input) for the exact
// same observation id. Each Ironside domain row is a full-row upsert
// (ReplacingMergeTree, no field-level merge), so mapping each LangFuse
// batch item independently would non-deterministically drop whichever
// side "loses" — this bit early: model/name/input were silently lost in
// the first working version because -update happened to map to a row and
// -create's row landed with an equal event_ts, an undefined tie-break.
//
// Fix: group by (kind, id) first, merge all events for the same id into
// one body — *-create events establish the base row, *-update events
// (regardless of array position) are applied ON TOP, since that matches
// LangFuse's own create-then-patch semantics — then map the merged body
// once. Field presence, not event order, decides precedence: a field only
// -update sets is never overwritten back to absent by a co-occurring
// -create for the same id.

export interface MappedLangfuseRows {
  traces: Trace[];
  observations: Observation[];
  scores: Score[];
}

/**
 * Maps a validated LangFuse ingestion request to domain rows, AND builds
 * the 207 per-event response LangFuse's own endpoint returns (their SDK's
 * response handling expects this shape, not a bare 4xx). A malformed
 * individual batch item is recorded in `errors`, not fatal to the batch —
 * same policy as the native mapper.
 */
export function mapLangfuseIngestionRequest(
  projectId: string,
  request: LangfuseIngestionRequest
): { rows: MappedLangfuseRows; response: LangfuseIngestionResponse } {
  const rows: MappedLangfuseRows = { traces: [], observations: [], scores: [] };
  const response: LangfuseIngestionResponse = { successes: [], errors: [] };

  const traceGroups = new Map<string, LangfuseBatchEvent[]>();
  const observationGroups = new Map<string, { type: ObservationKind; events: LangfuseBatchEvent[] }>();
  const scoreEvents: LangfuseBatchEvent[] = [];
  const sdkLogEventIds: string[] = [];
  const invalidEventIds: { id: string; message: string }[] = [];

  for (const event of request.batch) {
    const kind = classify(event.type);
    if (kind === "invalid") {
      invalidEventIds.push({ id: event.id, message: `unsupported event type: ${event.type}` });
      continue;
    }
    if (kind === "sdk-log") {
      sdkLogEventIds.push(event.id);
      continue;
    }
    if (kind === "score") {
      scoreEvents.push(event);
      continue;
    }
    if (kind === "trace") {
      const bodyId = getBodyId(event);
      const key = bodyId ?? `__no_id_${event.id}`; // no id -> can't be merged with anything else, own group
      const group = traceGroups.get(key) ?? [];
      group.push(event);
      traceGroups.set(key, group);
      continue;
    }
    // observation kinds (span/generation/event)
    const bodyId = getBodyId(event);
    const key = bodyId ?? `__no_id_${event.id}`;
    const existing = observationGroups.get(key);
    if (existing) {
      existing.events.push(event);
    } else {
      observationGroups.set(key, { type: kind, events: [event] });
    }
  }

  for (const id of sdkLogEventIds) response.successes.push({ id, status: 201 });
  for (const { id, message } of invalidEventIds) response.errors.push({ id, status: 400, message });

  for (const events of traceGroups.values()) {
    const result = mapMergedTrace(projectId, events);
    recordResult(response, events, result);
    if (result.ok && result.row) rows.traces.push(result.row);
  }

  for (const { type, events } of observationGroups.values()) {
    const result = mapMergedObservation(projectId, events, type);
    recordResult(response, events, result);
    if (result.ok && result.row) rows.observations.push(result.row);
  }

  for (const event of scoreEvents) {
    const result = mapScore(projectId, event);
    recordResult(response, [event], result);
    if (result.ok && result.row) rows.scores.push(result.row);
  }

  return { rows, response };
}

type ObservationKind = "span" | "generation" | "event";
type Classification = "trace" | ObservationKind | "score" | "sdk-log" | "invalid";

function classify(type: LangfuseBatchEvent["type"]): Classification {
  switch (type) {
    case "trace-create":
      return "trace";
    case "span-create":
    case "span-update":
      return "span";
    case "generation-create":
    case "generation-update":
      return "generation";
    case "event-create":
      return "event";
    case "observation-create":
    case "observation-update":
      // Deprecated LangFuse alias with no type discriminant of its own;
      // default to span, the most common case for this legacy path.
      return "span";
    case "score-create":
      return "score";
    case "sdk-log":
      return "sdk-log";
    default: {
      const exhaustive: never = type;
      void exhaustive;
      return "invalid";
    }
  }
}

/** Reads body.id without full schema validation, just to group events by target entity. */
function getBodyId(event: LangfuseBatchEvent): string | undefined {
  if (event.body && typeof event.body === "object" && "id" in event.body) {
    const id = (event.body as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

type MergedResult<Row> = { ok: true; row: Row | null } | { ok: false; message: string };

function recordResult(
  response: LangfuseIngestionResponse,
  events: LangfuseBatchEvent[],
  result: MergedResult<unknown>
): void {
  for (const event of events) {
    if (result.ok) response.successes.push({ id: event.id, status: 201 });
    else response.errors.push({ id: event.id, status: 400, message: result.message });
  }
}

function mergeBodies(events: LangfuseBatchEvent[]): Record<string, unknown> {
  // *-create events establish the base; *-update (any array position)
  // applies on top. Within the same category, later array position wins
  // (there's no better signal — timestamps are frequently identical).
  const creates = events.filter((e) => e.type.endsWith("-create"));
  const updates = events.filter((e) => e.type.endsWith("-update"));
  const merged: Record<string, unknown> = {};
  for (const event of [...creates, ...updates]) {
    if (event.body && typeof event.body === "object") {
      Object.assign(merged, event.body);
    }
  }
  return merged;
}

function mapMergedTrace(
  projectId: string,
  events: LangfuseBatchEvent[]
): MergedResult<Trace> {
  const merged = mergeBodies(events);
  const parsed = langfuseTraceBodySchema.safeParse(merged);
  if (!parsed.success) return { ok: false, message: "invalid trace-create body" };
  const body = parsed.data;
  const latestTimestamp = events.map((e) => e.timestamp).filter(Boolean).at(-1);
  const environment = normalizeEnvironment(body.environment);

  const trace: Trace = {
    id: body.id ?? ulid(),
    projectId,
    timestamp: body.timestamp ?? latestTimestamp ?? new Date().toISOString(),
    tags: body.tags ?? [],
    metadata: normalizeMetadata(body.metadata),
    ...(body.name && { name: body.name }),
    ...(body.userId && { userId: body.userId }),
    ...(body.sessionId && { sessionId: body.sessionId }),
    ...(environment !== null && { environment }),
    ...(body.release && { release: body.release }),
    ...(body.version && { version: body.version }),
    ...(body.input !== undefined && { input: body.input }),
    ...(body.output !== undefined && { output: body.output })
  };
  return { ok: true, row: trace };
}

function mapMergedObservation(
  projectId: string,
  events: LangfuseBatchEvent[],
  type: ObservationKind
): MergedResult<Observation> {
  const merged = mergeBodies(events);
  const parsed = langfuseObservationBodySchema.safeParse(merged);
  if (!parsed.success) return { ok: false, message: `invalid ${events[0]?.type} body` };
  const body = parsed.data;

  if (!body.traceId) {
    return { ok: false, message: `${events[0]?.type} body missing required traceId` };
  }

  const usageDetails = normalizeUsage(body.usageDetails ?? body.usage);
  const latestTimestamp = events.map((e) => e.timestamp).filter(Boolean).at(-1);

  const observation: Observation = {
    id: body.id ?? ulid(),
    traceId: body.traceId,
    projectId,
    type,
    startTime: body.startTime ?? latestTimestamp ?? new Date().toISOString(),
    level: (body.level ?? "DEFAULT").toLowerCase() as Observation["level"],
    metadata: normalizeMetadata(body.metadata),
    ...(body.parentObservationId && { parentObservationId: body.parentObservationId }),
    ...(body.name && { name: body.name }),
    ...(body.endTime && { endTime: body.endTime }),
    ...(body.statusMessage && { statusMessage: body.statusMessage }),
    ...(body.model && { model: body.model }),
    ...(body.modelParameters && {
      modelParameters: normalizeModelParameters(body.modelParameters)
    }),
    ...(body.input !== undefined && { input: body.input }),
    ...(body.output !== undefined && { output: body.output }),
    ...(usageDetails && { usageDetails }),
    ...(body.costDetails && { costDetails: body.costDetails })
  };
  return { ok: true, row: observation };
}

function mapScore(projectId: string, event: LangfuseBatchEvent): MergedResult<Score> {
  const parsed = langfuseScoreBodySchema.safeParse(event.body);
  if (!parsed.success) return { ok: false, message: "invalid score-create body" };
  const body = parsed.data;

  // The wire schema's `value` is optional, but the domain scoreSchema
  // requires value OR stringValue — a value-less score would otherwise
  // map "successfully" into a row with both columns NULL,
  // indistinguishable from data loss (the exact bug class M5-06 fixed in
  // the LangSmith feedback mapper; found here by the M9-03 dead-letter
  // tests). Rejecting makes it a per-event mapping error, which now
  // dead-letters visibly instead of silently inserting an invalid row.
  if (body.value === undefined) {
    return { ok: false, message: "score requires a value" };
  }

  const isNumeric = typeof body.value === "number";
  const score: Score = {
    id: body.id ?? ulid(),
    projectId,
    traceId: body.traceId,
    name: body.name,
    dataType: isNumeric ? "numeric" : "categorical",
    // Ironside's ScoreSource enum ("api"|"eval"|"annotation") has no
    // import-specific value; this arrived via an API call (the compat
    // endpoint), so "api" is the correct fit — LangFuse-origin scores
    // aren't distinguished from native ones at this field.
    source: "api",
    metadata: {},
    ...(body.observationId && { observationId: body.observationId }),
    ...(isNumeric && { value: body.value as number }),
    ...(!isNumeric && body.value !== undefined && { stringValue: String(body.value) }),
    ...(body.comment && { comment: body.comment })
  };
  return { ok: true, row: score };
}

function normalizeMetadata(metadata: unknown): Record<string, string> {
  if (!metadata || typeof metadata !== "object") return {};
  return Object.fromEntries(
    Object.entries(metadata as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === "string" ? v : JSON.stringify(v)
    ])
  );
}

function normalizeModelParameters(
  params: Record<string, unknown>
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => {
      if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        return [k, v];
      }
      return [k, JSON.stringify(v)];
    })
  );
}

/** Collapses LangFuse's several historical usage shapes into a flat map with canonical key names (see usage-keys.ts). */
function normalizeUsage(usage: unknown): Record<string, number> | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;

  // Collect every numeric field (ignoring non-numeric ones like the
  // legacy usage shape's `unit` string), then canonicalize key names —
  // the previous hand-rolled mapping here silently DROPPED `total`/
  // `totalTokens` in the legacy-shape branch (only input/output were
  // mapped), a real "all data" violation fixed by M9-04's shared
  // canonicalizer, which maps every known alias and passes unknown keys
  // through.
  //
  // Rounded and negative-filtered to match the importers' identical
  // normalization (review-flagged asymmetry): the ClickHouse column is
  // Map(String, UInt64), and a single fractional or negative value —
  // LangFuse occasionally reports fractional aggregate units — would
  // otherwise throw at INSERT time and fail the ENTIRE multi-source
  // batch insert (not per-event dead-lettering; verified against real
  // ClickHouse: Code 72 for negatives, Code 563 for fractionals).
  const numeric: Record<string, number> = {};
  for (const [key, value] of Object.entries(u)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      numeric[key] = Math.round(value);
    }
  }
  if (Object.keys(numeric).length === 0) return undefined;
  return canonicalizeUsageKeys(numeric);
}
