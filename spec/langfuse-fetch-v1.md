# LangFuse-Shaped Fetch API v1

Status: implemented. Owner: `apps/api/src/routes/langfuse-fetch.ts` (reads), `apps/api/src/routes/langfuse.ts` (`POST /api/public/scores`), `packages/clickhouse/src/queries.ts` (`listTracePage`, `getTrace`, `listObservationsForTrace`, `listScoresForTrace`).

## Purpose

Serve LangFuse's public trace-read endpoints and its score-create endpoint, so a tool that reads traces from LangFuse and writes scores back, such as Rubrist, can use Ironside by changing only its host and key. Ironside's own LangFuse importer can read from these endpoints too. New evaluator integrations should prefer the native protocol in `spec/evaluator-integration-v1.md`.

## Authentication

- The project comes from the machine credential; no route accepts a project id.
- The credential is sent as `Authorization: Bearer <credential>` or, as LangFuse clients do, `Authorization: Basic base64(publicKey:secretKey)` with the Ironside credential in the secret-key slot. The public-key slot is ignored.
- `GET /api/public/traces` and `GET /api/public/traces/{id}` require `traces:read` (the Integration preset) and are not rate limited, like the native read routes.
- `POST /api/public/scores` requires `scores:write` and shares the ingest rate limit.
- A missing or invalid credential returns 401; a credential without the capability returns 403.

## `GET /api/public/traces`

LangFuse's list endpoint.

- Query parameters:
  - `page`: 1-based, at most 1,000,000,000, default 1. The cap keeps the offset far inside safe integer range.
  - `limit`: 1 to 100, default 50.
  - `userId`, `sessionId`, `environment`: exact-match filters.
  - `fromTimestamp`, `toTimestamp`: ISO 8601 with an offset; inclusive bounds on the trace timestamp.
  - `orderBy`: `timestamp.asc` or `timestamp.desc`, default `timestamp.desc` as in LangFuse. Rows sort by timestamp, then id. Ironside's own importer requests `timestamp.asc`.
- An invalid parameter returns 400 `{ error: "invalid query", issues }`.
- The response is LangFuse's envelope, `{ data: Trace[], meta: { page, limit, totalItems, totalPages } }`, with `totalPages = ceil(totalItems / limit)`. List items carry trace fields and payloads, not observations or scores.
- Only settled traces are listed, using the project's effective quiet period (`spec/trace-envelope-v1.md`), so a consumer never judges a half-written trace. A score posted back does not reopen the trace.
- Page/offset pagination is unstable under concurrent inserts: a page boundary can move between two requests. That comes with LangFuse's page-number contract; the native `/traces` routes use keyset cursors instead.

## `GET /api/public/traces/{id}`

LangFuse's detail endpoint: the trace fields plus `observations[]` and `scores[]` as flat lists (not a tree), each oldest first. A trace that is not settled (still being written, or reopened by a later write) returns 404 `{ error: "trace not found" }` until it settles again, as does an unknown id or another project's trace.

## Response fields

- Observation `type` and `level`, and score `dataType` and `source`, are uppercase (`GENERATION`, `DEFAULT`, `NUMERIC`, `API`), as on LangFuse's wire. Ironside's importer lowercases them again.
- A trace item always has `id`, `timestamp`, `tags` and `metadata`; `name`, `userId`, `sessionId`, `environment`, `release`, `version`, `input` and `output` appear only when set.
- An observation item always has `id`, `traceId`, `type`, `startTime`, `level`, `modelParameters`, `usageDetails`, `costDetails` and `metadata`; `parentObservationId`, `name`, `endTime`, `completionStartTime`, `statusMessage`, `model`, `input` and `output` appear only when set.
- A score item always has `id`, `traceId`, `name`, `dataType`, `source`, `timestamp` and `metadata`; `observationId`, `value`, `stringValue` and `comment` appear only when set.
- An unset optional field omits the key instead of sending `null`. Rubrist's LangFuse schema types optional fields as optional but not nullable, so an explicit `null` fails its validation and errors the whole poll; Ironside's importer accepts either form.
- An input or output recorded as JSON `null` (stored as the text `"null"`, distinct from SQL NULL) is returned as `null`; one never recorded is omitted.

## `POST /api/public/scores`

LangFuse's score-create endpoint, which Rubrist uses to write verdicts back.

- Body: `id?`, `traceId`, `observationId?`, `name` (non-empty), `value` (a number or a non-empty string; required), `comment?`, `dataType?`, `metadata?`. Identifiers follow the native identifier rules. Other fields are ignored. An invalid body returns 400 `{ error: "invalid score payload", issues }`.
- A numeric `value` becomes a `numeric` score, or `boolean` when `dataType` is `BOOLEAN` (any case). A string `value` becomes a `categorical` score with `stringValue`, even when `dataType` says `BOOLEAN`. `source` is always `api`. Metadata values that are not strings are JSON-stringified. The score's `timestamp` is the receive time, and a missing `id` is generated.
- The route wraps the score as one native `score-upsert` event in an ingest batch and persists and queues it like native ingest; the worker writes it like any native score. It returns 200 `{ id }` once the batch is queued.
- There is no 409 for a repeated id; Rubrist treats any 2xx as success. A replay with the same id replaces the earlier score, and its receive time becomes the score's timestamp, also when it arrives on a later UTC day (`spec/trace-envelope-v1.md`, "Upsert semantics").

## Out of scope

LangFuse read endpoints beyond these (sessions, observation listing, daily metrics and so on) are not served; no current consumer needs them.

## Verified

`apps/api/test/langfuse-fetch.test.ts` covers, for the list: 401 without a key, `{ data, meta }` newest first by default with full payloads, `orderBy=timestamp.asc`, page/limit with the right `totalPages`, the `userId` and `fromTimestamp` filters, project isolation, 400 for an invalid `orderBy`, a newly active trace hidden until the quiet period has passed, and omission of unset fields. For the detail: the trace with its observations and scores in LangFuse casing, and 404 for an unknown id and for another project's trace. For scores: a Rubrist-shaped verdict enqueued as a valid `score-upsert`, a string value becoming `categorical`, `BOOLEAN` honored for a numeric value and ignored for a string, a generated id, and 400 when `value` is missing.

## History

- M8-01 added the read endpoints and `POST /api/public/scores` so Rubrist could use Ironside as a LangFuse-shaped trace source with no Rubrist code changes. The first live connection test failed on explicit `null` fields, which led to the omission rule above.
- The M8-01 end-to-end check ran a real local Rubrist instance (recorded at the time as coeval) with a mock judge against a live Ironside stack: its connection test passed, an import turned two seeded traces into cases, both verdicts arrived as score rows with full metadata and were readable through the detail endpoint, and a second import created no duplicate cases. At the time, Rubrist's LangFuse mapper read only trace-level input, output and metadata, not the observation trees this endpoint serves.
- The same work made the native trace detail read (`GET /traces/:id`) return fields that were stored but never selected: observation `modelParameters` and `completionStartTime`, and trace `environment`, `release` and `version`.
- A `POST /api/public/scores` replay that arrived on a later UTC day than the original used to store a second score row, because the score's day is part of its ClickHouse sort key. The ingest worker now deletes the earlier row.
