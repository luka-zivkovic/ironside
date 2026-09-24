# Trace Envelope v1

Status: implemented. Owner: `@ironside/shared` (`packages/shared/src/envelope.ts`, `packages/shared/src/domain.ts`).

## Purpose

Every ingest path — native JSON, OTLP, LangFuse-compat, importers — converges on **one raw event envelope**. The API validates only the envelope, persists the batch to object storage verbatim, and queues a reference. Workers map source-shaped bodies into the domain model. This makes compat layers thin adapters and every event replayable when mappers change.

## IngestEvent

```ts
{
  id: string,               // ULID, generated at the edge (API) if absent
  type: "trace-upsert" | "observation-upsert" | "score-upsert"
      | "otlp-export" | "langfuse-ingestion",
  source: "native" | "otlp" | "langfuse" | "import-langfuse" | "import-langsmith",
  schemaVersion: 1,
  idempotencyKey: string,   // the client's key, or the event id when it sent none (one exception below)
  body: unknown             // source-shaped payload; worker mapper owns interpretation
}
```

`otlp-export` carries a raw OTLP `ExportTraceServiceRequest` and
`langfuse-ingestion` a raw LangFuse ingestion batch; the worker's OTLP and
LangFuse mappers explode each into many domain rows.

`idempotencyKey` is a correlation value, not a deduplication key: nothing reads
it after storage. Resending an event is safe because rows upsert by their own
ids (see "Upsert semantics" below). It is always present, because releases up
to 0.3.0 reject a stored batch without it. The score event of
`POST /api/v1/evaluator/scores` carries the SHA-256 fingerprint of the
canonical request instead.

## IngestBatch (unit of storage + queueing)

```ts
{
  batchId: string,          // ULID, API-generated
  projectId: string,        // resolved from machine credential, never client-trusted
  receivedAt: string,       // ISO 8601, API clock
  events: IngestEvent[]     // 1..500
}
```

- Object storage key: `raw/{projectId}/{yyyy}/{mm}/{dd}/{batchId}.json`
- Queue message: `{ batchId, projectId, objectKey, eventCount, intentCreatedAt? }` — payloads never enter Redis (LangFuse v3 lesson). `intentCreatedAt` is the API acceptance time used by ingest recovery (`spec/ingest-recovery-v1.md`).

## Domain model (worker output → ClickHouse)

**Trace**: `id, projectId, timestamp, name?, userId?, sessionId?, environment?, release?, version?, tags: string[], metadata: Record<string,string>, input?, output?` (input/output JSON-serialized and stored inline; there is no size-based offload. Binary media is uploaded separately and referenced as `ironside://media/<id>`, per `spec/media-v1.md`).

`environment` follows the single normalization/filter/discovery contract in
`spec/environments-v1.md`; it is never a project or policy boundary.

**Observation**: `id, traceId, projectId, parentObservationId?, type: "span"|"generation"|"event", name?, startTime, endTime?, level?: "debug"|"default"|"warning"|"error", statusMessage?, model?, modelParameters?: Record<string, string|number|boolean|null>, input?, output?, usageDetails?: Record<string, number>, costDetails?: Record<string, number>, completionStartTime?, metadata`.

**Score**: `id, projectId, traceId, observationId?, name, dataType: "numeric"|"categorical"|"boolean", value?: number, stringValue?, source: "api"|"eval"|"annotation", comment?, timestamp?, metadata` (at least one of `value` and `stringValue`).

Rules:
- Upsert semantics: same id twice = update (ClickHouse ReplacingMergeTree handles dedup by event timestamp). A record is a trace by id, or an observation or score by trace id and id.
  - The day of a trace's or score's timestamp, and of an observation's start time, is part of its ClickHouse sort key, and ReplacingMergeTree replaces a row only under the same key. So before writing a batch, the ingest worker (`apps/worker/src/processors/moved-rows.ts`):
    - keeps a record's last row when the batch holds it more than once, as a single key would;
    - looks up each record's stored rows, in queries split to stay under ClickHouse's HTTP parameter limit;
    - when no stored row is newer than the batch, writes the batch's row and deletes the stored rows under other days;
    - when a stored row is newer, leaves the batch's row out as stale and deletes the stored rows older than the batch.

    Deletions carry the batch's version, are written before the batch's rows, and never share a key with them. LangFuse-compatible rows are merged field by field and handle a move the same way (`spec/langfuse-compat-v1.md`); imports delete every earlier row of a trace they rewrite.
  - Two batches writing the same record on different days at the same moment can both be written; the record's next write removes the extra row.
  - A score without a `timestamp` takes its batch's receive time, so a retried batch writes it under the same key.
- Usage/cost unavailable = **null/absent, never zero** (rubrist convention).
- Arbitrary metadata values are stringified for the CH Map column; original preserved in the raw envelope.
- Trace tree must flatten to rubrist's `TraceStep[] { name?, input, output, metadata? }` via depth-first ordered observations.

## Trace completion contract (normative)

Ironside uses a **quiet-period watermark** rather than a source-specific finalize event. A trace is settled when the receipt timestamp of its latest successful trace or observation write, from any event type, is at least `N` seconds old. `N` defaults to 300 seconds (`DEFAULT_TRACE_QUIET_PERIOD_SECONDS`) and may be overridden per project with `traceQuietPeriodSeconds`.

- `receivedAt`/the derived ClickHouse `event_ts` is the activity clock. It is server-generated and deterministic for a batch, so retrying the same batch does not move the watermark.
- Score writes do **not** reopen a trace. Scores are downstream annotations; treating a judge's own verdict as source activity would create an evaluation feedback loop.
- Any genuinely later trace or observation write reopens a previously settled trace. After another quiet period it becomes a new settled version. A version is the trace's feed version (`traceVersion`), assigned when the worker publishes the write to the durable trace feed (`spec/evaluator-integration-v1.md`), not its latest activity timestamp; a batch written late with an older receive time therefore still produces a new version.
- Automated exports, OTLP forwards, webhooks, and LangFuse-compatible fetches consume settled traces only; exports, OTLP forwards, and webhooks read them from the durable trace feed. Webhooks are exactly-once per `(rule, trace, version)` with that feed version (`spec/webhooks-v1.md`), so a late write produces one new notification after re-settling.
- Native list/detail/aggregate routes intentionally remain live views and may include in-flight traces; operators need to see active work while debugging.

This contract applies uniformly to native SDK/JSON, OTLP, LangFuse compatibility, and import sources. An explicit SDK `trace.end()` may be added later as a latency optimization, but correctness must never depend on a source being able to emit it.

## History

- Drafted in M0 as the single ingest envelope. The draft planned to offload large input/output payloads above a threshold to be set in M1; instead, media is uploaded separately (`spec/media-v1.md`).
- Through 0.3.0 the API filled an absent `idempotencyKey` with a SHA-256 hash of the body; it now uses the event id, which costs nothing.
- Settled versions were first identified by the trace's latest activity timestamp; they are now the trace's feed version (`spec/webhooks-v1.md`).
