# OTLP Trace Ingest v1

Status: implemented (M3-01/M3-02; protobuf encoding added in M9-06; canonical third-party role documented in issue #45). Owner: `packages/shared/src/otlp.ts`, `packages/mappers/src/otlp.ts`, `apps/api/src/routes/otlp.ts`, `apps/api/src/otlp-proto.ts`.

This is Ironside's canonical integration surface for third-party frameworks and services. Emit standard OpenTelemetry traces with `gen_ai.*` semantic-convention attributes instead of depending on an Ironside-specific client library. Node.js applications that want provider wrappers, manual lifecycle handles, cost fields, or scores should use the `ironside` package; see `spec/integration-contract-v1.md`.

## Endpoint

`POST /v1/otel/traces` — top-level, not nested under `/api/v1` (matches the path OTel exporters expect, and how LangFuse/LangSmith expose OTLP ingest separately from their native API). Bearer-authenticated like every other ingest path.

- Accepts both OTLP/HTTP encodings (M9-06): `Content-Type: application/x-protobuf` (what most OTel exporters send by default) and `application/json`. Anything else returns 415.
- `Content-Encoding: gzip` is accepted for both (the OTel Collector's `otlphttp` exporter compresses by default); other encodings return 415 (including multi-token values like `gzip, identity`, which no real exporter sends). A gzip-declared body that isn't gzip returns 400. **Decompressed size is capped at the same 10MB as the wire-size bodyLimit** (`gunzipSync` `maxOutputLength` → 413) — gzip reaches ~1000:1 on repetitive input, so without the cap a ~200KB compressed body could expand to 200MB in one synchronous allocation (PR #38 review finding, regression-tested with a real 64MB bomb).
- Success: `200` in the request's content-type, per spec — protobuf-in gets a serialized empty `ExportTraceServiceResponse` (zero bytes — all-defaults message), JSON-in gets `{}`. No `partial_success` is ever set: acceptance is all-or-nothing at this edge (per-event failures surface later via dead letters, spec/dead-letters-v1.md).
- Malformed payload: `400` with Zod issues (or a protobuf decode error message). Per OTLP spec, 400 is non-retryable — clients should not resend the same malformed payload.
- **Known protobuf/JSON asymmetry, pinned deliberately**: a protobuf span with `start_time_unix_nano` unset or 0 (the proto3 zero-default, omitted by decode) is rejected 400 because `startTimeUnixNano` is schema-required, while a JSON body sending the string `"0"` explicitly is accepted. A compliant exporter always sets a real timestamp (the proto's own comment calls the field "semantically required"), and a 1970-epoch start time is garbage better rejected than stored — regression-tested rather than papered over with `defaults: true` (which would also materialize empty arrays and zero enums everywhere).
- **Spec deviation, deliberate**: error responses are JSON regardless of request encoding. The OTLP spec prefers a `google.rpc.Status` in the request's encoding, but real exporters only log error bodies, and a readable JSON error beats an opaque binary one; vendoring `status.proto`+`any.proto` to encode what no client parses wasn't worth it.

### Protobuf decode path (M9-06)

A binary body is decoded (`apps/api/src/otlp-proto.ts`, protobufjs against vendored `.proto` files — `apps/api/proto/`, pinned to opentelemetry-proto v1.10.0, Apache-2.0) into the **same OTLP/JSON object shape** the JSON path receives: int64s as decimal strings, trace/span ids hex-encoded, other bytes base64. Everything downstream of the content-type branch — Zod validation, the stored raw envelope (still JSON), the worker mapper — is one shared code path. Consequence: the same export sent as protobuf and as JSON produces byte-identical stored events and the **same idempotency key** (the hash is computed post-conversion), proven by a parity test. Conformance is tested against the real `@opentelemetry/exporter-trace-otlp-proto` exporter over a real HTTP server, not hand-rolled fixtures (`apps/api/test/otlp-protobuf.test.ts`).

## Wire format notes (easy to get wrong)

- Field casing is **camelCase** (standard protobuf JSON mapping): `resourceSpans`, `scopeSpans`, `startTimeUnixNano`.
- `traceId`/`spanId`/`parentSpanId` are **hex strings**, not base64 — OTLP overrides the protobuf JSON default for these two fields specifically.
- `startTimeUnixNano`/`endTimeUnixNano` are **stringified int64 nanoseconds** (JSON numbers can't hold full nanosecond precision). Converted to ISO-8601 via `unixNanoToIso` using `BigInt` division, not float math.
- Attribute values are a oneof: `{stringValue}` / `{intValue}` (also a string) / `{doubleValue}` / `{boolValue}` / `{arrayValue}` / `{kvlistValue}` / `{bytesValue}` (base64 — this one *does* use standard base64).

## Mapping to the domain model

A span with no `parentSpanId` is the trace root — its `traceId` becomes the `Trace.id`, its own attributes/timing become both the Trace *and* an Observation (nothing is discarded by "promoting" it). Every span becomes an `Observation`; `parentSpanId` becomes `parentObservationId`.

`gen_ai.*` attributes (still **Development/unstable** upstream as of 2026 — `gen_ai.system` was renamed to `gen_ai.provider.name` mid-spec) populate typed fields when present:
- `gen_ai.request.model` / `gen_ai.response.model` → `Observation.model`
- `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` → `Observation.usageDetails`
- `gen_ai.request.temperature` / `.max_tokens` / `.top_p` / `.top_k` / `.frequency_penalty` / `.presence_penalty` / `.seed` → `Observation.modelParameters` (M4 direct-ingest-primacy audit; verified against the live `open-telemetry/semantic-conventions-genai` registry). `gen_ai.request.stop_sequences` is a string array and modelParameters values are scalar-only, so it isn't specially typed — it still survives in `metadata`, per the fallback below.
- `gen_ai.input.messages` / `gen_ai.output.messages` → `Observation.input` / `Observation.output` when they contain the standard OpenTelemetry message arrays. Both span encodings allowed upstream are accepted: structured OTLP `arrayValue`/`kvlistValue`, or a JSON string when structured attributes are unavailable. This is a bounded query projection, not a rewrite of the stored evidence: each JSON-string attribute is limited to 128 KiB, each attribute is limited to 200 messages, 200 aggregate parts, and 10,000 decoded nodes, and one export can project at most 512 KiB of content and 50,000 decoded nodes across all spans. Nonstandard, malformed, or over-budget content leaves the typed field unset while the original attribute remains in metadata and the raw export envelope remains authoritative.
- The root span's resource `deployment.environment.name` maps to the trace environment; deprecated `deployment.environment` is used only when the current attribute is absent. Both pass through `spec/environments-v1.md`'s canonicalizer, and an invalid current value does not silently fall through to legacy.
- `gen_ai.provider.name` (falling back to legacy `gen_ai.system`) → normalized into `metadata["gen_ai.provider.name"]`
- Presence of `gen_ai.operation.name` or a resolved model marks the span as `type: "generation"`; otherwise `type: "span"`.
- `status.code === 2` (`STATUS_CODE_ERROR`) → `level: "error"`.

**Every attribute — typed or not — is also copied verbatim into `metadata`** as a string. This is the data-flexibility mechanism: an unrecognized or future `gen_ai.*` attribute (the spec is still moving) is never silently dropped, just not specially typed yet.

## Known gaps (M4 direct-ingest-primacy audit, 2026-07-12)

- **No cost mapping.** Verified directly against the live semconv registry (`open-telemetry/semantic-conventions-genai`, `model/gen-ai/registry.yaml`): there is no `gen_ai.usage.cost` or any standardized cost/price attribute upstream — this isn't a missed mapping, there's nothing to map. A client that wants cost recorded must compute it and send it via the native JSON ingest path instead (`Observation.costDetails`), or as a custom OTLP attribute captured generically via the metadata fallback above.
- **No score support.** OTLP/OTel has no native "score" concept (human feedback, eval results). Scores can only be recorded via native JSON ingest (`score-upsert`) or the SDK's `score()` method — there is no OTLP-side workaround, documented here rather than left silent.

## Storage path

One `POST` = one `otlp-export` ingest event (`source: "otlp"`), whose `body` is the raw, Zod-validated `ExportTraceServiceRequest` — not split into per-span events at the API edge. The worker's OTLP mapper explodes it into many trace/observation rows, since a single export can span multiple traces. Same envelope/queue/ClickHouse pipeline as native ingest.
