# LangFuse Historical Importer v1

Status: implemented (M5-02); scheduling + credentials CRUD (M5-07) since added. Owner: `apps/worker/src/importers/langfuse-{client,mapper,importer}.ts`, `packages/db/src/import-checkpoints.ts`.

## Purpose

Pull-based backfill: page through a project's existing LangFuse traces (via LangFuse's read API, `GET /api/public/traces`) and import them into Ironside, so a team migrating off LangFuse doesn't lose history that predates switching their ingest endpoint (the M5-01 compat layer only captures *new* traces going forward).

## Design

`runLangfuseImport(options)` — a single callable function, not (yet) a scheduled job:
1. `claimImportRun` atomically transitions the project's `(project_id, 'langfuse')` checkpoint row to `status = 'running'`, or returns `null` if another run is already in progress — prevents two concurrent triggers from racing the same checkpoint.
2. Pages through `GET /api/public/traces?page=N&limit=…&orderBy=timestamp.asc[&fromTimestamp=…]`, oldest-first, mapping each page to Ironside `Trace` rows (tagged `imported:langfuse` for provenance) and batch-inserting into ClickHouse.
3. **Checkpoints after every page**, not just at the end — `saveImportProgress` persists `{page, lastTimestamp}` to Postgres. If the process is killed mid-run, the next invocation picks up from the last saved page/timestamp instead of restarting.
4. A single invocation stops after `maxPagesPerRun` pages (default 20) as a safety cap against one call running unbounded against a huge account; `resumable: true` in the result signals the caller should invoke again.
5. Once a `fromTimestamp` window is fully paged through, the checkpoint resets to `page: 1` with `lastTimestamp` advanced — so the *next* run (not the current one) picks up anything created after this run started, using LangFuse's `fromTimestamp` filter instead of re-scanning from the beginning.

### A subtle bug this design had to avoid

`fromTimestamp` must stay **fixed for the whole run**, not update after each page. LangFuse's API filters+re-paginates server-side against `fromTimestamp` — if it changed mid-run (e.g. naively re-reading the checkpoint's `lastTimestamp` on every loop iteration), page N+1's `page` offset would be applied against a *different* filtered result set than page N was counted against, silently skipping or duplicating traces. Caught by an integration test against a real multi-page paginated mock server, not by unit-testing the mapper alone (see `apps/worker/test/langfuse-importer.test.ts`).

### The cross-RUN variant of the same bug, caught only by the real-account conformance run (M5-04)

The in-run fix above had a cross-run sibling that survived until the conformance run against a real LangFuse account: the checkpoint saved the incremented `page` together with an **advanced** `lastTimestamp` after every page — but that page number was counted against the window anchored at the run's *original* timestamp. The next run re-anchored its query window at the newly-saved (later) `lastTimestamp`, renumbering every page; it then requested a page beyond the smaller window's end, received an empty response, and falsely concluded the source was exhausted. Against the real account (51 traces, `pageSize=10`, `maxPagesPerRun=3`): run 1 imported 30 and saved `{lastTimestamp: T30, page: 4}`; run 2 queried page 4 of the ~3-page `[T30, ∞)` window → empty → reported `resumable: false` with 21 traces silently missing. A crash mid-run had the same inconsistency, with skip potential rather than just early stop.

Fixed by making the checkpoint invariant explicit: **`checkpoint.page` is always the next page within the window anchored at `checkpoint.lastTimestamp`**. Mid-window saves advance only the page (anchor untouched); the anchor advances — with `page` reset to 1 — only when the window is exhausted. The fixture suite had a "stops after maxPagesPerRun" test that asserted the checkpoint's *shape* after a capped run but never resumed to completion — exactly the missing assertion; a new regression test (capped run → resume loop → assert every fixture trace arrived) was verified to genuinely discriminate by temporarily reintroducing the mid-loop anchor advance and watching it fail with the same 4-of-7 signature the real account produced (30-of-51).

## Conformance against a real LangFuse account (M5-04) — done

