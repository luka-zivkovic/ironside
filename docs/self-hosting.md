# Self-hosting Ironside

Ironside is a single `docker compose` stack: four infrastructure services (Postgres, ClickHouse, Redis, MinIO) plus three application services (`api`, `worker`, `web`). Everything is stateless except the four infra services' named volumes.

## Fresh install

```sh
git clone https://github.com/luka-zivkovic/ironside.git
cd ironside
docker compose up -d --build
```

This builds the `api`/`worker`/`web` images locally and starts the whole stack. First boot takes a few minutes (image builds + Postgres/ClickHouse initialization); subsequent `docker compose up` runs are fast, since Docker caches the image layers and the infra containers keep their data in named volumes (`pgdata`, `chdata`, `miniodata`).

The checked-in `docker-compose.yml` is a local stack with fixed development credentials, so it publishes every port on `127.0.0.1` only. Docker-published ports bypass host firewalls such as ufw on Linux, so do not widen the infrastructure ports. To reach the web app or API from another machine, set `IRONSIDE_BIND_ADDRESS` (for example `0.0.0.0`) to publish only `api` and `web` on that interface, put a TLS reverse proxy on the host in front of `127.0.0.1:8080`, or use the [generic single-host release bundle](#generic-single-host-release-bundle), which generates real secrets.

`api` and `worker` apply pending Postgres and ClickHouse migrations on boot and ensure the `ironside-raw` object storage bucket exists, so there's no separate schema step to run by hand. Installations created with 0.3.0 or later upgrade in place; see [Database schema migrations](schema-migrations.md).

Once every container reports healthy (`docker compose ps`), generate a short-lived, one-time owner setup code from the host:

```sh
docker compose exec api node apps/api/dist/src/scripts/owner-setup.js
```

Open `http://localhost:8080/setup`, paste the printed `ironside_setup_...` code, and create the one deployment owner and organization. Only a SHA-256 hash of the code is stored; it expires after 15 minutes by default and is consumed atomically.

After owner setup, create the first project in the UI. The project and its initial Ingest credential are committed atomically, and the plaintext `ironside_sc_...` token is shown once. Copy it into the SDK/exporter that will ingest data; the browser uses only the HttpOnly owner session and project-explicit URLs. Point a client at `http://localhost:8788` directly, or through the web container's nginx proxy on the same origin as the UI (`http://localhost:8080/api/...` for native ingest and LangFuse compatibility, `http://localhost:8080/v1/...` for OTLP — see `apps/web/nginx.conf`).

Native ingest, OTLP, media upload, and `/api/public/*` remain key-implicit; native browser reads and all management require the owner session under `/api/v1/projects/:projectId/...`. Cookie-jar CLI examples and the control-plane route matrix are in [`spec/project-session-routing-v1.md`](../spec/project-session-routing-v1.md); machine capabilities are in [`spec/scoped-machine-credentials-v1.md`](../spec/scoped-machine-credentials-v1.md).

The credential presets are **Ingest** (`ingest`, `media:write`) and **Integration** (`traces:read`, `scores:write`). Optional expiry, creation/revocation actors, status, and last use are visible in Connections. Plaintext is returned only by the create response and must be placed in your secret manager. To rotate, create the replacement preset, update the client, verify its last-use timestamp, and revoke the old credential.

Machine credentials use the `ironside_sc_...` token class. There is no older Ironside credential class in the current baseline.

If the owner password is lost, issue a recovery capability from the host and open `/recover`:

```sh
docker compose exec api node apps/api/dist/src/scripts/owner-recovery.js
```

Recovery replaces the existing owner's password, revokes every active owner session, and never creates another owner.

## Generic single-host release bundle

`deploy/self-host/compose.yaml` is the platform-neutral bundle for a Linux
host with Docker Engine and Compose v2. It uses exact application and
infrastructure images, exposes only the web service on loopback by default,
and persists Postgres, ClickHouse, Redis, and MinIO in named volumes.
`compose.yaml.sha256` is checked by the release workflow.

The separate pre-release `trustctl` CLI installs this bundle, generates the
required secrets, preserves operator additions in `compose.override.yaml`,
and provides `status`, `doctor`, update checking, and explicit updates. It is
not an Ironside runtime component and receives no Docker or hosting-platform
credentials. Do not advertise its one-line bootstrap until trustctl, this
tagged bundle, and the GHCR images are all public.

Coolify remains an independent deployment method whose saved Compose and
environment state define each Service. A trustctl installation is not adopted
by Coolify, and trustctl does not update a Coolify Service.

## Using published images instead of building locally

Every tagged release (`vX.Y.Z`) runs the build, typecheck, and test suite,
validates the generic Compose checksum and render, and then publishes
multi-architecture `ghcr.io/luka-zivkovic/ironside-{api,worker,web}:X.Y.Z`
images. The `0.4.0` images are the current release and are public and
anonymously pullable (amd64 and arm64); installations on `0.3.x` upgrade to it
in place (see [Upgrading](#upgrading)). `0.3.1` is `0.3.0` with MinIO moved to
a pullable image. `0.2.0` was the first version
installable this way; `0.3.0` changed the clean-install baselines, so install it
fresh rather than updating a `0.2.0` instance. `0.1.0` predates the
public-image contract. The release tag is immutable; a `sha-<full commit>` tag is published
for traceability. To use published images instead of building from source,
use the [generic single-host bundle](../deploy/self-host/compose.yaml), the
[Coolify stack](../deploy/coolify.yaml), or replace each `build:` block with
its matching exact `image:` reference.

```yaml
services:
  api:
    image: ghcr.io/luka-zivkovic/ironside-api:0.4.0
  worker:
    image: ghcr.io/luka-zivkovic/ironside-worker:0.4.0
  web:
    image: ghcr.io/luka-zivkovic/ironside-web:0.4.0
```

After every image publishes, the workflow pulls those exact tags into the
generic Compose bundle, boots a disposable stack, verifies the public health
route and owner-setup command, and only then creates a **draft** GitHub
release. After the first workflow run, an owner must make all three GHCR
packages public; package visibility persists for later versions. Verify
anonymous pulls, list any new Postgres or ClickHouse migrations in the release
notes, and then publish the draft.
Default trustctl installs and update checks see only the published release.
Do not use `latest`, `main`, or another floating tag for a persistent instance.

## Configuration

All configuration is environment variables, set directly on the `api`/`worker` services in `docker-compose.yml` (or via a `.env` file / your orchestrator's secret mechanism for a production deploy). See `apps/api/src/config.ts` and `apps/worker/src/config.ts` for the authoritative list; the ones most likely to need changing for a real deployment:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://ironside:ironside@postgres:5432/ironside` | Postgres connection string |
| `CLICKHOUSE_URL` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` / `CLICKHOUSE_DB` | see `docker-compose.yml` | ClickHouse connection |
| `REDIS_URL` | `redis://redis:6379` | Redis connection (auth cache, rate-limit counters, BullMQ queue) |
| `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` / `S3_REGION` | MinIO defaults | Raw event log plus ingest-recovery sidecars — point at real S3 (or any S3-compatible service) for production instead of the bundled MinIO |
| `WEB_ORIGINS` | `http://localhost:8080` | CORS allowlist for the web app's origin(s) — update if you serve the web app from a different host/port |
| `AUTH_INSECURE_COOKIES` | `false` in the API; the checked-in localhost Compose stack explicitly sets `true` | Disables the owner session cookie's `Secure` attribute. Use only for deliberate plain-HTTP localhost/LAN access; leave false behind TLS |
| `AUTH_SESSION_IDLE_TTL_SECONDS` | `43200` | Sliding owner-session inactivity lifetime (12 hours) |
| `AUTH_SESSION_ABSOLUTE_TTL_SECONDS` | `604800` | Hard owner-session lifetime (7 days), never extended by activity |
| `AUTH_CHALLENGE_TTL_SECONDS` | `900` | Lifetime of host-issued setup and recovery capabilities |
| `AUTH_RATE_LIMIT_PER_15_MINUTES` | `10` | Setup, login, and recovery attempts allowed per client address in each 15-minute window; login deliberately has no globally lockable username bucket |
| `AUTH_TRUST_PROXY` | `false` | Trust `X-Forwarded-For`/`X-Real-IP` for auth limiting. Enable only when a trusted reverse proxy is the API's sole ingress |
| `DEFAULT_RATE_LIMIT_PER_MINUTE` | `300` | Platform-default per-project machine-write rate limit shared by ingest, media upload, and score writes; override per project via session-authenticated `PATCH /api/v1/projects/:projectId/quotas` |
| `DEFAULT_TRACE_QUIET_PERIOD_SECONDS` | `300` | Seconds without trace/observation activity before automated consumers treat a trace as settled. Set identically on API and worker; override per project with `traceQuietPeriodSeconds` via session-authenticated `PATCH /api/v1/projects/:projectId/quotas` |
| `IRONSIDE_ENCRYPTION_SECRET` | unset | Encrypts export/forward/webhook/import-source credentials at rest (AES-256-GCM) in Postgres. Required before configuring any of those features (saving credentials errors without it); must be identical on `api` and `worker`. Treat it like a database password — losing or changing it orphans every stored credential (see the backup caveat below) |
| `METRICS_TOKEN` | unset | Enables Prometheus metrics. On the **api**, `GET /metrics` is disabled entirely (404) until this is set, then requires `Authorization: Bearer <token>`. On the **worker**, gates the worker's own metrics listener |
| `IRONSIDE_RUBRIST_URL` | unset | Optional Rubrist web base URL (API only), such as `https://rubrist.example.com`. When set, each trace view shows an **Open in Rubrist** link; unset leaves the viewer unchanged. Must be an absolute `http(s)` URL without credentials, query, or fragment. The web app reads it at runtime, so no image rebuild is needed. Link shapes: [`spec/evaluator-integration-v1.md`](../spec/evaluator-integration-v1.md#viewer-deep-links) |
| `METRICS_PORT` | `9464` | Port for the worker's dedicated `/metrics` listener (the worker has no other HTTP surface) |
| `INGEST_RECOVERY_INTERVAL_MS` | `30000` | How often the worker reconciles durable pending-ingest intents back into Redis after queue loss |
| `INGEST_RECOVERY_BATCH_SIZE` | `1000` | Maximum pending intents examined in one recovery pass; persisted scan cycles advance later passes and force fair revisitation |
| `DEFAULT_RETENTION_DAYS` | `90` | Default logical retention window for projects without a per-project override |
| `RETENTION_INTERVAL_MS` | `21600000` | Interval between ClickHouse retention passes (6 hours by default) |
| `LIFECYCLE_PLAN_SCAN_LIMIT` | `100000` | Maximum objects examined in each pending/failed prefix and, separately, across all included projects' raw prefixes; incomplete scans stay visibly incomplete |
| `LIFECYCLE_PLAN_PROJECT_LIMIT` | `1000` | Maximum projects included in an unscoped lifecycle plan |
| `LIFECYCLE_PLAN_PROJECT_ID` | unset | Optional exact project scope for the lifecycle plan; useful on installations above the project cap |
| `RAW_RETENTION_PROJECT_ID` | unset | Required exact project for the operator-run, non-destructive raw-retention intent preparer |
| `RAW_RETENTION_OBJECT_KEYS_JSON` | unset | Explicit JSON array of canonical raw object keys to validate and prepare; capped at 100 objects / 1 GiB / 10,000 aggregate trace refs, with separately bounded sidecar and diagnostic reads, and never read from the lifecycle manifest |
| `RAW_RETENTION_EXECUTION_ENABLED` | `true` | Deletes raw event objects once they are past their project's retention, through the automatic sweep and the operator executor. Any value other than exactly `true`, including an empty value, disables both and keeps raw events indefinitely; set it identically on every worker replica. Enabled workers need `DeleteObject` on `raw/*`. The self-host bundle also reads `IRONSIDE_RAW_RETENTION_ENABLED`. Ingest always coordinates with deletion, so switching it off never lets a delayed job restore data a deletion already started to remove |
| `RAW_RETENTION_SWEEP_INTERVAL_MS` | `900000` | How often the raw retention sweep runs (15 minutes; `IRONSIDE_RAW_RETENTION_SWEEP_INTERVAL_MS` in the self-host bundle). Each sweep examines at most 1,000 expired objects per project, starts with a different project each time, and stops starting new work after 5 minutes; the next sweep continues from there. Invalid values fall back to the default |
| `RAW_RETENTION_INTENT_IDS_JSON` | unset | Explicit JSON array of 1–10 reviewed intent ids for the executor; no discovery or manifest input |

**Change the default credentials before exposing this to anything but `localhost`.** `docker-compose.yml` ships with the same `ironside`/`ironside`/`ironside123` placeholder credentials across Postgres, ClickHouse, and MinIO for local-dev convenience — these are not safe defaults for a reachable deployment.

## Production considerations

- **TLS**: nothing in this stack terminates TLS itself. Put a reverse proxy (nginx, Caddy, Traefik, your cloud load balancer) in front of the `web` container (and the `api` container, if you expose it directly for SDK ingest rather than routing everything through `web`'s `/api` proxy) and terminate TLS there.
- **Owner cookies**: owner sessions are HttpOnly, SameSite=Lax, and Secure by default. The local Compose file explicitly opts out because it serves `http://localhost:8080`; remove that opt-out when TLS is enabled. Credentialed CORS accepts only `WEB_ORIGINS`, and every owner-auth mutation additionally requires an allowed `Origin` and rejects cross-site Fetch Metadata.
- **Retention**: the worker runs `runRetention` automatically on a schedule (default every 6h; override with `RETENTION_INTERVAL_MS`, and the platform-default window with `DEFAULT_RETENTION_DAYS`). It drops old ClickHouse partitions at the loosest retention floor and row-marks projects with shorter per-project overrides (session-authenticated `PATCH /api/v1/projects/:projectId/quotas`). Inspect the bounded lifecycle manifest with `docker compose exec worker node apps/worker/dist/src/scripts/lifecycle-plan.js`; it is inventory and must never be executed as a deletion list. A separate exact-key command prepares metadata-only raw-retention intents after rechecking cutoff, object size, pending/queue/diagnostic state, bounded refs, and visible trace rows: `docker compose exec -e RAW_RETENTION_PROJECT_ID=... -e 'RAW_RETENTION_OBJECT_KEYS_JSON=["raw/...json"]' worker node apps/worker/dist/src/scripts/raw-retention-intents.js`. It always reports `destructiveActionsEnabled: false`. **Raw event objects** (the full original payloads in object storage) are deleted automatically: every 15 minutes the worker's raw retention sweep finds objects whose UTC receive day is past their project's retention and passes them through the same preparer and executor, so an object whose trace is still visible, whose batch is still pending, or whose state is otherwise uncertain is skipped and revisited later rather than deleted. Set `RAW_RETENTION_EXECUTION_ENABLED` to anything other than `true` on every worker to keep raw events indefinitely. The operator executor remains available for exact reviewed intents: `docker compose exec -e RAW_RETENTION_PROJECT_ID=... -e 'RAW_RETENTION_INTENT_IDS_JSON=["rti_..."]' worker node apps/worker/dist/src/scripts/raw-retention-execute.js --execute`. For every raw-present intent, the executor probes a non-canonical `.retention-probes/*` key inside that exact project/day prefix and verifies pending/failed sidecar permissions before it claims work. Uploaded media is not yet covered by retention. See `spec/lifecycle-planning-v1.md` and `spec/raw-retention-intents-v1.md`.
- **Object-storage permissions**: API credentials need `PutObject` for `raw/*` and `pending-ingest/*`. Ordinary worker credentials need bucket listing plus `PutObject`/`GetObject`/`HeadObject`/`DeleteObject` for `pending-ingest/*`, `GetObject` for `raw/*`, and `PutObject`/`GetObject`/`DeleteObject` for `failed-ingest/*`. Worker `PutObject` on the pending prefix is required for its persisted scan cursor and reserved startup probe. The worker stores its probe under `pending-ingest/.internal/` but tests `ListObjectsV2` with the exact runtime `pending-ingest/` prefix; it refuses to consume jobs when the create/get/head/list/delete contract is unavailable. With raw retention enabled (the default), worker credentials also need `DeleteObject` on `raw/*` and `PutObject`/`HeadObject`/`DeleteObject` on `raw/{project}/{yyyy}/{mm}/{dd}/.retention-probes/*`; API credentials never need raw delete. To keep raw events as an immutable archive instead, set `RAW_RETENTION_EXECUTION_ENABLED=false` on every worker and deny `raw/*` `DeleteObject`. A bucket-wide Object Lock/default WORM policy is not compatible with raw retention or the deletable sidecars in this single-bucket version; use prefix-scoped IAM immutability for the raw archive if you disable retention.
- **Clock synchronization and trace completion**: keep API, worker, Postgres, and ClickHouse clocks synchronized with NTP in multi-host deployments. Recovery scan cycles compare the API acceptance time on an intent with the worker cycle start; trace-settlement watermarks compare write times across services. Automated exports, OTLP forwards, webhooks, and LangFuse-compatible reads wait until a trace has had no trace/observation writes for the configured quiet period. A later write reopens it; once quiet again it is a new settled version. Score writes do not reopen traces because scores are downstream annotations. Native UI/query routes intentionally continue showing in-flight traces for live debugging. LangFuse-compatible list/detail calls therefore have no read-after-write guarantee and may return an empty list/404 until the quiet period expires.
- **Backups**: see the dedicated [Backups and restore](#backups-and-restore) section below — every command there is tested against this compose stack.
- **Monitoring**: both processes export Prometheus metrics. The api serves `GET /metrics` on its main port (token-gated via `METRICS_TOKEN`; never exposed unauthenticated). The worker serves `:9464/metrics` on a dedicated listener — the port is *not* published in `docker-compose.yml` by default; scrape from inside the compose network, or add a `ports` mapping and set `METRICS_TOKEN` to scrape externally. Key series: `ironside_http_requests_total`/`ironside_http_request_duration_seconds` (api, labeled by matched route pattern), `ironside_worker_batches_processed_total`/`_failed_total`, `ironside_ingest_batches_recovered_total`, `ironside_ingest_queue_waiting`/`_active`/`_failed` (sampled live at scrape time), `ironside_scheduler_runs_total{subsystem,outcome}` for exports/forwards/webhooks/imports/environment-registry/retention/ingest-recovery/raw-retention, and `ironside_ingest_events_dead_lettered_total` (events the worker couldn't map — inspect them via owner-session `GET /api/v1/projects/:projectId/ingest-failures`, which includes a pointer to the raw payload in object storage; rows auto-purge after 30 days). A sustained non-zero `ironside_ingest_queue_waiting` means workers aren't keeping up — add worker replicas; a rising `_failed` needs investigation before retries exhaust.
- **Environment discovery**: trace data in ClickHouse is authoritative; Postgres stores only the capped picker/preferences projection. The worker repairs it daily in bounded resumable chunks. To force one exact project, run `docker compose exec -e ENVIRONMENT_REGISTRY_PROJECT_ID=proj_... worker node apps/worker/dist/src/scripts/environment-registry-rebuild.js`. At the 100-name cap, extra values remain directly queryable but are not listed; monitor `ironside_environment_registry_overflow_total{source="live"|"rebuild"}`. Hiding changes discovery only. See [`spec/environments-v1.md`](../spec/environments-v1.md).
- **Model prices**: when an observation reports token usage and a model but no cost, the worker derives cost at ingest from a bundled price table (trimmed from LiteLLM's community list; its sync date is shown in Configuration → Model prices and stamped on each cost derived from it as `ironside:cost_table`). Add per-project rules there for private or unlisted models; rules are regular expressions checked in order before the table. Cost a client sends is always stored as is, and stored costs are never rewritten when the table or rules change. Refresh the table in a release with `pnpm --filter @ironside/pricing sync-prices`. See [`spec/cost-pricing-v1.md`](../spec/cost-pricing-v1.md).
- **Scaling**: `api` and `worker` are both stateless and horizontally scalable — run multiple replicas behind a load balancer for `api`, or multiple `worker` instances (BullMQ handles concurrent consumers safely) for ingest throughput. `web` is a static SPA behind nginx and scales trivially.

## Backups and restore

Three stores hold three different kinds of data; back them up independently. Every command below was run and verified against this compose stack (including the restores — an untested backup is a hope, not a plan). Copy all backup artifacts **off-host**; a backup sitting next to the data it protects is not disaster recovery.

**What lives where:**

| Store | Contents | Loss impact |
|---|---|---|
| Postgres (`pgdata`) | orgs, projects, machine credentials, export/forward/webhook/import-source configs (encrypted credentials), import checkpoints, dead letters | You lose tenancy + configuration — the platform's control plane |
| ClickHouse (`chdata`) | traces/observations/scores — the queryable data | Rebuildable in principle from the raw log (no automated replay tool yet), painful in practice |
| MinIO/S3 (`miniodata`) | the immutable raw ingest log, pending recovery intents, and terminal ingest diagnostics | Permanent loss of the ability to reprocess/replay history; loss of pending intents removes automatic queue recovery |
| Redis | queue + auth cache — deliberately **not** backed up | The auth cache rebuilds itself. The worker automatically reconstructs lost queue jobs from durable pending intents in object storage |

### Postgres (online-safe, no downtime)

```sh
docker exec ironside-postgres-1 pg_dump -U ironside -d ironside --format=custom > ironside-pg-$(date +%F).dump
```

Restore into a fresh database (stop `api`/`worker` first so migrations/writes don't race the restore):

```sh
docker compose stop api worker
cat ironside-pg-YYYY-MM-DD.dump | docker exec -i ironside-postgres-1 pg_restore -U ironside -d ironside --clean --if-exists
docker compose start api worker
```

**Critical caveat — the encryption secret:** export/forward/webhook/import-source credentials in Postgres are AES-256-GCM ciphertext encrypted with `IRONSIDE_ENCRYPTION_SECRET`. A Postgres backup restored into an environment with a *different* secret leaves every stored credential undecryptable (scheduled runs will fail with decryption errors until each destination/source is reconnected). Back up the secret alongside the dump — in your secret manager, not next to the dump file.

### ClickHouse (native BACKUP/RESTORE, online)

The compose stack ships with ClickHouse's backup engine enabled (`docker/clickhouse-backups.xml` sets `backups.allowed_path`). One command backs up the whole database:

```sh
docker exec ironside-clickhouse-1 clickhouse-client --user ironside --password ironside \
  --query "BACKUP DATABASE ironside TO File('/var/lib/clickhouse/backups/ironside-$(date +%F)')"
# then copy it off-host:
docker cp ironside-clickhouse-1:/var/lib/clickhouse/backups/ironside-$(date +%F) ./
```

Restore (verified round-trip — restoring into a scratch database and counting rows is a cheap way to test a backup without touching live data):

```sh
# validate a backup non-destructively:
docker exec ironside-clickhouse-1 clickhouse-client --user ironside --password ironside \
  --query "RESTORE DATABASE ironside AS ironside_restored FROM File('/var/lib/clickhouse/backups/ironside-YYYY-MM-DD')"
# real restore (into the live database name), with api/worker stopped:
docker exec ironside-clickhouse-1 clickhouse-client --user ironside --password ironside \
  --query "RESTORE DATABASE ironside FROM File('/var/lib/clickhouse/backups/ironside-YYYY-MM-DD')"
```

### MinIO raw log (`mc` ships in the container)

```sh
docker exec ironside-minio-1 mc alias set local http://localhost:9000 ironside ironside123
docker exec ironside-minio-1 mc mirror local/ironside-raw /tmp/raw-backup
docker cp ironside-minio-1:/tmp/raw-backup ./ironside-raw-$(date +%F)
docker exec ironside-minio-1 rm -rf /tmp/raw-backup
```

Restore (verified round-trip): copy the backup back into the container and mirror it into the bucket. The api auto-creates the bucket on boot, so after a total `miniodata` loss just `docker compose up -d` first, then:

```sh
docker cp ./ironside-raw-YYYY-MM-DD ironside-minio-1:/tmp/raw-restore
docker exec ironside-minio-1 mc alias set local http://localhost:9000 ironside ironside123
docker exec ironside-minio-1 mc mirror /tmp/raw-restore local/ironside-raw
docker exec ironside-minio-1 rm -rf /tmp/raw-restore
```

`mc mirror` is additive here — it uploads what's missing and never deletes objects already in the bucket (don't pass `--remove`), so restoring an older backup alongside newer live objects is safe.

For production, prefer pointing `S3_ENDPOINT` at real S3 and using bucket versioning/replication instead of the bundled MinIO.

### Consistency across stores

The three backups are not a single consistent snapshot — a trace ingested between the ClickHouse and Postgres dumps exists in one and not the other. This is fine in practice: the stores are independently meaningful (Postgres = control plane, ClickHouse = data, raw log = history), and the raw log is append-only so a slightly-later object-storage backup only ever contains *more* history. If you need a hard-consistent snapshot, `docker compose stop api worker` first (ingest pauses; ACKed-but-unprocessed batches wait safely in Redis/raw log), back up all three, then `start`.

## Upgrading

Installations created with 0.3.0 or later upgrade in place. Back up all three
stores ([Backups and restore](#backups-and-restore)), change API, worker, and
web to the same exact target version, and start them; pending migrations apply
on boot. Then verify health, owner sign-in, ingest, query, queue recovery, and
scheduled work. Concurrent starts are safe, in-flight queue jobs survive
ordinary worker restarts, and durable pending-ingest intents reconstruct lost
Redis jobs.

**MinIO's image moved in 0.3.1.** MinIO no longer publishes public images:
`quay.io/minio/minio` refuses anonymous pulls, so an installation on the 0.3.0
Compose file keeps running from its cached image but cannot pull it again. From
0.3.1 the Compose files use Chainguard's build of MinIO, pinned by digest, and
run it as root like the official image did, so it opens the existing data
volume. The build is MinIO `RELEASE.2026-09-22T19-25-18Z`, a year newer than
the `RELEASE.2025-09-07T16-13-09Z` it replaces; the old image cannot be pulled
any more, so there is no going back to it. Back up MinIO first. The change is
in the Compose file, not in the application images: when updating to 0.3.1,
take `compose.yaml` (or `docker-compose.yml`) from the `v0.3.1` tag along with
the version; later releases' files include it.

**Take the Compose file from the `v0.4.0` tag.** The 0.3.x Compose files pin
`RAW_RETENTION_EXECUTION_ENABLED: "false"` for the worker; the 0.4.0 files
read the setting from the environment instead and add
`RAW_RETENTION_SWEEP_INTERVAL_MS`. With the new images alone, raw retention
stays off.

**With the 0.4.0 Compose file, upgrading starts deleting raw event objects.**
Raw retention is on by default from 0.4.0: within 15 minutes of the first boot,
the worker begins deleting raw event objects whose receive day is past their
project's retention (default 90 days). To keep raw events, set
`RAW_RETENTION_EXECUTION_ENABLED=false` (in the self-host bundle,
`IRONSIDE_RAW_RETENTION_ENABLED=false` also works) on every worker before
upgrading.

**Other 0.4.0 changes to check before upgrading:**

- Scheduled exports change format: `jsonl` writes native ingest events with a
  `traceVersion` instead of one summary row per trace, and `parquet` writes
  `traces/`, `observations/` and `scores/` folders instead of one file.
  Exports are also incremental, from the durable trace feed.
- Webhook and OTLP forward destinations are refused on more address ranges,
  checked again at each connection: every range that is not globally
  reachable, including `100.64.0.0/10` (carrier-grade NAT, also used by
  Tailscale). Their requests ignore `HTTP_PROXY` and `NODE_USE_ENV_PROXY`.
- Webhooks move to the durable trace feed. Migration `0006` hands existing rules
  over so that a rolling upgrade neither resends old deliveries nor sends one
  twice while 0.3.x and 0.4.0 workers overlap (see `spec/webhooks-v1.md`).

Downgrades are not supported: an older release refuses to start on a schema a
newer release migrated. To go back, restore the pre-upgrade backup. See
[Database schema migrations](schema-migrations.md) for the upgrade procedure
and the rules for writing migrations.

Coolify-specific installation, backup coverage, and version-change steps are
in [the Coolify runbook](coolify.md).
