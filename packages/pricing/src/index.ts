import { loadPriceTable, type ModelPrice, type PriceTable } from "./table.js";

export type { ModelPrice, PriceTable } from "./table.js";
export { loadPriceTable } from "./table.js";

/**
 * A project-defined price that takes precedence over the vendored table.
 * `pattern` is a case-insensitive regular expression tested against the
 * observation's model name; the first matching override (in list order) wins.
 */
export interface ModelPriceOverride extends ModelPrice {
  pattern: string;
}

export interface PriceResolution {
  price: ModelPrice;
  /** "override" = a project rule matched; "table" = the vendored table matched. */
  source: "override" | "table";
  /** The override pattern or table key that matched, for provenance. */
  matchedKey: string;
  /** Table sync date (table matches only), for provenance. */
  tableVersion?: string;
}

// Providers whose LiteLLM keys are prefixed (`gemini/gemini-2.5-pro`) while
// clients usually report the bare model name. Tried in this order after the
// bare candidates fail.
const PROVIDER_PREFIXES = [
  "openai",
  "anthropic",
  "gemini",
  "vertex_ai",
  "bedrock",
  "azure",
  "mistral",
  "groq",
  "deepseek",
  "xai",
  "cohere",
  "together_ai",
  "fireworks_ai",
  "openrouter"
];

/**
 * Candidate table keys for a reported model name, most specific first:
 * the name as reported, lower-cased, without a `provider/` prefix, without a
 * trailing date or version pin, then each of those under known provider
 * prefixes. Duplicates are removed while preserving order.
 */
export function modelNameCandidates(model: string): string[] {
  const bare: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !bare.includes(trimmed)) bare.push(trimmed);
  };

  push(model);
  push(model.toLowerCase());
  const lower = model.trim().toLowerCase();
  const withoutPrefix = lower.includes("/") ? lower.slice(lower.indexOf("/") + 1) : lower;
  push(withoutPrefix);
  for (const base of [lower, withoutPrefix]) {
    // claude-3-5-sonnet-20241022 / gpt-4o-2024-08-06 / claude-3-5-sonnet@20240620
    push(base.replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2})$/, ""));
    // gemini-1.5-pro-latest / llama3:latest
    push(base.replace(/[-:]latest$/, ""));
  }

  const candidates = [...bare];
  for (const prefix of PROVIDER_PREFIXES) {
    for (const candidate of bare) {
      const prefixed = `${prefix}/${candidate}`;
      if (!candidate.includes("/") && !candidates.includes(prefixed)) candidates.push(prefixed);
    }
  }
  return candidates;
}

function compileOverride(override: ModelPriceOverride): RegExp | null {
  try {
    return new RegExp(override.pattern, "i");
  } catch {
    return null;
  }
}

/**
 * Finds the price for a model: project overrides first (list order), then
 * the vendored table through the candidate chain. Returns null when nothing
 * matches — the caller must then leave cost absent, never zero.
 */
export function resolveModelPrice(
  model: string,
  options: { overrides?: ModelPriceOverride[]; table?: PriceTable } = {}
): PriceResolution | null {
  for (const override of options.overrides ?? []) {
    const regex = compileOverride(override);
    if (regex?.test(model)) {
      const { pattern, ...price } = override;
      return { price, source: "override", matchedKey: pattern };
    }
  }

  const table = options.table ?? loadPriceTable();
  for (const candidate of modelNameCandidates(model)) {
    const entry = table.models[candidate];
    if (entry) {
      const { provider: _provider, ...price } = entry;
      return { price, source: "table", matchedKey: candidate, tableVersion: table.syncedAt };
    }
  }
  return null;
}

// Canonical usage keys (spec/usage-keys-v1.md) plus the cache series the
// Anthropic-shaped sources report as separate, non-overlapping counts.
const USAGE_KEY_FOR_COMPONENT: Record<keyof ModelPrice, string> = {
  input: "input_tokens",
  output: "output_tokens",
  cache_read: "cache_read_input_tokens",
  cache_write: "cache_creation_input_tokens"
};

/** Decimal64(9) in ClickHouse; also keeps floating-point sums tidy. */
function round9(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/**
 * Multiplies each priced component by its token count. A component is
 * emitted only when both the count and the price exist, so an unpriced
 * cache series is left out rather than billed at zero. Returns null when no
 * component could be priced (e.g. usage has only unknown keys).
 */
export function computeCostDetails(
  usageDetails: Record<string, number>,
  price: ModelPrice
): Record<string, number> | null {
  const cost: Record<string, number> = {};
  let total = 0;
  let priced = false;
  for (const component of Object.keys(USAGE_KEY_FOR_COMPONENT) as (keyof ModelPrice)[]) {
    const perToken = price[component];
    const tokens = usageDetails[USAGE_KEY_FOR_COMPONENT[component]];
    if (perToken === undefined || typeof tokens !== "number" || !Number.isFinite(tokens)) continue;
    const amount = round9(tokens * perToken);
    cost[component] = amount;
    total += amount;
    priced = true;
  }
  if (!priced) return null;
  cost.total = round9(total);
  return cost;
}

export const COST_SOURCE_METADATA_KEY = "ironside:cost_source";
export const COST_MODEL_METADATA_KEY = "ironside:cost_model";
export const COST_TABLE_METADATA_KEY = "ironside:cost_table";

export interface CostEnrichable {
  model?: string | undefined;
  usageDetails?: Record<string, number> | undefined;
  costDetails?: Record<string, number> | undefined;
  metadata: Record<string, string>;
}

/**
 * Fills in `costDetails` for an observation that reports usage and a model
 * but no cost. Client-sent cost always wins (any non-empty costDetails is
 * left untouched), matching the contract that Ironside stores what the
 * source said and only derives what the source omitted. Provenance is
 * recorded in metadata so a number can later be traced to the price that
 * produced it. Returns true when cost was added.
 */
export function enrichObservationCost<T extends CostEnrichable>(
  observation: T,
  options: { overrides?: ModelPriceOverride[]; table?: PriceTable } = {}
): boolean {
  if (observation.costDetails && Object.keys(observation.costDetails).length > 0) return false;
  if (!observation.model || !observation.usageDetails) return false;

  const resolution = resolveModelPrice(observation.model, options);
  if (!resolution) return false;
  const cost = computeCostDetails(observation.usageDetails, resolution.price);
  if (!cost) return false;

  observation.costDetails = cost;
  observation.metadata = {
    ...observation.metadata,
    [COST_SOURCE_METADATA_KEY]: resolution.source,
    [COST_MODEL_METADATA_KEY]: resolution.matchedKey,
    ...(resolution.tableVersion !== undefined && { [COST_TABLE_METADATA_KEY]: resolution.tableVersion })
  };
  return true;
}
