import type { IngestEvent, Observation, Score, Trace } from "@ironside/shared";
import {
  normalizeEnvironment,
  observationSchema,
  scoreObjectSchema,
  traceSchema
} from "@ironside/shared";
import { z } from "zod";
import { canonicalizeUsageKeys } from "./usage-keys.js";

// Native ingest bodies are domain-shaped minus projectId (the server injects
// it from the authenticated batch — clients never control it). Reusing the
// domain schemas via omit keeps this mapper a thin, always-in-sync adapter
// rather than a second hand-maintained schema. Scores use the pre-refine
// scoreObjectSchema (zod v4 disallows .omit() after .refine()); the
// value/stringValue invariant is re-applied manually below in mapOne, since
// omitting drops it and nothing upstream (API validation) checks it either —
// body is z.unknown() there.
const nativeTraceBodySchema = traceSchema.omit({ projectId: true });
const nativeObservationBodySchema = observationSchema.omit({ projectId: true });
const nativeScoreBodySchema = scoreObjectSchema.omit({ projectId: true });

export interface MappedRows {
  traces: Trace[];
  observations: Observation[];
  scores: Score[];
}

export interface MapperError {
  eventId: string;
  message: string;
}

export interface MapResult {
  rows: MappedRows;
  errors: MapperError[];
}

function emptyRows(): MappedRows {
  return { traces: [], observations: [], scores: [] };
}

/**
 * Maps native-source IngestEvents to domain rows. A malformed event is
 * skipped and recorded in `errors` rather than failing the whole batch —
 * one bad event must not block the rest of a project's traces.
 */
export function mapNativeEvents(projectId: string, events: IngestEvent[]): MapResult {
  const rows = emptyRows();
  const errors: MapperError[] = [];

  for (const event of events) {
    if (event.source !== "native") continue;

    const result = mapOne(projectId, event);
    if (!result.ok) {
      errors.push({ eventId: event.id, message: result.message });
      continue;
    }
    if (event.type === "trace-upsert") rows.traces.push(result.value as Trace);
    else if (event.type === "observation-upsert")
      rows.observations.push(result.value as Observation);
    else rows.scores.push(result.value as Score);
  }

  return { rows, errors };
}

type MapOneResult =
  | { ok: true; value: Trace | Observation | Score }
  | { ok: false; message: string };

function mapOne(projectId: string, event: IngestEvent): MapOneResult {
  const schema =
    event.type === "trace-upsert"
      ? nativeTraceBodySchema
      : event.type === "observation-upsert"
        ? nativeObservationBodySchema
        : nativeScoreBodySchema;

  const parsed = schema.safeParse(
    event.type === "trace-upsert" ? normalizeTraceEnvironment(event.body) : event.body
  );
  if (!parsed.success) {
    return { ok: false, message: z.prettifyError(parsed.error) };
  }
  if (
    event.type === "score-upsert" &&
    (parsed.data as { value?: unknown; stringValue?: unknown }).value === undefined &&
    (parsed.data as { value?: unknown; stringValue?: unknown }).stringValue === undefined
  ) {
    return { ok: false, message: "score requires value or stringValue" };
  }
  // Observation usageDetails keys are canonicalized (M9-04) so a
  // hand-rolled native client posting {input: 5} doesn't silently
  // re-split token aggregates from the canonical input_tokens series —
  // the exact cross-source fork the shared canonicalizer exists to kill.
  // Only KNOWN aliases are renamed; a caller's custom keys pass through
  // untouched, so this rewrites ambiguity, not user data.
  const value = { ...parsed.data, projectId };
  if (event.type === "observation-upsert") {
    const usage = (value as { usageDetails?: Record<string, number> }).usageDetails;
    if (usage) {
      (value as { usageDetails?: Record<string, number> }).usageDetails =
        canonicalizeUsageKeys(usage);
    }
  }
  return { ok: true, value };
}

/** Invalid optional environment metadata must not discard the whole trace. */
function normalizeTraceEnvironment(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("environment" in body)) {
    return body;
  }
  const normalized = normalizeEnvironment((body as { environment?: unknown }).environment);
  const { environment: _environment, ...rest } = body as Record<string, unknown>;
  return normalized === null ? rest : { ...rest, environment: normalized };
}
