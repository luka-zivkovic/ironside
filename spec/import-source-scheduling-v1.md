# Import Source Scheduling v1

Status: implemented. Owner: `packages/db/src/import-sources.ts`, `apps/api/src/routes/import-sources.ts`, `packages/shared/src/management.ts`, `apps/worker/src/scheduler.ts`, `packages/db/migrations/0001_baseline.sql`.

## Purpose

Store the credentials and schedule for each project's LangFuse or LangSmith import, so the worker runs the importers (`spec/langfuse-importer-v1.md`, `spec/langsmith-importer-v1.md`) on its own. `import_sources` holds this configuration; `import_checkpoints` holds the progress and status of the runs made against it.

## Storage

`import_sources` has one row per `(project_id, provider)`, the same uniqueness as `import_checkpoints`: `provider` (`langfuse` | `langsmith`), `encrypted_credentials`, `enabled` (default true), `poll_interval_seconds` (default 3600, must be positive), `next_run_at` (default now, so a new source is due at once), and timestamps. Rows are deleted with their project.

Credentials are one JSON object, encrypted with AES-256-GCM by `encryptSecret` (key from `IRONSIDE_ENCRYPTION_SECRET`) before they reach Postgres:

- LangFuse: `{ provider, publicKey, secretKey, baseUrl }`
- LangSmith: `{ provider, apiKey, baseUrl?, sessionIds }`, where `sessionIds` are the LangSmith project UUIDs to import from.

A single blob keeps the table the same across providers whose credential shapes differ.

## API

Owner-session routes under `/api/v1/projects/:projectId` (`spec/project-session-routing-v1.md`); machine credentials cannot reach them.

- `GET /import-sources` returns `{ importSources: [...] }` in creation order.
- `POST /import-sources` connects a source and returns 201. The body is a union discriminated on `provider` (`createImportSourceRequestSchema`):
  - `langfuse`: `publicKey` and `secretKey` (non-empty), `baseUrl` (a URL).
  - `langsmith`: `apiKey` (non-empty), optional `baseUrl` (a URL), `sessionIds` (a non-empty array of non-empty strings).
  - Either may add `pollIntervalSeconds`, an integer from 1 to 2,592,000 (30 days).

  A body missing a field its provider requires returns 400 `{ error: "invalid request", issues }`. Fields the chosen provider does not define are dropped before encryption. `POST` upserts by `(project, provider)`: connecting a provider again (for example to rotate credentials) keeps the same id, replaces the whole credential blob, re-enables the source, and keeps the existing poll interval unless a new one is given. It does not change `next_run_at`.
- `PATCH /import-sources/:id` updates `enabled` and `pollIntervalSeconds` only.
- `DELETE /import-sources/:id` returns 204. It does not remove the project's `import_checkpoints` row, so connecting the same provider again resumes from the saved checkpoint.

Responses are `{ id, projectId, provider, enabled, pollIntervalSeconds, nextRunAt }`; no credential field appears in any response. `PATCH` and `DELETE` match on both id and project, so another project's source returns the same 404 `{ error: "import source not found" }` as a missing one.

## Scheduling

Imports run on their own timer in the worker's scheduler, at the same interval as the main tick (`SCHEDULER_TICK_INTERVAL_MS`, default 30 seconds). A backfill against an external API can take minutes, and the main tick runs exports, OTLP forwards and webhooks one after another, so sharing it would delay them behind a slow import. A new import tick does not start while the previous one is still running.

Each import tick:

