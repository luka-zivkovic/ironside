# Durable ingest recovery v1

Status: implemented. Owner: `apps/api/src/lib/persist-ingest-batch.ts`,
`apps/worker/src/recovery/`.

## Contract

Every HTTP ingest path performs these steps in order:

1. write the immutable `raw/{project}/{yyyy}/{mm}/{dd}/{batch}.json` envelope;
2. write the corresponding `pending-ingest/{batch}.json` queue intent, including
   its API acceptance time;
3. enqueue that exact intent in BullMQ using `batchId` as the stable job id;
4. return the route's success response.

The worker fetches and materializes the raw batch. Its final commit step is an
idempotent deletion of the pending intent. ClickHouse writes remain retry-safe,
so a crash between materialization and intent deletion can repeat work without
creating a second logical version.

## Reconciliation

Each worker runs a separate bounded recovery loop. It lists only
`pending-ingest/`, never the complete raw archive. Keys are global batch ULIDs,
and a cursor stored at `pending-ingest/.internal/cursor.json` advances the next
bounded pass past every examined intent, including waiting, delayed, and active
jobs. A cycle captures its start time; the first intent accepted after that
high-water mark ends the cycle and forces the next pass to wrap. Continuous new
ingestion therefore cannot postpone revisiting an older marker forever. The
cursor survives worker restarts and also wraps when its suffix is empty.
Reserved `.internal/` probe and cursor objects are ignored without consuming
the scan budget. Committed, invalid, and terminal-failure markers leave the hot prefix.
`INGEST_RECOVERY_BATCH_SIZE` caps work per pass and
`INGEST_RECOVERY_INTERVAL_MS` controls frequency.
API and worker clocks must remain NTP-synchronized because the bounded-cycle
cutoff compares their timestamps.
Malformed cursors and cutoffs later than the current worker clock are reported,
deleted, and restarted from the oldest pending intent.

For each valid intent, under the raw object's per-object retention lock:

- raw object under an `executing` or `complete` raw retention intent
  (`spec/raw-retention-intents-v1.md`): delete the pending intent without
  enqueueing it or writing a diagnostic;
- no Redis job: enqueue it;
- completed job (possible when it finishes during reconciliation): make its intent deletion idempotent;
- terminal failed job: first settle any evaluator publication the batch already
  committed (`spec/evaluator-integration-v1.md`). If the batch instead left
  pending raw-index references without publishing, or is an evaluator score
  batch whose score is not yet materialized, retry the job rather than
  quarantine it, because quarantine would leave its trace blocked. Otherwise
  preserve a diagnostic under `failed-ingest/` and remove it from the hot
  pending prefix, honoring BullMQ's finite retry policy. If settlement itself
  fails, the pass fails and the pending intent stays;
- waiting, delayed, or active job: leave it alone.

Multiple worker replicas may scan the same intent. Stable BullMQ job ids and
idempotent object deletion make duplicate reconciliation benign. Redis and S3
transport errors fail the pass. A list-to-GET 404 is treated as the normal race
where another worker just committed. Syntactically malformed, schema-invalid,
or mismatched sidecars are reported and deleted so derived metadata cannot
head-of-line block valid work; the immutable raw archive remains untouched for
manual recovery.

## Failure semantics

- Raw write failure: the request fails; no queue intent or job exists.
- Pending-intent write failure: the request fails; the raw object can remain as
  an unacknowledged orphan and is subject to the separate raw-retention policy,
  which keeps it because it has no raw references
  (`spec/raw-retention-intents-v1.md`).
- Redis enqueue failure: the request fails, but the durable pending intent
  remains and the reconciler can still process it. A client retrying a failed
  request should resend the same trace, observation and score ids: rows upsert
  by id, so the retry converges instead of duplicating.
- Redis loss after a success response: the pending intent remains and is
  automatically re-enqueued.
- Worker/materialization failure: BullMQ retries the job and the pending intent
  remains until a complete successful attempt.
- Pending-intent deletion failure: the job fails and retries rather than
  falsely committing recovery state.
- A batch that exhausts BullMQ retries is not retried forever by reconciliation;
  its queue message and failure details move to `failed-ingest/` for diagnosis.
  The exception is the evaluator case above: a batch that would leave its trace
  blocked is retried instead.

## Deliberate boundary

Recovery state lives in object storage: no Kafka, database ledger, new service,
or raw-log scan. Recovery never deletes raw events or media. Raw-object expiry is specified separately in
`spec/raw-retention-intents-v1.md`; recovery only honors its intents.

## Storage permissions

The worker validates the recovery prefixes at startup with
create/get/head/delete probes and a runtime-root `pending-ingest/` list probe.
Its pending object uses the reserved `pending-ingest/.internal/probes/`
subprefix so running reconcilers ignore it.
Production credentials require bucket listing plus `PutObject`,
`GetObject`/`HeadObject`, and `DeleteObject` for `pending-ingest/*`; failed-batch
diagnostics require Put/Get/Delete on `failed-ingest/*`. Raw retention, on by
default, additionally needs `DeleteObject` on `raw/*` and
`PutObject`/`HeadObject`/`DeleteObject` on the per-day
`raw/{project}/{yyyy}/{mm}/{dd}/.retention-probes/*` probe prefixes
(`spec/raw-retention-intents-v1.md`); deny these only when
`RAW_RETENTION_EXECUTION_ENABLED` is not exactly `true`. A bucket-wide
Object Lock/default WORM retention policy is incompatible with deletable
sidecars in this single-bucket version; use prefix-scoped IAM immutability for
`raw/*` instead.

## Verified

`apps/api/test/persist-ingest-batch.test.ts` checks the write order and that a
failed intent write enqueues nothing. `apps/worker/test/pending-ingest-reconciler.test.ts`
covers bounded passes, completed/terminal/live jobs, a terminal marker kept when
settlement is unavailable, a retried terminal job with incomplete
materialization, retention coordination, malformed and mismatched intents, the
list-to-GET race, Redis errors, cursor recovery and wrapping, and ignored probes.
`apps/worker/test/storage-permissions.test.ts` covers the startup probes.

## History

- Batches accepted before durable recovery was deployed have no pending intent
  and are not recovered.
- Recovery shipped without any raw-event or media deletion, because deletion
  needed its own destructive-data review. Raw-object deletion followed in
  `spec/raw-retention-intents-v1.md`.
