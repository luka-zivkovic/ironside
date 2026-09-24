# Prometheus Metrics v1

Status: implemented. Owner: `apps/api/src/metrics.ts`, `apps/api/src/app.ts` (`GET /metrics`), `apps/worker/src/metrics.ts`, `apps/worker/src/index.ts` (wiring), `apps/worker/src/scheduler.ts` (`onRunOutcome`).

## Purpose

Let an operator see request rates and latency, queue backlog, ingest failures and whether scheduled work succeeds, without shelling into Redis or reading logs. The API and the worker each export Prometheus metrics.

## API endpoint

`GET /metrics` is served on the API's main port.

- Without `METRICS_TOKEN` the endpoint is disabled and returns `404` `{"error":"not found"}`. With it, a request whose `Authorization` header is not exactly `Bearer <token>` gets `401` `{"error":"unauthorized"}`; otherwise the response is the Prometheus text format.
- Instance metrics are never served unauthenticated on the public port. The token is not a project machine credential, because metrics are instance-wide and one project must not see other tenants' request rates.

## Worker listener

The worker has no other HTTP surface, so it starts its own listener on `METRICS_PORT` (default `9464`), the usual pattern for queue consumers.

- It serves only `GET /metrics`; any other method or path gets `404`. With `METRICS_TOKEN` set, a request without exactly `Authorization: Bearer <token>` gets `401`; without it, the listener is unauthenticated. A collection failure returns `500`.
- A failure to bind the port (for example `EADDRINUSE`) is logged, and the worker keeps consuming ingest and running the scheduler without metrics; the listener is the process's least important surface. The listener is `unref()`'d, so it never keeps the process alive on its own.
- `docker-compose.yml` does not publish the port; scraping from outside the Compose network is an explicit opt-in (map the port and set `METRICS_TOKEN`). The self-host bundle (`deploy/self-host/compose.yaml`) requires a token and the Coolify template (`deploy/coolify.yaml`) generates one. Both, and the worker image (`apps/worker/Dockerfile`), use the worker's `/metrics` as its container health check.

## Labels and cardinality

- No metric has a project label. Project ids are unbounded, which is a Prometheus anti-pattern, and would reveal tenants to anyone who can scrape. Per-project usage questions are answered from ClickHouse.
- API request metrics label `route` with the matched route pattern (`c.req.routePath`, for example `/health`), never the raw URL, so unbounded ids cannot enter the label space. A request that no route matched, or that was answered before routing (a `bodyLimit` 413, a CORS preflight), reports the metrics middleware's own `/*` pattern and is labeled `unmatched`.
- The API metrics middleware is registered before every other middleware and route (`bodyLimit`, CORS, authentication), so requests those reject are still counted.

## Metric inventory

| Metric | Process | Labels | Meaning |
|---|---|---|---|
| `ironside_http_requests_total` | api | `route`, `method`, `status` | Requests handled |
| `ironside_http_request_duration_seconds` | api | `route`, `method` | Request duration histogram. Buckets run from 5 ms to 5 s: ingest acknowledgements normally take 5–50 ms, and the upper buckets make a degradation visible |
| `ironside_worker_batches_processed_total` | worker | — | Ingest jobs completed (BullMQ `completed` events) |
| `ironside_worker_batches_failed_total` | worker | — | Ingest job failures (BullMQ `failed` events); failed jobs are retried up to the queue's attempt limit |
| `ironside_ingest_batches_recovered_total` | worker | — | Pending ingest batches re-enqueued by ingest recovery (`spec/ingest-recovery-v1.md`) |
| `ironside_ingest_events_dead_lettered_total` | worker | — | Ingest events the worker could not map (`spec/dead-letters-v1.md`) |
| `ironside_ingest_queue_waiting`, `ironside_ingest_queue_active`, `ironside_ingest_queue_failed` | worker | — | Ingest queue depth by job state |
| `ironside_scheduler_runs_total` | worker | `subsystem`, `outcome` | Scheduled runs; `outcome` is `success` or `error` |
| `ironside_environment_registry_overflow_total` | worker | `source` (`live`, `rebuild`) | Valid new environment values left out of bounded discovery (`spec/environments-v1.md`) |
| `process_*`, `nodejs_*` | both | — | prom-client `collectDefaultMetrics` |

The queue gauges are sampled at scrape time: prom-client's async `collect()` calls `getWaitingCount()`, `getActiveCount()` and `getFailedCount()` on a producer-side BullMQ `Queue` handle the worker holds beside its consumer, since the `Worker` class does not expose counts. They are always current, and nothing runs between scrapes.

`ironside_scheduler_runs_total` counts one run per value of `subsystem`:

| `subsystem` | One run is | Counted as `error` when |
|---|---|---|
| `export` | a claimed export config | the run or its setup throws, or the claim query fails |
| `otlp-forward` | a claimed forward rule | the run throws, any trace failed or was skipped, or the claim query fails |
| `webhook` | a claimed webhook rule | the run throws, a delivery failed, or the claim query fails |
| `import` | a claimed import source | the run or its setup throws, or the imports tick itself fails |
| `environment-registry` | a claimed rebuild chunk | the chunk throws, or the claim query fails |
| `retention` | a `runRetention` pass | the pass throws |
| `ingest-recovery` | an ingest recovery pass | the pass throws |
| `raw-retention` | a raw retention sweep, only while raw retention is enabled | the sweep throws or reports any project or object error |

A failure recovering one abandoned evaluator import goes only to the scheduler's `onError`; a failed recovery query counts as an `import` error. See `spec/scheduler-v1.md` for where each run records its outcome.

## Configuration

| Variable | Process | Default | Effect |
|---|---|---|---|
| `METRICS_TOKEN` | api, worker | unset | API: enables `GET /metrics` and sets its bearer token. Worker: sets the listener's bearer token; unset leaves it unauthenticated |
| `METRICS_PORT` | worker | `9464` | Port of the worker's metrics listener |

## Verified

`apps/api/test/metrics.test.ts` covers `404` without a token, `401` for a missing or wrong token, Prometheus text with route-pattern labels and default process metrics and without the raw trace id of a request, unmatched requests labeled `unmatched` and never `/*`, and an ingest request rejected with `401` by authentication still being counted. `apps/worker/test/metrics.test.ts` serves the counters, including recovered batches, scheduler runs and environment overflow, and the live queue gauges from a real Redis-backed queue over the HTTP listener. It also covers token gating, a second listener failing to bind a taken port without crashing the process while the first keeps serving, and `404` for anything other than `GET /metrics`.

## History

- M9-02 added the API endpoint, the worker listener, and the request, batch, queue-depth and scheduler-run metrics.
- The route label first fell back with `?? "unmatched"`, which never fired: Hono reports the middleware's own `/*` pattern for an unmatched request, so such requests were labeled `/*`. The middleware now maps `/*` to `unmatched`.
- A bind failure on the worker's metrics port used to crash the worker, because the listener had no `error` handler. It now logs and continues.
- Later features added `ironside_ingest_events_dead_lettered_total` (M9-03), `ironside_ingest_batches_recovered_total` (ingest recovery), `ironside_environment_registry_overflow_total` (observed environments), and the `environment-registry`, `ingest-recovery` and `raw-retention` scheduler subsystems.
- Still open: no alerting rules or dashboards are shipped. The Monitoring section of `docs/self-hosting.md` names the signals to watch: a sustained non-zero `ironside_ingest_queue_waiting` means add workers, and a rising `ironside_ingest_queue_failed` needs investigation.
