# OTLP Forwarding v1

Status: implemented. Owner: `apps/worker/src/forwarders/`, `packages/shared/src/otlp-export.ts`, `packages/db/src/otlp-forward-rules.ts`.

## Purpose

Forward stored traces, filtered per rule, as OTLP/HTTP+JSON to a customer-owned destination (an OpenTelemetry Collector, Jaeger, or any other OTLP-native backend), so a team's own observability tooling receives Ironside traces without building an extractor. It is the reverse of OTLP ingest (`spec/otlp-ingest-v1.md`) and reads the same durable trace feed as scheduled exports (`spec/scheduled-export-v1.md`) and webhooks (`spec/webhooks-v1.md`).

## Rules

`otlp_forward_rules` holds per-project named rules: `destination_url`, an optional auth header, a `TraceFilter`-shaped `filter`, `enabled`, and the scheduling columns `poll_interval_seconds` (default 300) and `next_run_at`. The auth header is AES-256-GCM encrypted at the application layer (`encryptSecret`, `packages/shared/src/encryption.ts`) and stored in `destination_auth_header_encrypted`; a bearer token for a collector is the same class of credential as an export's S3 secret key. Rules are managed through the API in `spec/scheduled-destinations-crud-v1.md` and run by the worker scheduler (`spec/scheduler-v1.md`), which decrypts the header before calling the forwarder.

## What a run forwards

`forwardOtlpTraces` (`apps/worker/src/forwarders/otlp-forwarder.ts`) sends every matching settled trace version published after the rule's position, one OTLP export request per trace, in the feed's commit order.

- **Position:** each rule stores its position in the durable trace feed, `evaluator_trace_feed` (`feed_cursor_published_at`, `feed_cursor_trace_id`; Postgres migration `0003`). A new rule starts at the beginning of the feed, so its first run forwards every existing matching trace.
- **Settlement:** the feed is read with the same rules as scheduled exports (`apps/worker/src/exporters/settled-trace-feed.ts`), using the project's quiet period. A run stops at a trace still inside its quiet period or still being written, and steps over traces retention removed.
- **Filter:** the rule's filter (time range, user/session, tags, metadata) is applied to each trace; traces it excludes are stepped over.
- **Versions:** a trace that receives new trace or observation activity is published again and forwarded again with its current observations. Scores do not move the feed and are never forwarded.
- **Bounds:** a run forwards at most 5,000 traces and examines at most 100,000 feed entries, reading 100 per page. A larger backlog continues on the next scheduler tick (`next_run_at` is set to now). Each request times out after 30 seconds.

## Delivery and failures

Each request is a `POST` to `destination_url` with `content-type: application/json` and, when the rule has one, the decrypted auth header as the `Authorization` value, so the stored value includes its scheme (for example `Bearer <token>`). Any 2xx response counts as accepted; the response body, including an OTLP `partialSuccess`, is not read.

- **Stopping failure:** a timeout, network error, 5xx, or a 4xx that describes the destination rather than the trace (401, 403, 404, 405, 408, 429, ...) stops the run with the position before that trace. The next run retries it first, so an unreachable or misconfigured destination delays forwarding instead of skipping traces.
- **Permanent rejection:** a 400, 413 or 422 (for example 413 for an oversized trace) skips that trace, and the run continues, so one bad trace cannot block the rule for good. A skipped trace is not retried unless it is published again.
- **Position:** the position advances past each accepted, skipped or non-matching entry. It is written at the end of every run, including a run that threw partway, and only if it still holds the value the run started from, so a slow run claimed twice by different worker replicas cannot move it back.
- **At least once:** a trace can be sent twice, for example by two overlapping runs or when recording the position fails after the destination accepted the trace. OTLP ids are derived deterministically, so a resent trace is the same trace downstream.
- **Run record:** every run records `last_run_at`, `last_run_status`, `last_run_forwarded_count` and `last_run_error` (Postgres migration `0004`), returned by the forward-rule API as `lastRunAt`, `lastRunStatus`, `lastRunForwardedCount` and `lastRunError`. The status is `error` when any trace failed or was skipped, or the run threw. The error lists each such trace as `<traceId>: <error>`, with `(skipped)` after the id of a permanently rejected one, and is truncated to 2,000 characters. The scheduler also reports such a run through `onError` and an `error` outcome in `ironside_scheduler_runs_total` (`spec/metrics-v1.md`).

## OTLP mapping

`mapTraceToOtlpExportRequest` (`apps/worker/src/forwarders/otlp-mapper.ts`) builds one `ExportTraceServiceRequest` JSON body per trace:

