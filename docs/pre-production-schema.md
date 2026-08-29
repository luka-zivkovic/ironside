# Database schema lifecycle

Ironside used a disposable pre-production schema until the first persistent
external installation was deployed on **2026-08-28**. That event froze the
final-state Postgres and ClickHouse baselines:

- `packages/db/migrations/0001_baseline.sql`
- `packages/clickhouse/migrations/0001_baseline.sql`

The accepted bytes are identified by these SHA-256 digests:

- Postgres: `54309d8feec00b2eabaf677c3fcb4acac8047a477151bc7b37c23fe1c5ce8d86`
- ClickHouse: `47aa8eead3f96a6669dae8f123330ea881f08011aa5efc7d01344ff443167a80`

Those files are immutable. Every later schema change adds a new ordered SQL
file, an upgrade test starting from the previously released schema, and release
notes covering compatibility, deployment order, and recovery. Both migration
runners store and verify every applied checksum. Changed, missing, or
incompatible history fails closed with guidance to restore a compatible image;
runtime code never tells an operator to erase persistent data.

Downgrade is supported only when the release notes say that no data migration
ran. After a forward migration, recovery is either a tested forward fix or a
restore of all affected stores followed by the previous application version.
Rollback SQL is not assumed to be safe.

The original `0001` baselines intentionally remain capable of creating a fresh
installation in one step; their historical composition is recorded below.

## Disposable local reset

Developers may reset a stack only when they have positively identified it as
disposable. This command removes Compose-managed Postgres, ClickHouse, Redis,
and MinIO volumes, including traces, projects, credentials, and raw events:

```sh
docker compose down -v
docker compose up -d --build
```

Never use this command to update or repair an installation. Restore or migrate
persistent data as described in `docs/self-hosting.md` and `docs/coolify.md`.

## Schema PR audit

Every merged PR that introduced or changed an Ironside schema before the freeze
was reviewed for the final baseline. Runtime behavior remains represented
directly in the baselines; development-only upgrade behavior was removed.

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

Protocol compatibility is a separate concern and is not removed by this policy.
Ironside still accepts supported OTLP and LangFuse wire shapes because those are
external integration contracts, not compatibility with an older Ironside
database.
