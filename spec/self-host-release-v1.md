# Self-host release v1

Status: implemented. Owner: `apps/api/Dockerfile`, `apps/worker/Dockerfile`, `apps/web/Dockerfile`, `apps/web/nginx.conf`, `docker-compose.yml`, `deploy/self-host/`, `deploy/coolify.yaml`, `.github/workflows/release.yml`.

## Purpose

Run the whole of Ironside with Docker Compose, without a Node toolchain on the host: from source for local use, or from published, versioned images on a server. This spec covers the images, the Compose definitions, what happens at boot, and how a release is built, verified and published. Operator instructions are in `docs/self-hosting.md`.

## Deployment definitions

| File | Use | Application images |
|---|---|---|
| `docker-compose.yml` | Local stack with fixed development credentials | Built from source |
| `deploy/self-host/compose.yaml` | Generic single-host server install | Published, exact version |
| `deploy/coolify.yaml` | Coolify service template (runbook: `docs/coolify.md`) | Published, exact version |

Each runs four infrastructure services (Postgres, ClickHouse, Redis, MinIO) and three application services (`api`, `worker`, `web`). The application services are stateless; all state is in the infrastructure services. Services reach each other on the Compose network by service name and container port (`postgres:5432`, `clickhouse:8123`, `redis:6379`, `minio:9000`, `api:8788`).

## Images

- `api` and `worker` (`node:24-slim`, pnpm 10.33.0 through corepack) build in two stages. The build stage copies the workspace manifests, root `tsconfig.json`/`tsconfig.base.json`, `packages/` and `apps/`, then runs `pnpm install --frozen-lockfile` and `pnpm build` (`pnpm -r --sort build`, dependency order). The runtime stage copies the same workspace files so pnpm can resolve workspace packages, runs `pnpm install --frozen-lockfile --prod` (no devDependencies, no `tsc`), and copies in the built `dist/` of `shared`, `db`, `clickhouse`, `queue`, `storage`, `mappers`, `pricing` and the app. `--frozen-lockfile` makes a build fail rather than resolve versions other than the committed lockfile. The worker's install runs inside the image so the DuckDB native binding matches the image platform.
- `web` builds only `@ironside/shared` and `@ironside/web` and serves the static bundle from `nginx:1.27-alpine`.
- `.dockerignore` keeps `node_modules/`, build output, `.env`/`.env.local` and `.git/` out of the build context.
- Image health checks: `api` fetches `http://127.0.0.1:8788/health`; `worker` fetches its metrics listener on `METRICS_PORT` (default 9464), sending `Bearer $METRICS_TOKEN` when set; `web` fetches `/health`, which nginx proxies to the API, so `web` is healthy only while the API answers.

## Web proxy

`apps/web/nginx.conf` proxies `/api/`, `/health` and `/v1/` (OTLP) to `http://api:8788` and serves `index.html` for every other path so client-side routes work on direct navigation. The SPA has no routes under `/v1`, so the OTLP location cannot shadow one. The proxy overwrites `X-Forwarded-For` and `X-Real-IP` with the connecting address rather than passing client-supplied values through; this is what makes `AUTH_TRUST_PROXY=true` safe when this nginx is the API's only ingress.

The bundle calls the API with relative paths. `VITE_API_URL` is a build-time Vite variable, so leaving it unset keeps one image valid for any host; the same-origin setup matches the dev server's proxy in `apps/web/vite.config.ts`. Runtime viewer settings such as `IRONSIDE_RUBRIST_URL` come from the API (`GET /api/v1/viewer-config`), not the bundle.

## Boot

Every `api` and `worker` start applies pending Postgres and ClickHouse migrations and ensures the raw-event bucket exists (`apps/api/src/index.ts`, `apps/worker/src/index.ts`). There is no separate migration job or init container.

- Migrations are numbered, append-only and checksummed. A process refuses to start when an applied migration's file has changed or when the database has a migration the release does not know (a downgrade). Postgres applies all pending migrations in one transaction under an advisory lock; ClickHouse statements must be safe to repeat because `api` and `worker` can run them at the same time. Rules and the upgrade procedure: `docs/schema-migrations.md`.
- Installations created with 0.3.0 or later upgrade in place. 0.1.0 and 0.2.0 used earlier baselines and cannot be upgraded.
- `ensureBucket` (`packages/storage/src/index.ts`) checks the bucket and creates it when missing. `api` and `worker` start concurrently and can both attempt the create, so a `BucketAlreadyOwnedByYou` or `BucketAlreadyExists` response counts as success.

