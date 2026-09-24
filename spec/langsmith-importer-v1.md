# LangSmith Historical Importer v1

Status: implemented. Owner: `apps/worker/src/importers/langsmith-client.ts`, `apps/worker/src/importers/langsmith-mapper.ts`, `apps/worker/src/importers/langsmith-importer.ts`, `apps/worker/src/importers/evaluator-publication.ts`, `packages/db/src/import-checkpoints.ts`.

## Purpose

Pull a team's existing LangSmith history (root runs as traces, their descendant runs as observations, and feedback as scores) into Ironside, for the same reason as the LangFuse importer (`spec/langfuse-importer-v1.md`): an SDK pointed at Ironside only captures new traces. Runs are triggered by the scheduler for each configured import source (`spec/import-source-scheduling-v1.md`).

## Source API

All requests send `x-api-key: <apiKey>` to `baseUrl`, which defaults to `https://api.smith.langchain.com`.

- **Root runs:** `POST /api/v1/runs/query` with `{ session: <sessionIds>, is_root: true, limit, order: "asc", cursor?, start_time? }`. `session` is an array of LangSmith project UUIDs, not project names. Pagination is by an opaque cursor: the next page's cursor is `cursors.next`, and a missing or null value means the window is exhausted. The OpenAPI schema types `cursors` only as an open string map; the `next` key comes from the official `langsmith` JS and Python clients, which both read it.
- **One trace's runs:** `POST /api/v1/runs/query` with `{ trace: <traceId> }`. The OpenAPI description of the `trace` filter says limit and cursor pagination are not applied and all runs in the trace come back in one response. `runs/query` returns full run bodies (tokens, cost, status, parent id), so no per-run detail request is needed.
- **Feedback:** `GET /api/v1/feedback?run=<id>&run=<id>…&limit=100&offset=N`, which returns a plain array. The request carries every run id in the trace's tree (root and all descendants), because feedback can be attached to any run and the API does not document that `run` scopes to a whole trace. Run ids are sent 50 per request so a large tree cannot produce an over-long URL, and each chunk is paged by offset until a page shorter than 100 comes back.

## Run

`runLangsmithImport(options)` performs one bounded run for one project, with the same claim, lease, recovery, staging and failure contract as `runLangfuseImport` (`spec/langfuse-importer-v1.md`), keyed on `(project_id, 'langsmith')`:

1. Claim the checkpoint row with a run token and a five-minute renewable lease, or return `null` when a live run holds it.
2. Complete any snapshots a previous run left pending.
3. Query a page of root runs. For each root run, with trace id `trace_id` (or `id` when absent), fetch the trace's runs and then the feedback for all of its run ids. The trace query returns the root run again; it is removed by id so it is not also mapped as an observation.
4. Map, stage and materialize the page, then save the checkpoint.
5. Stop when the window is exhausted or after `maxPagesPerRun` pages (default 20); `pageSize` defaults to 50. Return `{ imported, resumable }`.

The source project UUIDs come from the import source's `sessionIds`.

## Checkpoint and pagination

The checkpoint is `{ cursor?, lastStartTime? }`.

- `start_time` is an inclusive lower bound, and the run's anchor is `lastStartTime`, read once when the run starts and kept fixed for the whole run. The source re-applies the filter on every request and a cursor is only meaningful within the window it was issued for, so moving the anchor mid-run would skip or duplicate runs.
- In the middle of a window, a save stores the next cursor and leaves `lastStartTime` unchanged.
- When the window is exhausted (no `cursors.next`, or an empty page), the cursor is removed and `lastStartTime` moves to the newest root-run `start_time` seen in this run. The next run starts a fresh window from there rather than resending a cursor from a finished window.
- Progress is saved after every page.

The tied-timestamp and concurrent-change limits described for LangFuse apply here too, with `start_time` in place of `fromTimestamp`.

## Mapping

**Trace** (from the root run):

- `id` is `trace_id`, falling back to `id`; `timestamp` is `start_time`; `name`; `sessionId` is the run's `session_id`; `input` and `output` come from `inputs` and `outputs` (an explicit `null` is kept, an absent value is omitted).
- Tags are the run's tags plus `imported:langsmith`.
- Metadata merges `extra` and `metadata` (a `metadata` key wins over the same `extra` key); values that are not strings are JSON-stringified.
- The root run's own tokens, costs, end time and status are not stored: the root run maps only to the trace, and only descendant runs become observations.

**Observation** (every descendant run):

