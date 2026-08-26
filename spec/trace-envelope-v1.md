# Trace Envelope v1

Status: draft (M0). Owner: `@ironside/shared` (`packages/shared/src/envelope.ts`).

## Purpose

Every ingest path — native JSON, OTLP, LangFuse-compat, importers — converges on **one raw event envelope**. The API validates only the envelope, persists the batch to object storage verbatim, and queues a reference. Workers map source-shaped bodies into the domain model. This makes compat layers thin adapters and every event replayable when mappers change.

## IngestEvent

```ts
{
  id: string,               // ULID, generated at the edge (API) if absent
  type: "trace-upsert" | "observation-upsert" | "score-upsert",
  source: "native" | "otlp" | "langfuse" | "import-langfuse" | "import-langsmith",
  schemaVersion: 1,
  idempotencyKey: string,   // client-provided or SHA-256 content hash of body
  body: unknown             // source-shaped payload; worker mapper owns interpretation
}
```

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
- Queue message: `{ batchId, projectId, objectKey, eventCount }` — payloads never enter Redis (LangFuse v3 lesson).

## Domain model (worker output → ClickHouse)

**Trace**: `id, projectId, timestamp, name?, userId?, sessionId?, environment?, release?, version?, tags: string[], metadata: Record<string,string>, input?, output?` (input/output JSON-serialized; large payloads offloaded to object storage by reference — threshold decided in M1).

`environment` follows the single normalization/filter/discovery contract in
`spec/environments-v1.md`; it is never a project or policy boundary.

**Observation**: `id, traceId, projectId, parentObservationId?, type: "span"|"generation"|"event", name?, startTime, endTime?, level?: "debug"|"default"|"warning"|"error", statusMessage?, model?, modelParameters?: Record<string, string|number|boolean|null>, input?, output?, usageDetails?: Record<string, number>, costDetails?: Record<string, number>, completionStartTime?, metadata`.

**Score**: `id, projectId, traceId, observationId?, name, dataType: "numeric"|"categorical"|"boolean", value?: number, stringValue?, source: "api"|"eval"|"annotation", comment?, metadata`.

Rules:
- Upsert semantics: same id twice = update (ClickHouse ReplacingMergeTree handles dedup by event timestamp).
- Usage/cost unavailable = **null/absent, never zero** (coeval convention).
- Arbitrary metadata values are stringified for the CH Map column; original preserved in the raw envelope.
- Trace tree must flatten to coeval's `TraceStep[] { name?, input, output, metadata? }` via depth-first ordered observations.

## Trace completion contract (normative)

Ironside uses a **quiet-period watermark** rather than a source-specific finalize event. A trace is settled when its latest successful `trace-upsert` or `observation-upsert` receipt timestamp is at least `N` seconds old. `N` defaults to 300 seconds (`DEFAULT_TRACE_QUIET_PERIOD_SECONDS`) and may be overridden per project with `traceQuietPeriodSeconds`.

- `receivedAt`/the derived ClickHouse `event_ts` is the activity clock. It is server-generated and deterministic for a batch, so retrying the same batch does not move the watermark.
- Score writes do **not** reopen a trace. Scores are downstream annotations; treating a judge's own verdict as source activity would create an evaluation feedback loop.
- Any genuinely later trace or observation write reopens a previously settled trace. After another quiet period it becomes a new settled version, identified by its latest activity timestamp.
- Automated exports, OTLP forwards, webhooks, and LangFuse-compatible fetches consume settled traces only. Webhooks are exactly-once per `(rule, trace, settled version)`, so a late write produces one new notification after re-settling.
- Native list/detail/aggregate routes intentionally remain live views and may include in-flight traces; operators need to see active work while debugging.

This contract applies uniformly to native SDK/JSON, OTLP, LangFuse compatibility, and import sources. An explicit SDK `trace.end()` may be added later as a latency optimization, but correctness must never depend on a source being able to emit it.