Run against a real self-hosted LangFuse instance (user-provided credentials, passed via environment variables only — never written to any file) holding 51 real production traces:
- **Capped + resume**: `pageSize=10`, `maxPagesPerRun=3` → run 1 imported 30 (`resumable: true`), run 2 imported the remaining 21 (`resumable: false`). 51/51 distinct traces in ClickHouse, newest imported trace exactly matching the account's newest via the public API.
- **Idempotency**: cleared the checkpoint and re-imported everything from scratch — distinct count still 51, no duplicates (deterministic `event_ts` per run + ReplacingMergeTree dedup, per the established contract).
- **Field fidelity**: names, user ids, session ids, tags (plus the `imported:langfuse` marker tag), and timestamps all spot-checked against the API's own responses.

Live LangSmith conformance is tracked separately and has not yet been completed.

## Full-data import (M5-05) — observations, scores, everything

User directive (2026-07-12): "we need full traces in all integrations — all data that I can get." The original importer only mapped trace-level fields from the list endpoint; imported traces had empty observation trees and no scores. Now, for each listed trace, the importer fetches `GET /api/public/traces/{id}` (the only way LangFuse's public API exposes the tree — one extra request per trace) and imports:
- **Observations**: type/level (uppercase → Ironside's lowercase enums, unknown type falls back to `span` rather than dropping the row), parent linkage, name, timing (start/end/completionStartTime), statusMessage, model, modelParameters, input/output, `usageDetails` (modern record; values rounded to satisfy the integer domain constraint), `costDetails` (falling back to legacy `calculated*Cost` fields when absent), metadata — plus prompt linkage (`promptName`/`promptVersion`) preserved as `langfuse:*` metadata keys since Ironside has no dedicated column.
- **Scores**: name, dataType/source (normalized, with the same `api` fallback as the ingest-side compat mapper), value (`0` is meaningful — null-checked, never truthiness-checked), stringValue, comment, observationId linkage, and the **original timestamp** — which required adding an optional `timestamp` field to the shared `Score` domain schema and threading it through `insertScores`, since the ClickHouse column otherwise defaults to insert time and backfilled scores would all look like they were created at import time.
- **Trace detail-only fields**: `environment`.

Failure containment: a failed detail fetch fails the whole run *before* that page's checkpoint save — a retry re-fetches the page and all its details idempotently; no partial page is ever recorded as done (fixture-tested, including the retry-after-recovery path).

Full-data conformance against the real account (same isolated project, cleared first): **51/51 traces, 48/48 observations, 6/6 scores** — each count checked against the API's own `meta.totalItems`, plus a per-trace tree-size spot-check, a field-level spot-check (model/input/output/usage), and confirmation the oldest imported scores carry their original May-2026 timestamps rather than import time.

### Accepted limitations inherent to LangFuse's page/limit pagination (flagged in code review, documented rather than fixed)

- **Tied-timestamp tail group**: the inclusive-`fromTimestamp` resume re-fetches not just one boundary trace but every trace sharing the anchor's exact timestamp. If such a tied group sits at the true end of the dataset (no newer data ever arrives), every future scheduled invocation re-fetches and re-inserts the whole group — harmless per-row (ReplacingMergeTree dedups), but an unbounded repeating cost proportional to the tie-group size. A tie-breaker (e.g. secondary ordering by trace id) would bound it, but LangFuse's list API offers no such parameter; accepted as-is.
- **Live mutation during a fixed-anchor window**: `page`/`limit` offsets are computed against whatever the server's live query returns at request time. A trace becoming visible with an earlier sort position *between two page fetches of the same run* (out-of-order arrival, clock skew) can shift page boundaries and skip or duplicate a row — inherent to offset pagination against a mutable dataset with no stable cursor, and not something the anchor/page checkpoint invariant can close. Duplicates are dedup-safe; a skip would be caught by a later full re-import (which the idempotency property makes cheap to run periodically).

## Not yet done (follow-up, not blocking M5-02's DoD)

~~No scheduler, cron, or API-triggered route~~ — **done since**: import source credentials + scheduling in M5-07 (spec/import-source-scheduling-v1.md); a periodic worker tick claims due sources and calls `runLangfuseImport`, exactly the coeval-poller-style pattern this note anticipated.
