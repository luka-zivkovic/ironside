# Pre-production schema policy

Ironside has no production installations or data-compatibility promise yet. The
repository therefore carries one final-state Postgres baseline and one
final-state ClickHouse baseline instead of an upgrade path through every schema
the project used during development:

- `packages/db/migrations/0001_baseline.sql`
- `packages/clickhouse/migrations/0001_baseline.sql`

Schema changes edit those files in place. Each migration ledger stores the
baseline SHA-256 checksum. A changed checksum or an obsolete migration id makes
startup fail with a reset instruction; application code never tries to upgrade
or reinterpret an older local schema.

This is a temporary pre-production rule. Before anyone relies on a deployed
Ironside database, freeze the then-current baselines and switch to append-only,
forward migrations with an explicit compatibility and rollback policy.

## Resetting the checked-in local stack

The reset is intentionally destructive: it removes the Compose-managed
Postgres, ClickHouse, and MinIO volumes, including all local traces, projects,
credentials, and raw events.

```sh
docker compose down -v
docker compose up -d --build
```

Then generate a fresh owner setup capability and create the first project as
described in `docs/self-hosting.md`. External Postgres, ClickHouse, or object
storage must be cleared with that provider's own tooling; do not point a newer
pre-production build at an older database.

## Schema PR audit

Every merged PR that introduced or changed an Ironside schema was reviewed for
this reset. Runtime behavior remains represented directly in the baselines;
upgrade-only behavior was removed.

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
