# Raw retention intents v1

Status: implemented; preparation is non-destructive and execution is explicit,
bounded, feature-disabled by default, and never scheduled.

## Product boundary

Ironside is a storage layer and trace viewer. This slice adds the minimum
control-plane contract needed to shorten raw history honestly; it does not add
analytics, automatic discovery, a scheduler, or media garbage collection.

`raw_event_trace_retention` is append-only evidence that at least one raw
object for a project+trace identity was deliberately expired. Raw-event reads
expose this independently as `retentionExpired: true`; when no higher-priority
scan cap applies, `truncationReason` is `retention_expired`. Fully expired
indexed history is a successful empty 200, not a misleading generic 404. The
marker stays true if the same trace id is later reused, including by an
importer. The marker is sufficient endpoint evidence after the final
query-visible trace row and raw ref are gone.

## Preparing work

The operator supplies one exact project and an explicit JSON array of canonical
raw object keys:

```sh
docker compose exec \
  -e RAW_RETENTION_PROJECT_ID=proj_example \
  -e 'RAW_RETENTION_OBJECT_KEYS_JSON=["raw/proj_example/2025/01/01/batch.json"]' \
  worker node apps/worker/dist/src/scripts/raw-retention-intents.js
```

This input is deliberately separate from the Batch 2A lifecycle manifest. The
manifest is inventory, never an executable deletion list. Preparation writes
metadata-only rows to Postgres and returns
`destructiveActionsEnabled: false`; it has no deletion path.

One invocation is capped at 100 unique objects, 1 GiB of exact HEAD-reported
raw-object bytes, 10,000 aggregate raw trace refs, and 1 MiB of conservatively
serialized trace ids. Each failed sidecar is HEAD-checked and capped at 64 KiB
again on GET. Postgres diagnostics are read newest-first through a covering
index with a 1,000-row per-object and 10,000-row aggregate budget. The
preparer rejects or skips any object unless all of the following hold:

- the key is canonical, belongs to the exact project, exists, and names a full
  UTC day strictly before the project's current retention cutoff;
- the exact pending-ingest marker is absent;
- BullMQ has no job or a completed job, with applied refs; alternatively, a
  missing/failed job has a valid terminal-failure sidecar whose project, batch,
  and raw key all match and whose failure time is also outside retention;
- the ref query completes inside fixed ClickHouse read limits; applied work has
  at least one ref, no pending ref, and no unknown ref state;
- every referenced trace has zero query-visible rows across traces,
  observations, and scores using one aggregate `FINAL` query with fixed
  timeout, thread, memory, and rows-read limits;
- any Postgres event-failure diagnostic for the object is itself outside the
  retention window.

Ref-less objects are ambiguous and always skipped; a terminal-failure sidecar
alone is not durable proof that a missing raw object was deliberately deleted.
Dependency failures abort rather than being converted into permission.
Object-key uniqueness makes repeated preparation idempotent without rewriting
an older captured cutoff or trace set.

## Durable intent

`raw_retention_intents` retains the preparation id, project, ingest batch,
exact object key and byte size, captured cutoff/policy, affected trace ids,
classification, diagnostic count, state, attempts, and a bounded future error
slot. Project deletion does not cascade away this audit record.

## Executing reviewed intents

Execution accepts no object scan, lifecycle manifest, or implicit prepared
queue. The operator must name one exact project and 1–10 exact intent ids, set
the normally-false feature flag, and pass the separate script's `--execute`
argument:

```sh
# First recreate every worker replica with the guard enabled.
RAW_RETENTION_EXECUTION_ENABLED=true docker compose up -d --force-recreate worker

docker compose exec \
  -e RAW_RETENTION_EXECUTION_ENABLED=true \
  -e RAW_RETENTION_PROJECT_ID=proj_example \
  -e 'RAW_RETENTION_INTENT_IDS_JSON=["rti_example"]' \
  worker node apps/worker/dist/src/scripts/raw-retention-execute.js --execute
```

All API and worker replicas must be upgraded before enabling execution. Every
worker must receive `RAW_RETENTION_EXECUTION_ENABLED=true` so its ingest
processor participates in the per-object advisory-lock/tombstone guard. Keep
the flag false during ordinary operation; in that state ingestion performs no
extra Postgres coordination. The coordination flag does not require ordinary
worker replicas to receive raw-delete credentials.

Run the explicit executor command with a short-lived execution role/window.
That role needs the ordinary pending/failed sidecar contract plus
`PutObject`/`HeadObject`/`DeleteObject` on each reviewed target day's
`raw/{project}/{yyyy}/{mm}/{dd}/.retention-probes/*` prefix and `DeleteObject`
on the exact reviewed canonical raw objects. For every raw-present intent, the
executor exercises the target-day probe and the pending/failed sidecar
contract before claiming the intent. It never uses a global probe as evidence
of target-prefix access. A post-delete retry skips destructive permission
probes and converges only from the already-written durable tombstones.

One Postgres advisory lock serializes executor commands across replicas. Each
intent then holds the same per-object advisory lock used by enabled ingest
workers and rechecks the current project policy, canonical key, object size,
pending marker, BullMQ terminal state/classification, bounded sidecar,
bounded Postgres diagnostics, exact raw refs, and zero query-visible domain
rows. Policy changes or new activity veto deletion.

After those checks, the intent enters `executing` and becomes an ingest
tombstone. The irreversible order is:

1. write only missing append-only trace retention markers and verify them;
2. write `applied = 2` ref tombstones using each ref's original `received_at`,
   skipping refs already at state 2, then verify them through `FINAL` (versions
   0/1 from delayed retries cannot resurrect a version 2 ref);
3. delete the exact object's diagnostics through a locked, 1,000-row-capped
   Postgres set and delete/verify its bounded terminal-failure sidecar;
4. recheck the pending marker and queue state;
5. delete the raw object last, HEAD-verify absence, and mark the intent
   `complete`.

Every step is idempotent without physically amplifying marker/ref rows on
retry. A failure before the claim leaves the intent
`prepared`; a failure after the claim leaves it `executing` with a bounded
error. Re-running the same explicit command resumes the markers, ref
tombstones, diagnostic cleanup, and missing-object completion. An absent raw
object is accepted only for an already-`executing` intent with a non-empty
captured trace set whose exact ref tombstones and trace markers are both
verifiably complete. Mutable policy, project, queue, and diagnostic state no
longer veto that post-delete convergence. This distinguishes a crash after the
last delete from unexplained external data loss.

## Explicitly deferred

- scheduled or all-project candidate discovery and automatic intent execution;
- strict compliance TTL for raw batches that still support visible traces;
- media cleanup, orphan/deleted-project cleanup, object versions, backups,
  WORM/Object Lock, and physical compaction of marker tables;
- replay of executing/complete objects (enabled ingest workers terminally
  no-op delayed/recovered jobs instead of resurrecting derived rows).
