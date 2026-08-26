# Prometheus Metrics v1 (M9-02)

Status: implemented, verified live. Owner: `apps/api/src/metrics.ts`, `apps/worker/src/metrics.ts`, `apps/worker/src/scheduler.ts` (`onRunOutcome` hook).

## Purpose

First batch of M9 Phase 1 ("trustworthy to operate"): before this, the only operational visibility was `/health` and console logs — a self-hoster couldn't see ingest rates, queue backlog, or whether scheduled work was succeeding without shelling into Redis/reading logs. Both processes now export Prometheus metrics.

## Design

- **API: `GET /metrics` on the main port, disabled-by-default.** Without `METRICS_TOKEN` configured the endpoint returns 404 (indistinguishable from no-such-route); with it, requires exactly `Authorization: Bearer <token>`. Deliberately NOT project machine credentials — metrics are instance-wide, and one project shouldn't see cross-tenant request rates. Instance metrics are never exposed unauthenticated on a public port.
- **Worker: a dedicated `:9464/metrics` listener** (`METRICS_PORT`, OTel-Prometheus-convention default) — the worker has no other HTTP surface, and per-process metrics listeners are the standard queue-consumer pattern. The port is NOT published in `docker-compose.yml`; scraping externally is an explicit opt-in (map the port + set `METRICS_TOKEN`). The listener is `unref()`'d so it never keeps the process alive on its own, same rule as the scheduler's timers.
- **Bounded label cardinality, no per-project labels.** Request metrics label by the *matched route pattern* (`c.req.routePath`, e.g. `/api/v1/traces/:id`) — never the raw URL, so unbounded ids can't explode the label space. Project ids are deliberately excluded everywhere: unbounded cardinality is a Prometheus anti-pattern, and per-project usage questions are ClickHouse's job.
- **The API middleware registers FIRST**, before `bodyLimit`/CORS — a 413 rejection or a preflight answered before the route layer still gets counted; registered later, anything short-circuiting ahead of it would be invisible.
- **Queue depth is sampled at scrape time** (prom-client async `collect()` calling `queue.getWaitingCount()` etc.), not on a timer — always current, zero background work between scrapes. This required the worker to hold a `Queue` (producer-side) handle alongside its `Worker` consumer, since the consumer class doesn't expose counts.
- **Scheduler outcomes via a new `onRunOutcome(subsystem, outcome)` hook** — additive and optional (existing tests/callers unaffected), fired once per scheduled run across all five subsystems (export/otlp-forward/webhook/import/retention) alongside the existing `onError`.

## Metric inventory

| Metric | Process | Notes |
|---|---|---|
| `ironside_http_requests_total{route,method,status}` | api | matched pattern, not raw URL |
| `ironside_http_request_duration_seconds{route,method}` | api | histogram; buckets tuned to the measured 5–50ms ACK band |
| `ironside_worker_batches_processed_total` / `_failed_total` | worker | from the BullMQ worker's completed/failed events |
| `ironside_ingest_queue_waiting` / `_active` / `_failed` | worker | gauges sampled live at scrape time |
| `ironside_scheduler_runs_total{subsystem,outcome}` | worker | five subsystems × success/error |
| `process_*` / `nodejs_*` defaults | both | prom-client `collectDefaultMetrics` |

## Verification

- `apps/api/test/metrics.test.ts` (4 tests): 404 when unconfigured, 401 on missing/wrong token, Prometheus text with route-pattern labels and the raw trace id provably absent from the output, and pre-route rejections (auth 401s) counted — proving the middleware-first registration.
- `apps/worker/test/metrics.test.ts` (3 tests): counters + live queue gauges served over the real HTTP listener against the real Redis-backed queue, token gating, non-`GET /metrics` requests 404.
- **Live**: started compiled api+worker with `METRICS_TOKEN` set; API `/metrics` 401'd without the token and served with it (the 401 itself visible in the counters — middleware-first proven live); worker `:9464/metrics` showed real activity (136 batches drained at startup, `scheduler_runs_total{subsystem="retention",outcome="success"} 1`); a 150-request ingest burst appeared as `{route="/api/v1/ingest",status="202"} 139+` (driver pacing under target, as usual).
- Full suite green; `docker compose config` validates the new env passthrough.

## Two review findings, fixed and regression-tested

1. **The `?? "unmatched"` fallback was dead code.** For a 404 (or a bodyLimit 413 / CORS preflight short-circuited before the route layer), Hono's `routePath` reports the metrics middleware's own `"*"` registration as `"/*"` — never `undefined` — so the fallback could never fire and unmatched traffic would have been labeled with the misleading `"/*"`. Fixed by explicitly mapping `"/*"` → `"unmatched"`; regression-tested (reverted the fix, confirmed the test fails with `route="/*"` present).
2. **A metrics-port bind failure crashed the whole worker.** `server.listen(port)` with no `'error'` handler turns EADDRINUSE into an uncaughtException, killing the ingest consumer and scheduler over the process's LEAST important surface. Fixed with an error handler that logs and continues without metrics; tested by binding two listeners to the same port and asserting the process survives and the first listener still serves.

## Not yet done (deliberate)

- No alerting rules/Grafana dashboard shipped — `docs/self-hosting.md`'s Monitoring section names the two signals that matter (sustained `queue_waiting` > 0 → add workers; rising `queue_failed` → investigate); packaging dashboards is post-MVP.
- No per-project usage metrics — by design (cardinality + tenant isolation); ClickHouse aggregates cover that.
