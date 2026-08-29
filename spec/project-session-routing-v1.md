# Owner-session project routing v1

Status: implemented for issue #64; machine credential details updated by #65.

Ironside has two deliberately separate principals. A human owner uses the
HttpOnly `ironside_session` cookie for the browser/control plane. A machine
uses a scoped `ironside_sc_*` credential for stable data-plane contracts. There is
no route that accepts either principal interchangeably.

## Routing and authorization

Session APIs name the project explicitly:

- `GET|POST /api/v1/projects` lists or creates projects in the session's organization.
- `/api/v1/projects/:projectId/traces[...]` is the native browser query surface.
- `/api/v1/projects/:projectId/{credentials,environments,exports,otlp-forwards,webhooks,import-sources}` is management/discovery.
- `/api/v1/projects/:projectId/{ingest-failures,media/:mediaId}` and raw-event inspection are sensitive owner reads.

Every nested request passes through `ownerProjectAuth`: it resolves the URL
project against `ownerSession.organizationId`, then sets the existing internal
`projectId` context. A foreign and nonexistent project both return the exact
same `404 {"error":"project not found"}`. Nested resources continue to query
by both resource id and that authorized project id.

Machine credentials remain key-implicit and cannot choose a project:

- `POST /api/v1/ingest`
- `POST /api/v1/media`
- `POST /v1/otel/traces`
- `/api/public/*` LangFuse-compatible reads, ingestion, and score writes

The former flat native query and management routes are removed. Supplying a
Bearer key to a nested session route returns 401 before project lookup. Owner
mutations additionally require an exact configured browser `Origin` and reject
cross-site Fetch Metadata.

## Browser model

Canonical routes are `/projects/:projectId/traces`,
`/projects/:projectId/traces/:traceId`, `/projects/:projectId/connections`, and
`/projects/:projectId/settings`. The project switcher changes the URL, and all
requests derive their explicit project from that validated context. Trace
`userId`, `sessionId`, repeated `tags`, and the global exact `environment`
filter live in the URL; pagination
cursors remain ephemeral.

`ironside.lastProjectId` is only a non-secret navigation hint and is validated
against the session's project list before use.

`POST /api/v1/projects` creates the project and its initial data-plane
Ingest credential in one Postgres transaction. The plaintext is returned exactly once;
only its hash is persisted. Optional expiry and least-privilege preset details
are in `spec/scoped-machine-credentials-v1.md`.

## Cookie-jar management example

For automation during this owner-only management phase, use a cookie jar and
the exact origin configured in `WEB_ORIGINS`:

```sh
ORIGIN=http://localhost:8080
curl -sS -c ironside-owner.cookies \
  -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -d '{"username":"owner","password":"..."}' \
  "$ORIGIN/api/auth/login"

curl -sS -b ironside-owner.cookies "$ORIGIN/api/v1/projects"

curl -sS -b ironside-owner.cookies \
  -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -d '{"name":"nightly","format":"jsonl","filter":{},"destinationBucket":"...","destinationEndpoint":"https://...","destinationAccessKeyId":"...","destinationSecretAccessKey":"..."}' \
  "$ORIGIN/api/v1/projects/proj_.../exports"
```

Treat the cookie jar like a password, keep it outside the repository, and
delete it after the operation. The browser UI is the preferred human workflow.

The frozen baseline contains the scoped credential table
directly; see `spec/scoped-machine-credentials-v1.md`.
