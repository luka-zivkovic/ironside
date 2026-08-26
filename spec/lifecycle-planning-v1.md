# Lifecycle planning v1

Status: implemented, read-only.

## Purpose

Ironside stores one trace across several physical systems. A retention promise
cannot be inferred from ClickHouse alone, and a generic bucket-age rule can
delete evidence that is still referenced. This contract adds an operator-run,
bounded inventory before any new destructive lifecycle executor exists.

Run the compiled planner in the self-hosted stack:

```sh
docker compose exec worker node apps/worker/dist/src/scripts/lifecycle-plan.js
```

The command prints one JSON document. It never mutates Postgres, ClickHouse,
Redis, or object storage; `mode` is `dry-run` and
`destructiveActionsEnabled` is always `false`.

## Clocks and classification

- Each project uses `project.retention_days ?? DEFAULT_RETENTION_DAYS`.
- ClickHouse domain candidates use the tables' existing event clocks:
  `traces.timestamp`, `observations.start_time`, and `scores.timestamp`.
- Raw references use `raw_event_refs.received_at`.
- Raw objects use the API acceptance day encoded by the canonical
  `raw/{project}/{yyyy}/{mm}/{dd}/{batch}.json` key. Only complete UTC days
  strictly before the cutoff day are candidates, providing a full-day safety
  margin. Client event timestamps and S3 `LastModified` do not decide raw
  expiry.
- Append-only raw coverage/retention rows are neither scanned nor classified.
  Counting the entire unpartitioned evidence tables would make a planning
  command itself an avoidable scalability risk. Honest `retention_expired`
  read semantics now exist, but preparation is a separate exact-key command.
- Exact ClickHouse counts use a recent-date prefilter plus conservative
  30-second, 2-thread, 512 MiB, and 50-million-row query limits. A limit or
  availability failure is reported as an incomplete count with `null` values,
  never as zero.

## Safety boundaries

- A matching `pending-ingest/*` intent puts an expired raw batch under
  `protectedByPending`, never `expiredWithoutPendingMarker`. Reserved
  `pending-ingest/.internal/*` bookkeeping is excluded from intent counts but
  remains untouched.
- `LIFECYCLE_PLAN_SCAN_LIMIT` (default 100,000) separately caps the pending
  and failed prefixes and is one shared budget across every included project's
  raw prefix. Iterators are exhausted within that budget; no backend ordering
  guarantee is assumed. An incomplete scan remains visibly incomplete.
- Unscoped runs include at most `LIFECYCLE_PLAN_PROJECT_LIMIT` projects
  (default 1,000) and report whether the registered-project list was fully
  represented. `LIFECYCLE_PLAN_PROJECT_ID` selects one exact project when a
  large installation needs a complete scoped view. Unscoped Postgres reads
  fetch only `limit + 1` rows; exact selection uses one primary-key lookup.
  `registeredProjectCount` is `null` when the global total was deliberately
  not scanned (a capped or exact-project run).
- Non-canonical raw keys are not included in the expired-object classification.
- `expiredWithoutPendingMarker` is only a factual snapshot; it is not deletion
  eligibility. Terminal diagnostics and ClickHouse refs are reported
  separately. `rawArchive.deletionEligible` is always false.
- Media is registration inventory only. `registeredAssetCount` and
  `registeredSizeBytes` come from Postgres metadata; content-addressed assets
  can be reused by newer traces, and v1 has no authoritative trace-to-media
  reference ledger. Upload age cannot prove reachability.
- Orphan raw objects for deleted/unregistered projects, orphan media objects
  left before a Postgres insert, and missing registered media objects are not
  reconciled. They are explicit unknowns, not implied zeros.
- Object-store versions, backups, exports, and Object Lock/WORM copies are
  outside the manifest. Logical ClickHouse counts do not claim immediate
  physical byte reclamation.

## Output

The manifest includes:

- the generation time, project/raw scan caps, represented-project status, and
  effective per-project cutoff;
- bounded query-visible domain-row candidates and raw-reference candidates, or
  an explicit incomplete result;
- raw candidate objects/bytes, pending-protected objects/bytes, scan
  completeness, batches without pending markers, and batches with terminal
  failure diagnostics;
- registered media rows/declared bytes, pending intents, and terminal failure
  diagnostics;
- explicit exclusions and blocked reasons.

Counts are a planning snapshot. Concurrent ingest may add work immediately
after it is generated, so a future executor must repeat all safety checks at
delete time rather than execute this manifest as a deletion list.

## Follow-up preparation batch

`spec/raw-retention-intents-v1.md` adds sticky `retention_expired` read
semantics and a separately supplied, exact-project, capped intent-preparation
command. It does not execute this manifest and cannot delete. The destructive
executor remains a later, separately reviewed batch. Media GC remains deferred
until references are authoritative, including a deliberate legacy-data
migration policy.