- `run_type` `llm` becomes `generation`; every other run type becomes `span`, and the original run type is kept in metadata as `langsmith:runType`.
- `level` is `error` when `status` is `error` or `error` is set, otherwise `default`. `statusMessage` is the `error` text when present, otherwise the raw `status`.
- `parent_run_id`, `name`, `start_time`, `end_time`, `first_token_time` (as `completionStartTime`), `inputs` and `outputs` map directly; metadata is built as for the trace.
- `prompt_tokens`, `completion_tokens` and `total_tokens` become `input_tokens`, `output_tokens` and `total_tokens` (`spec/usage-keys-v1.md`), rounded; negative counts are dropped.
- Costs arrive as decimal strings (`"0.00123"`). `prompt_cost`, `completion_cost` and `total_cost` are parsed at the mapping boundary into `input`, `output` and `total`; a string that does not parse to a finite, non-negative number is dropped rather than stored as `NaN`.

**Score** (each feedback entry):

- `name` is `key`, `comment` maps directly, `source` is always `api`, and `timestamp` is `created_at`. A score without a timestamp takes its trace's timestamp, as for LangFuse.
- A numeric `score` becomes `value` with data type `numeric` (`0` is kept). A `value` becomes `stringValue`, JSON-stringified when it is not a string, and data type `categorical` when there is no numeric score. Both are kept when both are present.
- Feedback with neither a numeric score nor a value is skipped.
- `observationId` is the feedback's `run_id`, except when `run_id` is absent or equals the resolved trace id, in which case the score is trace-level. The comparison uses the trace id the importer resolved, not the feedback's own `trace_id` field, which is optional.
- `correction` and `feedback_source` are not stored.

**Invalid traces.** If a trace, one of its observations, or one of its mapped scores fails domain validation (for example an identifier longer than 512 UTF-8 bytes, or an unparseable `created_at`), the whole trace is skipped and reported through `onInvalidTrace`; the scheduler reports it to its error hook as `import:langsmith:<traceId>`. The page still advances. Unlike the LangFuse importer, an invalid feedback entry skips its trace rather than only the score.

## Publication and failure behavior

Staging, generations, tombstoning, the score-only path, the import retention cutoff and crash recovery are the same as for LangFuse (`spec/langfuse-importer-v1.md#publication`), with `import_source = 'langsmith'` on imported scores. A failed root-run, trace-runs or feedback request fails the run before the page is staged or its checkpoint saved, sets `status = 'error'` and `last_error`, and rethrows.

## Verified

`apps/worker/test/langsmith-importer.test.ts` runs `runLangsmithImport` against a mock LangSmith server whose cursor is an offset within the `start_time`-filtered set, with real Postgres and ClickHouse. It covers a multi-page import that clears the cursor on exhaustion, `startTime` staying fixed for every request of a run, resuming from `lastStartTime`, the page cap keeping the cursor, full trees with child runs as observations and feedback on root and child runs as scores, a concurrent run returning `null`, and `error` status on a source failure. `apps/worker/test/langsmith-mapper.test.ts` covers the trace id fallback, run type and level mapping, decimal-string costs (including a malformed one), token mapping and rounding, explicit `null` output, and the feedback rules: score `0`, stringified values, score and value together, skipping empty feedback, and root versus child `observationId`.

## History

- M5-03 added the importer for root runs only. A sibling codebase's client called `GET /runs` with a `project_name` parameter; the live OpenAPI spec has no such listing endpoint, so the importer uses `POST /api/v1/runs/query` with project UUIDs and cursor pagination. The fixed per-run `start_time` anchor and a fixed per-run `event_ts` were built in from the start, after both had been fixed in the LangFuse importer.
- M5-06 made imports full-data: descendant runs through the `trace` filter, feedback over every run id in the tree, chunked by 50. Review found three mapper bugs, each fixed with a regression test: `observationId` was compared against the feedback's optional `trace_id` instead of the resolved trace id, a categorical `value` was dropped whenever a numeric `score` was present, and feedback with neither produced an invalid score row.
- M5-07 added import sources and the scheduler (`spec/import-source-scheduling-v1.md`).
- M9-04 changed usage keys from `input`/`output`/`total` to `input_tokens`/`output_tokens`/`total_tokens`.
- Imports moved onto the evaluator publication barrier, as described in the LangFuse importer's history.
- Still open: conformance against a live LangSmith account. The `cursors.next` key, `is_root` filtering, `session` UUID filtering, the unpaginated `trace` filter and the scope of the feedback `run` parameter are checked against the OpenAPI spec and SDK source only (`ROADMAP.md`).
