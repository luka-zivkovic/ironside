# LangSmith Historical Importer v1

Status: implemented (M5-03, full-data M5-06); scheduling + credentials CRUD (M5-07) since added. Owner: `apps/worker/src/importers/langsmith-{client,mapper,importer}.ts`.

## Purpose

Same rationale as the LangFuse importer (`spec/langfuse-importer-v1.md`): pull-based backfill of a team's existing LangSmith history, since a future ingest-side compat layer would only capture new traces going forward.

## API verification note

An existing sibling-codebase client (coeval) called `GET /runs` with `x-api-key` auth and a `project_name` query param. **This is not a documented LangSmith endpoint** — verified directly against the live OpenAPI spec at `api.smith.langchain.com/openapi.json`: no bare `GET /runs` listing endpoint exists. The only endpoint for listing/searching runs is `POST /api/v1/runs/query`, which filters by `session` (an array of project UUIDs, not a name string) and paginates via an opaque `cursor` string, not offset/limit.

The response's `cursors` field is typed in the OpenAPI schema only as a generic open string-keyed dict — the "next page" key name is **not recoverable from the spec alone**. Verified instead against the official `langsmith` SDK source (both JS `client.ts` and Python `client.py`, independently converging): both read `cursors.next`, treating a missing/falsy value as pagination exhaustion.

## Design

Same checkpoint/resume/concurrency-guard shape as `runLangfuseImport` (see `spec/langfuse-importer-v1.md`), adapted for LangSmith's different pagination model:

- **Cursor-based, not page-based.** LangSmith has no equivalent of "page >= totalPages" — exhaustion is signaled by `cursors.next` being absent/null, not a computable total.
- **`startTime` (LangSmith's `start_time` filter) must stay fixed for the whole run**, for the identical reason LangFuse's `fromTimestamp` must: the source re-evaluates the filter server-side per request, and a cursor is only meaningful relative to *that* filtered window. A moving anchor mid-run desyncs the cursor's position from what the caller expects, silently skipping or duplicating runs — this is the same bug class M5-02 found and fixed for LangFuse, deliberately avoided here from the start and locked in with a dedicated regression test (`apps/worker/test/langsmith-importer.test.ts`, "startTime stays fixed for the whole run").
- **Trace-level scope only** (`is_root: true`): LangSmith's "runs" include every nested span; this importer pulls root runs (traces) only, matching the LangFuse importer's scope (traces, not observations).
- **`eventTs` fixed per run**, matching the established `ReplacingMergeTree` retry-safety contract (`packages/clickhouse/src/rows.ts`) — applied from the start here, having been a review-driven fix in the LangFuse importer.

## Full-data import (M5-06) — child runs and feedback, everything

The importer follows the same full-data requirement as the LangFuse path. The original importer only mapped root runs (traces) — no observations, no feedback. LangSmith's data model differs from LangFuse's in a way that changes the shape of the fix:

- **No separate detail endpoint needed.** LangFuse's list API returns trace summaries only, requiring one `GET /traces/{id}` per trace to get the full tree. LangSmith's `POST /api/v1/runs/query` already returns full run bodies (tokens, cost, status, parent linkage) for every run, root or not — the gap was never "missing fields," it was "only root runs were ever queried."
- **The `trace` filter, not deeper pagination, gets the whole tree.** Verified directly against the live OpenAPI spec's `BodyParamsForRunsQuerySchema.trace` field description: *"Filter runs by trace ID. When set, limit and cursor-based pagination are not applied — all runs in the trace are returned in a single response."* So the importer keeps its proven-resumable root-run pagination/checkpoint loop for the trace-level backfill, and for each root run in a page issues one additional trace-scoped `runs/query` call (`LangsmithClient.getTraceRuns`) to fetch every descendant run in one unpaginated response — architecturally the same "per-trace detail fetch" pattern as the LangFuse fix, just via a different API shape.
- **`run_type` → Ironside's observation type**: `llm` maps to `generation` (the type Ironside's usage/cost columns are meant for); every other type (`tool`/`chain`/`retriever`/`embedding`/`prompt`/`parser`) maps to `span`, with the original `run_type` preserved as a `langsmith:runType` metadata key.
- **Costs are decimal STRINGS on the wire** (`"0.00123"`, not a JSON number) — confirmed directly against the live schema, not assumed. Parsed at the mapping boundary (not in the Zod schema, so a malformed string is caught by an explicit `Number.isFinite` guard rather than silently coercing to `NaN` via `z.coerce.number()`).
- **Feedback (LangSmith's score equivalent) is fetched per trace via `GET /api/v1/feedback?run=<id>&run=<id>...`**, passed the FULL set of run ids in the trace's tree (root + every descendant), not just the trace/root id. The OpenAPI spec's `run` parameter has no scope description (unlike the `trace` filter's explicit "all runs in the trace" docstring) — deliberately not assumed to auto-scope by trace, since LangSmith's UI attaches feedback to individual runs, which can be any node in the tree, not just the root. Feedback whose `run_id` equals the trace's own root id maps to a trace-level score (no `observationId`); feedback on any other run id links to that run's `Observation` via `observationId`. Run ids are sent to the feedback endpoint in chunks of 50, not one unbounded query string per trace — a trace with hundreds of runs (plausible for agentic/looping workflows) could otherwise grow the URL past a proxy/load-balancer's length limit.

### Three bugs caught by code review, fixed and regression-tested

1. **`observationId` scoping compared against the wrong field.** The first version compared a feedback entry's `run_id` against `feedback.trace_id` (a field on the feedback response itself, independently nullable/optional) instead of the importer's own resolved `traceId` parameter. If the API ever returns feedback with `trace_id` absent, root-run feedback would fail the equality check and get misclassified as pointing at a child observation. Fixed to compare against the `traceId` the mapper already receives; regression-tested (including a case where `feedback.trace_id` is deliberately omitted from the fixture) and verified to discriminate by reverting and confirming the test fails.
2. **A categorical `value` was silently dropped whenever a numeric `score` was also present.** LangSmith feedback can carry both simultaneously (e.g. `score: 1, value: "thumbs_up"`) — neither field implies the absence of the other. The original code only computed `stringValue` when `!isNumeric`, discarding real data against the "all data I can get" directive. Fixed to compute `stringValue` unconditionally; regression-tested and verified to discriminate.
3. **Feedback with neither a score nor a value produced an invalid `Score`.** The domain schema requires at least one of `value`/`stringValue`; a comment-only feedback entry (both fields absent) would otherwise silently write a row with both columns null — indistinguishable from data loss. `mapLangsmithFeedback` now returns `Score | null`, and the importer skips a `null` return rather than inserting an invalid row; regression-tested at the mapper level.

## Not yet done (follow-up, not blocking either M5-03's or M5-06's DoD)

~~No scheduler/trigger route~~ — **done since**: import source credentials + scheduling in M5-07 (spec/import-source-scheduling-v1.md).

## Still blocked

Real conformance against a live LangSmith account — the exact `cursors.next` key name, `is_root` filtering behavior, `session` UUID resolution, the `trace` filter's unpaginated-full-tree behavior, and the `run` feedback parameter's actual filter scope are all verified against the OpenAPI spec and SDK source, not a live response. This remains an explicit conformance item pending access to a suitable live account (LangFuse's equivalent conformance item is done — see `spec/langfuse-importer-v1.md`).