1. Ensures every project has an import retention cutoff (`seedEvaluatorImportRetentionCutoffs`). If that fails, the tick stops and no import runs, because an import without a cutoff could bring back traces retention removed.
2. Runs `recoverAbandonedEvaluatorImports`, which completes staged snapshots whose run is no longer live, for up to 25 project/provider pairs. It needs no provider credentials, so a disabled or deleted source cannot leave a snapshot stuck.
3. Claims up to 25 due sources with `claimDueImportSources`: enabled, `next_run_at <= now()`, oldest first, `FOR UPDATE SKIP LOCKED`. The claim sets `next_run_at` to now plus the poll interval, so concurrent ticks or worker replicas never claim the same row, and a slow or failed run does not change the cadence.
4. For each claimed source in turn, decrypts and parses the credentials, checks that the blob's `provider` equals the row's `provider` column, and calls `runLangfuseImport` or `runLangsmithImport`, chosen by the column, with the importers' default page size and page cap.

A run imports at most 20 pages of 50 traces. A larger history continues on the next scheduled run, one poll interval later.

## Failure behavior

- The importers record their own outcome in `import_checkpoints` (`idle`, or `error` with `last_error`) and rethrow; the scheduler reports the error to its error hook under `import` and counts it in `ironside_scheduler_runs_total{subsystem="import"}`.
- A failure before the importer starts (a decryption error, unparseable JSON, or a provider mismatch) is reported to the error hook and the metric only; nothing is written to `import_checkpoints`. The provider check keeps a tampered blob, or one decrypted with the wrong environment's key, from running the wrong importer against the wrong checkpoint row.
- One source's failure does not stop the other sources in the tick. Either way the claim has already moved `next_run_at`, so the source is tried again one poll interval later.
- A trace the importer skips as invalid is reported to the error hook as `import:langfuse:<traceId>` or `import:langsmith:<traceId>`.
- When another live run holds the source's checkpoint, the importer returns without running and the tick counts it as a success.

## Verified

- `packages/db/test/import-sources.test.ts` covers upsert defaults, reconnecting the same provider replacing the row rather than adding one, re-enabling a disabled source, a custom poll interval, a claim advancing `next_run_at`, a disabled source never being claimed, concurrent claims never taking the same row, and project-scoped delete. Each test creates its own project, since two tests sharing a project and provider would collapse onto one upserted row.
- `apps/api/test/import-sources.test.ts` covers the 401 without an owner session, connecting LangFuse and LangSmith sources, credentials absent from responses (checked by key and by searching the serialized body for the secret) and decrypting to what was sent, a 400 for a LangFuse body carrying LangSmith fields instead of its own, reconnect keeping the same id, and patch and delete including cross-project 404s.
- `apps/worker/test/scheduler.test.ts` covers a claimed LangFuse source being decrypted and passed to the real `runLangfuseImport` (shown by the `error` row it writes in `import_checkpoints` after failing against a closed local port), a provider mismatch being reported without running either importer, and one project's undecryptable source not blocking another project's import in the same tick.

## History

- M6-05 added the scheduler for exports, OTLP forwards, webhooks and retention but left imports out, because there was no table of import credentials. M5-07 added `import_sources`, the CRUD routes and the separate import timer, and was checked live: a source created through the API was picked up by a running worker, which decrypted it and ran the real importer.
- `upsertImportSource` first used `coalesce($5, $6)` for the optional poll interval. node-postgres sends an untyped `null` as text, so the insert failed with a type error; the DB tests caught it, and `$5::integer` fixed it.
- Review found that dispatch used the decrypted blob's own `provider` behind an `as` cast, so a blob disagreeing with the row ran the wrong importer. Dispatch now uses the row's column plus the explicit mismatch check, with a regression test.
- The scheduler tests first pointed sources at an unroutable TEST-NET-1 address, which can hang for a full TCP connect timeout; they now use the closed local port `127.0.0.1:9`, which fails at once.
- Issue #64 moved the routes from the flat `/api/v1/import-sources` to the owner-session `/api/v1/projects/:projectId/import-sources`.- The retention cutoff step and the recovery pass were added when imports moved onto the evaluator publication barrier (`spec/evaluator-integration-v1.md`).
- Still open: there is no way to rotate credentials or change a LangSmith source's `sessionIds` without reconnecting with a full `POST`; `PATCH` covers only `enabled` and `pollIntervalSeconds`.
