# LangFuse Historical Importer v1

Status: implemented. Owner: `apps/worker/src/importers/langfuse-client.ts`, `apps/worker/src/importers/langfuse-mapper.ts`, `apps/worker/src/importers/langfuse-importer.ts`, `apps/worker/src/importers/evaluator-publication.ts`, `packages/db/src/import-checkpoints.ts`.

## Purpose

Pull a project's existing LangFuse history (traces with their observations and scores) into Ironside, so a team moving off LangFuse keeps the history that predates pointing its SDK at the compat endpoint (`spec/langfuse-compat-v1.md`), which only captures new traces. Runs are triggered by the scheduler for each configured import source (`spec/import-source-scheduling-v1.md`).

## Run

`runLangfuseImport(options)` performs one bounded run for one project:

1. **Claim.** `claimImportRun` creates the project's `(project_id, 'langfuse')` row in `import_checkpoints` if it is missing and sets `status = 'running'` with a new run token and a five-minute lease. If a live run already holds the lease it returns `null` and the call does nothing; an expired lease is taken over. Progress saves, staging, publication and the final status all require the same token and an unexpired lease, so a worker that lost its lease fails with `import run lease was lost` instead of writing. The lease is renewed before every page and every trace detail request.
2. **Recover.** Snapshots a previous run staged but did not finish materializing are completed first (see Publication).
3. **List.** Pages through `GET /api/public/traces?page=N&limit=<pageSize>&orderBy=timestamp.asc[&fromTimestamp=<anchor>]`, oldest first, with `Authorization: Basic base64(publicKey:secretKey)`.
4. **Detail.** For each listed trace, fetches `GET /api/public/traces/{id}`. The list endpoint returns trace fields only; the detail endpoint is the only public API that returns observations and scores, so every trace costs one extra request.
5. **Stage and materialize** the page's traces, then save the checkpoint.
6. **Stop** when the window is exhausted or after `maxPagesPerRun` pages (default 20). `pageSize` defaults to 50; the scheduler uses both defaults. The run returns `{ imported, resumable }`; `resumable: true` means the page cap stopped it before the window was exhausted and the next run continues. A finished run sets `status = 'idle'`. `imported_count` accumulates across runs.

## Checkpoint and pagination

The checkpoint is `{ page, lastTimestamp? }`. LangFuse's list API has no cursor token, only `page`/`limit` and an inclusive `fromTimestamp` filter.

Invariant: `page` is always the next page to fetch within the window anchored at `lastTimestamp`.

- The anchor is read once when the run starts and stays fixed for the whole run. LangFuse re-applies the filter and re-paginates on every request, so a page number only means something against the window it was counted in; moving the anchor mid-run would skip or duplicate traces.
- A save in the middle of a window advances only `page`.
- When the window is exhausted (`page >= meta.totalPages`, or an empty page), `lastTimestamp` moves to the newest trace timestamp seen in this run and `page` resets to 1. The next run queries from there and picks up traces created since.
- Progress is saved after every page, so an interrupted run resumes at the first unsaved page.

## Mapping

**Trace** (list fields plus the detail-only `environment`):

- `id`, `timestamp`, `name`, `userId`, `sessionId`, `release`, `version`, `input` and `output` map to the same native fields.
- Tags are the source tags plus `imported:langfuse`.
- Metadata values that are not strings are JSON-stringified.
- `environment` is normalized as in `spec/environments-v1.md`; an invalid value is omitted.
- An explicit `null` input or output is kept as a recorded `null`; an absent one is omitted.

**Observation:**

- `type` and `level` are lowercased. An unknown type becomes `span` and an unknown or missing level becomes `default`, so the row is kept.
- `parentObservationId`, `name`, `startTime`, `endTime`, `completionStartTime`, `statusMessage`, `model`, `input` and `output` map directly (an explicit `null` input or output is kept).
- `modelParameters` keep string, number, boolean and null values; other values are JSON-stringified.
- `usageDetails`: finite, non-negative values are rounded to integers (the column is an unsigned integer map) and others are dropped; key names are canonicalized (`input` becomes `input_tokens`, see `spec/usage-keys-v1.md`) and unknown keys pass through. Only `usageDetails` is read, not the legacy `usage` object.
- `costDetails` is used when present and non-empty; otherwise the legacy `calculatedInputCost`, `calculatedOutputCost` and `calculatedTotalCost` become `input`, `output` and `total`.
- Prompt linkage has no native column and is kept in metadata as `langfuse:promptName` and `langfuse:promptVersion`.

**Score:**

- `name`, `value`, `stringValue`, `comment`, `observationId` and stringified `metadata` map directly. `value` is checked for null, not truthiness, so `0` is kept.
- `dataType` `NUMERIC`/`CATEGORICAL`/`BOOLEAN` is lowercased; any other value becomes `numeric` when `value` is a number and `categorical` otherwise.
- `source` `API`/`EVAL`/`ANNOTATION` is lowercased; any other value becomes `api`, the same fallback as the compat mapper.
- The score keeps its original `timestamp`. A score without one takes its trace's timestamp, because the ClickHouse score key includes the score's date and an insert-time default would create a second row when a retry crosses UTC midnight.
- A score that fails the domain schema (no `value` and no `stringValue`, an invalid timestamp) is dropped; its trace still imports.

