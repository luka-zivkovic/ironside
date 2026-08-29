# Coolify installation and maintenance

## Status and support boundary

- **TARGET:** an Ironside release is one exact semantic version shared by the
  API, worker, and web images and deployed as one Coolify Service.
- **CURRENT:** `deploy/coolify.yaml` defines that seven-container Service. It
  becomes installable after the next release publishes public GHCR images; the
  existing `v0.1.0` predates the verified multi-architecture/public-image
  contract.
- **CURRENT:** the first persistent external deployment on 2026-08-28 froze
  the Postgres and ClickHouse baselines. Future schema changes are append-only
  forward migrations.
- **ASSUMPTION:** the default stack is single-server, the nginx web component
  is the only public ingress, and Coolify terminates TLS.

## Install

`deploy/coolify.yaml` can be pasted into **Docker Compose Empty** and is the
source for a future public Coolify catalog template.

1. Create a Docker Compose Empty Service in the target project/environment.
2. Paste `deploy/coolify.yaml` and save it.
3. Set `IRONSIDE_VERSION` to an exact published release such as `0.2.0`.
   Never use `latest`, `main`, or another floating value.
4. Confirm Coolify generated the web URL and the Postgres, ClickHouse, Redis,
   MinIO, metrics, and encryption secrets. These values are instance identity;
   do not regenerate them during an update.
5. Deploy. Only `web` receives a public domain. Its `/health` request traverses
   nginx to the API, whose report checks Postgres, ClickHouse, Redis, and
   object storage. The worker separately health-checks its metrics listener.
6. Open a terminal for the `api` component and generate the initial 15-minute
   owner setup code:

   ```sh
   node apps/api/dist/src/scripts/owner-setup.js
   ```

7. Open the generated URL at `/setup`, consume the code, and create the first
   project and scoped machine credential.

Coolify copies a one-click template into each created Service. Catalog changes
do not rewrite existing instances, so the saved Compose and environment values
remain that instance's update contract.

Official Coolify catalog publication is a later distribution step. Coolify's
current contribution policy requires at least 1,000 GitHub stars for the
upstream repository. That does not prevent operating and testing the same file
as a user-defined Service.

## Release contract

Bump the root `package.json` version, merge it, and push the matching
`vX.Y.Z` tag. A mismatch fails before publishing. The workflow first runs the
complete build, typecheck, and test suite against Postgres, ClickHouse, Redis,
and MinIO. It then publishes amd64 and arm64 API/worker/web images with exact
`X.Y.Z` and `sha-<full commit>` tags, OCI metadata, provenance, and an SBOM.

After the first run, an owner must make all three GHCR packages public. Verify
anonymous pulls of every exact tag before announcing the release. Every release
note must list:

- required Compose and environment changes;
- supported source versions and whether mixed-version replicas are safe;
- Postgres and ClickHouse migrations and expected duration;
- object-storage or queue compatibility changes;
- backup and restore prerequisites; and
- whether image-only rollback is safe or data restore/forward-fix is required.

Infrastructure images are pinned independently in the template. Upgrade them
only through a documented compatibility drill. In particular, changing a
Postgres major version is a dump/restore or `pg_upgrade` project, not an image
tag edit.

## Update an instance

1. Read every release note between the installed and target versions.
2. Save the current Source Compose and record domains, generated secrets,
   scheduled tasks, persistent storage, and all seven exact image versions.
3. Clone the Coolify Service for a trial. A clone copies configuration, not
   volumes or data; restore representative backups separately.
4. Verify fresh Postgres, ClickHouse, and object-storage backups off-host.
   Preserve `IRONSIDE_ENCRYPTION_SECRET` in a secret manager.
5. Change the single `IRONSIDE_VERSION` value in the trial so API, worker, and
   web move together. Merge any release-specific Compose changes.
6. Deploy and verify component health, migration logs, owner sign-in, native
   ingest, OTLP ingest, trace reads, queue processing/recovery, and scheduled
   worker activity.
7. During a production maintenance window, take new backups, apply the tested
   version/configuration change, deploy, and repeat the checks.
8. Keep the backups and previous Compose/version for the stated recovery
   window.

Do not use **Pull Latest Images & Restart** for Ironside. Exact semantic-version
tags are immutable, so a normal redeploy is enough. Pulling a mutable tag can
silently combine a new app, a schema migration, and changed dependencies.

Downgrade is supported only when the release note says no data migration ran.
Once a forward migration is applied, use a tested forward fix or restore every
affected store before starting old images. Never delete volumes to update.

## Backup coverage

The template exposes standard database environment names, allowing Coolify to
schedule engine-aware backups for the Postgres and ClickHouse components.
Store copies off-host and test restores into a disposable Service.

Coolify's database backup does not protect the MinIO or Redis volumes:

- MinIO contains the raw event log and durable pending-ingest intents. Prefer
  external S3 with bucket versioning/replication, or schedule and test a MinIO
  mirror to independent storage.
- Redis is recoverable queue/cache state; the worker reconstructs accepted
  pending ingest from object storage. Its volume improves ordinary restart
  continuity but is not the source-of-truth backup.

Persistent volumes survive container recreation but are not backups. Do not
rename or remove the four `ironside_*_data` mounts during an update.

`IRONSIDE_ENCRYPTION_SECRET` decrypts destination/source credentials stored in
Postgres. A database restore without the same secret leaves those credentials
unreadable. Keep the secret in a separate recovery record, not only in Coolify.

## Local validation

Before publishing:

```sh
docker build -f apps/api/Dockerfile -t ironside-api:smoke .
docker build -f apps/worker/Dockerfile -t ironside-worker:smoke .
docker build -f apps/web/Dockerfile -t ironside-web:smoke .
IRONSIDE_VERSION=0.2.0 docker compose -f deploy/coolify.yaml config >/dev/null
```

Use the real candidate version. Compose rendering does not prove anonymous GHCR
access or recovery safety; verify both as separate release gates.
