# Rate limiting, quotas, and retention v1

Status: implemented. Owner: `apps/api/src/middleware/rate-limit.ts`, `apps/api/src/routes/projects.ts` (`projectQuotasRoutes`), `packages/db/src/projects.ts` (`setProjectQuotas`), `packages/clickhouse/src/retention.ts`, `apps/worker/src/retention/retention-runner.ts` (`runRetention`).

## Purpose

Protect a deployment from a runaway client with a per-project write budget, let an owner adjust a project's limits, and remove trace data once it passes its project's retention window.

## Rate limiting

A fixed-window, per-project limiter backed by the shared Redis instance, so every API replica enforces one count and a restart loses nothing. It runs after `machineAuth`, so an unauthenticated request is rejected before it is counted.

These machine write routes share one project budget:

| Route | Credential capability |
|---|---|
| `POST /api/v1/ingest` | `ingest` |
| `POST /v1/otel/traces` | `ingest` |
| `POST /api/public/ingestion` | `ingest` |
| `POST /api/public/scores` | `scores:write` |
| `POST /api/v1/evaluator/scores` | `scores:write` |
| `POST /api/v1/media` | `media:write` |

- **Limit:** `projects.rate_limit_per_minute`, or `DEFAULT_RATE_LIMIT_PER_MINUTE` (default 300) when the project has no override. The window is 60 seconds.
- **Counting:** Redis key `ratelimit:{projectId}:{window}`, where `window` is the Unix time in seconds divided by 60, rounded down. Each request `INCR`s the key; the request that creates it sets `EXPIRE 60`, so later requests cannot push the expiry out. Every authenticated request on these routes counts, including ones that are then rejected.
- **Rejection:** past the limit the API returns `429` with `{"error": "rate limit exceeded: <limit> requests per 60s per project"}` and `Retry-After` set to the seconds left in the current window.
- **Boundary:** a fixed window allows up to twice the limit across a window boundary. That is acceptable because the limiter exists to stop a runaway client, not to meter usage.
- **Override cache:** the limiter reads a project's override through Redis (`quota:ratelimit:{projectId}`, 60-second TTL; an empty value means no override), so a change to `rateLimitPerMinute` can take up to a minute to apply. A per-request Postgres read would sit on every ingest request. Credential revocation, by contrast, takes effect immediately (`spec/scoped-machine-credentials-v1.md`).
- **Failure:** the limiter has no in-process fallback; if Redis is unavailable the request fails instead of bypassing the limit.

Other routes:

- The owner-session raw-event lookup, `GET /api/v1/projects/:projectId/traces/:id/raw-events`, has its own limit of 30 requests per minute per project (key `ratelimit:raw-events:{projectId}:{window}`). It ignores the project's `rateLimitPerMinute` override and does not share the write budget, because one lookup can fan out into many object-storage reads.
- Other owner-session routes and the machine read routes (`/api/public/traces`, `/api/v1/evaluator/context`, `/api/v1/evaluator/traces`) are not rate limited.
- Owner setup, login and recovery have a separate per-address limiter, `AUTH_RATE_LIMIT_PER_15_MINUTES` (`spec/owner-auth-v1.md`).

## Project quotas

`projects.rate_limit_per_minute`, `projects.retention_days` and `projects.trace_quiet_period_seconds` are nullable positive integers (enforced by check constraints). `null` means the platform default: `DEFAULT_RATE_LIMIT_PER_MINUTE` (API), `DEFAULT_RETENTION_DAYS` (worker, default 90), and `DEFAULT_TRACE_QUIET_PERIOD_SECONDS` (default 300; see `spec/trace-envelope-v1.md`).

`PATCH /api/v1/projects/:projectId/quotas` sets them. It requires the owner session and an owned project (a foreign or unknown project is `404`); machine credentials cannot call it. The body accepts `rateLimitPerMinute`, `retentionDays` and `traceQuietPeriodSeconds` (`updateProjectQuotasRequestSchema`, `packages/shared/src/management.ts`), each a positive integer or `null`, and `traceQuietPeriodSeconds` at most 2,147,483,647. The response is the updated project.

