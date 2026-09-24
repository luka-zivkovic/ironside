# Owner authentication foundation v1

Status: implemented. Owner: `packages/db/src/owner-auth.ts`, `apps/api/src/routes/owner-auth.ts`, `apps/api/src/middleware/owner-session.ts`, `apps/api/src/lib/passwords.ts`, `apps/api/src/lib/owner-secrets.ts`, `apps/api/src/scripts/owner-setup.ts`, `apps/api/src/scripts/owner-recovery.ts`.

## Boundary

Human control-plane identity and machine data-plane credentials are separate. `ironside_sc_*` credentials authenticate stable data-plane routes but cannot create or resume an owner session (`spec/scoped-machine-credentials-v1.md`). Owner sessions authenticate the browser and the project-explicit control plane described in `spec/project-session-routing-v1.md`.

The SPA has `/setup`, `/login`, and `/recover` routes. It never stores a machine credential.

## Persistence and secrets

The Postgres baseline includes:

- `owner_principals`: exactly one deployment owner, linked to the implicit organization;
- `owner_auth_challenges`: hashed, expiring, single-use setup/recovery capabilities;
- `owner_sessions`: hashed opaque session tokens with idle and absolute expiry plus revocation;
- `auth_audit_events`: setup, recovery, login, and logout security events.

Passwords use Node's scrypt with a random 16-byte salt (`N=32768`, `r=8`, `p=1`, 32-byte output). Random capabilities and sessions carry 256 bits of entropy; only SHA-256 hashes are stored. Active challenge hashes are compared with `timingSafeEqual`, then the selected row is revalidated and claimed inside a transaction.

## Setup and recovery invariants

`owner-setup` and `owner-recovery` are host-local commands that print one short-lived capability. Issuing a newer capability invalidates an older unconsumed capability of the same purpose.

Setup and recovery claims share a Postgres advisory transaction lock. Concurrent setup submissions therefore cannot create two owners. Fresh setup creates the organization and owner atomically. Recovery updates the existing owner only, consumes outstanding recovery capabilities, and revokes every owner session.

The optional local `seed` command requires completed owner setup and creates or reuses a project inside that owner's organization.

## Browser security

The session cookie is host-only, HttpOnly, SameSite=Lax, Path=/, and Secure by default. `AUTH_INSECURE_COOKIES=true` is the sole plain-HTTP opt-out; the checked-in localhost Compose stack sets it explicitly. Sessions have a 12-hour sliding idle expiry and 7-day absolute expiry by default.

CORS sends credentials only for exact `WEB_ORIGINS`. Every state-changing owner-auth request also requires an allowed `Origin` and rejects `Sec-Fetch-Site: cross-site`. Setup, login, and recovery use shared Redis fixed-window counters by client address. Login deliberately has no username-wide hard-blocking bucket, because that would let a remote caller lock the deployment's sole owner out globally. Forwarded IP headers are ignored unless `AUTH_TRUST_PROXY=true`; the bundled nginx proxy overwrites forwarded-address headers rather than passing client-supplied values through.

## Verified

`apps/api/test/owner-auth.test.ts` covers fresh setup, concurrent double-submit, password hashing, cookie attributes, machine-key rejection, session refresh/logout, secure-cookie mode, auth rate limiting, recovery password replacement, session revocation, and absence of plaintext capabilities in Postgres.

## History

- Issue #63 added owner authentication. #64 followed with project-scoped session routing (`spec/project-session-routing-v1.md`), and #65 replaced the transitional project keys with scoped machine credentials (`spec/scoped-machine-credentials-v1.md`).
