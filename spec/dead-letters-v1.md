# Ingest Dead Letters v1 (M9-03)

Status: implemented, verified live end-to-end. Owner: `packages/db/migrations/0001_baseline.sql`, `packages/db/src/ingest-failures.ts`, `apps/worker/src/processors/ingest.ts`, `apps/api/src/routes/ingest-failures.ts`.

## Purpose

M9 Phase 1: since M5-01, an ingest event the worker couldn't map surfaced ONLY as a worker log line — a documented visibility gap. The LangFuse compat route's 207 response optimistically reports every event accepted (the API edge can't see worker-side mapping outcomes), so a client had *no* way to learn an event was silently dropped. Failed events are now persisted queryably: what was dropped, from which batch, and why.

## Design

- **One row per failed EVENT** (`ingest_event_failures`), not per batch — a batch retries whole on infrastructure errors, but a mapping failure is deterministic and per-event. Rows carry `batch_id`, `object_key`, `event_id`, `source`, `event_type`, `error`.
- **The payload is a pointer, not a copy.** The full raw batch already lives durably in object storage (the immutable ingest log); `object_key` + `event_id` locate the exact failed body for debugging or replay. Duplicating bodies into Postgres would bloat it with exactly the malformed-and-possibly-huge payloads least worth storing twice.
- **All four failure paths dead-letter**: native mapper validation errors, invalid OTLP export bodies, invalid LangFuse ingestion envelopes, and per-event LangFuse mapping errors (where the failure's `event_id` is the *inner* LangFuse SDK event id — what a 207 response would key on — since many SDK events nest inside one envelope event).
- **Best-effort persistence.** The failure rows are written AFTER the batch's valid rows insert into ClickHouse; a failure writing the diagnostics themselves logs and continues — it must never fail the batch and trigger a full retry over a bookkeeping write. Postgres is a required worker dependency.
- **Retried batches can duplicate failure rows** (per-attempt ulid ids) — accepted deliberately: duplicates in a diagnostics table beat inventing a cross-retry idempotency scheme for rows whose whole purpose is "look at me".
- **`GET /api/v1/projects/:projectId/ingest-failures`** (owner-session, project-scoped, newest-first, `limit` ≤ 200) — read-only; no delete/ack route, because rows age out automatically: the retention sweep purges failures older than a fixed 30 days (`purgeIngestFailuresOlderThan`, wired into `runRetention`), so the table can't grow unbounded and a diagnostics table needs no manual grooming.
- **`ironside_ingest_events_dead_lettered_total`** counter on the worker's metrics (M9-02's `onDeadLetter` hook) — the third actionable signal alongside queue depth and batch failures.

## A latent build bug found and fixed along the way

The new migration never reached `packages/db/dist/migrations` on incremental rebuilds: the build script's `cp -r migrations dist/migrations` copies the source *into* the destination when it already exists, silently nesting `dist/migrations/migrations/` — so compiled processes ran with a stale migration list (dev mode masked this by resolving migrations from the source tree; Docker images masked it by always building fresh). `packages/clickhouse` had the identical bug and identical nesting corruption in its `dist`. Both build scripts now `rm -rf dist/migrations` first. Found because the new test genuinely failed against the compiled path — not by inspection.

## Verification

- `apps/worker/test/ingest-processor.test.ts`: a batch with one valid native trace + three malformed events (native/OTLP/LangFuse) inserts the valid trace, records exactly 3 failure rows with correct source/eventType/eventId and an `object_key` pointing at the stored batch, and fires the metrics hook with the count; a dead-letter WRITE failure (pool whose `query` always rejects) never fails the batch — the trace data still lands.
- `packages/db/test/ingest-failures.test.ts` (4): batch insert + newest-first project-scoped listing, empty-array no-op, limit, and the 30-day purge (old row backdated and purged, recent kept).
- `apps/api/test/ingest-failures.test.ts` (3): 401 unauthenticated, full pointer fields round-trip with cross-project isolation, out-of-range limit 400.
- **Live end-to-end**: real API + worker; posted a batch with one valid trace and one invalid score (`score requires value or stringValue`); the failure appeared via `GET /api/v1/ingest-failures` with the real Zod-derived error and the exact `raw/<project>/<date>/<batch>.json` object key, the metrics counter read 1, and the valid sibling trace inserted into ClickHouse.

## Two more real bugs surfaced by this batch's review and tests

1. **Bind-param overflow could silently lose a whole batch's diagnostics (review-flagged).** `recordIngestFailures` used one multi-row INSERT at 8 params/row against Postgres's 65535 wire-protocol param cap (~8191 rows). The native path is bounded (500 events/batch), but one LangFuse envelope event nests an UNBOUNDED inner batch (`.min(1)`, no `.max()` — only the 10MB body limit, ~200k minimal events) — a huge all-failing LangFuse batch would blow the single INSERT, the processor's best-effort catch would swallow the throw, and ZERO rows would persist for exactly the batch most worth seeing (while the metrics counter, incremented before the write, still reported them — a silent counter/table divergence). Fixed by chunking at 8000 rows/statement; regression-tested with an 8500-row call.
2. **The LangFuse compat mapper silently accepted value-less scores (test-discovered).** Writing the per-event-mapping-failure processor test revealed `mapScore` mapped a score with no `value` "successfully" into a row with both `value` and `string_value` NULL — violating the domain invariant, indistinguishable from data loss, and the exact bug class M5-06 fixed in the LangSmith feedback mapper. Now rejected as a per-event mapping error (`score requires a value`), which dead-letters visibly. Pinned by a mapper-level regression test.

## Not yet done (deliberate)

- The API-edge responses (native 202, LangFuse 207) still can't reflect worker-side outcomes — inherent to fast-ACK async ingest; the dead-letter store is the queryable record, not a synchronous one.
- No web UI for the dead-letter list — API-only, same route-before-UI sequencing as the destination CRUD.
- The 30-day purge window is fixed, not configurable — add a knob when someone actually needs one.
