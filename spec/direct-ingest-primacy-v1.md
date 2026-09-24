# Direct-Ingest Primacy v1

Status: implemented. Owner: `packages/sdk/src/`, `packages/mappers/src/otlp.ts`, `packages/mappers/src/native.ts`.

## Purpose

Direct ingest into Ironside, through the `ironside` package, OTLP/HTTP, or native JSON, is the primary product path. LangFuse and LangSmith compatibility endpoints and importers exist for teams migrating from another platform and are not the recommended basis for new instrumentation. This spec states what each direct path captures, so the primary path does not fall behind the migration tooling on data completeness. `spec/integration-contract-v1.md` sets the role of each surface.

## Roles

- OTLP/HTTP with `gen_ai.*` attributes is the canonical portable contract for third-party frameworks and services (`spec/otlp-ingest-v1.md`). "Canonical" says which integration a third party should implement; it does not give OTLP capabilities OpenTelemetry lacks, notably client-reported cost and scores.
- The `ironside` package is the ergonomic Node.js contract: provider wrappers, manual trace, span and generation handles, scores, and media uploads.
- Native JSON (`POST /api/v1/ingest`) is the complete low-level contract. Event bodies are validated against the domain Zod schemas with `projectId` omitted (`packages/mappers/src/native.ts`), so every domain field can be set.

## Coverage

| Data | `ironside` package | OTLP | Native JSON |
| --- | --- | --- | --- |
| Scores | `trace.score()`, `observation.score()` | Not available | `score-upsert` events |
| Model parameters | Read from wrapped requests; `modelParameters` option on `generation()` and `recordGenerateTextResult()` | `gen_ai.request.*` attributes | `modelParameters` |
| Trace `environment`, `release`, `version` | `trace()` options | `environment` from the `deployment.environment.name` resource attribute; release and version are not mapped, and resource attributes stay in trace metadata | Trace fields |
| Cost | Derived by the worker; a client figure can be sent with `end({ costDetails })` | Derived by the worker | Derived by the worker, or `costDetails` as sent |
| Usage keys | Canonical keys | Canonical keys | Known aliases renamed to canonical keys |

Cost derivation is described in `spec/cost-pricing-v1.md` and usage keys in `spec/usage-keys-v1.md`. The wrappers record streamed provider calls as well (`spec/sdk-streaming-v1.md`).

## SDK contract

### Scores

`trace.score(options)` and `observation.score(options)` enqueue a `score-upsert` for that trace or that observation (`packages/sdk/src/client.ts`). An `observationId` in the options attaches the score to that observation instead, including from `trace.score()`.

- `ScoreOptions` (`packages/sdk/src/types.ts`) is a discriminated union that requires exactly one of `value` (a number) and `stringValue` (a string), so a score with neither or both fails to type-check. The type is the only place to catch it: the worker rejects a score with neither as a dead letter (`spec/dead-letters-v1.md`), and the SDK's background delivery never reports per-event rejections to the caller.
- `dataType` is `numeric` when `value` is set and `categorical` otherwise. A `value` of 0 is sent as data.
- `source` defaults to `api` and `id` to a new ULID; `comment` and `metadata` are optional.

### Model parameters

Only fields present on the request are recorded, and a request with none of them records no `modelParameters`.

- `wrapOpenAI`: `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `presence_penalty`, `frequency_penalty`, `seed`.
- `wrapAnthropic`: `temperature`, `top_p`, `top_k`, `max_tokens`.
- `recordGenerateTextResult` (Vercel AI SDK) takes an explicit `modelParameters` option, because it records a completed result and never sees the request.
- Manual instrumentation passes `modelParameters` to `generation()`.

### Trace fields

`trace()` accepts `environment`, `release` and `version` alongside `name`, `userId`, `sessionId`, `tags`, `metadata` and `input`. A `trace-upsert` replaces the whole stored row, since ClickHouse has no field-level merge, so `update()` re-sends every field given to `trace()` and the original timestamp, together with the new `output` and the merged metadata.

### Cost

The wrappers do not compute cost; the worker derives it from usage and model. A caller with a provider-billed figure passes `costDetails` to `end()`, and it is stored as sent.

## OTLP contract

- `gen_ai.request.temperature`, `.max_tokens`, `.top_p`, `.top_k`, `.frequency_penalty`, `.presence_penalty` and `.seed` map to `modelParameters`. `gen_ai.request.stop_sequences` is a string array and stays in metadata, because `modelParameters` values are scalars.
- OpenTelemetry has no cost attribute and no score concept, and Ironside does not invent `gen_ai.*` attributes for them. Cost is derived from the mapped usage and model; a custom cost attribute stays in metadata. An application that needs scores or an exact provider-billed cost alongside OTLP sends them through native JSON or the `ironside` package.

## Verified

`packages/sdk/test/client.test.ts` covers `trace.score()` and `observation.score()`, including a `value` of 0 and a categorical score, compile-time rejection of a score with neither or both values (`@ts-expect-error`), and `environment`, `release` and `version` through both `trace()` and `update()`. `packages/sdk/test/wrappers.test.ts` covers `modelParameters` capture, present and absent, for `wrapOpenAI`, `wrapAnthropic` and `recordGenerateTextResult`. `packages/mappers/test/otlp.test.ts` covers the `gen_ai.request.*` mapping and its absence. `packages/mappers/test/native.test.ts` covers rejection of a native score with neither value.

## History

- M4-05 audited the direct paths after M5 brought the LangFuse and LangSmith importers to full data parity (observations, scores, usage, cost), following the direction that traces should reach Ironside directly without another platform. The native JSON contract was already schema-complete; the gaps were in the SDK and the OTLP mapper. The audit added the SDK's `score()` methods, `modelParameters` capture in the wrappers and the OTLP mapper, and the `environment`, `release` and `version` trace options.
- The first `ScoreOptions` made `value` and `stringValue` independently optional. `score({ name })` type-checked, and the worker then dropped the event with no signal to the caller; setting both produced an inconsistent `dataType`. Review caught it and the type became a discriminated union.
- The audit deferred three gaps, all resolved later: cost (derived at ingest, `spec/cost-pricing-v1.md`), streaming in the wrappers (M9-07, `spec/sdk-streaming-v1.md`), and the split usage-key vocabulary across writers (M9-04, `spec/usage-keys-v1.md`, proven by `apps/worker/test/usage-key-unification.test.ts`).
- Issue #45 made OTLP the canonical contract for third-party integrations (`spec/integration-contract-v1.md`).
