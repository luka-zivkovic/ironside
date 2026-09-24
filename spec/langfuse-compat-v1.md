# LangFuse Ingestion Compat v1

Status: implemented. Owner: `packages/shared/src/langfuse.ts`, `packages/mappers/src/langfuse.ts`, `apps/api/src/routes/langfuse.ts`, `apps/worker/src/processors/langfuse-merge.ts`, `packages/db/src/langfuse-field-provenance.ts`.

## Purpose

Accept the legacy LangFuse SDK's ingestion requests, so a team already instrumented with that SDK can send traces to Ironside by changing only its base URL and key. Historical LangFuse data is pulled separately by the importer (`spec/langfuse-importer-v1.md`).

## SDK generations

LangFuse ships two SDK generations that send data differently:

- The legacy `langfuse` npm package (v3.x, still published) batches events to `POST /api/public/ingestion` and is redirected with the `LANGFUSE_BASEURL` environment variable or the `baseUrl` option. This endpoint targets it.
- The current `@langfuse/*` packages (v4 and later) send OpenTelemetry spans to `/api/public/otel`, redirected through standard OTel exporter configuration. Those clients point their exporter at Ironside's OTLP endpoint, `POST /v1/otel/traces` (`spec/otlp-ingest-v1.md`), instead.

## Endpoint

`POST /api/public/ingestion`, the same path LangFuse uses, so a client with `LANGFUSE_BASEURL=<ironside-host>` and its existing `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` variables works without code changes. The wire format follows LangFuse's Fern API definition (`fern/apis/server/definition/ingestion.yml` in `github.com/langfuse/langfuse`) and the `langfuse-js` v3-stable source.

### Auth

LangFuse's SDK sends `Authorization: Basic base64(publicKey:secretKey)`. Ironside has no public/secret key pair, so the endpoint accepts either `Authorization: Bearer <credential>` or `Authorization: Basic base64(anything:<credential>)`. The secret-key slot carries an Ingest credential (`ironside_sc_...`, `ingest` capability) and the public-key slot is ignored; see `spec/scoped-machine-credentials-v1.md`. Requests count against the project's ingest rate limit.

### Request body

```json
{
  "batch": [
    { "id": "<event-id>", "timestamp": "<iso>", "type": "trace-create", "body": {...} }
  ],
  "metadata": { "sdk_name": "langfuse-js", "...": "..." }
}
```

- `batch` must be a non-empty array. Each item needs a string `id` and a supported `type`; `timestamp` is optional.
- `metadata` is accepted and ignored: it is SDK diagnostics, not data.
- `batch[].id` is the envelope id of the ingestion event. `batch[].body.id` is the trace, observation or score id, and is what upserts.
- A request that does not match this envelope (not JSON, no `batch`, an empty `batch`, an item without an `id`, an unsupported `type`) returns 400 `{ error: "invalid LangFuse ingestion payload", issues }`.

Supported `type` values and the native event each becomes:

| LangFuse type | Ironside type |
|---|---|
| `trace-create` | `trace-upsert` |
| `span-create`, `span-update` | `observation-upsert` (type: span) |
| `generation-create`, `generation-update` | `observation-upsert` (type: generation) |
| `event-create` | `observation-upsert` (type: event) |
| `score-create` | `score-upsert` |
| `observation-create`, `observation-update` (deprecated LangFuse alias) | `observation-upsert` (type: span) |
| `sdk-log` | ignored (diagnostic only, not trace data) |

### Field mapping

Body schemas accept `null` as well as omission for every optional field, because the SDK sends explicit `null` for fields it is not setting. Record ids follow the native identifier rules (trimmed, 1 to 512 UTF-8 bytes, no NUL).

