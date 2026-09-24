# Worker Scheduler v1

Status: implemented. Owner: `apps/worker/src/scheduler.ts`, `apps/worker/src/index.ts`, `packages/db/src/{export-configs,otlp-forward-rules,webhooks,import-sources}.ts` (claim functions).

## Purpose

Run the worker's periodic work (scheduled exports, OTLP forwards, webhooks, pull imports, environment-registry rebuilds, retention, ingest recovery and raw retention) inside the worker process, without an external cron or a second queue. Per-row work is claimed from Postgres, so several worker replicas can run the same loops safely.

## Loops

The worker entrypoint (`apps/worker/src/index.ts`) starts six loops. `startScheduler` (`apps/worker/src/scheduler.ts`) owns the first four; ingest recovery and the raw retention sweep are started beside it.

| Loop | Interval | Work |
|---|---|---|
| Destinations | `SCHEDULER_TICK_INTERVAL_MS` (30 s) | Claims due export configs, then OTLP forward rules, then webhook rules, and runs each with `runExport`, `forwardOtlpTraces` or `runWebhooks` |
| Imports | `SCHEDULER_TICK_INTERVAL_MS`, own timer | Refreshes the evaluator import-retention cutoffs (`seedEvaluatorImportRetentionCutoffs`), recovers abandoned evaluator imports (`recoverAbandonedEvaluatorImports`), then claims due import sources and runs `runLangfuseImport` or `runLangsmithImport` (`spec/import-source-scheduling-v1.md`) |
| Environment registry | `SCHEDULER_TICK_INTERVAL_MS`, own timer | Claims due project rebuilds and runs one bounded chunk of each (`spec/environments-v1.md`) |
| Retention | `RETENTION_INTERVAL_MS` (6 h) | `runRetention`, one global sweep over every project (`spec/rate-limiting-quotas-retention-v1.md`), which also purges dead letters older than 30 days (`spec/dead-letters-v1.md`) |
| Ingest recovery | `INGEST_RECOVERY_INTERVAL_MS` (30 s) | Reconciles durable pending-ingest intents in object storage back into the Redis queue (`spec/ingest-recovery-v1.md`) |
| Raw retention sweep | `RAW_RETENTION_SWEEP_INTERVAL_MS` (15 min) | Deletes raw event objects past their project's retention (`spec/raw-retention-intents-v1.md`). Started only when `RAW_RETENTION_EXECUTION_ENABLED` is exactly `true`, the default |

- Every loop runs once at startup and then on its interval, so a fresh worker does not wait a full interval before doing anything.
- Imports have their own timer because a backfill against an external API can take minutes, and on the destinations timer it would delay every export, forward and webhook behind it. The cutoffs are refreshed first so no import runs before every project has a durable retention cutoff (`spec/evaluator-integration-v1.md`).
- Each loop except retention skips a tick while its previous tick is still running, so sustained slowness spaces ticks out instead of piling them up. Retention passes are serialized by an exclusive Postgres advisory lock (`withEvaluatorRetentionFence`), which a second pass waits on.
- Within a tick, claimed rows run one at a time, and the destinations tick runs exports, forwards and webhooks in that order. A slow run delays the next tick; it does not skip claimed work.
- Timers are `unref()`'d, so they never keep the process alive on their own. On `SIGTERM` or `SIGINT` the worker stops every loop's timer before closing the ingest consumer and its connections; `stop()` does not wait for a tick that is already running.

## Claiming

A per-row loop claims its due rows in one statement per table. For export configs (`claimDueExportConfigs`; `claimDueOtlpForwardRules`, `claimDueWebhookRules` and `claimDueImportSources` are the same statement on their tables):

```sql
update export_configs
set next_run_at = now() + (poll_interval_seconds || ' seconds')::interval
where id in (
  select id from export_configs
  where enabled = true and next_run_at <= now()
  order by next_run_at asc
  limit $1
  for update skip locked
)
returning *
```

