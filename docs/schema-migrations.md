# Database schema migrations

The Postgres and ClickHouse schemas are numbered migration files:

- `packages/db/migrations/NNNN_name.sql`
- `packages/clickhouse/migrations/NNNN_name.sql`

`api` and `worker` apply pending migrations in file order when they start.
Each database records the migrations it applied, with their SHA-256 checksums,
in its `ironside_migrations` table. Installations created with 0.3.0 or later
upgrade in place.

## Rules for schema changes

- **A released migration is never edited.** Installed databases recorded its
  checksum, and a database whose applied migration no longer matches refuses
  to start. Change the schema by adding the next numbered file. Each
  package's `test/migration-files.test.ts` pins the checksums of released
  migrations; when cutting a release, add its new migrations to
  `RELEASED_CHECKSUMS` there.
- **Number files `0001`, `0002`, ... without gaps**, and put unreleased
  migrations after released ones. The migration-files tests enforce both.
- **Keep adjacent releases compatible with one schema.** Add tables and
  nullable or defaulted columns in one release; stop reading a column before
  a later release drops or renames it. A replica still running the previous
  release then keeps working while the new one migrates.
- **Postgres:** every pending migration runs in one transaction under an
  advisory lock, so concurrent starts apply each migration once and a failure
  changes nothing. Do not use statements that cannot run inside a
  transaction, such as `create index concurrently`.
- **ClickHouse:** DDL is not transactional, and `api` and `worker` both
  migrate on boot, so a migration can run twice or resume after failing
  partway. Every statement must be safe to repeat: `create ... if not exists`,
  `alter table ... add column if not exists`, `drop ... if exists`. Do not use
  `insert`, `rename`, or `exchange`; backfill data in application code. The
  runner splits statements on `;` and drops lines that start with `--`, so do
  not put `;` inside string literals or trailing comments. The migration-files
  test rejects statements that are unsafe to repeat.

## Upgrading an installation

1. Read the release notes for new migrations and configuration changes.
2. Back up Postgres, ClickHouse, and object storage
   ([Backups and restore](self-hosting.md#backups-and-restore)).
3. Move `api`, `worker`, and `web` to the same new version and start them.
   Pending migrations apply on boot.
4. Verify health, owner sign-in, ingest, and trace reads.

Downgrades are not supported. An older release refuses to start on a schema a
newer release migrated and names the unknown migration. To go back, restore
the backup from step 2 and run the older release.

Installations created with 0.1.0 or 0.2.0 used earlier baselines and cannot be
upgraded; install 0.3.0 or later into new databases.

## Resetting a local development stack

Only reset a stack you have positively identified as disposable. This command
removes the Compose-managed Postgres, ClickHouse, Redis, and MinIO volumes,
including traces, projects, credentials, and raw events:

```sh
docker compose down -v
docker compose up -d --build
```

## Baseline history

Before 0.3.0, schema changes were folded into `0001_baseline` instead of added
as new files, and no database was upgraded in place. Every merged PR that
introduced or changed a schema was reviewed into that baseline; upgrade-only
steps were removed because no pre-0.3.0 database is upgraded.

| PR | Schema contribution now in the baseline | Upgrade-only behavior removed |
|---|---|---|
| #2 — M0-02: db/clickhouse migration runners, live health checks, CI | organizations, projects, trace/observation/score storage | historical migration identity; original unscoped `api_keys` table |
| #14 — M5-02: LangFuse historical importer | import checkpoints | none; checkpoints are current runtime state |
| #16 — M6-01: scheduled export engine | export configurations | layered table creation |
| #17 — M6-02: OTLP forwarding | forward rules | layered table creation |
| #18 — M6-03: webhooks | webhook rules and deliveries | nullable pre-version delivery compatibility |
| #21 — M7-03: rate limiting, quotas, retention | project quota columns | `ALTER TABLE` upgrade step |
| #29 — M6-05: scheduler wiring | scheduling columns and due indexes | scheduling backfill/default upgrade steps |
| #31 — M5-07: import source credentials | import sources | layered table creation |
| #32 — Replay R-01: raw-event-log lookup | exact raw-object references | pre-index coverage table and bounded day-prefix fallback |
| #35 — M9-03: dead-letter visibility | ingest failure diagnostics | layered table creation |
| #41 — M9-09: media/attachments | media asset references | layered table creation |
| #46 — Define trace finalization semantics | quiet-period setting and non-null webhook trace versions | nullable legacy delivery rows and their runtime suppression guard |
| #58 — Prepare raw retention intents safely | retention intents, raw-ref tombstones, retention evidence | historical migration layer only; current safety gates remain |
| #67 — Add owner bootstrap, recovery, and browser sessions | owner principals, challenges, sessions, audit events | adopting or disambiguating organizations created before owner auth |
| #70 — Add scoped machine credentials and Connections UX | scoped `ironside_sc_` credentials | `ironside_sk_` backfill, dual cache namespaces, mixed-version replica handling, browser-key cleanup |
| #71 — Add observed environments and project trace filtering | environment projection and rebuild state | existing-project backfill and mixed-version project trigger; current project creation initializes state explicitly |

Changes after 0.3.0 are separate migrations:

| Migration | Change |
|---|---|
| Postgres `0002_project_model_prices` | Project model-price overrides for derived cost (spec/cost-pricing-v1.md) |
| Postgres `0003_destination_feed_cursors` | Trace-feed positions for scheduled exports and OTLP forward rules (spec/scheduled-export-v1.md) |
| Postgres `0004_trace_score_feed_and_forward_status` | Score feed and score positions for exports; last-run status for OTLP forward rules (spec/scheduled-export-v1.md, spec/otlp-forwarding-v1.md) |
| Postgres `0005_langfuse_field_provenance` | When each LangFuse-compatible field was last sent, for order-independent merging (spec/langfuse-compat-v1.md) |

Protocol compatibility is a separate concern and is not removed by this policy.
Ironside still accepts supported OTLP and LangFuse wire shapes because those are
external integration contracts, not compatibility with an older Ironside
database.
