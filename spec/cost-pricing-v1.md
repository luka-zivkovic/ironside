# Computed model cost v1

Ironside derives USD cost for observations that report token usage and a model but no cost. This closes the gap recorded in `spec/direct-ingest-primacy-v1.md`: direct SDK, OTLP, and native JSON ingest previously produced no cost unless the caller computed it, while imported LangFuse and LangSmith data carried the cost those platforms had already computed.

## Contract

- **Client cost wins.** Any non-empty `costDetails` on an observation is stored exactly as sent. Ironside never rewrites, rescales, or "corrects" a client-reported cost.
- **Derivation happens at ingest, in the worker**, before the ClickHouse insert, so the derived cost is part of the same durable row as the usage it came from. A retry of the same batch recomputes identically.
- **Inputs:** `observation.model` and the canonical usage keys from `spec/usage-keys-v1.md` (`input_tokens`, `output_tokens`) plus the non-overlapping cache series `cache_read_input_tokens` and `cache_creation_input_tokens`. Other usage keys (reasoning, audio, provider-specific) are not priced.
- **Output:** `costDetails` with one entry per priced component (`input`, `output`, `cache_read`, `cache_write`) and `total`, rounded to nine decimal places (the ClickHouse `Decimal64(9)` column). A component is emitted only when both a token count and a price exist; unpriced series are omitted rather than billed at zero.
- **Unknown model = no cost.** When no price resolves, `costDetails` stays absent. Zero is never invented; the trace explorer shows a dash.
- **Provenance** is recorded in observation metadata so a number can be traced to the price that produced it:
  - `ironside:cost_source` — `table` or `override`
  - `ironside:cost_model` — the table key or override pattern that matched
  - `ironside:cost_table` — the table's sync date (table matches only)
- **Frozen at ingest.** A later table refresh or override edit never rewrites stored cost. This matches every comparable platform reviewed (LangFuse, LangSmith, Phoenix, Opik, Helicone) and keeps historical totals reproducible.

## Price resolution

1. **Project overrides** (`project_model_prices`, ordered by `position`) are tested first as case-insensitive regular expressions against the model name. The first match wins. An override may price any subset of components.
2. **The vendored table** is consulted through a candidate chain, most specific first: the name as reported; lower-cased; without a `provider/` prefix; without a trailing date (`-20250929`, `-2024-08-06`, `@20240620`) or `-latest`/`:latest` pin; then each of those under known provider prefixes (`gemini/`, `vertex_ai/`, `bedrock/`, ...). This is the ordered exact-match approach Opik uses rather than table-wide regexes, so resolution is deterministic and cheap.

## The vendored table

`packages/pricing/data/model-prices.json` is trimmed from LiteLLM's community-maintained `model_prices_and_context_window.json` (the same source Opik vendors). Only `input`, `output`, `cache_read`, `cache_write` (USD per token) and `provider` are kept per model. The file records its `source` and `syncedAt` date.

Refresh policy: run `pnpm --filter @ironside/pricing sync-prices` and commit the result. The table is bundled at build time and never fetched at runtime, so an installation's numbers are reproducible for a given release. The date is exposed to owners in Configuration → Model prices and stamped on every derived cost.

## Project overrides

`GET`/`PUT /api/v1/projects/:projectId/model-prices` (owner session, project-scoped like quotas). `PUT` replaces the whole ordered list; the list is small and order-sensitive, so whole replacement is simpler and safer than per-row edits. Validation: pattern 1–200 characters and a compilable regular expression; prices non-negative USD per token; at least one price per rule; at most 100 rules. The web form edits prices per million tokens and converts.

The worker caches a project's overrides for 30 seconds; an edit affects batches processed after that window.

## Non-goals

- Tokenizer-based usage estimation when the client sends none.
- Tiered pricing (above-200k-token rates, batch or priority tiers) and per-request modalities (images, audio, search). The upstream table has them; Ironside prices the flat rate only.
- Cost for OTLP custom cost attributes: they remain metadata, per `spec/integration-contract-v1.md`. OTLP observations do gain derived cost because `gen_ai.usage.*` and `gen_ai.request.model` map to usage and model.
