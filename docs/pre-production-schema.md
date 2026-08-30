# Database schema lifecycle

Ironside currently supports clean installations only. Founder-only deployments
are disposable test instances, so the complete current schemas live in:

- `packages/db/migrations/0001_baseline.sql`
- `packages/clickhouse/migrations/0001_baseline.sql`

Each migration runner stores and verifies the current baseline checksum and
rejects any other ledger. There is no supported in-place schema upgrade during
this pre-launch period; recreate disposable instances when a baseline changes.
Runtime crash recovery and data-integrity invariants still apply to every
instance after it starts serving work.

## Disposable local reset

Developers may reset a stack only when they have positively identified it as
disposable. This command removes Compose-managed Postgres, ClickHouse, Redis,
and MinIO volumes, including traces, projects, credentials, and raw events:

```sh
docker compose down -v
docker compose up -d --build
```

Use this only for the founder-owned disposable instances covered by the current
clean-install support boundary.

## Schema PR audit

Every merged PR that introduced or changed an Ironside schema was reviewed for
the current baseline. Runtime behavior remains represented directly in the
baselines; development-only upgrade behavior is removed.

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
