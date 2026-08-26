# Project and credential management v1

Status: the original M7-02 key-authenticated design was superseded by issues
#63–#65. This file records the current boundary; Git history contains the old
route design.

The single deployment owner is created through the host-issued setup
capability. Owner-session routes list and create projects only inside that
owner's organization. Creating a project also creates its initial Ingest
credential in the same Postgres transaction and returns that plaintext once.

Credential management is project-explicit and owner-only:

- `GET /api/v1/projects/:projectId/credentials`
- `POST /api/v1/projects/:projectId/credentials`
- `DELETE /api/v1/projects/:projectId/credentials/:credentialId`

Machine credentials cannot call these routes. They are scoped to one project
and authorize only the key-implicit data-plane capabilities described in
`spec/scoped-machine-credentials-v1.md`.

Revocation writes a short-lived Redis sentinel before committing the soft
revoke in Postgres. Resolvers use `SET NX`, so a concurrent successful lookup
cannot overwrite that sentinel and restore the credential. Creation and
revocation actor details remain inspectable in the credential row and audit
log.

There is no project deletion API yet. That is intentionally separate because
deletion would cascade control-plane records and requires an explicit trace,
raw-event, media, and retention contract.
