import type { Observation, Trace } from "@ironside/shared";
import { Buffer } from "node:buffer";
import {
  attributeValueToString,
  flattenOtlpSpans,
  getAttributeNumber,
  getAttributeString,
  normalizeEnvironment,
  unixNanoToIso,
  type OtlpExportTraceServiceRequest
} from "@ironside/shared";

// Maps OTLP spans -> Ironside's domain model. A span with no parentSpanId
// is the trace root; its traceId becomes the Trace id. All spans (root
// included) also become Observations, so the root span's own
// name/timing/attributes are preserved rather than discarded once "promoted"
// to a trace. gen_ai.* attributes (still Development-stability upstream;
// gen_ai.system was renamed to gen_ai.provider.name mid-2026) populate
// model/usage/cost when present; every other attribute is preserved in
// metadata as a string so nothing is silently dropped — the core
// "data flexibility" promise for a spec still in flux.

const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
const GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages";
const GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages";
/** gen_ai.provider.name (current) supersedes gen_ai.system (legacy, pre-rename). */
const GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";
const GEN_AI_SYSTEM_LEGACY = "gen_ai.system";
const DEPLOYMENT_ENVIRONMENT_NAME = "deployment.environment.name";
const DEPLOYMENT_ENVIRONMENT_LEGACY = "deployment.environment";

// Request sampling parameters — verified against the live semconv registry
// (open-telemetry/semantic-conventions-genai, model/gen-ai/registry.yaml).
// All still Development-stability, same caveat as the usage/model
// attributes above. gen_ai.request.stop_sequences (a string array) isn't
// included here since modelParameters values are scalar-only — it still
// survives, un-dropped, via attributesToMetadata's generic JSON fallback.
const GEN_AI_REQUEST_MODEL_PARAMETERS = [
  "gen_ai.request.temperature",
  "gen_ai.request.max_tokens",
  "gen_ai.request.top_p",
  "gen_ai.request.top_k",
  "gen_ai.request.frequency_penalty",
  "gen_ai.request.presence_penalty",
  "gen_ai.request.seed"
] as const;

export interface MappedOtlpRows {
  traces: Trace[];
  observations: Observation[];
}

export function mapOtlpTraceRequest(
  projectId: string,
  request: OtlpExportTraceServiceRequest
): MappedOtlpRows {
  const flattened = flattenOtlpSpans(request);
  const traces = new Map<string, Trace>();
  const observations: Observation[] = [];
  const messageProjectionBudget: ProjectionBudget = {
    remainingNodes: MAX_EXPORT_MESSAGE_PROJECTION_NODES,
    remainingBytes: MAX_EXPORT_MESSAGE_PROJECTION_BYTES
  };

  for (const { span, resourceAttributes } of flattened) {
    const attrs = span.attributes ?? [];
    const startTime = unixNanoToIso(span.startTimeUnixNano);
    const endTime = span.endTimeUnixNano ? unixNanoToIso(span.endTimeUnixNano) : undefined;
    const metadata = attributesToMetadata(attrs);

    const isRoot = !span.parentSpanId;
    if (isRoot && !traces.has(span.traceId)) {
      const currentEnvironment = getAttributeString(
        resourceAttributes,
        DEPLOYMENT_ENVIRONMENT_NAME
      );
      const rawEnvironment =
        currentEnvironment !== undefined
          ? currentEnvironment
          : getAttributeString(resourceAttributes, DEPLOYMENT_ENVIRONMENT_LEGACY);
      const environment = normalizeEnvironment(rawEnvironment);
      traces.set(span.traceId, {
        id: span.traceId,
        projectId,
        timestamp: startTime,
        name: span.name,
        tags: [],
        metadata: attributesToMetadata(resourceAttributes),
        ...(environment !== null && { environment })
      });
    }

    const model = getAttributeString(attrs, GEN_AI_REQUEST_MODEL) ??
      getAttributeString(attrs, GEN_AI_RESPONSE_MODEL);
    const provider = getAttributeString(attrs, GEN_AI_PROVIDER_NAME) ??
      getAttributeString(attrs, GEN_AI_SYSTEM_LEGACY);
    const inputTokens = getAttributeNumber(attrs, GEN_AI_USAGE_INPUT_TOKENS);
    const outputTokens = getAttributeNumber(attrs, GEN_AI_USAGE_OUTPUT_TOKENS);
    const input = extractGenAiMessages(attrs, GEN_AI_INPUT_MESSAGES, "input", messageProjectionBudget);
    const output = extractGenAiMessages(attrs, GEN_AI_OUTPUT_MESSAGES, "output", messageProjectionBudget);
    const modelParameters = extractModelParameters(attrs);
    const isGeneration = attrs.some((a) => a.key === GEN_AI_OPERATION_NAME) || model !== undefined;

    // Normalize under the current attribute name so callers can always look
    // up "gen_ai.provider.name" regardless of which spec revision the
    // client's instrumentation emits; the raw legacy key (if present) is
    // still preserved as-is via attributesToMetadata below.
    if (provider) metadata["gen_ai.provider.name"] = provider;

    const observation: Observation = {
      id: span.spanId,
      traceId: span.traceId,
      projectId,
      type: isGeneration ? "generation" : "span",
      name: span.name,
      startTime,
      level: span.status?.code === 2 /* STATUS_CODE_ERROR */ ? "error" : "default",
      metadata
    };
    if (span.parentSpanId) observation.parentObservationId = span.parentSpanId;
    if (endTime) observation.endTime = endTime;
    if (model) observation.model = model;
    if (modelParameters) observation.modelParameters = modelParameters;
    if (span.status?.message) observation.statusMessage = span.status.message;
    if (input !== undefined) observation.input = input;
    if (output !== undefined) observation.output = output;
    if (inputTokens !== undefined || outputTokens !== undefined) {
      observation.usageDetails = {
        ...(inputTokens !== undefined && { input_tokens: inputTokens }),
        ...(outputTokens !== undefined && { output_tokens: outputTokens })
      };
    }
    observations.push(observation);
  }

  return { traces: [...traces.values()], observations };
}

