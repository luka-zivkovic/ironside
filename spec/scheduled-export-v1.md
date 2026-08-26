# Scheduled Export v1

Status: implemented (M6-01); scheduler wiring (M6-05) and admin API routes (M6-06) since added. Owner: `packages/db/src/export-configs.ts`, `apps/worker/src/exporters/`, `apps/api/src/lib/encryption.ts`.

## Purpose

The stated differentiator (see `ROADMAP.md`'s north star): export stored traces to a customer's own S3-compatible bucket on a schedule, so a team paying for LangFuse/LangSmith purely as trace storage can pipe data into infra they already own (a warehouse, another analytics tool) without building their own extractor.

## Design

- **Config** (`export_configs` table): per-project, named export destinations — bucket/endpoint/region/access key, an optional `TraceFilter`-shaped JSON filter (time range, user/session, tags, metadata), and output `format` (`parquet` | `jsonl`). The destination secret key is AES-256-GCM encrypted at the application layer (`apps/api/src/lib/encryption.ts`, ported from coeval's identical pattern) before it ever reaches Postgres — a database dump never exposes a customer's S3 credentials in plaintext.
- **`exportTraces`** (`packages/clickhouse`): fetches *all settled* matching traces for a filter, unpaginated (this is a bulk export, not a UI list) — reuses the same `TraceFilter`/condition-builder as `listTraces`/`getAggregates`. Each row includes the additive `last_activity_at` column, the stable settled-version identifier; strict downstream schemas must allow this field after upgrading. See `spec/trace-envelope-v1.md`'s completion contract.
- **`writeExportFile`** (`apps/worker/src/exporters/duckdb-writer.ts`): writes rows to a local Parquet or JSONL file via `@duckdb/node-api`. Rows are staged as an NDJSON temp file and loaded with `read_ndjson_auto()`, which natively infers nested types (the `tags` array, `metadata` map) — this sidesteps hand-authoring a Parquet schema for those fields. DuckDB's own writer is the reference implementation, so "readable by DuckDB afterward" (the DoD) is satisfied by construction, and is verified directly in tests (write → read back with a *fresh* DuckDB instance → assert exact row count and field fidelity), not just assumed.
- **`runExport`** (`apps/worker/src/exporters/export-runner.ts`): ties it together — query, write, upload via `@ironside/storage`'s `putFile` (multipart streaming via `@aws-sdk/lib-storage`, so large exports aren't buffered in memory), record the outcome on the config row (`last_run_status`/`last_run_row_count`/`last_run_error`). A filter matching zero traces is a **successful no-op**, not an error.

## Verified end-to-end (not just unit-tested)

`apps/worker/test/export-runner.test.ts` runs the complete real pipeline: insert traces into real ClickHouse → `runExport` → real DuckDB Parquet write → real upload to a MinIO bucket → download the object back with a fresh S3 client → read it with a fresh DuckDB instance → assert the exact row count matches what was inserted. This is the literal DoD text ("output readable by DuckDB with expected row count"), exercised for real rather than inferred from unit tests of the pieces in isolation.

## Not yet done (follow-up, not blocking this DoD item)

- ~~No API routes / no scheduler~~ — **done since**: scheduler wiring in M6-05 (spec/scheduler-v1.md; note it claims via `claimDueExportConfigs`, not `listEnabledExportConfigs`, which is now unused), admin CRUD routes in M6-06 (spec/scheduled-destinations-crud-v1.md). A manual-trigger route still doesn't exist — setting `next_run_at` low via `pollIntervalSeconds` is the workaround.
- Streaming ClickHouse query results (`exportTraces` currently buffers via `.json()`) — fine at current scale, flagged in `packages/clickhouse/src/queries.ts`'s doc comment as the thing to revisit before this becomes a memory concern on very large exports.