- One resource with `service.name` `ironside` and one scope, `ironside-forwarder`.
- One span per observation. A child observation's span carries its parent's span id as `parentSpanId`. The span name is the observation name, or its id when it has none. Times are Unix nanoseconds; an observation with no end time has no `endTimeUnixNano`.
- Span attributes are the observation's metadata as string attributes, plus the attributes a gen_ai-semconv instrumentation SDK produces: `gen_ai.request.model` (string) when the observation has a model, and `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` (int), each when its usage has the matching `input_tokens` or `output_tokens` key.
- Span status code is `2` (error) for an observation with level `error` and `1` (OK) otherwise, with the observation's status message when it has one.
- A trace with no observations is sent as one synthetic root span named after the trace (its id when unnamed), starting at the trace timestamp. An export with zero spans for a real trace would look like data loss downstream.
- Not sent: trace tags, metadata, user and session ids; observation type, input, output, cost and model parameters; scores.

Ids: OTLP requires `trace_id` to be exactly 16 bytes (32 hex characters) and `span_id` exactly 8 bytes (16 hex characters), and Ironside ids (ULIDs, imported UUIDs) do not fit. `toOtlpTraceId` and `toOtlpSpanId` (`packages/shared/src/otlp-export.ts`) take the first 32 or 16 hex characters of SHA-256 over `trace:<id>` or `span:<id>`. The same Ironside id always maps to the same OTLP id, so a re-forwarded trace is the same trace downstream, not a new one. SHA-256 is used only as a well-distributed byte source; the collision risk is accepted as negligible.

## SSRF guard

`destination_url` is customer-supplied, so each run first calls `assertPublicHttpDestination` (`apps/worker/src/lib/ssrf-guard.ts`), the same guard webhooks use. It requires `http` or `https`, resolves the hostname, and rejects the destination if any resolved address is loopback, private (`10/8`, `172.16/12`, `192.168/16`), link-local (including the cloud metadata address `169.254.169.254`), `0/8`, IPv6 unique-local (`fc00::/7`), unspecified, or an IPv4-mapped IPv6 form of an IPv4 address in those ranges. It checks the resolved addresses, not only the hostname string.

A rejected destination fails the run before any request is sent; the run is recorded on the rule, the scheduler reports the error, and the rule is retried on its own interval. Requests do not follow redirects: a 3xx response fails the trace like a 5xx, because its target was never checked. The check runs once per run, and each request resolves the hostname again, so a hostname that resolves to a public address for the check and a private one for the request (DNS rebinding) is not caught. Tests opt out with `allowPrivateDestinations: true` to reach a local server; the scheduler never sets it.

## Verified

`apps/worker/test/otlp-forwarder.test.ts` publishes traces to the feed and runs `forwardOtlpTraces` against real Postgres and ClickHouse and a local HTTP server. It covers one request per trace with the auth header and nested spans, a 500 stopping the run and the next run resuming at the same trace, a 413 skipped and recorded while the next trace is forwarded, a 401, 403 or 404 stopping the run without skipping anything, a request timeout stopping the run, filter matching, and the SSRF guard rejecting a loopback destination with no request sent. `apps/worker/test/otlp-mapper.test.ts` covers id length and stability, parent/child links, the `gen_ai.*` attributes, error status, the synthetic root span, and nanosecond timestamps. `apps/worker/test/ssrf-guard.test.ts` covers the rejected address ranges, including IPv4-mapped IPv6.

## History

- M6-02 (PR #17) added OTLP forwarding as a callable function. The scheduler (M6-05, `spec/scheduler-v1.md`) and the forward-rule API (M6-06, `spec/scheduled-destinations-crud-v1.md`) came later.
- The mapper output was checked once by hand against a Jaeger all-in-one container's OTLP/HTTP receiver (`:4318/v1/traces`): the `ironside` service, both span names, the child's parent reference, and the `gen_ai.*` attribute types (string model, int64 token counts) arrived as expected.
- M6-04 added the SSRF guard to the forwarder; the M6-03 webhooks review had found it missing.
- Migration `0003` moved forwarding onto the durable trace feed with a stored position per rule, and migration `0004` added the last-run columns so the API shows why a run stopped and which traces were skipped.
- Still open: forwarding follows the scheduler's poll cadence (default every 5 minutes, after the quiet period), not the moment a trace settles; forwarding on ingest would change the ingest pipeline and is not built. The SSRF guard does not pin the checked address for the request, so DNS rebinding is not caught. Only the `Authorization` header can be configured.
