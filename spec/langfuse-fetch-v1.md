# LangFuse-Shaped Fetch API + Score Ingest (M8-01)

Status: implemented, verified end-to-end against a real local coeval instance. Owner: `apps/api/src/routes/langfuse-fetch.ts` (reads), `apps/api/src/routes/langfuse.ts` (`POST /public/scores`), `packages/clickhouse/src/queries.ts` (`listTracePage`, `listScoresForTrace`).

## Purpose

M8: coeval (github.com/luka-zivkovic/coeval) consumes traces from LangFuse-shaped APIs and posts judge verdicts back as scores. Serving those exact endpoints makes Ironside a drop-in trace source for coeval — **zero coeval code changes**, just an integration record pointing `endpointUrl` at the Ironside host.

## Endpoints

### `GET /api/public/traces`

LangFuse's list endpoint. Auth: an Integration credential with `traces:read`, using the same dual Bearer/Basic scheme as the compat ingest route (LangFuse clients send `Basic base64(publicKey:secretKey)`; the secret slot carries the real machine credential, the public slot is ignored).

- Query: `page` (1-based, default 1), `limit` (default 50, max 100), `userId`, `sessionId`, `fromTimestamp`/`toTimestamp` (ISO), `orderBy` (`timestamp.asc`/`timestamp.desc`, default desc — LangFuse's default; Ironside's own importer requests asc).
- Response: `{ data: Trace[], meta: { page, limit, totalItems, totalPages } }` — LangFuse's envelope, including the `meta` block Ironside's own importer paginates by.
- Only settled traces are listed, using the project-effective quiet period from `spec/trace-envelope-v1.md`. This prevents coeval from judging a half-written trace; a score posted back by coeval does not reopen it.
- **Page/offset pagination is unstable under concurrent inserts** — inherent to LangFuse's page-number contract, not fixable here; Ironside's native `/api/v1/traces` keeps keyset cursors for exactly this reason. Documented on `listTracePage`.

### `GET /api/public/traces/{id}`

LangFuse's detail endpoint: the trace plus `observations[]` and `scores[]` (flat lists, not a tree — LangFuse's shape). In-flight/reopened traces return 404 until settled again, matching the list endpoint's eligibility contract. Observation `type`/`level` and score `dataType`/`source` are emitted UPPERCASE (`GENERATION`/`DEFAULT`/`NUMERIC`/`API`), matching LangFuse's real wire format as verified against a live instance during M5 — Ironside's own importer normalizes these back down, closing the loop.

### `POST /api/public/scores`

LangFuse's score-create endpoint — coeval's verdict sync-back target. Body: `{ id?, traceId, name, value (number|string), comment?, dataType?, metadata? }`. Translates to a native `score-upsert` ingest event and reuses the existing envelope → storage → queue → worker path unchanged; no worker changes. Numeric value → `numeric` (or `boolean` when `dataType: "BOOLEAN"` is declared), string value → `categorical`/`stringValue`. Non-string metadata values are stringified (same convention as every mapper). Returns `200 {id}`; replays with the same id are harmless ReplacingMergeTree upserts, so no 409-on-duplicate is needed (coeval treats any 2xx as success and its idempotency ids converge).

## Null-omission contract (found live, not in review)

Optional trace/observation/score fields that are unset **omit the key** rather than emitting an explicit `null`. Found empirically on the very first live coeval connection test: coeval's LangFuse trace schema types optional fields as `z.string().optional()` — absent passes, an explicit `null` fails the union and errors the whole poll. Omission is the compatible intersection (coeval requires absent-or-present; Ironside's own importer schema is `.nullable().optional()` and accepts either). An explicitly-recorded `null` input/output (stored as JSON text `"null"`, distinct from SQL NULL) still round-trips as a real `null`.

## Read-side full-data fix (same batch)

The native trace-tree read path (`GET /api/v1/traces/:id`) never selected `model_parameters` or `completion_start_time` — ingested and stored since M0, invisible on every read. Fixed across `ObservationRow`/`listObservationsForTrace`, `ObservationNode` (+ `modelParameters`, `completionStartTime`), `buildObservationTree`, and the trace-level fields `environment`/`release`/`version` on `TraceDetailRow`/`getTrace`/`traceTreeResponseSchema`. Consistent with the M4-05 direct-ingest primacy directive: data captured must be data readable.

## End-to-end DoD verification (2026-07-12, real local coeval)

Ran a real coeval instance (local Postgres, mock judge — no LLM keys) against a live Ironside stack:

1. Seeded 2 demo traces into Ironside via native ingest.
2. Created the owner + default project/skill in coeval, connected a LangFuse integration with `endpointUrl: http://localhost:8788` and the Ironside key in the secret slot.
3. Coeval's connection test (its real `listTraces({limit:1})` code path) passed — after the null-omission fix above, which its first run caught.
4. Manual import trigger → **2/2 traces imported as cases**, both auto-judged (MockJudgeProvider), `syncBackCoverage: 1`.
5. Both verdicts landed in Ironside ClickHouse as `coeval_verdict` score rows — value `0.92`, `pass` comment, full metadata (verdict/skillVersionId/modelBinding-stringified/judgeRunId/provider), the feedback-sync-job UUID as the score id.
6. Round-trip: the scores are readable back via `GET /api/public/traces/demo_trace_1` in LangFuse shape.
7. Idempotency: re-triggering the import created no duplicate cases (coeval dedups on `source_trace_id`; still 2/2).

## Not in scope

- coeval's LangFuse importer reads only trace-level `input`/`output`/`metadata` — it never populates `TraceStep[]` from LangFuse-shaped sources (its own mapper's limitation, present against real LangFuse too). Ironside's detail endpoint serves full observation trees; if coeval's mapper ever learns to read them, the data is already there.
- LangFuse fetch endpoints beyond what coeval + Ironside's own importer consume (sessions API, observations listing, daily metrics, etc.) — not needed by any current consumer.
