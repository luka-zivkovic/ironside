# Webhooks v1

Status: implemented (M6-03); scheduler wiring (M6-05) and admin API routes (M6-06) since added. Owner: `packages/db/src/webhooks.ts`, `apps/worker/src/webhooks/`.

## Purpose

Fire an HTTP POST at a customer-owned destination when a settled trace matches a saved filter rule — the push counterpart to M6-01's scheduled pull export and M6-02's OTLP forward. Same `TraceFilter`/`exportTraces` building block as both of those, third and final consumer of it for M6. Since issue #44, delivery is exactly once per settled trace version: late trace/observation activity reopens the trace and produces one new notification after the quiet period.

## "Fires exactly once" — what that actually means

The roadmap DoD text is "fires exactly once per matching trace." Read literally as "exactly one delivery *attempt* ever," this would make a single transient failure (destination briefly down, a dropped connection) permanently block that trace from ever being delivered — clearly not the intent. The correct reading, consistent with standard webhook semantics (Stripe, GitHub): **exactly one *successful* delivery**, with failed attempts remaining retryable until they succeed.

## Design

- **`webhook_rules` table**: per-project named rules (destination URL, HMAC signing secret, `TraceFilter`-shaped filter, enabled flag). `signing_secret_encrypted` is AES-256-GCM encrypted at rest via the same helper as M6-01's export credentials and M6-02's forward-rule auth header — a webhook signing secret is the same credential risk class as either.
- **`webhook_deliveries` table**: one row per `(webhook_rule_id, trace_id, trace_version)` tuple, with a matching unique constraint. `trace_version` is the settled trace's latest ingest-activity timestamp and is always present. `status` is `pending | delivered | failed`.
- **`claimWebhookDelivery`** (`packages/db/src/webhooks.ts`): the sole correctness mechanism for exactly-once. A single atomic upsert claims the exact settled version before the request:
  ```sql
  insert into webhook_deliveries
    (id, webhook_rule_id, trace_id, trace_version, status, attempted_at)
  values ($1, $2, $3, $4, 'pending', now())
  on conflict (webhook_rule_id, trace_id, trace_version) do update
    set status = 'pending', attempted_at = now()
    where webhook_deliveries.status = 'failed'
       or (webhook_deliveries.status = 'pending'
           and webhook_deliveries.attempted_at < now() - interval '10 minutes')
  returning id
  ```
  Delivered tuples cannot be claimed again; failed or stale-pending tuples are retryable and preserve their original delivery id.
- **`runWebhooks`** (`apps/worker/src/webhooks/webhook-runner.ts`): fetches currently-matching settled traces via `exportTraces` (shared with M6-01/M6-02), claims each settled version *before* making the HTTP call, and includes that version in the payload. A later trace/observation write creates one new deliverable version after another quiet period.
- **Payload signing**: `X-Ironside-Signature: sha256=<hex>` header, HMAC-SHA256 computed over the exact raw JSON string sent as the request body (not a re-serialized object, which is not guaranteed byte-identical) — same pattern as Stripe/GitHub webhook signing, so receivers can verify authenticity with a standard recipe.
- **Payload shape**: `{ event: "trace.matched", traceId, projectId, timestamp, name, traceVersion }` — the minimum needed to identify the settled version and optionally fetch the trace back via the query API. `traceVersion` is additive in issue #44; strict receivers must allow it after upgrading.
- **SSRF guard** (`apps/worker/src/lib/ssrf-guard.ts`, `assertPublicHttpDestination`): `rule.destinationUrl` is customer-supplied, so before sending anything `runWebhooks` resolves the hostname and rejects loopback/link-local/private/reserved addresses (including DNS-rebinding cases, since the check runs against the actually-resolved IP, not the hostname string) — otherwise the worker is a general SSRF proxy into whatever network it runs on. Checked once per run (the destination is fixed for the whole rule), not per-trace. Tests opt out via `allowPrivateDestinations: true` to talk to a local mock server; production code paths never set it. IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are handled by extracting the embedded IPv4 and re-running the IPv4 range check, not by hardcoded per-range prefix strings — an initial version only matched a few hardcoded `::ffff:` prefixes and missed most private ranges (caught by automated security review); it also had to account for Node's `URL` parser canonicalizing a dotted-quad mapped address into pure hex-group form (`::ffff:172.20.1.1` → `::ffff:ac14:101`) before the embedded octets could be extracted.

## Verified against real infrastructure — not just mocks

`packages/db/test/webhooks.test.ts` runs against a real local Postgres: first claim succeeds; an already-delivered settled version returns `null`; a genuinely later version is independently claimable; failed claims reuse the original delivery id; and 10 parallel claims for the same tuple produce exactly one winner.

`apps/worker/test/webhook-runner.test.ts` runs against a real local Postgres + ClickHouse + a real local HTTP server (not a mocked `fetch`): a matching settled version is delivered with a correctly signed body; rerunning the same version is skipped; late activity produces one new delivery after re-settling; an HTTP 500 is retryable; and private destinations are rejected by default. `apps/worker/test/ssrf-guard.test.ts` covers the SSRF guard directly.

## Not yet done (follow-up, not blocking this DoD item)

~~No API routes / no scheduler~~ — **done since**: scheduler wiring in M6-05 (spec/scheduler-v1.md), admin CRUD routes in M6-06 (spec/scheduled-destinations-crud-v1.md). Still true: a real-time push-on-ingest trigger (firing the instant a trace is stored rather than on the M6-05 poll cadence) is the same larger architectural change flagged in `spec/otlp-forwarding-v1.md`, and applies equally here.
