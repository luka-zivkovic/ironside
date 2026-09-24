# Usage-Key Canonicalization v1

Status: implemented. Owner: `packages/mappers/src/usage-keys.ts`, `packages/mappers/src/native.ts`, `packages/mappers/src/langfuse.ts`, `apps/worker/src/importers/langfuse-mapper.ts`, `apps/worker/src/importers/langsmith-mapper.ts`.

## Purpose

Every writer stores observation token usage under one key vocabulary, so per-key usage aggregates (`getAggregates`) and cost derivation (`spec/cost-pricing-v1.md`) see one series per quantity in a project that mixes ingest and import sources.

## Canonical keys

The canonical keys are `input_tokens`, `output_tokens`, and `total_tokens`. Any other key is kept as sent: provider-specific series such as `cache_read_input_tokens` are real data, and `usageDetails` is an open record.

`canonicalizeUsageKeys` (exported from `@ironside/mappers`) renames the known aliases:

| Alias | Canonical key |
| --- | --- |
| `input`, `promptTokens`, `prompt_tokens` | `input_tokens` |
| `output`, `completionTokens`, `completion_tokens` | `output_tokens` |
| `total`, `totalTokens` | `total_tokens` |

- Unknown keys pass through unchanged.
- When a canonical key and an alias of it are both present, the canonical key's value wins regardless of key order. The function makes two passes to guarantee this.
- When two different aliases map to the same canonical key (malformed input), the first in the object's key order wins. This is deterministic for a given object and has no other meaning.

`costDetails` is not canonicalized: every writer already uses `input`, `output` and `total` for cost.

## Writers

| Writer | Usage handling |
| --- | --- |
| `ironside` SDK wrappers | Write canonical keys directly. OpenAI `prompt_tokens`/`completion_tokens`, Anthropic `input_tokens`/`output_tokens`, and the Vercel AI SDK's `inputTokens`/`outputTokens` become `input_tokens`/`output_tokens`. |
| OTLP mapper | `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` become `input_tokens` and `output_tokens` (`spec/otlp-ingest-v1.md`). |
| Native JSON (`packages/mappers/src/native.ts`) | Observation `usageDetails` pass through `canonicalizeUsageKeys` after validation. Only known aliases are renamed, so a client that sends `{input: 5}` lands in the canonical series while its custom keys stay as sent. |
| LangFuse-compatible ingest (`packages/mappers/src/langfuse.ts`) | Takes every numeric field of `usageDetails`, or of the legacy `usage` shape, ignoring non-numeric fields such as the legacy `unit`, then canonicalizes. |
| LangFuse importer | Canonicalizes LangFuse's `usageDetails`. |
| LangSmith importer | Maps `prompt_tokens`, `completion_tokens` and `total_tokens` to the canonical keys directly. |

Values must end up as nonnegative integers, because the ClickHouse column is `Map(LowCardinality(String), UInt64)` and one invalid value fails the insert of the whole batch, which can hold rows from several sources, rather than a single event.

- The native mapper validates `usageDetails` against the domain schema. A fractional or negative value fails only that event, which is recorded as a dead letter (`spec/dead-letters-v1.md`).
- The OTLP mapper, the LangFuse-compatible mapper and both importers round fractional values to the nearest integer and drop negative and non-finite values.

## Readers

- `getAggregates` sums `usage_details` per key.
- Per-observation token counts in trace queries use `total_tokens` when present and `input_tokens` plus `output_tokens` otherwise. Other keys, such as cache reads, can overlap those and are not added (`packages/clickhouse/src/queries.ts`).
- Cost derivation prices `input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` (`spec/cost-pricing-v1.md`).

Changing this vocabulary for stored rows requires a data migration (`docs/schema-migrations.md`).

## Verified

`packages/mappers/test/usage-keys.test.ts` covers all three alias vocabularies, passthrough of canonical and unknown keys, a canonical key beating its alias in both key orders, the alias-against-alias rule, and empty input. `apps/worker/test/usage-key-unification.test.ts` runs the LangSmith importer mapper and the LangFuse-compatible mapper (legacy `{input, output, total}` usage) through real ClickHouse and asserts that `getAggregates` returns one token series, `{input_tokens: 130, output_tokens: 70, total_tokens: 200}`. `packages/mappers/test/native.test.ts` covers alias canonicalization on native ingest. `packages/mappers/test/langfuse.test.ts` covers the legacy and camelCase usage shapes, rounding, dropped negatives, and the ignored `unit` field. `apps/worker/test/langfuse-mapper.test.ts` and `apps/worker/test/langsmith-mapper.test.ts` cover rounding and canonical keys in the importers.

## History

- M9-04 introduced the canonical vocabulary. Before it, the SDK wrappers, the OTLP mapper and the LangFuse-compatible mapper wrote `input_tokens`/`output_tokens`, while the LangSmith importer wrote `input`/`output`/`total` and the LangFuse importer passed LangFuse's `input`/`output`/`total` through, so token aggregates split into two disjoint series for any project mixing sources. The M4-05 audit had flagged the split and deferred it (`spec/direct-ingest-primacy-v1.md`). The canonical names were already the majority convention and the one documented on the domain schema.
- The LangFuse-compatible mapper's earlier hand-written normalization dropped `total` and `totalTokens` from the legacy usage shape. It now keeps them as `total_tokens`.
- Review of M9-04 found two gaps, both fixed in the same change: the LangFuse-compatible mapper neither rounded fractions nor dropped negatives, so one bad value failed the whole combined insert (ClickHouse error 72 for negatives, 563 for fractions); and native ingest did not canonicalize, so a native client could still write alias keys.
- Stored rows were not migrated: local data was disposable when this shipped, before 0.3.0, and was reset instead.