**Invalid traces.** If a trace or one of its observations fails mapping or domain validation (for example an identifier longer than 512 UTF-8 bytes or containing NUL), that trace is skipped and reported through `onInvalidTrace`; the scheduler reports it to its error hook as `import:langfuse:<traceId>`. The rest of the page imports and the checkpoint advances, so one bad trace cannot pin the source.

## Publication

Imported traces pass through the same fail-closed publication barrier as ingested ones (`spec/evaluator-integration-v1.md`):

- Each page's valid snapshots (trace, observations and scores) are staged in Postgres `evaluator_import_trace_state`, keyed by project, trace and source with a content hash, before anything is written to ClickHouse.
- An unchanged snapshot that is already materialized writes nothing. Re-importing, including after the checkpoint is cleared, is therefore idempotent.
- A changed snapshot gets a new generation, strictly later than the trace's previous one, which becomes the rows' `event_ts`. Materialization tombstones the previously imported tree first, so observations and scores the source no longer returns disappear, then writes the new rows and publishes a new trace version to the trace feed.
- A change to scores alone replaces this provider's imported scores and notifies the score feed without reopening the trace. Imported scores carry `import_source = 'langfuse'`, so native, manual and evaluator scores on the same trace are never replaced.
- Materialization fails closed when the project's import retention cutoff is missing, and discards a snapshot whose trace timestamp is older than the cutoff. The inclusive `fromTimestamp` boundary therefore cannot bring back a trace that retention removed.
- A snapshot left pending by a crash is completed by the next run, or, once the lease has expired, by the scheduler's recovery pass, which needs no provider credentials.

`imported` counts the traces staged per page, including unchanged ones.

## Failure behavior

A failed list or detail request (a non-2xx response, a network error, or a body that fails schema parsing) fails the run before that page is staged or its checkpoint saved, so the next run fetches the whole page again; a partial page is never recorded as done. A failed run sets `status = 'error'` and `last_error` and rethrows.

## Known limits of page/limit pagination

- **Tied timestamps at the tail.** The inclusive `fromTimestamp` re-fetches every trace sharing the anchor's exact timestamp. If such a group is the newest data, every later run fetches it again until newer data arrives. The re-fetch writes nothing when the content is unchanged, but it costs one detail request per trace in the group. LangFuse's list API has no secondary sort key to break the tie.
- **Changes during a run.** Offsets are computed against the live query at request time. A trace that becomes visible at an earlier sort position between two page requests of one run (late arrival, clock skew) can shift page boundaries and skip or duplicate a row. A duplicate is harmless; a skipped trace is picked up by a full re-import, which is cheap because unchanged traces write nothing.

## Verified

`apps/worker/test/langfuse-importer.test.ts` runs `runLangfuseImport` against a mock LangFuse HTTP server with real Postgres and ClickHouse. It covers a multi-page import, resuming from the checkpoint, the page cap, a capped run resumed until every fixture trace arrives (the checkpoint invariant), full trees with observations and scores keeping their original timestamps, dropping unusable scores, tombstoning rows a later snapshot omits, recovering a staged snapshot after its lease expires, monotonic score generations, a failed detail fetch not advancing the checkpoint, skipping an invalid identifier while advancing the page, not resurrecting an expired boundary trace, failing closed without a retention cutoff, a concurrent run returning `null`, and `error` status on a source failure. `apps/worker/test/langfuse-mapper.test.ts` covers the field mapping: enum normalization and fallbacks, explicit `null` input/output, legacy cost fallback, usage rounding, prompt metadata, environment normalization, and score value, source, timestamp and drop rules.

## History

- M5-02 added the importer: trace-level fields only, a checkpoint saved after every page, and an anchor fixed for the whole run. An integration test against a multi-page mock server caught the anchor moving within a run.
- M5-04 ran it against a real self-hosted LangFuse account with 51 traces. With `pageSize=10` and `maxPagesPerRun=3`, run 1 saved `{lastTimestamp: T30, page: 4}`; run 2 asked for page 4 of the re-anchored `[T30, ∞)` window, got an empty page, and reported the source exhausted with 21 traces missing. The fixture test had checked the checkpoint's shape after a capped run but never resumed to completion. The checkpoint invariant above fixed it, with a regression test that resumes a capped run to completion. After the fix the account imported 51 of 51 traces across two runs, re-importing produced no duplicates, and names, user and session ids, tags and timestamps matched the API.
- M5-05 made imports full-data: the per-trace detail request, observations, scores and `environment`. It added the optional `timestamp` to the shared `Score` schema and `insertScores` so imported scores keep their original time instead of the insert time. Conformance against the same account: 51/51 traces, 48/48 observations and 6/6 scores, each checked against the API's `meta.totalItems`.
- M5-07 added import sources and the scheduler (`spec/import-source-scheduling-v1.md`); before that `runLangfuseImport` had no trigger.
- M9-04 canonicalized usage keys to `input_tokens`/`output_tokens`/`total_tokens`.
- Imports moved onto the evaluator publication barrier. Before, each page was inserted straight into ClickHouse with one fixed `event_ts` per run and ReplacingMergeTree collapsed re-imported rows. The barrier added staged snapshots with content-hash generations, run tokens with renewable leases, tombstoning of rows the source no longer returns, the import retention cutoff, and per-trace skipping of invalid rows.
