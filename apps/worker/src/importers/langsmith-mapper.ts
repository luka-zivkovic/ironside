import type { Observation, Score, Trace } from "@ironside/shared";
import type { LangsmithFeedback, LangsmithRun } from "./langsmith-client.js";

/** Maps a LangSmith root run to Ironside's domain Trace. */
export function mapLangsmithRun(projectId: string, run: LangsmithRun): Trace {
  const tags = [...(run.tags ?? []), "imported:langsmith"];
  return {
    id: run.trace_id ?? run.id,
    projectId,
    timestamp: run.start_time,
    tags,
    metadata: normalizeMetadata(run.extra, run.metadata),
    ...(run.name && { name: run.name }),
    ...(run.session_id && { sessionId: run.session_id }),
    ...(run.inputs !== undefined && { input: run.inputs }),
    ...(run.outputs !== undefined && { output: run.outputs })
  };
}

// LangSmith's run_type has no direct Ironside equivalent — "llm" maps to
// generation (the type Ironside's cost/usage columns are meant for);
// every other run_type (tool/chain/retriever/embedding/prompt/parser)
// maps to span, with the original type preserved in metadata so it isn't
// lost. There is no "event" equivalent in LangSmith's run model.
export function mapLangsmithObservation(
  projectId: string,
  traceId: string,
  run: LangsmithRun
): Observation {
  const type: Observation["type"] = run.run_type === "llm" ? "generation" : "span";
  const metadata = normalizeMetadata(run.extra, run.metadata);
  if (run.run_type) metadata["langsmith:runType"] = run.run_type;

  const usageDetails = normalizeUsageDetails(run);
  const costDetails = normalizeCostDetails(run);

  return {
    id: run.id,
    traceId,
    projectId,
    type,
    startTime: run.start_time,
    // LangSmith's status ("success"/"error"/"pending") maps to Ironside's
    // level as a best-effort signal, not a lossless mapping — the
    // original status string survives in statusMessage/metadata
    // regardless.
    level: run.status === "error" || run.error ? "error" : "default",
    metadata,
    ...(run.parent_run_id && { parentObservationId: run.parent_run_id }),
    ...(run.name && { name: run.name }),
    ...(run.end_time && { endTime: run.end_time }),
    ...(run.first_token_time && { completionStartTime: run.first_token_time }),
    // error takes precedence as the human-readable status message when
    // present; falls back to the raw status string otherwise.
    ...((run.error || run.status) && { statusMessage: run.error ?? run.status ?? undefined }),
    ...(run.inputs !== undefined && { input: run.inputs }),
    ...(run.outputs !== undefined && { output: run.outputs }),
    ...(usageDetails && { usageDetails }),
    ...(costDetails && { costDetails })
  };
}

/**
 * Maps LangSmith feedback to an Ironside Score, or null when the feedback
 * carries neither a numeric score nor a categorical value — the domain
 * Score schema requires at least one (packages/shared/src/domain.ts),
 * and a comment/correction-only feedback entry with neither would
 * otherwise produce an invalid Score silently written with both columns
 * null, indistinguishable from data loss. The caller (runLangsmithImport)
 * must skip a null return, not insert it.
 */
export function mapLangsmithFeedback(projectId: string, traceId: string, feedback: LangsmithFeedback): Score | null {
  const isNumeric = typeof feedback.score === "number";
  // LangSmith feedback can carry BOTH a numeric score (e.g. 1) and a
  // categorical value (e.g. "thumbs_up") simultaneously — neither field
  // implies the absence of the other in the schema. Computed
  // independently of isNumeric so a categorical value is never silently
  // dropped just because a numeric score is also present ("all data I
  // can get").
  const stringValue = feedback.value !== undefined && feedback.value !== null
    ? typeof feedback.value === "string"
      ? feedback.value
      : JSON.stringify(feedback.value)
    : undefined;

  if (!isNumeric && stringValue === undefined) return null;

  return {
    id: feedback.id,
    projectId,
    traceId,
    name: feedback.key,
    dataType: isNumeric ? "numeric" : "categorical",
    // LangSmith feedback has no direct source taxonomy exposed in the
    // list response beyond feedback_source's free-form type field;
    // "api" matches the ingest-side compat mapper's fallback for
    // externally-sourced scores.
    source: "api",
    metadata: {},
    ...(observationIdOf(feedback, traceId) && { observationId: observationIdOf(feedback, traceId) }),
    // score 0 is meaningful (e.g. thumbs-down) — null/undefined check,
    // never truthiness.
    ...(isNumeric && { value: feedback.score as number }),
    ...(stringValue !== undefined && { stringValue }),
    ...(feedback.comment && { comment: feedback.comment }),
    ...(feedback.created_at && { timestamp: feedback.created_at })
  };
}

// The feedback's run_id, if it points at a CHILD observation rather than
// the trace's own root run — feedback on the root run itself has no
// dedicated Ironside observationId (it's trace-level), so this is
// omitted specifically when run_id === traceId. Compares against the
// IMPORTER'S resolved traceId (rootRun.trace_id ?? rootRun.id), not
// feedback.trace_id — the feedback API's own trace_id field is
// independently nullable/optional and not guaranteed to match, which
// would misclassify root-run feedback as child-observation feedback.
function observationIdOf(feedback: LangsmithFeedback, traceId: string): string | undefined {
  if (!feedback.run_id || feedback.run_id === traceId) return undefined;
  return feedback.run_id;
}

function normalizeUsageDetails(run: LangsmithRun): Record<string, number> | undefined {
  const entries: [string, number][] = [];
  // Canonical usage-key vocabulary (input_tokens/output_tokens/
  // total_tokens, M9-04) — this mapper previously wrote input/output/
  // total, splitting cross-source token aggregates across two key sets.
  if (typeof run.prompt_tokens === "number" && run.prompt_tokens >= 0) {
    entries.push(["input_tokens", Math.round(run.prompt_tokens)]);
  }
  if (typeof run.completion_tokens === "number" && run.completion_tokens >= 0) {
    entries.push(["output_tokens", Math.round(run.completion_tokens)]);
  }
  if (typeof run.total_tokens === "number" && run.total_tokens >= 0) {
    entries.push(["total_tokens", Math.round(run.total_tokens)]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// Costs arrive as decimal STRINGS (e.g. "0.00123"), not JSON numbers —
// parsed here, at the mapping boundary, rather than in the Zod schema,
// so a malformed cost string is caught by this function's own
// Number.isFinite guard instead of silently coercing to NaN via
// z.coerce.number() at parse time.
function normalizeCostDetails(run: LangsmithRun): Record<string, number> | undefined {
  const entries: [string, number][] = [];
  const input = parseCost(run.prompt_cost);
  const output = parseCost(run.completion_cost);
  const total = parseCost(run.total_cost);
  if (input !== undefined) entries.push(["input", input]);
  if (output !== undefined) entries.push(["output", output]);
  if (total !== undefined) entries.push(["total", total]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseCost(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeMetadata(
  extra: unknown,
  metadata?: Record<string, unknown> | null
): Record<string, string> {
  const combined: Record<string, unknown> = {};
  if (extra && typeof extra === "object") Object.assign(combined, extra);
  if (metadata && typeof metadata === "object") Object.assign(combined, metadata);
  return Object.fromEntries(
    Object.entries(combined).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
  );
}
