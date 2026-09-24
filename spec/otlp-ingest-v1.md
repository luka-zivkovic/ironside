# OTLP Trace Ingest v1

Status: implemented. Owner: `apps/api/src/routes/otlp.ts`, `apps/api/src/otlp-proto.ts`, `packages/shared/src/otlp.ts`, `packages/mappers/src/otlp.ts`.

## Purpose

Accept OpenTelemetry traces over OTLP/HTTP and map them, including the `gen_ai.*` semantic-convention attributes, into Ironside traces and observations. This is the canonical integration surface for third-party frameworks and services: they emit standard OpenTelemetry instead of depending on an Ironside client library. Node.js applications that want provider wrappers, manual lifecycle handles, client-reported cost, or scores use the `ironside` package. `spec/integration-contract-v1.md` sets the role of each ingest surface.

## Endpoint

`POST /v1/otel/traces`. The path is top level, not under `/api/v1`, like other platforms that expose OTLP separately from their native API. It is not the exporters' default `/v1/traces` path, so the endpoint must be configured. Clients configure the signal-specific traces endpoint (`spec/integration-contract-v1.md`).

- Authentication: a project machine credential with the `ingest` capability, as a bearer token (`spec/scoped-machine-credentials-v1.md`). Requests count against the project's shared write rate limit (`spec/rate-limiting-quotas-retention-v1.md`).
- Encodings: `Content-Type: application/x-protobuf`, which most exporters send by default, or `application/json`. Any other content type returns 415.
- Compression: `Content-Encoding: gzip` is accepted for both encodings; `identity` or no header means uncompressed. Any other value returns 415, including lists such as `gzip, identity`. A body declared gzip that is not valid gzip returns 400.
- Size: the wire body is limited to 10 MiB (`MAX_REQUEST_BODY_BYTES`, 413). A gzip body is limited to the same 10 MiB after decompression (`gunzipSync` `maxOutputLength`, 413), because gzip reaches about 1000:1 on repetitive input and a small compressed body could otherwise expand to hundreds of megabytes in one allocation.
- Validation: the decoded body must match `otlpExportTraceServiceRequestSchema`. A failure returns 400 with `{ error, issues }` holding the Zod issues, or with an error message when the protobuf does not decode. Per the OTLP spec, 400 is not retryable. Attribute values may nest at most 32 levels (`MAX_ATTRIBUTE_VALUE_DEPTH`); deeper values are rejected so recursive validation cannot overflow the stack.
- Success: 200 in the request's encoding. A protobuf request gets a serialized empty `ExportTraceServiceResponse` (zero bytes, `application/x-protobuf`); a JSON request gets `{}`. `partial_success` is never set: an export is accepted whole or rejected with 400. A failure in the worker surfaces later as a dead letter (`spec/dead-letters-v1.md`).
- Error bodies are JSON whatever the request encoding. This deviates from the OTLP spec, which prefers a `google.rpc.Status` in the request's encoding; exporters only log error bodies, so a readable JSON error serves them better.

## Protobuf decoding

`apps/api/src/otlp-proto.ts` decodes a binary body with protobufjs against `.proto` files vendored in `apps/api/proto/` (opentelemetry-proto v1.10.0, Apache-2.0). The result has the same shape as a JSON body: camelCase keys, int64 values as decimal strings, `traceId`/`spanId`/`parentSpanId` as hex, and other bytes as base64. Validation, the stored event, and the worker mapper are one shared path after decoding, so the same export sent as protobuf and as JSON stores an identical event body.

Proto3 omits zero-valued fields, so a protobuf span whose `start_time_unix_nano` is unset or 0 decodes without `startTimeUnixNano` and is rejected with 400, because the schema requires that field. A JSON body that sends `"0"` explicitly is accepted. The asymmetry is intentional: a compliant exporter always sets a start time (the proto comment calls it semantically required), and decoding with defaults filled in would also materialize empty arrays and zero enums throughout the message.

## Wire format

- Field names are camelCase, per the protobuf JSON mapping: `resourceSpans`, `scopeSpans`, `startTimeUnixNano`.
- `traceId`, `spanId` and `parentSpanId` are hex strings, not base64; OTLP overrides the protobuf JSON default for these fields.
- `startTimeUnixNano` and `endTimeUnixNano` are int64 nanoseconds as decimal strings, because JSON numbers cannot hold nanosecond precision. `unixNanoToIso` converts them to ISO-8601 milliseconds with `BigInt` floor division, not float arithmetic.
- An attribute value is exactly one of `stringValue`, `intValue` (a string or number), `doubleValue`, `boolValue`, `bytesValue` (standard base64), `arrayValue`, or `kvlistValue`.

## Storage

One request becomes one ingest event of type `otlp-export` with `source: "otlp"` and goes through the same envelope, raw storage, and queue as native ingest (`spec/trace-envelope-v1.md`): the API writes the raw batch and its pending intent to object storage and enqueues it before answering 200. The event is not split per span at the API; one export can hold spans from many traces, and the worker's mapper expands it into trace and observation rows.

The event `body` is the export as parsed by `otlpExportTraceServiceRequestSchema`. It keeps resource attributes, scope name, and each span's ids, name, kind, times, attributes, status and events. Fields the schema does not declare, such as span links, `traceState`, `flags`, dropped-attribute counts, `schemaUrl`, and scope version, are not stored.

## Mapping to the domain model

