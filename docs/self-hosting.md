# Self-hosting Ironside

Ironside is a single `docker compose` stack: four infrastructure services (Postgres, ClickHouse, Redis, MinIO) plus three application services (`api`, `worker`, `web`). Everything is stateless except the four infra services' named volumes.

## Fresh install

```sh
git clone https://github.com/luka-zivkovic/ironside.git
cd ironside
docker compose up -d --build
```

This builds the `api`/`worker`/`web` images locally and starts the whole stack. First boot takes a few minutes (image builds + Postgres/ClickHouse initialization); subsequent `docker compose up` runs are fast, since Docker caches the image layers and the infra containers keep their data in named volumes (`pgdata`, `chdata`, `miniodata`).

`api` and `worker` each verify the same Postgres/ClickHouse migration history on boot and ensure the `ironside-raw` object storage bucket exists, so there's no separate schema step to run by hand. The first persistent external deployment froze both baselines on 2026-08-28; later releases use append-only forward migrations. See [Database schema lifecycle](pre-production-schema.md).

Once every container reports healthy (`docker compose ps`), generate a short-lived, one-time owner setup code from the host:

```sh
docker compose exec api node apps/api/dist/src/scripts/owner-setup.js
```

Open `http://localhost:8080/setup`, paste the printed `ironside_setup_...` code, and create the one deployment owner and organization. Only a SHA-256 hash of the code is stored; it expires after 15 minutes by default and is consumed atomically.

After owner setup, create the first project in the UI. The project and its initial Ingest credential are committed atomically, and the plaintext `ironside_sc_...` token is shown once. Copy it into the SDK/exporter that will ingest data; the browser uses only the HttpOnly owner session and project-explicit URLs. Point a client at `http://localhost:8788` directly, or through the web container's nginx proxy on the same origin as the UI (`http://localhost:8080/api/...` for native ingest and LangFuse compatibility, `http://localhost:8080/v1/...` for OTLP — see `apps/web/nginx.conf`).

Native ingest, OTLP, media upload, and `/api/public/*` remain key-implicit; native browser reads and all management require the owner session under `/api/v1/projects/:projectId/...`. Cookie-jar CLI examples and the control-plane route matrix are in [`spec/project-session-routing-v1.md`](../spec/project-session-routing-v1.md); machine capabilities are in [`spec/scoped-machine-credentials-v1.md`](../spec/scoped-machine-credentials-v1.md).

The credential presets are **Ingest** (`ingest`, `media:write`) and **Integration** (`traces:read`, `scores:write`). Optional expiry, creation/revocation actors, status, and last use are visible in Connections. Plaintext is returned only by the create response and must be placed in your secret manager. To rotate, create the replacement preset, update the client, verify its last-use timestamp, and revoke the old credential.

Machine credentials use the `ironside_sc_...` token class. There is no older Ironside credential class in the frozen baseline.

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
images. The release tag is immutable; a `sha-<full commit>` tag is published
for traceability. To use published images instead of building from source,
use the [generic single-host bundle](../deploy/self-host/compose.yaml), the
[Coolify stack](../deploy/coolify.yaml), or replace each `build:` block with
its matching exact `image:` reference.

```yaml
services:
  api:
    image: ghcr.io/luka-zivkovic/ironside-api:0.2.0
  worker:
    image: ghcr.io/luka-zivkovic/ironside-worker:0.2.0
  web:
    image: ghcr.io/luka-zivkovic/ironside-web:0.2.0
```

Only after every image publishes does the workflow create a **draft** GitHub
release. After the first workflow run, an owner must make all three GHCR
packages public; package visibility persists for later versions. Verify
anonymous pulls, document whether the release has no data migration or a
forward migration with its restore expectations, and then publish the draft.
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
| `RAW_RETENTION_EXECUTION_ENABLED` | `false` | Literal `true` opt-in for the separate executor and ingest tombstone coordination guard; enable only when every worker replica runs the same current build. Ordinary enabled workers do not need raw-delete credentials |
| `RAW_RETENTION_INTENT_IDS_JSON` | unset | Explicit JSON array of 1–10 reviewed intent ids for the executor; no discovery or manifest input |