- A tick claims at most 25 rows per table, oldest due first (`claimBatchSize`, set in code, not by environment).
- `for update skip locked` gives concurrent ticks and worker replicas disjoint rows with no coordination beyond Postgres row locks. The correctness-critical locking is in the database, so a plain interval loop is enough and no BullMQ repeatable job is used.
- `next_run_at` advances in the claiming statement, before the run starts. A row whose run fails, or whose worker dies mid-run, is retried after its own interval, never on every tick.
- Claims span every project.
- `next_run_at` defaults to `now()`, so a new row is due on the next tick. `poll_interval_seconds` defaults per table in the Postgres baseline: `export_configs` 3,600, `otlp_forward_rules` 300, `webhook_rules` 60, `import_sources` 3,600. The API can set it per row (`spec/scheduled-destinations-crud-v1.md`).
- An export, forward or webhook run that stops at its per-run bound with backlog left sets `next_run_at` to now when it records its outcome, so the next tick continues it.
- With several replicas, a run that outlasts its row's interval can be claimed again by another replica and run concurrently. Exports, forwards and webhooks tolerate this: each stores its feed position only if it still holds the value the run started from, and webhooks also claim each delivery (`spec/webhooks-v1.md`).

Environment-registry rebuilds use the same `for update skip locked` claim on `project_environment_registry_state`, advancing `next_rebuild_at` by a 5-minute lease (`claimDueEnvironmentRegistryRebuilds`).

## Running a claimed row