A field changes only when the body includes it: an omitted field keeps its value and an explicit `null` clears the override. The distinction holds at every layer:

- the schema uses `.nullable().optional()` so omitted and `null` stay distinct on the wire;
- the route copies a field into the update only when the key is present (`exactOptionalPropertyTypes` would otherwise let Zod's `undefined` for an omitted field through);
- `setProjectQuotas` builds its `SET` clause from the keys present. It does not use `COALESCE`, which could never clear a value back to `null`. A body with no fields returns the project unchanged.

The web app has no quota screen; quotas are set through this route.

## ClickHouse retention

Each worker's scheduler runs `runRetention` when it starts and then every `RETENTION_INTERVAL_MS` (default 21,600,000, six hours). The interval is global, not per project. A pass holds an exclusive Postgres advisory lock (`withEvaluatorRetentionFence`, `packages/db/src/evaluator-lifecycle-fence.ts`) that ingest and import writes take in shared mode, so retention never runs while a trace tree is half-written and concurrent passes from several workers run one at a time. Each outcome is counted in `ironside_scheduler_runs_total{subsystem="retention"}`.

A project's retention is `retentionDays ?? DEFAULT_RETENTION_DAYS`. `traces` and `scores` are partitioned by `toYYYYMM(timestamp)` and `observations` by `toYYYYMM(start_time)`: calendar-month partitions shared by every project. Dropping a partition therefore removes that month for all projects, so partition drops can enforce only one global cutoff, and shorter per-project windows need row-level deletion.

A pass, in order:

1. **Import cutoffs.** Records each project's cutoff in a durable, monotonic per-project ledger before deleting anything, so a pull importer cannot re-insert a trace retention is about to remove. The scheduler's import tick also seeds these cutoffs before any import runs, and fails closed until they exist.
2. **Expired parents.** Records the ids of every trace older than its project's cutoff in `evaluator_trace_retention`, paged 10,000 at a time, before any deletion hides them.
3. **Partition drops.** For each of `traces`, `observations` and `scores`, drops a partition only when its newest row is older than the global floor, `max(DEFAULT_RETENTION_DAYS, every project's retentionDays)`, minus a further 24-hour grace period (`PARTITION_DROP_GRACE_PERIOD_MS`). The floor is the loosest window because a partition may still hold another project's in-window rows. The grace period covers the gap between checking a partition and dropping it: ingest is asynchronous and event timestamps are client-supplied, so a late or backfilled row can land in an old partition. An `observations` or `scores` partition is kept while any of its rows belongs to a trace still present in `traces`.
4. **Row-level deletion.** Only for projects with an explicit `retentionDays` shorter than the floor, `markProjectDataDeletedOlderThan` re-inserts each expired row with `is_deleted = 1` (an `INSERT ... SELECT ... FINAL` of every column). Observations and scores whose parent trace is still inside the project's window are excluded. Projects on the platform default are not row-deleted when a longer override raises the floor; their old data goes when the floor comes back down. Row-deleting every default project whenever one project has a long override would run a full ClickHouse mutation per project on every pass.
5. **Children of expired parents.** For every recorded parent that is no longer present in `traces`, tombstones all of its observations and scores, whatever their own timestamps, in batches of 500.
6. **Housekeeping.** Purges ingest failure diagnostics older than 30 days (`spec/dead-letters-v1.md`) and LangFuse field-provenance rows older than 30 days (`spec/langfuse-compat-v1.md`), and deletes `evaluator_trace_feed` rows whose trace no longer exists in ClickHouse, 500 at a time. The feed deletion is version-guarded, so a trace republished meanwhile keeps its row, and it runs on every pass so rows left by a crashed pass are still cleaned.

Guarantees:

- Retention is whole-trace. A tree whose parent trace is still visible is never partially deleted, even when a child's timestamp is older, so an evaluator never sees a trace's content change under an unchanged trace version. When the parent goes, every child goes with it, even a newer one. The cost is that old child rows are kept until their parent expires.
- `is_deleted` is `ReplacingMergeTree(event_ts, is_deleted)`'s engine tombstone: once a row's newest version has `is_deleted = 1`, `FINAL` queries omit the row entirely. Disk space is reclaimed when ClickHouse merges the parts.
- Partition drops and row tombstones are not atomic with ingest; the grace period narrows the race to rows arriving more than 24 hours late.

## Raw events and media

Raw event objects in object storage follow the same per-project retention but are deleted separately: the worker's raw retention sweep runs every `RAW_RETENTION_SWEEP_INTERVAL_MS` (default 15 minutes) and deletes an object only when nothing visible still depends on it. It is on by default; setting `RAW_RETENTION_EXECUTION_ENABLED` to anything other than `true` on every worker keeps raw events indefinitely. Upgrading from 0.3.0 starts this deletion. Contract: `spec/raw-retention-intents-v1.md`; inventory: `spec/lifecycle-planning-v1.md`.

Uploaded media is not covered by retention (`spec/media-v1.md`).

## Verified

`apps/api/test/rate-limit.test.ts` covers the 429 with `Retry-After`, owner-session reads still working after the ingest budget is spent, independent per-project budgets, a project override replacing the default, media sharing the ingest budget, and the raw-event lookup's separate limit ignoring the ingest override. `apps/api/test/projects.test.ts` covers the quota route (an omitted field unchanged, `null` clearing, foreign and unknown projects) and `packages/db/test/projects.test.ts` covers `setProjectQuotas` directly. `packages/clickhouse/test/retention.test.ts` covers whole-month partition drops across projects, the grace period, partitions with in-window data, row-level tombstones that preserve every other column and leave other projects alone, children kept with a live parent, children removed with an expired parent, and paging without a global row limit. `apps/worker/test/retention-runner.test.ts` covers import cutoffs seeded before the first pass, drops at the default floor, a longer override blocking a drop, a default-retention tree kept intact under a raised floor, and row-level deletion for a shorter override. `packages/db/test/evaluator-lifecycle-fence.test.ts` covers retention waiting for in-flight writers.

## History

- M7-03 added the ingest rate limiter, the quota columns and `PATCH /api/v1/projects/:id/quotas` (then authenticated by project API key), and `runRetention` as a callable job. M6-05's scheduler later ran it on its own interval.
- Bugs found and fixed during M7-03 development and review: a `COALESCE`-based update that could never clear an override; `exactOptionalPropertyTypes` exposing that spreading the parsed body passed `undefined` for omitted fields; row-level deletion applied to every default-retention project whenever one project had a long override, which hung a pass on a stack with about 35 projects; tests first assumed `FINAL` returns tombstoned rows with the flag set, but it omits them; and a check-then-drop race in partition drops, fixed with the 24-hour grace period.
- Retention later became whole-trace (child partitions and rows kept while the parent lives, children removed with their parent), and gained the import cutoff ledger, the evaluator lifecycle fence and feed pruning, so evaluators never see a changed tree under an unchanged version.
- Owner sessions replaced API-key management (#63–#65): the quota route moved under `/api/v1/projects/:projectId/` behind the owner session. `traceQuietPeriodSeconds` joined the quota fields with the trace finalization contract (#46). Write routes added after M7-03 (media upload, score writes) joined the shared budget; the raw-event lookup has its own.
- The S3 lifecycle half of retention became the raw retention intent executor and sweep (`spec/raw-retention-intents-v1.md`) instead of a bucket lifecycle policy.
- Still open: no web UI for project quotas; no retention for uploaded media; outbound exports, OTLP forwards and webhooks are bounded per run but not rate limited.
