import { canonicalizeUsageKeys } from "@ironside/mappers";
import { normalizeEnvironment, type Observation, type Score, type Trace } from "@ironside/shared";
import type {
  LangfuseListTrace,
  LangfuseObservation,
  LangfuseScore,
  LangfuseTraceDetail
} from "./langfuse-client.js";

/** Maps a LangFuse list-API trace to Ironside's domain Trace. Distinct from packages/mappers/src/langfuse.ts, which maps the ingestion (write) wire format — this maps the read/list API shape, which has different field presence guarantees. */
export function mapLangfuseListTrace(projectId: string, source: LangfuseListTrace): Trace {
  const tags = [...(source.tags ?? []), "imported:langfuse"];
  return {
    id: source.id,
    projectId,
    timestamp: source.timestamp,
    tags,
    metadata: normalizeMetadata(source.metadata),
    ...(source.name && { name: source.name }),
    ...(source.userId && { userId: source.userId }),
    ...(source.sessionId && { sessionId: source.sessionId }),
    ...(source.release && { release: source.release }),
    ...(source.version && { version: source.version }),
    ...(source.input !== undefined && { input: source.input }),
    ...(source.output !== undefined && { output: source.output })
  };
}

/** The full-detail variant: everything mapLangfuseListTrace maps, plus fields only the detail endpoint returns (environment). Observations and scores are mapped separately. */
export function mapLangfuseTraceDetail(projectId: string, source: LangfuseTraceDetail): Trace {
  const environment = normalizeEnvironment(source.environment);
  return {
    ...mapLangfuseListTrace(projectId, source),
    ...(environment !== null && { environment })
  };
}

// LangFuse returns uppercase enums (GENERATION/DEFAULT); Ironside's domain
// is lowercase, matching the ingest-side compat mapper's
// `.toLowerCase()` convention (packages/mappers/src/langfuse.ts). An
// unrecognized value falls back rather than dropping the row — "all data"
// means an unknown observation type still imports, as a span.
const OBSERVATION_TYPES = new Set(["span", "generation", "event"]);
const OBSERVATION_LEVELS = new Set(["debug", "default", "warning", "error"]);

export function mapLangfuseObservation(
  projectId: string,
  traceId: string,
  source: LangfuseObservation
): Observation {
  const rawType = (source.type ?? "").toLowerCase();
  const type = (OBSERVATION_TYPES.has(rawType) ? rawType : "span") as Observation["type"];
  const rawLevel = (source.level ?? "default").toLowerCase();
  const level = (OBSERVATION_LEVELS.has(rawLevel) ? rawLevel : "default") as Observation["level"];

  const usageDetails = normalizeUsageDetails(source.usageDetails);
  const costDetails = normalizeCostDetails(source);

  // Prompt linkage has no dedicated Ironside column — preserved in
  // metadata rather than dropped ("all data" directive).
  const metadata = normalizeMetadata(source.metadata);
  if (source.promptName) metadata["langfuse:promptName"] = source.promptName;
  if (source.promptVersion !== null && source.promptVersion !== undefined) {
    metadata["langfuse:promptVersion"] = String(source.promptVersion);
  }

  return {
    id: source.id,
    traceId,
    projectId,
    type,
    startTime: source.startTime,
    level,
    metadata,
    ...(source.parentObservationId && { parentObservationId: source.parentObservationId }),
    ...(source.name && { name: source.name }),
    ...(source.endTime && { endTime: source.endTime }),
    ...(source.completionStartTime && { completionStartTime: source.completionStartTime }),
    ...(source.statusMessage && { statusMessage: source.statusMessage }),
    ...(source.model && { model: source.model }),
    ...(source.modelParameters && { modelParameters: normalizeModelParameters(source.modelParameters) }),
    // `!== undefined` only (matching mapLangfuseListTrace and the
    // ingest-side compat mapper): an explicit null is data LangFuse
    // recorded and must survive the import, not be downgraded to
    // "field absent".
    ...(source.input !== undefined && { input: source.input }),
    ...(source.output !== undefined && { output: source.output }),
    ...(usageDetails && { usageDetails }),
    ...(costDetails && { costDetails })
  };
}

export function mapLangfuseScore(projectId: string, source: LangfuseScore): Score {
  const rawDataType = (source.dataType ?? "").toLowerCase();
  const dataType = (
    ["numeric", "categorical", "boolean"].includes(rawDataType)
      ? rawDataType
      : typeof source.value === "number"
        ? "numeric"
        : "categorical"
  ) as Score["dataType"];
  const rawSource = (source.source ?? "").toLowerCase();
  // LangFuse sources include API/EVAL/ANNOTATION; Ironside's enum matches
  // lowercase. Unknown → "api", same fallback the ingest-side compat
  // mapper uses.
  const scoreSource = (
    ["api", "eval", "annotation"].includes(rawSource) ? rawSource : "api"
  ) as Score["source"];

  return {
    id: source.id,
    projectId,
    traceId: source.traceId,
    name: source.name,
    dataType,
    source: scoreSource,
    metadata: normalizeMetadata(source.metadata),
    ...(source.observationId && { observationId: source.observationId }),
    // `value: 0` is meaningful (e.g. a thumbs-down) — null/undefined
    // checks, never truthiness.
    ...(source.value !== null && source.value !== undefined && { value: source.value }),
    ...(source.stringValue !== null && source.stringValue !== undefined && { stringValue: source.stringValue }),
    ...(source.comment && { comment: source.comment }),
    ...(source.timestamp && { timestamp: source.timestamp })
  };
}

function normalizeUsageDetails(
  usageDetails: Record<string, number> | null | undefined
): Record<string, number> | undefined {
  if (!usageDetails) return undefined;
  // Domain schema requires nonnegative integers; LangFuse occasionally
  // reports fractional aggregate units — round rather than drop. Key
  // names are then canonicalized (LangFuse's usageDetails uses
  // input/output/total; Ironside's convention is input_tokens/
  // output_tokens/total_tokens — M9-04) so cross-source token aggregates
  // sum under one vocabulary; unknown provider-specific keys pass through.
  const entries = Object.entries(usageDetails)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0)
    .map(([k, v]) => [k, Math.round(v)] as const);
  if (entries.length === 0) return undefined;
  return canonicalizeUsageKeys(Object.fromEntries(entries));
}

function normalizeCostDetails(source: LangfuseObservation): Record<string, number> | undefined {
  if (source.costDetails && Object.keys(source.costDetails).length > 0) {
    return source.costDetails;
  }
  // Fall back to the legacy calculated*Cost fields when the modern
  // costDetails record is absent — older LangFuse versions/rows only
  // populate the legacy fields.
  const legacy: Record<string, number> = {};
  if (typeof source.calculatedInputCost === "number") legacy.input = source.calculatedInputCost;
  if (typeof source.calculatedOutputCost === "number") legacy.output = source.calculatedOutputCost;
  if (typeof source.calculatedTotalCost === "number") legacy.total = source.calculatedTotalCost;
  return Object.keys(legacy).length > 0 ? legacy : undefined;
}

function normalizeModelParameters(
  params: Record<string, unknown>
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [
      k,
      typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null
        ? v
        : JSON.stringify(v)
    ])
  );
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
