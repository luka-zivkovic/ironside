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

`traceVersion` is the server-owned latest trace/observation activity timestamp,
not the trace's client-supplied start time. A later trace or observation write
therefore produces a new feed item after re-settlement.

## Recovery and retention

The ingest worker advances `evaluator_trace_feed` after ClickHouse and the raw
index succeed and before deleting the durable pending-ingest intent. If that
Postgres write fails, the whole idempotent job retries. The table stores only
the latest activity per trace, bounding its size. New consumers bootstrap
ClickHouse first so traces predating the table remain discoverable.

If retention removes a trace after publication, the feed cursor advances past
that orphan. Consumers deduplicate by `(remote project, traceId, traceVersion)`.

## Non-goals

This protocol does not define release policy, evaluator thresholds, automatic
promotion, webhooks, or ownership of evaluator evidence. Polling is the
correctness path; push notification may later reduce latency without replacing
reconciliation.