- **Trace:** `id` (a ULID is generated when absent), `timestamp` (falls back to the event's `timestamp`, then to the processing time), `name`, `userId`, `sessionId`, `release`, `version`, `tags`, `metadata`, `input` and `output`. `environment` is normalized and registered for discovery as in `spec/environments-v1.md`, and an invalid value is dropped without failing the trace.
- **Observation:** requires `traceId`. `id` is generated when absent and `startTime` falls back like a trace timestamp. `level` arrives uppercase (`DEBUG`, `DEFAULT`, `WARNING`, `ERROR`) and is lowercased; it defaults to `default`. `parentObservationId`, `name`, `endTime`, `completionStartTime` (a streamed generation's first-token time), `statusMessage`, `model`, `modelParameters`, `input`, `output` and `costDetails` map directly.
- **Usage:** `usageDetails`, or `usage` when `usageDetails` is absent, in any of LangFuse's historical shapes: the legacy `{ input, output, total, unit }`, the OpenAI-shaped `{ promptTokens, completionTokens, totalTokens }`, or a plain map of numbers. Every finite, non-negative number is rounded to an integer (the column is an unsigned integer map, and one bad value would fail the whole insert), other values such as `unit` are ignored, and key names are canonicalized (`spec/usage-keys-v1.md`). An observation with usage and a model but no cost gets a derived cost (`spec/cost-pricing-v1.md`).
- **Score:** requires `traceId`, `name` and `value`. A numeric `value` is stored as `numeric` and a string as `categorical` with `stringValue`; `dataType`, if sent, must be `NUMERIC`, `CATEGORICAL` or `BOOLEAN` but does not change the stored type. `observationId` and `comment` map directly, `source` is `api`, and a missing `id` is generated. The score is stored with its batch's receive time as its timestamp.
- Metadata values that are not strings are JSON-stringified, as are `modelParameters` values that are not strings, numbers, booleans or `null`.

### Response

Once the envelope parses and the batch is persisted, the endpoint always returns 207 with `{ successes: [...], errors: [] }`, listing every batch item as a success with status 201. LangFuse's own endpoint returns 207 rather than a 4xx for per-event problems, and the SDK's response handling expects that shape.

Ironside does not validate events at the edge. The route persists the batch and returns, and mapping happens in the worker, as for native and OTLP ingest. An event that fails mapping (a malformed body, a missing `traceId`, a score without `value`, an invalid identifier) is logged and dead-lettered in `ingest_event_failures` under the inner event's `id` (`spec/dead-letters-v1.md`), and the rest of the batch is still written. The 207 body never reports these failures, so a client that relies on per-event errors in the response will not see them; this keeps the edge fast and the same across every ingest path.

## Storage path

Same as native and OTLP ingest: the whole request becomes one `langfuse-ingestion` event (`source: "langfuse"`) in an ingest batch, which is persisted to object storage, queued, and mapped into rows by the worker's LangFuse mapper (`spec/trace-envelope-v1.md`).

## Partial updates across requests

The SDK sends each record as a `*-create` followed by partial `*-update` events (and repeated partial `trace-create` events for trace updates), and it flushes on a timer. An update therefore routinely arrives in a later HTTP request than its create. Ironside rows are whole-row upserts (ReplacingMergeTree, highest `event_ts` wins), so the worker must not write an update's row as mapped: on its own it lacks name, model and input, and its start time or timestamp defaults to the update's event time.

- Within one request, events for the same `body.id` are merged before mapping: creates first, then updates, regardless of their position in the array; within each group a later array position wins. An explicit `null` never erases a value another event in the group supplied.
- The mapper reports which domain fields each row actually received (`MappedLangfuseRows.providedFields`). A defaulted trace `timestamp`, `tags` or `metadata`, an observation's `startTime`, `level` or `metadata`, and the `type` guessed for the untyped `observation-*` alias do not count as received.
- The worker merges each incoming row into the stored one field by field (`apps/worker/src/processors/langfuse-merge.ts`), in any processing order:
  - **Serialized per record.** Before reading the stored rows it takes Postgres advisory locks, from a dedicated lock pool, and holds them until the merged rows are written and their field times recorded. Each trace and observation id hashes into one of 64 lock buckets per project, so two batches for one record never merge concurrently, and a job holds at most 64 locks however large its batch: every held lock takes a slot in Postgres's shared lock table, and exhausting it fails queries server-wide.
  - **By recency.** `langfuse_field_provenance` (Postgres migration `0005`) records, per record, the receive time of the batch that last sent each field. A field both sides sent takes the later-received batch's value; a field only one side sent takes that side's value; a field neither sent keeps the stored placeholder. An update-only row's placeholder start time therefore gives way to the create's real one even when the create is processed later. A stored row with no recorded times (older data) counts its non-empty fields as sent at its stored version, except a row an earlier attempt of the same batch wrote before failing to record them: only the fields that batch sent count, not its placeholders. Field times not updated for 30 days are pruned after each retention pass, in batches.
  - **Same record only.** A stored observation is merged only when its trace id matches; an observation id reused under another trace is a different record.
  - **Moved rows are deleted.** The day of a trace's timestamp and of an observation's start time is part of its ClickHouse sort key. When a merge moves one to another day (a late create replacing a placeholder across midnight UTC), every stored row of the record under another day is written as a deletion with the merged row's version, after the merged row, so one row remains (`spec/trace-envelope-v1.md`, "Upsert semantics").
  - **Last write wins the tie.** A merged row whose stored version is newer than its batch is written with the stored version (`event_ts`, exact to the microsecond). ReplacingMergeTree keeps the most recently inserted row among equal versions, so the merged row wins, and the trace's latest activity, the settlement clock for evaluators and exports, does not move.
  - **Derived cost stays consistent.** A stored cost Ironside derived is dropped when the merge takes newer usage or a newer model, so it is derived again from the merged values; a client-sent cost is kept, and derived-cost labels carried over from stored metadata are removed from it.

## Verified

- `packages/mappers/test/langfuse.test.ts` covers the envelope schema, explicit `null` fields, identifier rules, the type table, environment/release/version normalization, the three usage shapes, usage rounding, level lowercasing, score type inference and the rejection of a score without `value`, `sdk-log`, the `observation-*` alias, per-event errors that leave the rest of the batch intact, create/update merging in either array order, and the received-field report.
- `apps/api/test/langfuse-compat.test.ts` covers 401 without auth, Bearer and Basic auth, a malformed Basic header, the 207 shape, 400 for a missing `batch`, and the batch being persisted and queued like native ingest.
- `apps/worker/test/langfuse-merge.test.ts` covers the recency rules, a retried batch's placeholders, the derived and client-sent cost rules, and time normalization.
- `packages/db/test/langfuse-merge-locks.test.ts` covers the lock bound for a 20,000-record batch, a batch for the same record waiting while another project's runs, and locks released after a failure.
- `apps/worker/test/ingest-processor.test.ts` covers dead-lettering a per-event mapping failure under the inner event id, a create and update arriving in separate requests, and the update's request processed before, or at the same time as, the create's, including across midnight UTC and after a retry that failed before recording field times.

## History

- M5-01 added the endpoint for the legacy SDK; current-SDK users were already covered by OTLP ingest (M3).
- A live run of the real SDK showed two wire details the first version missed: it sends explicit `null` for unset fields (a `parentObservationId: null` on a root generation failed the whole event), and one `generation.end()` call emitted `generation-update` before `generation-create` in the same batch, so mapping each event separately lost name, model and input. Nullable body schemas and the create-then-update merge fixed them.
- M9-03 added dead-lettering; before it, a failed event appeared only in worker logs. Its tests found that a score without `value` mapped to a row with both value columns empty; it is now a per-event error.
- M9-04 replaced the hand-written usage mapping, which dropped `total`/`totalTokens` from the legacy shape, with the shared key canonicalizer. Rounding and negative filtering were added to match the importers after review found that one fractional or negative value failed a whole ClickHouse insert.
- Postgres migration `0005` added `langfuse_field_provenance`, which makes the cross-request merge independent of the order in which batches are processed.
