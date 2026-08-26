# Usage-Key Canonicalization v1 (M9-04)

Status: implemented. Owner: `packages/mappers/src/usage-keys.ts` (shared canonicalizer), `packages/mappers/src/langfuse.ts`, `apps/worker/src/importers/{langfuse,langsmith}-mapper.ts`.

## Purpose

M9 Phase 1: the codebase's usage-key vocabulary had silently forked — the SDK wrappers, OTLP mapper, and LangFuse compat mapper wrote `input_tokens`/`output_tokens`, while the LangSmith importer wrote `input`/`output`/`total` and the LangFuse importer passed LangFuse's own `input`/`output`/`total` keys through untouched. `sumMap`-based token aggregates (`getAggregates`) split across two disjoint series for any project mixing sources. Flagged in `spec/direct-ingest-primacy-v1.md` (M4-05) as a deliberate deferral; fixed now, BEFORE real user data accumulates, since the migration cost only grows.

## Design

- **Canonical vocabulary: `input_tokens` / `output_tokens` / `total_tokens`** — the existing majority convention (SDK, OTLP via gen_ai semconv, compat mapper) and the one `domain.ts`'s own doc comment already documented.
- **One shared `canonicalizeUsageKeys`** (`@ironside/mappers`): maps every known alias (`input`/`output`/`total`, `promptTokens`/`completionTokens`/`totalTokens`, `prompt_tokens`/`completion_tokens`) to canonical names; **unknown keys pass through unchanged** (provider-specific series like `cache_read_input_tokens` are real data — the open record is the point of the schema). Collision rule: a canonical key present in the source wins over an alias targeting it, regardless of key order (two-pass, deterministic).
- **`costDetails` untouched** — its `input`/`output`/`total` convention was already consistent across every writer; only usage keys had forked.
- **No ClickHouse data rewrite** — local development data is disposable, so changing this contract requires a clean reset rather than mutation code.

## A bonus bug fixed: the compat mapper silently dropped `total`

The old hand-rolled `normalizeUsage` in the compat mapper only mapped `input`/`output` (and `promptTokens`/`completionTokens`) in its legacy-shape branch — `total`/`totalTokens` were dropped entirely, an "all data" violation its own code comment even alluded to. The canonicalizer-based rewrite collects every numeric field first, then renames — `total` now survives as `total_tokens`, pinned by updated compat-mapper tests.

## Verification

- `packages/mappers/test/usage-keys.test.ts` (4): all three alias vocabularies, unknown-key passthrough, canonical-beats-alias collision in both key orders, empty-in-empty-out.
- **The money test** — `apps/worker/test/usage-key-unification.test.ts`: runs the REAL LangSmith importer mapper (wire-shaped run, decimal-string costs) and the REAL LangFuse compat mapper (SDK legacy `{input, output, total}` usage shape) through real ClickHouse and asserts `getAggregates` returns ONE unified token series (`{input_tokens: 130, output_tokens: 70, total_tokens: 200}`) — the exact cross-source split this batch exists to fix. Verified to discriminate: reverting the LangSmith mapper change fails this test.
- Updated existing assertions across five test files (the old keys were load-bearing in ~8 assertions); full suite 366/366, stable across 6 consecutive runs.

## Two review findings, both fixed in-PR

1. **The compat path could poison an entire multi-source batch INSERT (pre-existing, newly load-bearing).** Unlike the importers' normalization, the compat mapper's `normalizeUsage` neither rounded fractionals nor dropped negatives — and the ClickHouse column is `Map(String, UInt64)`, so one fractional aggregate unit from a LangFuse SDK batch (their API occasionally reports them) threw at INSERT time and failed the WHOLE combined native+OTLP+LangFuse insert, not a per-event dead-letter (reviewer confirmed empirically against real ClickHouse: Code 72 for negatives, Code 563 for fractionals). Fixed: the compat path now rounds and negative-filters identically to the importers; pinned by a compat-mapper test that also covers the legacy shape's non-numeric `unit` string being ignored.
2. **The native ingest path could still write alias keys.** A hand-rolled client posting `usageDetails: {input: 5}` via `POST /api/v1/ingest` was schema-legal and re-created exactly the cross-source split this batch exists to kill. Fixed: the native mapper canonicalizes observation `usageDetails` — only KNOWN aliases are renamed; a caller's custom keys pass through untouched, so this rewrites ambiguity, not user data. Pinned by a native-mapper test.

Also pinned: alias-vs-alias collisions (two different aliases targeting one canonical key — malformed input) resolve first-in-key-order, documented as deterministic-with-no-deeper-meaning.
