# Integration Contract v1

Status: implemented (issue #45). Owners: `apps/api/src/routes/otlp.ts`, `packages/mappers/src/otlp.ts`, `packages/sdk/`.

## Decision

Ironside supports three first-class direct-ingest surfaces, each with one explicit role:

| Surface | Canonical use | Contract |
| --- | --- | --- |
| OTLP/HTTP | Third-party frameworks, agents, gateways, and services | `POST /v1/otel/traces`, preferably protobuf, with OpenTelemetry `gen_ai.*` attributes |
| `ironside` | Native Node.js/TypeScript ergonomics | Provider wrappers plus manual trace/span/generation, media, cost, and score APIs |
| Native JSON | Low-level integrations requiring the complete Ironside domain envelope | `POST /api/v1/ingest` using `spec/trace-envelope-v1.md` |

OTLP is the portable default a third party should implement. It keeps Ironside interoperable with the OpenTelemetry ecosystem and avoids requiring every language or framework to depend on an Ironside package. The SDK is not a competing wire protocol: it is a Node.js convenience layer over native ingest for applications that want Ironside-specific capabilities.

LangFuse/LangSmith compatibility endpoints and importers remain migration surfaces, not the recommended basis for new instrumentation.

## OTLP configuration

Clients must configure the signal-specific endpoint because Ironside intentionally exposes `/v1/otel/traces`, not the endpoint that an SDK would derive by appending `/v1/traces` to a generic OTLP base URL.

```sh
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://ironside.example.com/v1/otel/traces
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_TRACES_HEADERS="authorization=Bearer%20${IRONSIDE_API_KEY}"
```

The endpoint also accepts OTLP/HTTP JSON and gzip. Authentication is the same project-scoped bearer key used by native ingest. The detailed payload, response, and mapping contract lives in `spec/otlp-ingest-v1.md`.

## Capability boundary

OpenTelemetry GenAI semantic conventions represent models, operations, inputs/outputs, token usage, provider details, and request parameters. Ironside maps those fields and preserves every remaining attribute in observation metadata.

OTLP does not standardize computed monetary cost or eval/human-feedback scores. Ironside does not invent proprietary `gen_ai.*` attributes for them. Applications needing these fields should use the `ironside` package or native JSON, either as their primary integration or alongside OTLP. Custom OTLP cost attributes are retained as metadata but are not promoted into `costDetails`.

## Stability

The upstream `gen_ai.*` semantic conventions are still marked Development. Ironside accepts the current `gen_ai.provider.name` attribute and the legacy `gen_ai.system` fallback, and it retains unknown attributes so a semconv change does not discard data. Typed mappings may grow compatibly as the upstream vocabulary stabilizes.
