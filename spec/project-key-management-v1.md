# Project and credential management v1

Status: the API-key design is superseded by owner sessions and scoped machine credentials; the boundary below is implemented. Owner: `apps/api/src/routes/projects.ts`, `apps/api/src/routes/credentials.ts`, `apps/api/src/lib/project-bootstrap.ts`, `apps/api/src/lib/machine-credentials.ts`.

## Purpose

Record where project and credential management lives now that project API keys are gone. Projects and machine credentials are managed by the deployment owner through the owner session; machines authenticate with project-scoped credentials. The normative contracts are:

- `spec/owner-auth-v1.md`: the owner, setup, login, recovery and sessions;
- `spec/project-session-routing-v1.md`: project-explicit owner routes and the browser model;
- `spec/scoped-machine-credentials-v1.md`: credential capabilities, presets, lifecycle and the Connections page.

## Boundary

- The single deployment owner is created with a host-issued setup capability. `GET /api/v1/projects` and `POST /api/v1/projects` list and create projects only in that owner's organization.
- Creating a project also creates its initial Ingest credential in the same Postgres transaction (`createProjectWithBootstrapCredential`), so a project never exists without its first credential. The plaintext is returned once, with `Cache-Control: no-store`.
- Credentials are managed per project, by the owner only: `GET /api/v1/projects/:projectId/credentials`, `POST /api/v1/projects/:projectId/credentials` and `DELETE /api/v1/projects/:projectId/credentials/:credentialId`. A foreign or unknown project is `404`.
- Machine credentials cannot call these routes. Each is bound to one project and authorizes only the data-plane capabilities in `spec/scoped-machine-credentials-v1.md`.
- Revocation writes a short-lived Redis sentinel before the soft revoke commits in Postgres. Credential resolution caches with `SET NX`, so a concurrent successful lookup cannot overwrite the sentinel and restore the credential. If the sentinel cannot be written, the revoke rolls back.
- Creation and revocation actors stay on the credential row and in `auth_audit_events`.
- There is no project deletion API. Deleting a project would cascade control-plane records and needs its own contract for traces, raw events, media and retention.

## Verified

`apps/api/test/projects.test.ts` covers listing and creating projects in the owner's organization, the same `404` for foreign and unknown projects, and machine credentials being refused. `apps/api/test/project-bootstrap.test.ts` checks that a failed initial-credential insert rolls back the project. `apps/api/test/credentials.test.ts` covers owner-only access, hash-only listing, one-time disclosure, immediate revocation of a cached credential, and cross-project revocation being refused; `apps/api/test/credential-revocation-order.test.ts` checks that the sentinel is written before the Postgres commit and that a failed sentinel write rolls the revoke back.

## History

- M7-02 added project and API key management routes under `/api/v1/projects` and `/api/v1/keys`, authenticated with a project API key and limited to that key's organization. The web app sent a key from the browser.
- #63 added the owner principal and browser sessions, #64 moved management and browser reads to owner-session, project-explicit routes, and #65 replaced project keys with scoped `ironside_sc_` machine credentials. The 0.3.0 baseline has no `api_keys` table or `ironside_sk_` token class (`docs/schema-migrations.md`).
- Still open: project deletion.
