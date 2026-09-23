# Scheduled Export v1

Status: implemented. Owner: `packages/db/src/export-configs.ts`, `apps/worker/src/exporters/`, `apps/api/src/lib/encryption.ts`.

## Purpose

Export stored traces to a customer's own S3-compatible bucket on a schedule, so a team can pipe complete trace data into infrastructure it already owns (a warehouse, another analytics tool, another Ironside) without building its own extractor.

## What a run sends

Each run sends the **settled trace versions published since the previous run**, in the durable feed's commit order, as complete traces: the trace plus all of its observations and scores.

- **Position:** each export config stores its position in the durable trace feed, `evaluator_trace_feed` (`feed_cursor_published_at`, `feed_cursor_trace_id`; Postgres migration `0003`). The feed holds one row per trace, moved to the end whenever the ingest worker commits new trace or observation activity for it, after the ClickHouse rows are written. A config starts at the beginning of the feed, so its first run sends all existing traces.
- **Why the feed, not activity time:** a trace's activity time is the API receive time of its latest batch. A batch the worker writes late (queue backlog, a Redis job recovered by the reconciler) carries an old activity time, so a cursor over activity time would already have passed it. Its feed position is assigned when it commits, so it is still sent.
- **Settlement:** the feed is read with the same rules as the live phase of `GET /api/v1/evaluator/traces` (`apps/worker/src/exporters/settled-trace-feed.ts`). A run stops at the first trace still inside its quiet period or still being written, and at a trace whose ClickHouse snapshot is newer than its feed row. Traces that retention removed are stepped over. Later traces wait behind a blocked one rather than being skipped.
- **Versions:** a trace that receives new activity after being exported moves to the end of the feed and is exported again. Every Parquet row and every JSONL line carries `trace_version` (`traceVersion` in JSONL): the trace feed's version for that publication, distinct and increasing for every publication of the trace. It is not the trace's latest activity time, which a late batch with an older receive time leaves unchanged. Consumers keep the highest version per trace; scores upsert by their own id.
- **Scores after export:** a score written in a batch with no trace or observation activity does not move the trace feed (a score must never reopen a trace for evaluators). Those batches publish to a separate score feed, `trace_score_feed` (Postgres migration `0004`), and each run's score pass re-sends the current scores of those traces as score rows (`score-upsert` lines in JSONL) with the config's second position (`score_cursor_*`). Scores are annotations, so they go out as soon as they are written rather than after a quiet period. A score whose trace is not in ClickHouse yet is stepped over and goes out with the trace itself. The ingest worker and the pull importers' score-only path both publish to it; retention prunes it with the trace feed.
- **Filter:** the config's `TraceFilter` (time range, user/session, tags, metadata) is applied to each trace; traces it excludes are stepped over. Environment is not a destination filter (`spec/environments-v1.md`).
- **Delivery:** both positions advance only after every file of the run is uploaded, so a failed run sends the same data again. Delivery is at-least-once. A position is stored only if it still holds the value the run started from, so a slow run claimed again by another worker replica can duplicate an upload but never moves a position back.
- **Bounds:** a run loads 100 traces per page and stages them on local disk, so memory is bounded by one page. It sends at most 10,000 traces and examines at most 100,000 feed entries; a larger backlog continues on the next scheduler tick (`next_run_at` is set to now). A run with nothing new is a successful no-op that still records its position.

## File formats

Object names are `<prefix>/<name>` with a run name of `export-<timestamp>`.

- **`jsonl`** — `export-<timestamp>.jsonl`: native ingest events, one per line: `trace-upsert`, then that trace's `observation-upsert` and `score-upsert` events, followed by the score pass's `score-upsert` events. Bodies are domain objects without `projectId`, and each line's extra `traceVersion` is ignored by the API, so the lines POST straight back to `POST /api/v1/ingest` as `{"events": [...]}` (up to 500 per request) on any Ironside project. This is the format for replay and migration; replay files in name order, which is run order.
- **`parquet`** — `traces/export-<timestamp>.parquet`, `observations/export-<timestamp>.parquet`, `scores/export-<timestamp>.parquet`, so a warehouse external table can point at each folder. A table with no rows in a run gets no file. Columns use explicit DuckDB types (`apps/worker/src/exporters/duckdb-writer.ts`), so every run writes the same schema: timestamps are `TIMESTAMP WITH TIME ZONE`, `tags` is `VARCHAR[]`, metadata and model parameters are `MAP(VARCHAR, VARCHAR)`, usage is `MAP(VARCHAR, UBIGINT)` (ClickHouse stores it as `UInt64`), cost is `MAP(VARCHAR, DOUBLE)`, and `input`/`output` are JSON text because they are schemaless.

## Configuration

The `export_configs` table holds per-project named destinations: bucket/endpoint/region/access key, an optional `TraceFilter`-shaped filter, and the output `format` (`parquet` | `jsonl`). The destination secret key is AES-256-GCM encrypted at the application layer (`apps/api/src/lib/encryption.ts`) before it reaches Postgres. CRUD routes are in `spec/scheduled-destinations-crud-v1.md`; scheduling is in `spec/scheduler-v1.md`. Each run records `last_run_status`, `last_run_row_count` (traces exported, including traces whose scores alone were re-sent), and `last_run_error`.

## Verified end to end

`apps/worker/test/export-runner.test.ts` publishes traces to the feed, runs `runExport` against real ClickHouse, Postgres, and MinIO, downloads the uploaded objects, and reads them with a fresh DuckDB instance. It covers complete trees across the three Parquet tables, a second run sending only newly published traces, a changed trace re-exported as a new version, a batch written after its receive time had passed the previous run, an upload failure leaving the position unchanged, a filter that excludes everything still advancing, and a trace inside its quiet period blocking the run. `apps/worker/test/duckdb-writer.test.ts` maps a JSONL export back through the native ingest mapper and gets the original domain rows, and checks the Parquet column types. `apps/worker/test/settled-trace-feed.test.ts` covers a pending batch, a retention-removed trace, and an unpublished newer snapshot.

## History

Through 0.3.0, a run exported one summary row per settled trace (no observations or scores) and re-exported every matching trace on every run, buffering them in memory.
