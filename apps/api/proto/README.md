# Vendored OTLP proto definitions

Copied verbatim from [open-telemetry/opentelemetry-proto](https://github.com/open-telemetry/opentelemetry-proto)
at tag **v1.10.0** (Apache License 2.0 — license headers preserved in each file).
Only the four files the trace ingest path needs are vendored:

- `opentelemetry/proto/collector/trace/v1/trace_service.proto`
- `opentelemetry/proto/trace/v1/trace.proto`
- `opentelemetry/proto/common/v1/common.proto`
- `opentelemetry/proto/resource/v1/resource.proto`

Loaded at runtime by `src/otlp-proto.ts` (protobufjs); the build script
copies this directory to `dist/proto`. The OTLP wire format is stable
(required fields never change meaning), so upgrades are only needed to
pick up *new* optional fields — re-download the same four paths from a
newer tag and update this note.
