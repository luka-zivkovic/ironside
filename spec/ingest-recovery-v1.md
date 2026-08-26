# Durable ingest recovery v1

Status: implemented for batches accepted after this version is deployed.

## Contract

Every HTTP ingest path now performs these steps in order:

1. write the immutable `raw/{project}/{yyyy}/{mm}/{dd}/{batch}.json` envelope;
2. write the corresponding `pending-ingest/{batch}.json` queue intent, including
   its API acceptance time;
3. enqueue that exact intent in BullMQ using `batchId` as the stable job id;
4. return the route's success response.

The worker fetches and materializes the raw batch exactly as before. Its final
commit step is an idempotent deletion of the pending intent. ClickHouse writes
remain retry-safe, so a crash between materialization and intent deletion can
repeat work without creating a second logical version.

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

For each valid intent:

- no Redis job: enqueue it;
- completed job (possible when it finishes during reconciliation): make its intent deletion idempotent;
- terminal failed job: preserve a diagnostic under `failed-ingest/` and remove
  it from the hot pending prefix, honoring BullMQ's finite retry policy;
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
  an unacknowledged orphan and is subject to the separate raw-retention policy.
- Redis enqueue failure: the request fails, but the durable pending intent
  remains and the reconciler can still process it. Clients should continue to
  use stable event idempotency keys when retrying failed requests.
- Redis loss after a success response: the pending intent remains and is
  automatically re-enqueued.
- Worker/materialization failure: BullMQ retry behavior is unchanged and the
  pending intent remains until a complete successful attempt.
- Pending-intent deletion failure: the job fails and retries rather than
  falsely committing recovery state.
- A batch that exhausts BullMQ retries is not retried forever by reconciliation;
  its queue message and failure details move to `failed-ingest/` for diagnosis.

## Deliberate boundary

This batch adds no Kafka, database ledger, new service, or raw-log scan. It also
does not delete raw events or media. End-to-end expiry across ClickHouse, raw
objects, raw indexes, and media is a separate batch because deletion semantics
require independent destructive-data review.

## Storage permissions

The worker validates the recovery prefixes at startup with
create/get/head/delete probes and a runtime-root `pending-ingest/` list probe.
Its pending object uses the reserved `pending-ingest/.internal/probes/`
subprefix so running reconcilers ignore it.
Production credentials require bucket listing plus `PutObject`,
`GetObject`/`HeadObject`, and `DeleteObject` for `pending-ingest/*`; failed-batch
diagnostics require Put/Get/Delete on `failed-ingest/*`. Keep delete denied for
`raw/*` to preserve the forensic archive. A bucket-wide Object Lock/default WORM
retention policy is incompatible with deletable sidecars in this single-bucket
version; use prefix-scoped IAM immutability for `raw/*` instead.