const INVALID_ANY_VALUE = Symbol("invalid OTLP AnyValue");
const MAX_MESSAGE_PROJECTION_BYTES = 128 * 1024;
const MAX_MESSAGE_PROJECTION_NODES = 10_000;
const MAX_EXPORT_MESSAGE_PROJECTION_BYTES = 512 * 1024;
const MAX_EXPORT_MESSAGE_PROJECTION_NODES = 50_000;
const MAX_MESSAGE_COUNT = 200;
const MAX_MESSAGE_PARTS = 200;

interface ProjectionBudget {
  remainingNodes: number;
  remainingBytes: number;
}

/**
 * Message content is standardized as an OTLP `any` attribute. On spans it
 * may arrive either as structured AnyValue data or as a JSON string. This is
 * a projection into the query model only: attributesToMetadata still keeps
 * the source attribute intact for inspection and the raw envelope remains
 * the storage authority.
 */
function extractGenAiMessages(
  attributes: { key: string; value?: unknown }[],
  key: string,
  kind: "input" | "output",
  exportBudget: ProjectionBudget
): unknown[] | undefined {
  const value = attributes.find((attribute) => attribute.key === key)?.value;
  if (!isRecord(value) || exportBudget.remainingNodes <= 0 || exportBudget.remainingBytes <= 0) return undefined;

  let decoded: unknown;
  if (typeof value.stringValue === "string") {
    const encodedBytes = Buffer.byteLength(value.stringValue, "utf8");
    if (
      encodedBytes > MAX_MESSAGE_PROJECTION_BYTES ||
      !consumeByteCount([exportBudget], encodedBytes)
    ) return undefined;
    try {
      decoded = parseJsonPreservingUnsafeNumbers(value.stringValue, exportBudget);
    } catch {
      return undefined;
    }
  } else {
    const attributeBudget: ProjectionBudget = {
      remainingNodes: MAX_MESSAGE_PROJECTION_NODES,
      remainingBytes: MAX_MESSAGE_PROJECTION_BYTES
    };
    decoded = unwrapAnyValue(value, [attributeBudget, exportBudget]);
    if (decoded === INVALID_ANY_VALUE) return undefined;
  }

  return isStandardMessageArray(decoded, kind) ? decoded : undefined;
}

