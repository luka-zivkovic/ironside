# Computed Model Cost v1

Status: implemented. Owner: `packages/pricing/src/`, `packages/pricing/data/model-prices.json`, `apps/worker/src/processors/cost-enrichment.ts`, `apps/api/src/routes/model-prices.ts`, `packages/db/src/model-prices.ts`.

## Purpose

Derive USD cost at ingest for observations that report token usage and a model but no cost, so direct SDK, OTLP and native JSON ingest carry cost the way imported LangFuse and LangSmith data does, without every client computing it.

## Contract

- Scope: the ingest worker (`apps/worker/src/processors/ingest.ts`) derives cost for observations from native JSON, OTLP, and LangFuse-compatible ingest. LangFuse-compatible rows are merged with stored rows first, because derivation needs the merged model and usage. Observations written by the pull importers keep the cost the source platform reported and are not enriched.
- Candidates: an observation with a `model`, a `usageDetails` map, and no `costDetails` or an empty one.
- Client cost wins. Any non-empty `costDetails` is stored exactly as sent. Ironside never rewrites, rescales, or corrects a client-reported cost.
- Timing: derivation runs in the worker before the ClickHouse insert, so the derived cost is part of the same durable row as the usage it came from. A retry of the same batch computes the same cost unless a price changed in between.
- Inputs: `observation.model` and the canonical usage keys `input_tokens` and `output_tokens` (`spec/usage-keys-v1.md`), plus the non-overlapping cache series `cache_read_input_tokens` and `cache_creation_input_tokens`. Other usage keys (reasoning, audio, provider-specific) are not priced.
- Output: `costDetails` with one entry per priced component (`input`, `output`, `cache_read`, `cache_write`) and a `total`, each rounded to nine decimal places to match the ClickHouse `Decimal64(9)` column. A component is written only when both its token count and its price exist; an unpriced series is left out rather than billed at zero.
- Unknown model means no cost. When no price resolves, or the resolved price covers none of the reported components, `costDetails` stays absent. Zero is never invented, and the trace list shows a dash.
- Provenance is recorded in the observation's metadata, so each number can be traced to the price that produced it:
  - `ironside:cost_source`: `table` or `override`
  - `ironside:cost_model`: the table key or override pattern that matched
  - `ironside:cost_table`: the table's sync date (table matches only)
- Frozen at ingest. A later table refresh or override edit never rewrites stored cost, so historical totals stay reproducible.

## Price resolution

`resolveModelPrice` (`packages/pricing/src/index.ts`):

1. Project overrides (`project_model_prices`, ordered by `position`) are tested first, each as a case-insensitive regular expression against the model name. The first match wins, even if it prices none of the reported components; the table is then not consulted. An override may price any subset of components. A stored pattern that fails to compile is skipped.
2. The vendored table is consulted through a candidate chain, most specific first, using exact key lookups: the name as reported; lower-cased; without a `provider/` prefix; without a trailing date (`-20250929`, `-2024-08-06`, `@20240620`) or a `-latest`/`:latest` pin; then each candidate without a slash under the known provider prefixes `openai/`, `anthropic/`, `gemini/`, `vertex_ai/`, `bedrock/`, `azure/`, `mistral/`, `groq/`, `deepseek/`, `xai/`, `cohere/`, `together_ai/`, `fireworks_ai/`, `openrouter/`, in that order. Exact lookups in a fixed order keep resolution deterministic and cheap, unlike regular expressions over the whole table.

## The vendored table

`packages/pricing/data/model-prices.json` is trimmed from LiteLLM's community-maintained `model_prices_and_context_window.json`. Each model keeps only `input`, `output`, `cache_read`, `cache_write` (USD per token) and `provider`; models with neither an input nor an output price are left out. The file records its `source` URL and `syncedAt` date.

To refresh it, run `pnpm --filter @ironside/pricing sync-prices` and commit the result. The table ships with the build and is never fetched at runtime, so an installation's numbers are reproducible for a given release. Owners see the sync date and model count in Configuration → Model prices, and every table-derived cost carries the date in `ironside:cost_table`.

## Project overrides

`GET` and `PUT /api/v1/projects/:projectId/model-prices` require an owner session and resolve the project through the owner's organization (`spec/project-session-routing-v1.md`). Both return `{ overrides, table }`, where `table` is `{ source, syncedAt, modelCount }`.

`PUT` replaces the whole ordered list in one transaction; the list is small and order-sensitive, so whole replacement is simpler and safer than per-row edits. Each rule has a `pattern` and the prices `inputCostPerToken`, `outputCostPerToken`, `cacheReadInputTokenCost` and `cacheWriteInputTokenCost`, where null means the rule does not price that component. Validation:

- `pattern`: trimmed, 1 to 200 characters, and a regular expression that compiles.
- Prices: USD per token, from 0 to 1.
- At least one price per rule, and at most 100 rules.

The web form edits prices per million tokens and converts them. Rules are stored in `project_model_prices` (Postgres migration `0002_project_model_prices`).

The worker caches a project's overrides for 30 seconds, so an edit applies to batches processed after that window.

## Non-goals

- Estimating usage with a tokenizer when the client sends none.
- Tiered pricing (rates above 200k tokens, batch or priority tiers) and per-request modalities (images, audio, search). The upstream table has them; Ironside prices the flat per-token rate only.
- Promoting custom OTLP cost attributes into `costDetails`: they stay metadata (`spec/integration-contract-v1.md`). OTLP observations still get derived cost, because `gen_ai.usage.*` and `gen_ai.request.model` map to usage and model.

## Verified

`packages/pricing/test/pricing.test.ts` covers the candidate chain, table and prefixed matches, date stripping, unknown models returning no price, override order and invalid patterns, per-component pricing, enrichment with provenance, client cost left untouched, and loading the vendored table. `apps/worker/test/cost-enrichment.test.ts` runs the ingest processor over native batches into ClickHouse and checks a table-derived cost with provenance, client cost kept, no cost for an unknown model or missing usage, and an override preferred over the table. `apps/api/test/model-prices.test.ts` covers the initial empty list with the table summary, ordered replacement, validation, and owner-session and organization scoping.

## History

- Derived cost closed a gap the M4-05 audit recorded (`spec/direct-ingest-primacy-v1.md`): direct SDK, OTLP and native JSON ingest produced no cost unless the caller computed it, while imported data carried the cost its source platform had computed. Project overrides arrived with Postgres migration `0002_project_model_prices`.