- Credentials are decrypted here, once per claimed row, with `decryptSecret` (`packages/shared/src/encryption.ts`: AES-256-GCM with a key derived from `IRONSIDE_ENCRYPTION_SECRET`, which must match the API's). Runners receive plaintext: `destinationSecretAccessKey`, `destinationAuthHeader`, `signingSecret` and the import credentials.
- Exports, forwards and webhooks use the project's `traceQuietPeriodSeconds`, or `DEFAULT_TRACE_QUIET_PERIOD_SECONDS` (300) when the project has none.
- An import source is dispatched on its stored `provider` column. The decrypted credentials' `provider` must match it; a mismatch fails before either importer runs, so a tampered or mis-keyed blob cannot run the wrong importer against the project's `import_checkpoints` row.
- The scheduler never passes `allowPrivateDestinations`, so every forward and webhook run applies the SSRF guard (`apps/worker/src/lib/ssrf-guard.ts`). A destination that resolves to a private or loopback address fails its run before any request is sent, and the row is retried on its own interval.

## Failure handling and outcomes

One failing row never stops a tick. Each row's run is wrapped, and its outcome goes to two callbacks: `onError(subsystem, error)` (default `console.error`, prefixed `[scheduler:<subsystem>]`) and `onRunOutcome(subsystem, "success" | "error")`, which the worker counts in `ironside_scheduler_runs_total` (`spec/metrics-v1.md`). Where each outcome is stored:

- **Export:** `runExport` records its own outcome on every path it reaches. The scheduler records only errors, to cover failures before `runExport` starts (for example a secret that does not decrypt); recording a `runExport` failure a second time is harmless because an error outcome never moves the position. It never records success, which would overwrite the run's row count.
- **OTLP forward:** `forwardOtlpTraces` records its run, including an SSRF rejection, and a run in which any trace failed or was skipped counts as `error`. A decryption failure happens before the run starts, so it shows only in `onError` and the metric.
- **Webhook:** `runWebhooks` records its run, including an SSRF rejection, and a run that stopped at a failed delivery counts as `error`. A decryption failure is not recorded on the rule.
- **Import:** the importers record their own outcome in `import_checkpoints`; the scheduler's handler covers decrypting and parsing the credentials. A failure recovering an abandoned evaluator import goes to `onError("import-recovery", …)` without an outcome. A failure of the imports tick itself (the cutoff refresh or a claim query) counts as an `import` error.
- **Environment registry:** a failed chunk is recorded with `failEnvironmentRegistryRebuild`; a failed claim query counts as an error.
- **Retention:** reported through the callbacks only.
- **Ingest recovery and raw retention** report through their own callbacks in `index.ts`, to the same counter as `ingest-recovery` and `raw-retention`.

A failed claim query (for example, Postgres unreachable) counts as an error for that subsystem, and the destinations tick still runs the other two subsystems. No loop lets a failure escape as an unhandled rejection, which would stop the worker.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `SCHEDULER_TICK_INTERVAL_MS` | `30000` | Interval of the destinations, imports and environment-registry loops |
| `RETENTION_INTERVAL_MS` | `21600000` | Interval of `runRetention` |
| `DEFAULT_RETENTION_DAYS` | `90` | Retention for projects without an override; also sets the import cutoffs and the raw retention cutoff |
| `DEFAULT_TRACE_QUIET_PERIOD_SECONDS` | `300` | Quiet period for projects without an override |
| `IRONSIDE_ENCRYPTION_SECRET` | unset | Decrypts stored credentials. Without it every export, webhook and import run fails, as does every forward with an auth header |
| `INGEST_RECOVERY_INTERVAL_MS`, `INGEST_RECOVERY_BATCH_SIZE` | `30000`, `1000` | Ingest recovery loop |
| `RAW_RETENTION_EXECUTION_ENABLED`, `RAW_RETENTION_SWEEP_INTERVAL_MS` | `true`, `900000` | Raw retention sweep |

## Verified

`packages/db/test/scheduling.test.ts` covers claim selection (due, not yet due, disabled), rescheduling to the row's own `poll_interval_seconds`, and two concurrent claims of one row producing one winner; the forward and webhook claims are spot-checked. `packages/shared/test/encryption.test.ts` covers the round trip, random IVs, a tampered auth tag, an unknown version prefix and a missing `IRONSIDE_ENCRYPTION_SECRET`.

`apps/worker/test/scheduler.test.ts` runs `startScheduler` in its own Postgres schema and ClickHouse database, with real MinIO. It covers a claimed export running end to end and recording success; an unreachable export destination recording an error while `next_run_at` still advances; an export matching nothing recording row count 0; an undecryptable row reported without blocking a healthy row in the same tick; a LangFuse import source decrypted and dispatched to the importer; a provider mismatch rejected before any importer runs; one project's broken import source not blocking another project's import; forward and webhook rules with a loopback destination being claimed (the SSRF rejection itself is asserted in `otlp-forwarder.test.ts` and `webhook-runner.test.ts`); and `stop()` preventing further ticks. `apps/worker/test/scheduler-claim-failure.test.ts` runs it against an unreachable Postgres and checks that each destination subsystem reports its failed claim. The ingest recovery and raw retention loops are covered by their own specs' tests.

## History

- M6-05 (PR #29) added the scheduler, with the scheduling columns and due indexes, for exports, forwards, webhooks and retention; until then `runExport`, `forwardOtlpTraces` and `runWebhooks` were callable functions only. It moved `encryptSecret` and `decryptSecret` from `apps/api/src/lib/encryption.ts` to `@ironside/shared` so the worker can decrypt.
- M5-07 (PR #31) added the imports timer and `claimDueImportSources` (`spec/import-source-scheduling-v1.md`). The environment-registry timer, the cutoff refresh and abandoned-import recovery on the imports tick, and the ingest recovery and raw retention loops in the entrypoint came with their own features.
- The scheduler used to record a successful export a second time, and for an empty run its `rowCount ?? null` overwrote the `0` that `runExport` had stored. It now records only failures; a regression test in `scheduler.test.ts` covers the empty case.
- Because claims span every project, scheduler tests in the shared test database claimed other test files' rows and failed on their unrelated errors. `scheduler.test.ts` now uses its own Postgres schema and ClickHouse database.
- A failed claim query on the destinations tick used to escape as an unhandled rejection, which stops the worker under Node's default; it is now caught per subsystem.
- Still open: retention is one global sweep on one interval, with no per-project schedule.