function unwrapAnyValue(value: unknown, budgets: ProjectionBudget[]): unknown | typeof INVALID_ANY_VALUE {
  if (!isRecord(value) || !consumeNode(budgets)) return INVALID_ANY_VALUE;
  if (typeof value.stringValue === "string") {
    return consumeBytes(budgets, value.stringValue) ? value.stringValue : INVALID_ANY_VALUE;
  }
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (typeof value.doubleValue === "number") return value.doubleValue;
  if (typeof value.bytesValue === "string") {
    return consumeBytes(budgets, value.bytesValue) ? value.bytesValue : INVALID_ANY_VALUE;
  }
  if (typeof value.intValue === "string" || typeof value.intValue === "number") {
    if (typeof value.intValue === "string" && !consumeBytes(budgets, value.intValue)) return INVALID_ANY_VALUE;
    return normalizeOtlpInteger(value.intValue);
  }

  if (isRecord(value.arrayValue)) {
    const values = value.arrayValue.values;
    if (values === undefined) return [];
    if (!Array.isArray(values)) return INVALID_ANY_VALUE;
    const decoded: unknown[] = [];
    for (const item of values) {
      const unwrapped = unwrapAnyValue(item, budgets);
      if (unwrapped === INVALID_ANY_VALUE) return INVALID_ANY_VALUE;
      decoded.push(unwrapped);
    }
    return decoded;
  }

  if (isRecord(value.kvlistValue)) {
    const values = value.kvlistValue.values;
    if (values === undefined) return {};
    if (!Array.isArray(values)) return INVALID_ANY_VALUE;

    const entries: Array<[string, unknown]> = [];
    const keys = new Set<string>();
    for (const entry of values) {
      if (
        !isRecord(entry) ||
        typeof entry.key !== "string" ||
        keys.has(entry.key) ||
        !consumeBytes(budgets, entry.key)
      ) return INVALID_ANY_VALUE;
      const decoded = unwrapAnyValue(entry.value, budgets);
      if (decoded === INVALID_ANY_VALUE) return INVALID_ANY_VALUE;
      keys.add(entry.key);
      entries.push([entry.key, decoded]);
    }
    return Object.fromEntries(entries);
  }

  return INVALID_ANY_VALUE;
}

function normalizeOtlpInteger(value: string | number): string | number {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : String(value);
  if (value.length > 64) return value;
  try {
    const integer = BigInt(value);
    return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(integer)
      : value;
  } catch {
    return value;
  }
}

function parseJsonPreservingUnsafeNumbers(value: string, exportBudget: ProjectionBudget): unknown {
  const parseWithSource = JSON.parse as (
    text: string,
    reviver: (key: string, value: unknown, context: { source?: string }) => unknown
  ) => unknown;

  let nodes = 0;
  return parseWithSource(value, (_key, parsed, context) => {
    nodes += 1;
    if (
      nodes > MAX_MESSAGE_PROJECTION_NODES ||
      !consumeNode([exportBudget])
    ) throw new RangeError("GenAI message projection exceeds node budget");
    if (
      typeof parsed === "number" &&
      (!Number.isFinite(parsed) || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))) &&
      context.source
    ) {
      return context.source;
    }
    return parsed;
  });
}

function isStandardMessageArray(value: unknown, kind: "input" | "output"): value is unknown[] {
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_COUNT) return false;

  let partCount = 0;
  for (const message of value) {
    if (
      !isRecord(message) ||
      typeof message.role !== "string" ||
      !Array.isArray(message.parts) ||
      (kind === "output" && typeof message.finish_reason !== "string")
    ) return false;

    partCount += message.parts.length;
    if (partCount > MAX_MESSAGE_PARTS) return false;
    if (!message.parts.every((part) => isRecord(part) && typeof part.type === "string")) return false;
  }
  return true;
}

function consumeNode(budgets: ProjectionBudget[]): boolean {
  let withinBudget = true;
  for (const budget of budgets) {
    budget.remainingNodes -= 1;
    if (budget.remainingNodes < 0) withinBudget = false;
  }
  return withinBudget;
}

function consumeBytes(budgets: ProjectionBudget[], value: string): boolean {
  return consumeByteCount(budgets, Buffer.byteLength(value, "utf8"));
}

function consumeByteCount(budgets: ProjectionBudget[], bytes: number): boolean {
  let withinBudget = true;
  for (const budget of budgets) {
    budget.remainingBytes -= bytes;
    if (budget.remainingBytes < 0) withinBudget = false;
  }
  return withinBudget;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractModelParameters(
  attrs: { key: string; value?: unknown }[]
): Record<string, number> | undefined {
  const entries = GEN_AI_REQUEST_MODEL_PARAMETERS.map(
    (key) => [key.replace("gen_ai.request.", ""), getAttributeNumber(attrs, key)] as const
  ).filter((entry): entry is [string, number] => entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function attributesToMetadata(
  attributes: { key: string; value?: unknown }[]
): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const attr of attributes) {
    metadata[attr.key] = attributeValueToString(attr.value);
  }
  return metadata;
}