## Local stack

`docker-compose.yml` builds the three application images from the checkout (`docker compose up -d --build`).

- Infrastructure uses fixed development credentials (`ironside`/`ironside`, MinIO `ironside123`), so every published port binds to `127.0.0.1`: Postgres `5433`, ClickHouse `8123` and `9000`, Redis `6380`, MinIO `9010` (S3) and `9011` (console). The offsets let the stack run beside a local Rubrist (Postgres `5432`) and keep ClickHouse's native port off MinIO's default `9000`.
- `api` (`8788`) and `web` (`8080`) bind to `IRONSIDE_BIND_ADDRESS`, default `127.0.0.1`. Infrastructure ports are never widened, because Docker-published ports bypass host firewalls such as ufw on Linux. The worker's metrics port is not published.
- `api` and `worker` depend on all four infrastructure services with `condition: service_healthy`; `web` starts after `api`.
- `api` sets `WEB_ORIGINS=http://localhost:8080` and `AUTH_INSECURE_COOKIES=true` (the latter overridable), because the stack is plain HTTP on localhost.
- Postgres, ClickHouse and MinIO persist in the `pgdata`, `chdata` and `miniodata` volumes; Redis is not persisted. ClickHouse mounts `docker/clickhouse-backups.xml` to enable native `BACKUP`/`RESTORE`.
- Worker retention and recovery settings default to the values in `docs/self-hosting.md`; raw event retention is on (`RAW_RETENTION_EXECUTION_ENABLED=true`, see `spec/raw-retention-intents-v1.md`).

First run: once the containers are healthy, `docker compose exec api node apps/api/dist/src/scripts/owner-setup.js` prints a one-time `ironside_setup_...` code for `/setup`; the owner then creates a project, whose Ingest credential is shown once (`spec/owner-auth-v1.md`, `spec/project-session-routing-v1.md`). Clients send data to the API directly on `8788` or through `web` on `8080` (`/api/...` for native and LangFuse-compatible ingest, `/v1/...` for OTLP).

## Single-host release bundle

`deploy/self-host/compose.yaml` is the platform-neutral bundle for a Linux host with Docker Engine and Compose v2.

- Images are exact: `ghcr.io/luka-zivkovic/ironside-{web,api,worker}:${IRONSIDE_VERSION}`, `postgres:16.15-alpine`, `clickhouse/clickhouse-server:25.3.14.14-alpine`, `redis:7.4.7-alpine` and MinIO `RELEASE.2025-09-07T16-13-09Z`.
- Compose refuses to render without `IRONSIDE_VERSION`, `IRONSIDE_POSTGRES_PASSWORD`, `IRONSIDE_CLICKHOUSE_PASSWORD`, `IRONSIDE_REDIS_PASSWORD`, `IRONSIDE_MINIO_PASSWORD`, `IRONSIDE_METRICS_TOKEN` and `IRONSIDE_ENCRYPTION_SECRET`.
- Only `web` publishes a port: `${IRONSIDE_BIND_ADDRESS:-127.0.0.1}:${IRONSIDE_PORT:-8080}`. `api` gets `WEB_ORIGINS` from `IRONSIDE_PUBLIC_URL` (default `http://localhost:8080`), `AUTH_INSECURE_COOKIES` from `IRONSIDE_AUTH_INSECURE_COOKIES` (default `true`; set `false` behind TLS), and `AUTH_TRUST_PROXY=true` because the bundled nginx is its only ingress.
- Redis requires a password and uses append-only persistence. All four stores persist in named volumes. Services restart `unless-stopped`; `api` and `worker` run with an init process; `web` waits for a healthy `api`, and `api`/`worker` wait for healthy infrastructure. The worker health check authenticates to its metrics listener with the metrics token.
- The worker reads `IRONSIDE_RAW_RETENTION_ENABLED`, falling back to `RAW_RETENTION_EXECUTION_ENABLED`, default `true`.
- `compose.yaml.sha256` holds the bundle's SHA-256, checked by the release workflow. The bundle is release-owned; operator additions go in `compose.override.yaml`. The separate `trustctl` CLI installs and updates this bundle; it is not an Ironside runtime component (`docs/self-hosting.md`).

