# Webhooks v1

Status: implemented. Owner: `packages/db/src/webhooks.ts`, `apps/worker/src/webhooks/webhook-runner.ts`.

## Purpose

Send an HTTP POST to a customer-owned destination when a settled trace matches a saved filter rule. It is the push counterpart to scheduled exports (`spec/scheduled-export-v1.md`) and OTLP forwarding (`spec/otlp-forwarding-v1.md`), and reads the same durable trace feed.

## What a run delivers

Each run delivers one webhook for every **matching settled trace version published since the rule's position**, in the feed's commit order.

- **Position:** each rule stores its position in the durable trace feed, `evaluator_trace_feed` (`feed_cursor_published_at`, `feed_cursor_trace_id`; Postgres migration `0006`). A rule starts at the beginning of the feed, so its first run notifies about every existing matching trace. The feed, and why it is read instead of activity time, are described in `spec/scheduled-export-v1.md`.
- **Settlement:** the feed is read with the same rules as scheduled exports (`apps/worker/src/exporters/settled-trace-feed.ts`): a run stops at a trace still inside its quiet period or still being written, and steps over traces retention removed.
- **Versions:** a trace that receives new trace or observation activity is published again and gets a new webhook after another quiet period, including a late batch whose receive time is older than the trace's latest activity. Scores never reopen a trace, so they never trigger a webhook.
- **Filter:** the rule's `TraceFilter` (time range, user/session, tags, metadata) is applied to each trace; traces it excludes are stepped over.
- **Bounds:** a run sends at most 1,000 webhooks and examines at most 100,000 feed entries; a larger backlog continues on the next scheduler tick. Each request times out after 30 seconds.

## Exactly once

Each `(rule, trace, version)` is delivered successfully exactly once. A failed attempt stays retryable; "exactly once" never means one attempt.

`webhook_deliveries` holds one row per tuple under a unique constraint, with `status` `pending | delivered | failed`. Before sending, `claimWebhookDelivery` claims the tuple in one atomic upsert:

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

A delivered tuple cannot be claimed again, so a run that starts from an old position (a slow run claimed twice by different worker replicas) skips what was already sent. A pending attempt older than 10 minutes belonged to a worker that stopped mid-send and is claimed again; that one case can send twice. A failure to record a confirmed delivery propagates as an error rather than marking the row failed, which would let the next run send it again.

`trace_version` is the trace's feed version: distinct and increasing for every publication of the trace, and the same token the evaluator API and exports use.

## Failures

A request that fails (a network error, a timeout, or any non-2xx response) marks its delivery failed and stops the run before that trace. The next run retries it first, so an unreachable or misconfigured destination delays webhooks instead of skipping traces, and delivery stays in feed order. A run also stops, without an error, at a version another run is still sending.

The position advances past every delivered, already-delivered, or non-matching entry, and is stored only if it still holds the value the run started from. Every run records `last_run_status`, `last_run_error` and `last_run_delivered_count` on the rule, returned by the webhook rule API as `lastRunStatus`, `lastRunError` and `lastRunDeliveredCount`. `last_run_error` names the delivery a run stopped at: the failed one, or, with a `success` status, the one another run is still sending.

## Payload and signing

```json
{ "event": "trace.matched", "traceId": "…", "projectId": "…", "timestamp": "…", "name": "…", "traceVersion": "…" }
```

`timestamp` is the trace's own timestamp and `traceVersion` its feed version. The body is signed with HMAC-SHA256 over the exact raw JSON string sent, in `X-Ironside-Signature: sha256=<hex>` — the Stripe and GitHub pattern, so receivers can verify it with a standard recipe. The signing secret is generated server-side and stored AES-256-GCM encrypted (`signing_secret_encrypted`).

## SSRF guard

`destinationUrl` is customer-supplied, so each run first resolves it and rejects loopback, link-local, private and reserved addresses (`apps/worker/src/lib/ssrf-guard.ts`, `assertPublicHttpDestination`), checking the resolved addresses rather than the hostname string. IPv4-mapped IPv6 addresses are checked by extracting the embedded IPv4 address, including the hex-group form Node's `URL` parser produces (`::ffff:172.20.1.1` becomes `::ffff:ac14:101`). A rejected destination fails the run and is recorded on the rule. Requests do not follow redirects: a 3xx response is a failed delivery, because its target was never checked. The check runs once per run and each request resolves the hostname again, so DNS rebinding between the two is not caught. Tests opt out with `allowPrivateDestinations: true` to reach a local server; production code never sets it.

## Upgrading from 0.3.0

Before migration `0006`, a run scanned every matching settled trace on every run and keyed each delivery by the trace's latest activity time (the "scanner" key). Each rule has a `scanner_handoff_at`: the migration time for a rule that existed before it, otherwise the rule's creation time, whichever release's API created it.

- For a feed entry published at or before the handoff, a run first looks up the scanner key. A delivered one means the trace was already sent, and the run skips it; a pending one younger than 10 minutes means a previous-release worker is sending it, and the run stops before it. Upgrading therefore does not resend earlier webhooks.
- For 24 hours after the handoff, while a worker from the previous release may still run beside this one during a rolling upgrade (`docs/schema-migrations.md`), a run checks the scanner key for every entry, and after delivering a trace it marks the scanner key `covered`. The older worker's claim cannot take a covered key, so it does not send the trace again.
- After that window, a trace published again with an unchanged activity time (a late batch) gets a new webhook, even if the scanner delivered that activity time.

A previous-release worker that claims a trace between a new run's check and its delivery can still send it twice. The window for that is one request, and only during a rolling upgrade.

Receivers see `traceVersion` change meaning from the activity time to the feed version. Both are timestamps; a receiver that stores the latest `traceVersion` per trace and compares them keeps working, because feed versions only increase.

## Verified

`apps/worker/test/webhook-runner.test.ts` publishes traces to the feed and runs `runWebhooks` against real Postgres, ClickHouse and a local HTTP server. It covers the signed payload and the recorded run, no resend from a later run and no position change from a stale one, a new webhook for each republication (including a late batch), a failed delivery stopping the run and being retried first in feed order, stopping at an in-flight delivery, the handoff from a previous-release worker (before the handoff, inside and after the 24-hour window, and covering the old key), a filter matching nothing, a bookkeeping failure after a confirmed delivery, and the SSRF guard. `packages/db/test/webhooks.test.ts` covers the claim itself (including 10 parallel claims producing one winner), scanner-key lookups and covering, and the guarded position update. `packages/db/test/migrate-upgrade.test.ts` checks that existing rules are handed off at the migration.

## History

- M6-03 added webhooks, scanning matching traces with `exportTraces` on every run. Issue #44 made delivery exactly once per settled version, keyed by activity time.
- Migration `0006` moved webhooks onto the trace feed: runs read only new publications instead of every matching trace, deliveries are keyed by feed version with a handoff from the old activity-time key, a failed delivery stops the run instead of being retried out of order, and each run's outcome is recorded on the rule. `exportTraces` was removed.
- Still open: webhooks fire on the scheduler's poll cadence, not the instant a trace settles (the same trade-off as `spec/otlp-forwarding-v1.md`). The SSRF guard does not pin the checked address for the request, so DNS rebinding is not caught.