**Change the default credentials before exposing this to anything but `localhost`.** `docker-compose.yml` ships with the same `ironside`/`ironside`/`ironside123` placeholder credentials across Postgres, ClickHouse, and MinIO for local-dev convenience — these are not safe defaults for a reachable deployment.

## Production considerations

- **TLS**: nothing in this stack terminates TLS itself. Put a reverse proxy (nginx, Caddy, Traefik, your cloud load balancer) in front of the `web` container (and the `api` container, if you expose it directly for SDK ingest rather than routing everything through `web`'s `/api` proxy) and terminate TLS there.
- **Owner cookies**: owner sessions are HttpOnly, SameSite=Lax, and Secure by default. The local Compose file explicitly opts out because it serves `http://localhost:8080`; remove that opt-out when TLS is enabled. Credentialed CORS accepts only `WEB_ORIGINS`, and every owner-auth mutation additionally requires an allowed `Origin` and rejects cross-site Fetch Metadata.
- **Retention**: the worker runs `runRetention` automatically on a schedule (default every 6h; override with `RETENTION_INTERVAL_MS`, and the platform-default window with `DEFAULT_RETENTION_DAYS`). It drops old ClickHouse partitions at the loosest retention floor and row-marks projects with shorter per-project overrides (session-authenticated `PATCH /api/v1/projects/:projectId/quotas`). Inspect the bounded lifecycle manifest with `docker compose exec worker node apps/worker/dist/src/scripts/lifecycle-plan.js`; it is inventory and must never be executed as a deletion list. A separate exact-key command prepares metadata-only raw-retention intents after rechecking cutoff, object size, pending/queue/diagnostic state, bounded refs, and visible trace rows: `docker compose exec -e RAW_RETENTION_PROJECT_ID=... -e 'RAW_RETENTION_OBJECT_KEYS_JSON=["raw/...json"]' worker node apps/worker/dist/src/scripts/raw-retention-intents.js`. It always reports `destructiveActionsEnabled: false`. Deletion is a second operator action over 1–10 exact reviewed intent ids and requires both `RAW_RETENTION_EXECUTION_ENABLED=true` and `--execute`. Upgrade every replica, set the flag in the worker service environment, recreate all workers (`RAW_RETENTION_EXECUTION_ENABLED=true docker compose up -d --force-recreate worker`), then invoke the command with short-lived executor credentials: `docker compose exec -e RAW_RETENTION_EXECUTION_ENABLED=true -e RAW_RETENTION_PROJECT_ID=... -e 'RAW_RETENTION_INTENT_IDS_JSON=["rti_..."]' -e S3_ACCESS_KEY=... -e S3_SECRET_KEY=... worker node apps/worker/dist/src/scripts/raw-retention-execute.js --execute`. All enabled workers coordinate ingest/recovery with the executor, but ordinary replicas do not need raw-delete access. For every raw-present intent, the command probes a non-canonical `.retention-probes/*` key inside that exact project/day prefix and verifies pending/failed sidecar permissions before it claims work. Keep `DeleteObject` denied for canonical `raw/*` outside this deliberate executor role/window. See `spec/lifecycle-planning-v1.md` and `spec/raw-retention-intents-v1.md`.
- **Object-storage permissions**: API credentials need `PutObject` for `raw/*` and `pending-ingest/*`. Ordinary worker credentials need bucket listing plus `PutObject`/`GetObject`/`HeadObject`/`DeleteObject` for `pending-ingest/*`, `GetObject` for `raw/*`, and `PutObject`/`GetObject`/`DeleteObject` for `failed-ingest/*`. Worker `PutObject` on the pending prefix is required for its persisted scan cursor and reserved startup probe. The worker stores its probe under `pending-ingest/.internal/` but tests `ListObjectsV2` with the exact runtime `pending-ingest/` prefix; it refuses to consume jobs when the create/get/head/list/delete contract is unavailable. Keep canonical `raw/*` `DeleteObject` denied for ordinary API/worker roles. During an explicit executor window, the executor role additionally needs `PutObject`/`HeadObject`/`DeleteObject` on each reviewed `raw/{project}/{yyyy}/{mm}/{dd}/.retention-probes/*` prefix and `DeleteObject` on the exact reviewed canonical raw objects. A bucket-wide Object Lock/default WORM policy is not compatible with this execution path or the deletable sidecars in this single-bucket version, so use prefix-scoped IAM immutability for the raw archive.
- **Clock synchronization and trace completion**: keep API, worker, Postgres, and ClickHouse clocks synchronized with NTP in multi-host deployments. Recovery scan cycles compare the API acceptance time on an intent with the worker cycle start; trace-settlement watermarks compare write times across services. Automated exports, OTLP forwards, webhooks, and LangFuse-compatible reads wait until a trace has had no trace/observation writes for the configured quiet period. A later write reopens it; once quiet again it is a new settled version. Score writes do not reopen traces because scores are downstream annotations. Native UI/query routes intentionally continue showing in-flight traces for live debugging. LangFuse-compatible list/detail calls therefore have no read-after-write guarantee and may return an empty list/404 until the quiet period expires.
- **Backups**: see the dedicated [Backups and restore](#backups-and-restore) section below — every command there is tested against this compose stack.
- **Monitoring**: both processes export Prometheus metrics. The api serves `GET /metrics` on its main port (token-gated via `METRICS_TOKEN`; never exposed unauthenticated). The worker serves `:9464/metrics` on a dedicated listener — the port is *not* published in `docker-compose.yml` by default; scrape from inside the compose network, or add a `ports` mapping and set `METRICS_TOKEN` to scrape externally. Key series: `ironside_http_requests_total`/`ironside_http_request_duration_seconds` (api, labeled by matched route pattern), `ironside_worker_batches_processed_total`/`_failed_total`, `ironside_ingest_batches_recovered_total`, `ironside_ingest_queue_waiting`/`_active`/`_failed` (sampled live at scrape time), `ironside_scheduler_runs_total{subsystem,outcome}` for exports/forwards/webhooks/imports/environment-registry/retention/ingest-recovery, and `ironside_ingest_events_dead_lettered_total` (events the worker couldn't map — inspect them via owner-session `GET /api/v1/projects/:projectId/ingest-failures`, which includes a pointer to the raw payload in object storage; rows auto-purge after 30 days). A sustained non-zero `ironside_ingest_queue_waiting` means workers aren't keeping up — add worker replicas; a rising `_failed` needs investigation before retries exhaust.
- **Environment discovery**: trace data in ClickHouse is authoritative; Postgres stores only the capped picker/preferences projection. The worker repairs it daily in bounded resumable chunks. To force one exact project, run `docker compose exec -e ENVIRONMENT_REGISTRY_PROJECT_ID=proj_... worker node apps/worker/dist/src/scripts/environment-registry-rebuild.js`. At the 100-name cap, extra values remain directly queryable but are not listed; monitor `ironside_environment_registry_overflow_total{source="live"|"rebuild"}`. Hiding changes discovery only. See [`spec/environments-v1.md`](../spec/environments-v1.md).
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

Treat an upgrade as a coordinated change to three application images and up to
four stateful services:

1. Read every intervening release note and identify Postgres, ClickHouse,
   object-storage, Redis, Compose, and secret changes.
2. Restore representative backups into a separate trial stack and deploy the
   exact target version there.
3. Before production, stop or pause writes when the release notes require it,
   take fresh off-host Postgres, ClickHouse, and object-storage backups, and
   record the current exact app and infrastructure image versions.
4. Change API, worker, and web to the same target version. Never run mixed app
   versions unless that release explicitly documents rolling compatibility.
5. Deploy, inspect both migration runners, verify `/health`, owner sign-in,
   ingest, query, queue recovery, scheduled work, and the worker metrics health
   check.
6. Retain the backups and old Compose definition for the recovery window.

An image downgrade is valid only when release notes declare that no data
migration ran. After a forward migration, recover by a tested forward fix or
restore every affected store before starting the old images. Never use
`docker compose down -v` as an upgrade step.

Both `api` and `worker` verify the frozen baselines and every later migration
checksum on boot. Concurrent first starts are safe (Postgres uses an advisory
lock; ClickHouse uses idempotent DDL). In-flight queue jobs survive a worker
restart, and durable pending-ingest intents reconstruct lost Redis jobs.

Coolify-specific installation, backup coverage, and version-change steps are
in [the Coolify runbook](coolify.md).
