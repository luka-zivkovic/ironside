# Scheduled Destinations CRUD v1 (M6-06)

Status: implemented, verified live end-to-end. Owner: `apps/api/src/routes/{exports,forwards,webhooks}.ts`, `packages/db/src/{export-configs,otlp-forward-rules,webhooks}.ts` (update/delete/list), `packages/shared/src/management.ts` (wire schemas).

## Purpose

M6-05 wired a scheduler to run `export_configs`/`otlp_forward_rules`/`webhook_rules` automatically, but nothing outside direct database access could create one. This batch closes that: `GET`/`POST`/`PATCH`/`DELETE /api/v1/exports`, `/api/v1/otlp-forwards`, `/api/v1/webhooks` — day-2 management, same house style and project-scoping contract as the existing `/api/v1/projects`/`/api/v1/keys` routes.

## Design

- **Mounted in the unrated-limited `v1` group** (`apps/api/src/app.ts`), alongside `projects`/`keys` — low-volume management traffic, not ingest.
- **Project-scoped, not-found-either-way.** `updateExportConfig`/`deleteExportConfig` etc. (new `packages/db/src/*.ts` functions) filter by `id AND project_id` in one query — a caller from a different project gets the identical 404 whether the id doesn't exist at all or belongs to someone else, so there's no way to enumerate other projects' destination ids by observing a different error.
- **Secrets are write-only.** `POST /exports` takes `destinationSecretAccessKey` (plaintext) and `POST /otlp-forwards` takes `destinationAuthHeader` (plaintext, optional); both are encrypted via `encryptSecret` (moved to `@ironside/shared` in M6-05) before the create call ever reaches Postgres, and neither field exists anywhere in any response shape — not "omitted this time," genuinely absent from `ExportConfigResponse`/`OtlpForwardRuleResponse`. `POST /webhooks` doesn't even accept a secret from the caller: the HMAC signing secret is generated server-side (`randomBytes(32)`, same pattern as an API key token) since there's no reason a caller should ever choose or see the value a `runWebhooks` request-signature check verifies against.
- **`pollIntervalSeconds` is an optional override**, applied as an immediate follow-up `UPDATE` after `INSERT` rather than widening each `createX` function's own insert statement for one field only the API layer ever sets at create time — the DB migration's per-subsystem defaults (exports 1h, forwards 5m, webhooks 1m) already cover the common case.
- **`exactOptionalPropertyTypes` friction, same class already established in `projects.ts`'s quota route.** Zod's `.optional()` infers `T | undefined`, but the domain types (and `tsconfig.base.json`'s `exactOptionalPropertyTypes: true`) require the key to be genuinely absent, not present-with-`undefined`. A new shared helper, `apps/api/src/lib/exact-optional.ts` (`toFilter`/`toEnabledPollIntervalUpdate`), rebuilds the Zod-parsed request body into a properly-optional object once, reused across all three route files instead of duplicating the same conditional-spread three times.

## Verification

- `apps/api/test/scheduled-destinations.test.ts`: 10 integration tests against the real local stack — full create/list/patch/delete round-trip for each of the three subsystems, secret non-leakage (asserted both by key-absence and by `JSON.stringify` not containing the plaintext secret anywhere in the response), cross-project isolation (404, not 403 — no information leak about whether the id exists), invalid-input 400s, the `pollIntervalSeconds` override.
- **Live end-to-end, not just tests**: started the real API and worker processes against the live local stack, created a webhook rule via `POST /api/v1/webhooks` with a loopback `destinationUrl`, and confirmed the running M6-05 scheduler picked it up on its own next tick, decrypted the server-generated signing secret, and correctly rejected the destination via the SSRF guard (`[scheduler:webhook] Error: destination URL resolves to a non-public address: 127.0.0.1`) — proving the full create-via-API → scheduler-picks-it-up → guard-enforced chain works together in a real running deployment, not only in isolated unit/integration tests.
- Full suite: 318/318 passing (10 new), build + typecheck clean, run 3× to confirm no flakiness introduced.

## Not yet done (follow-up, not blocking this batch's DoD)

- **No route to rotate a webhook's signing secret** or an OTLP forward's auth header after creation — currently requires delete + recreate. A dedicated rotate endpoint is a natural follow-up once this is used in anger.
- **No route to update `destinationUrl`/`filter`/other non-scheduling fields** — `PATCH` only covers `enabled`/`pollIntervalSeconds`, the two fields actually needed for day-2 on/off + cadence management. Broader field updates are deferred rather than building a general partial-update endpoint speculatively.
- **No `apps/web` UI** for any of these three — API-only for now, matching M6's overall scope (the differentiator is the export/forward/webhook capability itself, not yet a settings screen for it).
