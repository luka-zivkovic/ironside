# Scoped machine credentials v1

Status: implemented for #65. Owners use session-authenticated, project-explicit management routes; machines use project-bound credentials on stable key-implicit data-plane routes.

## Authorization model

Authorization checks immutable primitive capabilities stored on each credential. `ingest` and `integration` are creation-time presets only; route middleware never authorizes a preset name.

| Machine route | Method | Required capability |
|---|---:|---|
| `/api/v1/ingest` | POST | `ingest` |
| `/v1/otel/traces` | POST | `ingest` |
| `/api/public/ingestion` | POST | `ingest` |
| `/api/v1/media` | POST | `media:write` |
| `/api/public/traces` | GET | `traces:read` |
| `/api/public/traces/:id` | GET | `traces:read` |
| `/api/public/scores` | POST | `scores:write` |
| `/api/v1/evaluator/context` | GET | `traces:read` |
| `/api/v1/evaluator/traces` | GET | `traces:read` |
| `/api/v1/evaluator/traces/:id` | GET | `traces:read` |
| `/api/v1/evaluator/scores` | POST | `scores:write` |

The initial presets expand to these frozen snapshots:

- **Ingest**: `ingest`, `media:write`
- **Integration**: `traces:read`, `scores:write`

Native and LangFuse ingestion envelopes can contain inline score events. An Ingest credential may submit those events as part of an ingest batch because rejecting individual event kinds would break the SDK and LangFuse batching contracts. It cannot call the standalone `/api/public/scores` route. Integrations that only read traces and write evaluator results use the Integration preset.

Every owner, tenancy, quota, destination, import-source, failure-diagnostic, raw-event, native trace-view, credential-management, and media-read route remains physically outside machine authorization. Machine tokens never establish an owner session and cannot select a project in the URL; the resolved token selects exactly one project.

## Credential lifecycle

Owners manage credentials at:

- `GET /api/v1/projects/:projectId/credentials`
- `POST /api/v1/projects/:projectId/credentials`
- `DELETE /api/v1/projects/:projectId/credentials/:credentialId`

Creation accepts only `name`, `preset`, and optional future `expiresAt`. The server expands the preset, stores only a SHA-256 token hash, and returns the `ironside_sc_...` plaintext once with `Cache-Control: no-store`. Lists contain a short token prefix, capability snapshot, optional expiry, last-use time, creation actor, and revocation actor, but never plaintext.

Revocation is a soft revoke so its actor and timestamp remain inspectable. Creation and revocation also append `auth_audit_events` in the same Postgres transaction.

Expiry is enforced both in Postgres resolution and on Redis cache hits. A cache entry never lives longer than the credential's remaining lifetime. Revocation writes a sentinel before the Postgres transaction commits so a concurrently cached resolution cannot restore access.

## Token class and storage

All machine credentials use the `ironside_sc_` token class and live in
`machine_credentials`. Ironside is pre-production and has no prior credential
class or data-plane key table in its baseline.

## Connections UX

The project-scoped Connections page displays the deployment host and active project, creates Ingest or Integration credentials, optionally sets expiry, reveals plaintext once, lists active/expired/revoked credentials with actor metadata, and supplies copyable examples for:

- the `ironside` SDK package
- OTLP/HTTP trace export (including the percent-encoded Bearer header)
- LangFuse SDK Basic-auth compatibility
- evaluator trace reads and score writes

Examples use `IRONSIDE_API_KEY` rather than embedding the disclosed token. Runtime data-plane URLs contain no project id because the credential itself binds the request to a project. Switching projects remounts the page so one project's one-time secret and credential state cannot appear under another project.

Media upload shares the same Redis per-project write budget as native, OTLP, LangFuse ingestion, and standalone score writes.

## Verification

`apps/api/test/machine-capabilities.test.ts` exercises positive and negative authorization for every machine route and both presets. Credential tests cover one-time disclosure, hash-only storage, frozen capabilities, actor/audit persistence, strict request fields, non-enumerating project isolation, cache-primed immediate revocation, and owner-only management. Low-level cache tests cover expiry after a cached resolution. Rate-limit tests prove media and ingest share one project budget. Web tests pin generated hosts, paths, header encoding, environment-variable guidance, and the absence of embedded tokens/project ids.
