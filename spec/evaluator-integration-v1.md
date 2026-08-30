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
  Reusing `id` converges on one score. Score writes do not reopen traces.

`traceVersion` is a server-owned, commit-ordered publication version for one
materialized trace snapshot, not the trace's client-supplied start time. The
source activity timestamp remains the settlement watermark. Every distinct
trace or observation ingest batch that changes the materialized tree publishes
a fresh version after re-settlement, including a delayed older batch.

## Recovery and retention

The ingest worker advances `evaluator_trace_feed` after ClickHouse and the raw
index succeed and before marking the durable pending-ingest intent applied. A
batch ID makes a retry idempotent. Publications are serialized per project so
cursor order is commit order; timestamps retain PostgreSQL microsecond
precision in opaque cursors. Exact detail reads also reject a version with 409
while any durable raw reference for the trace is pending. Feed polling keeps
the cursor before such a publication until its pending reference is cleared,
so the same version remains discoverable. New consumers bootstrap ClickHouse
first so traces predating the table remain discoverable.

If retention removes a trace after publication, the feed cursor advances past
that orphan. Retention reconciles and prunes the corresponding feed and batch
ledger rows; deletion is version-guarded so a concurrent republish wins.
Consumers deduplicate by `(remote project, traceId, traceVersion)`.

## Upgrade order

Migration `0002_evaluator_trace_feed` must be applied before the API or worker
that serves this protocol. During a rolling application upgrade, deploy the
worker before (or together with) the API so no newly materialized trace can
fall between feed publication and API availability. Do not expose a new
evaluator API against an old worker that does not publish the feed. Consumers
upgrading from a pre-v1 cursor must reset that opaque cursor and perform the
bounded bootstrap reconciliation before resuming live polling.

## Non-goals

This protocol does not define release policy, evaluator thresholds, automatic
promotion, webhooks, or ownership of evaluator evidence. Polling is the
correctness path; push notification may later reduce latency without replacing
reconciliation.
