# OTLP Forwarding v1

Status: implemented (M6-02); scheduler wiring (M6-05) and admin API routes (M6-06) since added. Owner: `packages/shared/src/otlp-export.ts`, `apps/worker/src/forwarders/`.

## Purpose

The inverse of M3's OTLP ingest: forward stored traces (filtered) as OTLP/HTTP+JSON to an arbitrary destination — an otel-collector, Jaeger, or any other OTel-native/gen_ai-semconv-aware backend — so a customer's own observability tooling gets a live feed without them building an extractor.

## Design

- **`toOtlpTraceId`/`toOtlpSpanId`** (`packages/shared/src/otlp-export.ts`): Ironside's own trace/observation ids (ULIDs, imported UUIDs) don't fit OTLP's exact byte-length requirement — verified directly against the OTel proto spec (`trace.proto`): `trace_id` MUST be exactly 16 raw bytes (32 hex chars), `span_id` exactly 8 raw bytes (16 hex chars); an all-zero or wrong-length id is explicitly invalid. Derives valid hex ids via a deterministic SHA-256-based hash, so the same source id always maps to the same OTLP id across repeated forwarding runs (a re-forwarded trace looks like the same trace downstream, not a new one every time).
- **`mapTraceToOtlpExportRequest`** (`apps/worker/src/forwarders/otlp-mapper.ts`): converts a trace + its observation tree into an `ExportTraceServiceRequest` JSON body. Re-emits `gen_ai.request.model`/`gen_ai.usage.{input,output}_tokens` for observations carrying a model, so a downstream gen_ai-semconv-aware system sees the same attribute shape a real instrumentation SDK would produce. A trace with zero observations still emits one synthetic root span — an export with zero spans for an otherwise-real trace would look like data loss to a downstream consumer, not an intentional signal.
- **`otlp_forward_rules` table**: per-project named rules (destination URL, optional auth header, `TraceFilter`-shaped filter). The auth header is AES-256-GCM encrypted at rest (`destination_auth_header_encrypted`), same pattern and same encryption helper as M6-01's `export_configs.destination_secret_access_key_encrypted` — a bearer token to a customer's otel-collector is the same credential risk class as an S3 secret key, so both tables encrypt at the application layer before Postgres ever sees the value.
- **`forwardOtlpTraces`** (`apps/worker/src/forwarders/otlp-forwarder.ts`): fetches settled matching traces (via the same quiet-period-aware `exportTraces` used by M6-01's file export), forwards each as its own OTLP POST. One trace's failure (destination timeout, non-2xx) is recorded per-trace and doesn't block the rest — matches the "one bad item doesn't fail the whole batch" policy used throughout the ingest pipeline.

## Verified against a real, independent OTel-native system — not just a mock

`apps/worker/test/otlp-forwarder.test.ts` covers the logic against a mock HTTP server (auth headers, span nesting, per-trace failure isolation, tenant/filter isolation). Beyond that, the DoD ("forwarded traces visible in local otel-collector/Jaeger") was verified manually against a **real Jaeger all-in-one container**: seeded a trace with a root span and a nested `gen_ai`-attributed generation into ClickHouse, ran `forwardOtlpTraces` against Jaeger's real OTLP/HTTP receiver (`:4318/v1/traces`), then queried Jaeger's own API (`/api/traces`) and confirmed:
- The `ironside` service registered (from the mapper's `resource.attributes["service.name"]`).
- Both spans present with correct names.
- The child span's `CHILD_OF` reference resolves to the exact root span's id (parent/child structure survives the hash-based id derivation correctly).
- All three `gen_ai.*` attributes present with correct values and types (`gen_ai.request.model` as string, `gen_ai.usage.input_tokens`/`output_tokens` as int64).

This is real proof against real, independent software — not an assumption that a correctly-shaped OTLP JSON body would obviously be accepted.

## SSRF guard applied (2026-07-12)

`forwardOtlpTraces` now calls the same `assertPublicHttpDestination` guard `runWebhooks` already used, closing the gap flagged during M6-03 review — `rule.destinationUrl` is customer-supplied and is now validated to resolve to a public address before any request is sent, resolving actual DNS answers (not just the hostname string) so a public-looking hostname that rebinds to a private address is still blocked. An `allowPrivateDestinations` escape hatch exists for tests, matching `runWebhooks`' identical option. Regression-tested (`apps/worker/test/otlp-forwarder.test.ts`): a rule targeting `http://127.0.0.1:9/v1/traces` is rejected before any HTTP request reaches the mock server.

## Not yet done (follow-up, not blocking this DoD item)

~~No API routes / no scheduler~~ — **done since**: scheduler wiring in M6-05 (spec/scheduler-v1.md), admin CRUD routes in M6-06 (spec/scheduled-destinations-crud-v1.md). Still true: real-time forward-on-ingest (pushing a trace the instant it's stored, rather than the M6-05 poll cadence) would be a larger architectural change touching the ingest pipeline itself — deliberately not built.
