# Scheduled Destinations CRUD v1

Status: implemented. Owner: `apps/api/src/routes/{exports,forwards,webhooks}.ts`, `apps/api/src/lib/exact-optional.ts`, `packages/db/src/{export-configs,otlp-forward-rules,webhooks}.ts`, `packages/shared/src/management.ts` (wire schemas).

## Purpose

Create, list, update and delete the three destinations the worker scheduler runs, scheduled exports (`spec/scheduled-export-v1.md`), OTLP forward rules (`spec/otlp-forwarding-v1.md`) and webhook rules (`spec/webhooks-v1.md`), through the API instead of direct database writes.

## Routes

| Resource | Collection | Item | List key | Id prefix |
|---|---|---|---|---|
| Export configs | `/api/v1/projects/:projectId/exports` | `/api/v1/projects/:projectId/exports/:id` | `exports` | `export_` |
| OTLP forward rules | `/api/v1/projects/:projectId/otlp-forwards` | `/api/v1/projects/:projectId/otlp-forwards/:id` | `forwards` | `fwd_` |
| Webhook rules | `/api/v1/projects/:projectId/webhooks` | `/api/v1/projects/:projectId/webhooks/:id` | `webhooks` | `webhook_` |

- `GET` on the collection returns `200` with `{ "<list key>": [...] }`, oldest first. `POST` returns `201` with the created resource.
- `PATCH` on an item returns `200` with the updated resource. `DELETE` returns `204`.
- An invalid or unparseable body returns `400` `{ "error": "invalid request", "issues": [...] }`. An unknown id returns `404`.

## Access and project scoping

The routes are mounted in the owner-session project router (`apps/api/src/app.ts`). `ownerSessionAuth` requires an owner session (`401` without one); `trustedBrowserMutation` rejects a `POST`, `PATCH` or `DELETE` with `403` unless its `Origin` is an allowed web origin and `Sec-Fetch-Site` is not `cross-site`; `ownerProjectAuth` returns `404 project not found` unless the project belongs to the session's organization. Machine credentials cannot reach these routes, and they are not rate limited. See `spec/owner-auth-v1.md` and `spec/project-session-routing-v1.md`.

Update and delete filter by `id` and `project_id` in one query, so an id that does not exist and an id that belongs to another project return the same `404`, and one project cannot discover another's destination ids by comparing errors. Deleting a project deletes its destinations (`on delete cascade`), and deleting a webhook rule deletes its delivery records.

## Create requests

Every create request takes `name` (1–200 characters), an optional `filter` and an optional `pollIntervalSeconds`.

- `filter` is a `TraceFilter`: `from` and `to` (ISO 8601 datetimes with offset), `userId`, `sessionId`, `tags`, `metadataKey` and `metadataValue`, all optional; the default is `{}`. Environment is not a destination filter (`spec/environments-v1.md`).
- `pollIntervalSeconds` is an integer from 1 to 2,592,000 (30 days); the cap keeps a typo from leaving a destination unscheduled for a near-eternity. When omitted, the table default applies: exports 3,600, forwards 300, webhooks 60. It is applied by an `UPDATE` right after the `INSERT`, which keeps the create functions' insert statements unchanged for a field only the API sets.
- Exports also take `format` (`parquet` or `jsonl`, default `jsonl`), `destinationBucket`, `destinationPrefix` (default `""`), `destinationEndpoint`, `destinationRegion` (default `us-east-1`), `destinationAccessKeyId` and `destinationSecretAccessKey`.
- OTLP forwards take `destinationUrl` (a URL) and an optional `destinationAuthHeader`.
- Webhooks take `destinationUrl` (a URL).

A new destination is enabled, due on the next scheduler tick (`next_run_at` defaults to `now()`), and starts at the beginning of the trace feed. The API validates a destination URL only as a URL; the worker applies the SSRF guard before each run (`apps/worker/src/lib/ssrf-guard.ts`).

## Secrets are write-only

- `destinationSecretAccessKey` and `destinationAuthHeader` are encrypted with `encryptSecret` (AES-256-GCM with a key derived from `IRONSIDE_ENCRYPTION_SECRET`, `packages/shared/src/encryption.ts`) before the row is inserted. No response schema has a field for either; a forward rule reports only `hasDestinationAuthHeader`.
- A webhook's HMAC signing secret is never accepted from or returned to the caller. The API generates it (32 random bytes, hex-encoded) and stores it encrypted; a receiver only verifies signatures.
- Without `IRONSIDE_ENCRYPTION_SECRET`, creating an export or a webhook, or a forward with an auth header, fails with `500`. The worker needs the same secret to decrypt (`spec/scheduler-v1.md`).

## Updates

`PATCH` takes only `enabled` (boolean) and `pollIntervalSeconds` (same bounds as on create). Both are optional; an explicit `null` is rejected with `400` rather than silently ignored. Neither changes `next_run_at`: a new interval applies from the next claim, and a re-enabled destination whose `next_run_at` has passed runs on the next scheduler tick.

The destination, filter, format and secrets cannot be changed. Replacing any of them means deleting and recreating the destination, which starts it again at the beginning of the trace feed, so its first run sends every existing matching trace again.

`toFilter` and `toEnabledPollIntervalUpdate` (`apps/api/src/lib/exact-optional.ts`) rebuild Zod-parsed bodies so an unset field is absent rather than present as `undefined`, as `exactOptionalPropertyTypes` requires; all three route files share them.

## Responses

- Export config: `id`, `projectId`, `name`, `format`, `filter`, `destinationBucket`, `destinationPrefix`, `destinationEndpoint`, `destinationRegion`, `destinationAccessKeyId`, `enabled`, `pollIntervalSeconds`, `nextRunAt`, `lastRunAt`, `lastRunStatus`, `lastRunError`, `lastRunRowCount`.
- OTLP forward rule: `id`, `projectId`, `name`, `destinationUrl`, `hasDestinationAuthHeader`, `filter`, `enabled`, `pollIntervalSeconds`, `nextRunAt`, `lastRunAt`, `lastRunStatus`, `lastRunError`, `lastRunForwardedCount`.
- Webhook rule: `id`, `projectId`, `name`, `destinationUrl`, `filter`, `enabled`, `pollIntervalSeconds`, `nextRunAt`, `lastRunAt`, `lastRunStatus`, `lastRunError`, `lastRunDeliveredCount`.

Timestamps are ISO 8601 strings. `lastRunStatus` is `success`, `error` or `null`; the `lastRun*` fields are `null` until a run is recorded. Each feature's spec defines what its run fields report.

## Verified

`apps/api/test/scheduled-destinations.test.ts` runs the API against real Postgres with an owner session. It covers a create, list, patch and delete round trip for each resource; the export secret and forward auth header absent from responses, checked both by key and by searching the serialized body; the stored auth header decrypting to the submitted value; `hasDestinationAuthHeader: false` for a rule without one; no signing secret in webhook responses; `401` without an owner session; `400` for an invalid create, a non-URL `destinationUrl` and `enabled: null`; `404` for an unknown webhook id; another project's destination missing from the list and returning `404` on patch and delete; and the `pollIntervalSeconds` override.

## History

- M6-06 added these routes: the scheduler (M6-05) could already run destinations, but only direct database writes could create them. They were first mounted at `/api/v1/exports`, `/api/v1/otlp-forwards` and `/api/v1/webhooks` alongside the project and key routes; they now live under `/api/v1/projects/:projectId/` behind owner sessions.
- Still open: a webhook signing secret or forward auth header cannot be rotated, and a destination's URL, filter or format cannot be changed, without deleting and recreating it. There is no web UI for these routes.