`mapOtlpTraceRequest` (`packages/mappers/src/otlp.ts`) maps each span:

- Every span becomes an `Observation`: `id` is the `spanId`, `parentObservationId` the `parentSpanId`, plus `traceId`, `name`, `startTime`, `endTime`, and `statusMessage` from `status.message`. `status.code` 2 (`STATUS_CODE_ERROR`) sets `level: "error"`; any other status sets `level: "default"`.
- A span with no `parentSpanId` is the trace root and also produces the `Trace`: `id` is the `traceId`, `timestamp` the root's start time, `name` the root span's name, and `metadata` the resource attributes. The root stays an observation as well, so nothing on it is discarded. An export that carries only child spans writes observations only; the trace row comes with the export that carries the root.
- The root's resource attribute `deployment.environment.name` sets the trace environment; the deprecated `deployment.environment` is read only when the current attribute is absent. Both pass through the environment canonicalizer (`spec/environments-v1.md`), and an invalid current value leaves the environment unset instead of falling back to the legacy attribute.
- A span is `type: "generation"` when it has a `gen_ai.operation.name` attribute or a resolved model, and `type: "span"` otherwise.
- Span `kind` and span events are validated and stored but not mapped to domain fields.

Typed `gen_ai.*` mappings. The upstream conventions are still Development stability (`gen_ai.system` has already been renamed to `gen_ai.provider.name`), so the mapper reads both names where a rename happened:

| Attribute | Domain field |
| --- | --- |
| `gen_ai.request.model`, else `gen_ai.response.model` | `model` |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | `usageDetails.input_tokens`, `usageDetails.output_tokens` (`spec/usage-keys-v1.md`) |
| `gen_ai.request.temperature`, `.max_tokens`, `.top_p`, `.top_k`, `.frequency_penalty`, `.presence_penalty`, `.seed` | `modelParameters`, keyed without the `gen_ai.request.` prefix; numeric values only |
| `gen_ai.provider.name`, else legacy `gen_ai.system` | `metadata["gen_ai.provider.name"]` |
| `gen_ai.input.messages`, `gen_ai.output.messages` | `input`, `output` (see Message projection) |

`gen_ai.request.stop_sequences` is a string array while `modelParameters` values are scalars, so it is kept only in metadata.

Every span attribute, typed or not, is also copied into the observation's `metadata`: scalar values as their string form, and array, key-value list and bytes values as the JSON of the OTLP value. An unrecognized or future `gen_ai.*` attribute is therefore kept, only not typed.

### Message projection

`gen_ai.input.messages` and `gen_ai.output.messages` set `input` and `output` when they hold the standard OpenTelemetry message arrays: every message has a string `role` and a `parts` array whose items each have a string `type`, and every output message also has a string `finish_reason`. Both encodings allowed upstream are accepted: a structured `arrayValue`/`kvlistValue`, or a JSON string for exporters without structured attributes. Integers outside JavaScript's safe range are kept as their exact decimal string.

This is a bounded query projection, not a rewrite of the stored evidence. Each attribute is limited to 128 KiB of content, 10,000 decoded nodes, 200 messages, and 200 parts across its messages. One export can project at most 512 KiB and 50,000 decoded nodes across all spans and both directions. Content that is nonstandard, malformed, or over a limit leaves the field unset; the original attribute remains in metadata and the stored export body remains authoritative.

## Cost and scores

OpenTelemetry has no cost attribute (the `open-telemetry/semantic-conventions-genai` registry defines none) and no score concept.

- Cost: the worker derives cost from the mapped usage and model with the price table (`spec/cost-pricing-v1.md`). A custom cost attribute is kept in metadata but not promoted into `costDetails`. A client that needs an exact provider-billed figure sends it through native JSON ingest or the `ironside` package.
- Scores: OTLP has no way to send them. Scores are recorded through native JSON ingest (`score-upsert`) or the SDK's `score()` methods.

## Verified

`apps/api/test/otlp.test.ts` covers authentication, 415 for other content types, 400 for malformed payloads, and a JSON export stored raw, queued, and mapped the way the worker maps it. `apps/api/test/otlp-protobuf.test.ts` covers the protobuf response, identical stored events for the protobuf and JSON encodings of one export, gzip for both encodings, 400 for a body declared gzip that is not, 413 for a 64 MiB gzip bomb, 400 for a protobuf span without a start time, 415 for other content encodings, 400 for undecodable protobuf, and the real `@opentelemetry/exporter-trace-otlp-proto` exporter sending through a local HTTP server into the mapper. `packages/mappers/test/otlp.test.ts` covers root promotion, model, usage, provider and sampling-parameter mapping, environment precedence, message projection and its limits, error status, metadata passthrough, and timestamp conversion.

## History

- M3-01 and M3-02 added the endpoint with OTLP/HTTP JSON.
- M9-06 added protobuf decoding. The decompressed-size cap on gzip bodies came from a review finding on PR #38.
- The M4-05 direct-ingest audit added the `gen_ai.request.*` to `modelParameters` mapping (`spec/direct-ingest-primacy-v1.md`). OTLP observations gained cost later, when the worker began deriving it (`spec/cost-pricing-v1.md`).
- Issue #45 made OTLP the canonical integration surface for third-party frameworks and services.
- Through 0.3.0 the API also filled each event's idempotency key with a hash of the body, which was identical for the protobuf and JSON encodings of an export. The key is now the event id (`spec/trace-envelope-v1.md`).
