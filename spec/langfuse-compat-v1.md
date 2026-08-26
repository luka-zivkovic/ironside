# LangFuse Ingestion Compat v1

Status: implemented (M5-01). Owner: `packages/shared/src/langfuse.ts`, `apps/api/src/routes/langfuse.ts`.

Trace-create `environment`, `release`, and `version` fields map to their native
trace fields. Environment normalization and discovery follow
`spec/environments-v1.md`; historical LangFuse detail imports use the same
contract.

## Scope note — two incompatible LangFuse SDK generations

LangFuse ships two SDK generations under different mechanisms:
- **Legacy (`langfuse` npm package, still published, e.g. v3.38.x)**: batches events and POSTs to `/api/public/ingestion`, redirected via the `LANGFUSE_BASEURL` env var (or `baseUrl` constructor option). **This is what this compat layer targets.**
- **Current (`@langfuse/*` packages, v4+/v5, 2025+ rewrite)**: sends OTel spans over OTLP to `/api/public/otel`, redirected via OTel's standard `OTEL_EXPORTER_OTLP_ENDPOINT`/SDK config, not a LangFuse-specific env var.

Ironside's M3 `POST /v1/otel/traces` (OTLP/HTTP+JSON) already gives current-SDK LangFuse users a migration path with zero code changes beyond OTel endpoint config — that's not this batch. This batch is specifically for teams still on the legacy SDK, which is likely most existing production LangFuse integrations as of a 2025 rewrite.

## Endpoint

`POST /api/public/ingestion` — same URL LangFuse's own API uses, so a client setting `LANGFUSE_BASEURL=<ironside-host>` and its existing `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` genuinely works with zero code changes.

Verified against LangFuse's Fern API definition (`github.com/langfuse/langfuse/blob/main/fern/apis/server/definition/ingestion.yml`) and their JS SDK source (`langfuse-js`, v3-stable branch), not guessed from narrative docs.

### Auth

LangFuse's SDK sends `Authorization: Basic base64(publicKey:secretKey)`. Ironside has no public/secret key pair concept: the compat endpoint accepts either `Authorization: Bearer <machine-credential>` or `Authorization: Basic base64(anything:<machine-credential>)`. The secret-key slot carries an Ingest credential (`ironside_sc_...`), while the public-key slot is ignored. See `spec/scoped-machine-credentials-v1.md`.

### Request body

```json
{
  "batch": [
    { "id": "<event-id>", "timestamp": "<iso>", "type": "trace-create", "body": {...} }
  ],
  "metadata": { "sdk_name": "langfuse-js", "...": "..." }
}
```

`metadata` is accepted and ignored (SDK diagnostics, not data). `batch[].id` is the *envelope* id (dedup key for the ingestion event itself) — distinct from `batch[].body.id`, which is the actual trace/observation id and is what upserts.

Supported `type` values (mapped to Ironside's internal `IngestEventType`):
| LangFuse type | Ironside type |
|---|---|
| `trace-create` | `trace-upsert` |
| `span-create`, `span-update` | `observation-upsert` (type: span) |
| `generation-create`, `generation-update` | `observation-upsert` (type: generation) |
| `event-create` | `observation-upsert` (type: event) |
| `score-create` | `score-upsert` |
| `observation-create`, `observation-update` (deprecated LangFuse alias) | `observation-upsert` |
| `sdk-log` | ignored (diagnostic only, not trace data) |

Field mapping for `generation-create`/`generation-update` bodies: LangFuse's `usage`/`usageDetails` (several historical shapes — legacy `{input,output,total,...}`, OpenAI-shaped `{promptTokens,completionTokens,totalTokens}`, or a plain `map<string,int>`) are all normalized into Ironside's `usageDetails: Record<string, number>`. `level` is uppercase in LangFuse (`DEBUG`/`DEFAULT`/`WARNING`/`ERROR`) and lowercased for Ironside's schema.

### Response

LangFuse's real endpoint always returns **207** (not 4xx on per-event validation errors) with a `{successes: [...], errors: [...]}` body — this compat layer matches that shape so the SDK's own response handling (which expects 207) doesn't choke.

## Storage path

Same as native/OTLP: the whole batch is wrapped as one `langfuse-ingestion` event (`source: "langfuse"`), persisted to S3, queued, and exploded into rows by the worker's LangFuse mapper.

**Deliberate deviation from LangFuse's own per-event error granularity**: LangFuse's real endpoint validates each batch item synchronously and reports per-item success/failure in the 207 body immediately. Ironside's ingest pipeline is fast-ACK-then-async everywhere (established since M1 — the edge never does mapping/validation work, only envelope checks) — event-level mapping errors (a malformed `generation-create` body, a missing `traceId`, etc.) surface only in worker logs, not this response. The route optimistically reports every event in the batch as accepted (once the outer `{batch: [...]}` envelope itself parses) rather than faking synchronous per-event validation it doesn't actually perform. This trades exact behavioral parity for staying consistent with the rest of the ingest architecture; a client relying on the SDK surfacing per-event validation errors from the response body won't see them here.
