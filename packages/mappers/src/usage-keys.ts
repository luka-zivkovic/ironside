// Canonical usage-key convention (M9-04): `input_tokens`, `output_tokens`,
// `total_tokens`. Before this, writers disagreed — the SDK wrappers, OTLP
// mapper, and LangFuse compat mapper wrote `input_tokens`/`output_tokens`,
// while the LangSmith importer (and LangFuse importer passthrough) wrote
// `input`/`output`/`total` — so `sumMap`-based token aggregates
// (packages/clickhouse getAggregates) silently split across two key
// vocabularies for any project mixing sources. Flagged in
// spec/direct-ingest-primacy-v1.md; fixed here BEFORE real user data
// accumulates, since the migration cost only grows.
//
// Unknown keys pass through untouched — provider-specific series like
// cache_read_input_tokens/reasoning_output_tokens are real data ("all
// data I can get") and an open record is the point of the schema.
// costDetails is NOT touched by this: its `input`/`output`/`total`
// convention was already consistent across every writer.

const CANONICAL_ALIASES: Record<string, string> = {
  input: "input_tokens",
  output: "output_tokens",
  total: "total_tokens",
  promptTokens: "input_tokens",
  completionTokens: "output_tokens",
  totalTokens: "total_tokens",
  prompt_tokens: "input_tokens",
  completion_tokens: "output_tokens"
};

/**
 * Renames known usage-key aliases to the canonical vocabulary, passing
 * unknown keys through unchanged. If both an alias and its canonical key
 * are present (a malformed source), the canonical key's value wins and
 * the alias's value is dropped — preferring the value the source
 * explicitly labeled canonically. If two DIFFERENT aliases map to the
 * same target (also malformed), the first in the object's key order wins
 * — deterministic for a given input object, with no deeper meaning.
 */
export function canonicalizeUsageKeys(
  usage: Record<string, number>
): Record<string, number> {
  const result: Record<string, number> = {};
  // Two passes so a canonical key present in the source always wins over
  // an alias mapping to the same target, regardless of key order.
  for (const [key, value] of Object.entries(usage)) {
    if (!(key in CANONICAL_ALIASES)) result[key] = value;
  }
  for (const [key, value] of Object.entries(usage)) {
    const canonical = CANONICAL_ALIASES[key];
    if (canonical && !(canonical in result)) result[canonical] = value;
  }
  return result;
}