`deploy/coolify.yaml` runs the same published images with Coolify-generated secrets and `AUTH_INSECURE_COOKIES=false`. Coolify and trustctl installations are independent: Coolify does not adopt a trustctl installation, and trustctl does not update a Coolify service.

## Release process

Pushing a tag matching `v*.*.*` runs `.github/workflows/release.yml`:

1. `verify`: the tag must be exactly `vX.Y.Z` and equal `v` plus the root `package.json` version. The bundle checksum is verified with `sha256sum -c` and the bundle is rendered with `docker compose config --quiet`. Then `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck` and `pnpm test` run against Postgres, ClickHouse and Redis services and a MinIO container.
2. `publish` (matrix `api`, `worker`, `web`): fails if `ghcr.io/<owner>/ironside-<image>:X.Y.Z` already exists, so a release tag is never overwritten. Builds `linux/amd64` and `linux/arm64` and pushes `X.Y.Z` and `sha-<full commit>` tags with provenance (`mode=max`), an SBOM, and OCI source/revision/version labels, using the GitHub Actions build cache. It never publishes `latest` or another floating tag.
3. `smoke-release`: pulls the published tags into `deploy/self-host/compose.yaml` with throwaway secrets on `127.0.0.1:18080`, waits for `/health` through `web` (up to 120 attempts, 2 seconds apart), runs the owner-setup script in `api` and checks that it prints an `ironside_setup_` code, then removes the stack and its volumes.
4. `draft-release`: creates a draft GitHub release with generated notes.

A person publishes the draft. After a repository's first release run, the owner makes the three GHCR packages public (visibility persists for later versions); before publishing, verify anonymous pulls and list any new Postgres or ClickHouse migrations in the release notes. Persistent instances pin an exact version tag.

## License

MIT (`LICENSE.md`). `packages/sdk/LICENSE.md` carries the same text so the npm package is self-describing, and the root and SDK `package.json` declare `"license": "MIT"`.

## Verified

`packages/storage/test/index.test.ts` covers `ensureBucket` creating a bucket and re-running as a no-op, a second client instance finding the bucket another created, and five concurrent calls against a new bucket. `packages/db/test/migrate-upgrade.test.ts` covers an in-place upgrade from a 0.3.0 database, concurrent starts applying an upgrade once, and refusing to start on an unknown or edited migration; the `migration-files.test.ts` files in `packages/db/test` and `packages/clickhouse/test` pin released checksums, numbering, and repeat-safe ClickHouse statements. The release workflow's `smoke-release` job boots each release's published images from the bundle.

## History

- M7-04 added the `api`, `worker` and `web` services and their Dockerfiles; before it, `docker-compose.yml` started only the infrastructure. It also added `apps/web/nginx.conf`, the self-hosting guide and the license. The fresh-machine check (clone, `docker compose up`, send a trace, read it through `web` on `8080`) passed against real Docker.
- The first real `docker compose up` crashed `api` with `BucketAlreadyOwnedByYou`: `api` and `worker` both found the bucket missing and both tried to create it. `ensureBucket` now treats an already-existing bucket as success, and the storage package gained its first tests.
- Review follow-ups in the same milestone: `@ironside/mappers` moved from `devDependencies` to `dependencies` in `apps/api` (it is imported at runtime; pnpm's workspace links had kept the `--prod` image working) and the lockfile was regenerated; nginx gained the `/v1/` location because the docs promised OTLP through `web` but only `/api/` was proxied; a retention test that flaked under parallel test files now uses a current-month timestamp.
- The original smoke flow used a seed script to mint an API key. Owner setup and scoped machine credentials replaced that (#63–#65); `apps/api/src/scripts/seed.ts` remains a local-development helper that requires owner setup first.
- Ironside was relicensed from the Sustainable Use License to MIT.
- 0.1.0 predates the public-image contract; 0.2.0 was the first version installable from published images; 0.3.0 changed the clean-install baselines, and later releases upgrade 0.3.0 installations in place. The planned `docker-compose.release.yml` override was superseded by `deploy/self-host/compose.yaml` and `deploy/coolify.yaml`.
- Still open: fresh-machine install, upgrade, backup and recovery drills against the published images, with upgrade and restore drills for every release that adds a migration (`ROADMAP.md`).
