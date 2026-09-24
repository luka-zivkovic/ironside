# Ingest Dead Letters v1

Status: implemented. Owner: `apps/worker/src/processors/ingest.ts`, `packages/db/src/ingest-failures.ts`, `apps/api/src/routes/ingest-failures.ts`, `packages/db/migrations/0001_baseline.sql` (`ingest_event_failures`).

## Purpose

Record every ingest event the worker could not map, so a client can find out what was dropped, from which batch, and why. Ingest acknowledges before the worker maps events (native `202`, LangFuse-compatible `207` reporting every event accepted, OTLP `200`), so the API response cannot report these failures; the dead-letter table is the queryable record.

## What is recorded

The ingest worker skips an event it cannot map and still writes the rest of the batch, so one malformed event never blocks a project's other traces. Each skipped event becomes one row in `ingest_event_failures`. Rows are per event, not per batch: a mapping failure is deterministic and specific to one event, while infrastructure errors retry the whole batch.

| Failure | `source` | `event_type` | `event_id` | `error` |
|---|---|---|---|---|
| A native event fails mapping or validation | `native` | the event's type, or `unknown` | the event id | the mapper's message |
| An OTLP export body fails the schema | `otlp` | `otlp-export` | the envelope event id | `invalid OTLP export body` |
| A LangFuse ingestion envelope fails the schema | `langfuse` | `langfuse-ingestion` | the envelope event id | `invalid LangFuse ingestion body` |
| One LangFuse SDK event inside a valid envelope fails mapping | `langfuse` | `langfuse-ingestion` | the inner LangFuse event id | the mapper's message, or `event failed LangFuse mapping (no detail provided)` |

- A row also carries `id` (`ingfail_<ulid>`), `project_id`, `batch_id`, `object_key` and `created_at`.
- The payload is a pointer, not a copy. `object_key` is the batch's immutable raw object in object storage (`raw/<projectId>/<yyyy>/<mm>/<dd>/<batchId>.json`), and `event_id` locates the failed event in it, for debugging or replay. Copying bodies into Postgres would store the malformed and possibly large payloads twice.
- For a failed inner LangFuse event, `event_id` is the inner SDK event id, which is what LangFuse's own `207` response keys on; many SDK events share one envelope event.
- Each failure is also logged as `[ingest] batch=<batchId> event=<eventId> skipped: <error>`.

## Write behavior

- Rows are written after the batch's valid rows are written to ClickHouse, in chunks of at most 8,000 rows per `INSERT`. Postgres allows 65,535 bind parameters per statement and each row uses 8, and one LangFuse envelope can nest an unbounded number of inner events, limited only by the 10 MB request body limit.
- Persistence is best-effort. If writing the rows fails, the worker logs `failed to persist <n> dead-letter rows` and the batch still succeeds: the trace data is already written, and failing the batch would retry all of it over a bookkeeping write.
- `ironside_ingest_events_dead_lettered_total` (`spec/metrics-v1.md`) is incremented by the number of failures before the rows are written, so it counts failures even when storing them fails.
- A retried batch can record the same event's failure again, because ids are generated per attempt. Duplicates in a diagnostics table are accepted rather than adding cross-retry idempotency.

## Reading failures

`GET /api/v1/projects/:projectId/ingest-failures?limit=<n>` requires an owner session whose organization owns the project (`spec/project-session-routing-v1.md`).

- `limit` is an integer from 1 to 200, default 50. A value outside that range returns `400` `{ "error": "invalid query", "issues": [...] }`.
- The response is `{ "failures": [...] }`, newest first (`created_at desc, id desc`). Each item has `id`, `projectId`, `batchId`, `objectKey`, `eventId`, `source`, `eventType`, `error` and `createdAt`.
- The route is read-only. There is no delete or acknowledge route, because rows expire on their own.

## Lifetime

- Every retention pass (`runRetention`, every 6 hours by default; `spec/scheduler-v1.md`) deletes rows older than 30 days (`purgeIngestFailuresOlderThan`). The window is fixed and independent of project retention, because the rows are diagnostics, not trace data.
- Raw retention (`spec/raw-retention-intents-v1.md`) does not delete a raw object while it has dead-letter rows newer than the retention cutoff. When it deletes an object, it first deletes that object's rows in one locked set of at most 1,000, so no row outlives the object it points to.
- Deleting a project deletes its rows.

## Verified

`apps/worker/test/ingest-processor.test.ts` covers a batch with one valid trace and malformed native, OTLP and LangFuse events: the trace is inserted, one row is recorded per failed event with its source, type, event id and the stored batch's object key, and the metrics hook receives the count. It also covers a failed inner LangFuse event recorded under the inner SDK event id, and a failing dead-letter write that does not fail the batch. `packages/db/test/ingest-failures.test.ts` covers the batch insert and newest-first, project-scoped listing, an empty input, 8,500 rows in one call, the limit, the 30-day purge, and the bounded per-object delete raw retention uses. `apps/api/test/ingest-failures.test.ts` covers `401` without an owner session, the pointer fields in the response, no rows from another project, and `400` for an out-of-range limit. `packages/mappers/test/langfuse.test.ts` covers a LangFuse score without a value becoming a per-event mapping error.

## History

- M9-03 (PR #35) added the table, the route and the counter. Before it, an unmappable event appeared only as a worker log line.
- `recordIngestFailures` first wrote one `INSERT` per batch. A large all-failing LangFuse batch would exceed the bind-parameter limit, the best-effort handler would swallow the error, and no rows would be stored while the counter still counted them. Inserts are now chunked at 8,000 rows.
- The LangFuse compatibility mapper used to accept a score with no value and store it with both value columns null. It now rejects it with `score requires a value`, which dead-letters it.
- The `packages/db` and `packages/clickhouse` build scripts copied `migrations` into an existing `dist/migrations`, nesting it and leaving compiled processes with a stale migration list. Both now remove `dist/migrations` first.
- Still open: ingest responses cannot report worker-side mapping failures, which follows from acknowledging before mapping. No web UI lists dead letters. The 30-day window is not configurable.
