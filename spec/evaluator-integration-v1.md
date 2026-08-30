# Evaluator Integration v1

Status: implemented. Owner: Ironside. Protocol identifier:
`ironside/evaluator/v1`.

## Purpose

Provide a stable, project-bound machine contract for evaluator systems such as
Coeval without making them impersonate LangFuse clients or copy Ironside's
trace-settlement policy.

An Integration credential selects exactly one project and requires
`traces:read` for context and trace reads and `scores:write` for assessment
writeback. Machine routes never accept a project id from the caller.

## Routes

- `GET /api/v1/evaluator/context` returns the protocol version, resolved
  project identity, credential capabilities, and effective quiet period.
- `GET /api/v1/evaluator/traces?cursor=&limit=` returns only settled trace
  versions. The first cursor bootstraps current settled traces and keeps a
  bounded catch-up horizon long enough for traces already inside the quiet
  period to settle. It then switches to a durable latest-activity feed written
  only after the ingest worker has materialized ClickHouse rows and raw-event
  references. Cursors are opaque and every response returns the next cursor.
- `GET /api/v1/evaluator/traces/:id?version=` returns the complete trace and
  nested observation tree only when that exact version remains settled. A
  concurrent later write returns `409 trace_version_changed` rather than
  mixing two versions.
- `POST /api/v1/evaluator/scores` records an idempotent numeric assessment.
  Reusing `id` with the same request converges on the first server timestamp
  and one score, including retries on another UTC day. Reusing the id for a
  different request returns 409. Score writes do not reopen traces. Receipt
  identity is independent of trace-feed retention and remains scoped to the
  project, whose deletion cascades the ledger.

`traceVersion` is a server-owned, commit-ordered publication version for one
materialized trace snapshot, not the trace's client-supplied start time. The
source activity timestamp remains the settlement watermark. Every distinct
trace or observation ingest batch that changes the materialized tree publishes
a fresh version after re-settlement, including a delayed older batch. Scheduled
LangFuse and LangSmith pull imports stage the full trace snapshot behind the
same fail-closed publication barrier before writing ClickHouse; retries reuse
the staged generation, while later content changes allocate a newer one. The
durable snapshot includes rows removed by the provider: materialization
tombstones the previous imported trace tree before writing the replacement, so
the newly published version cannot retain stale observations. Score content is
part of the durable import identity but not the evaluator-visible identity, so
provider score-only changes reconcile without reopening a trace. Imported
scores carry an explicit ClickHouse `import_source`; replacement tombstones
only scores owned by that provider, preserving native/manual/Coeval
assessments on the same trace.
All evaluator-visible writers hold the shared side of a cross-worker lifecycle
fence from the first ClickHouse mutation through PG publication. Retention
holds the exclusive side through ClickHouse deletion and feed reconciliation,
so it cannot remove part of a snapshot during materialization.

## Recovery and retention

The ingest worker advances `evaluator_trace_feed` after ClickHouse and the raw
index succeed and before marking the durable pending-ingest intent applied. A
batch ID makes a retry idempotent. Publications are serialized per project so
cursor order is commit order; timestamps retain PostgreSQL microsecond
precision in opaque cursors. Exact detail reads also reject a version with 409
while any durable raw reference for the trace is pending. Feed polling keeps
the cursor before such a publication until its pending reference is cleared,
so the same version remains discoverable. New consumers bootstrap ClickHouse
first so traces predating the table remain discoverable. Bootstrap applies the
same pending guard. Its live handoff starts from the feed origin: entries
already returned by bootstrap retain the same publication version and are
consumer-deduplicated, while no source and publication clocks are compared.
If a worker attempt fails after publication, its failure hook reconciles the
published batch ledger back to applied raw references; score-only references
are never marked snapshot-pending. Exact score retries share one durable ingest
batch. A staged receipt suppresses duplicate API enqueue, while terminal
recovery continues replaying that batch until the worker marks the score
materialized; acknowledgement never turns a failed score into silent loss.

Pull-import runs use renewable five-minute leases and fencing tokens. Their
exact pending snapshots live as base64-encoded JSON recovery envelopes in
PostgreSQL (so valid U+0000 payload content cannot poison `jsonb`), so a crashed,
disabled, or deleted source cannot strand an evaluator trace: the independent
recovery pass takes over an expired lease and completes materialization. A stale
worker cannot save progress or publish after takeover. Invalid provider
identifiers are skipped per trace before staging and surfaced to the scheduler
error hook, allowing the source checkpoint to advance. Successful publication
clears the staged snapshot and run token, retaining only compact generation
identity; imported trace payloads therefore do not outlive their ClickHouse
retention in Postgres.

If retention removes a trace after publication, the feed cursor advances past
that orphan. Observation and score rows belonging to an in-window trace are
retained with their parent even when their own timestamps are older; retention
therefore cannot silently mutate an evaluator tree under an unchanged trace
version. Conversely, parent expiry tombstones every child even when a child or
assessment has a newer timestamp. Retention reconciles and prunes the corresponding feed and batch
ledger rows; deletion is version-guarded so a concurrent republish wins. A
durable monotonic per-project import cutoff also fences pull materialization
before and after ClickHouse writes, preventing inclusive provider checkpoints
from resurrecting expired traces.
Consumers deduplicate by `(remote project, traceId, traceVersion)`.

Identifiers accepted by the native ingest contract are trimmed, reject NUL,
and are bounded to 512 UTF-8 bytes before durable raw storage or ClickHouse
materialization. This keeps a client-supplied identifier from becoming a
deterministic PostgreSQL publication poison.

## Installation

The PostgreSQL and ClickHouse baseline migrations contain the complete
evaluator protocol schema. Worker startup initializes the durable per-project
import-retention cutoff before enabling scheduled provider imports. The worker
refreshes this monotonic ledger before every import tick, so projects created
after startup are covered too; it fails closed and retries if initialization
cannot complete.

## Non-goals

This protocol does not define release policy, evaluator thresholds, automatic
promotion, webhooks, or ownership of evaluator evidence. Polling is the
correctness path; push notification may later reduce latency without replacing
reconciliation.
