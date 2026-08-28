# Ironside

[![CI](https://github.com/luka-zivkovic/ironside/actions/workflows/ci.yml/badge.svg)](https://github.com/luka-zivkovic/ironside/actions/workflows/ci.yml)
[![License: Sustainable Use](https://img.shields.io/badge/license-sustainable%20use-314158)](./LICENSE.md)

**The system of record for AI interaction data.** Ingest LLM traces from anywhere (native SDK, plain JSON, OpenTelemetry `gen_ai.*`, LangFuse-compatible endpoints), store them durably and cheaply, and export them anywhere (Parquet to your warehouse, OTLP forwarding, webhooks, full API).

Deliberately narrow: **storage + pipes + a great trace viewer**. Evals and prompt management live elsewhere — bring any eval tool. Ironside's fetch and score APIs are LangFuse-compatible, so anything that can read traces and post scores works ([coeval](https://github.com/luka-zivkovic/coeval) is one example).

Status: pre-release, under active development. See [ROADMAP.md](./ROADMAP.md). Licensed under the [Ironside Sustainable Use License](./LICENSE.md) — self-hosting for your own organization's use is always free and unrestricted; see the license for the (narrow) limitations.

[Self-hosting](./docs/self-hosting.md) · [SDK guide](./packages/sdk/README.md) · [Roadmap](./ROADMAP.md) · [Security](./SECURITY.md) · [Contributing](./CONTRIBUTING.md)

## Run it

```sh
git clone https://github.com/luka-zivkovic/ironside.git
cd ironside
docker compose up -d --build
```

This starts the full stack — Postgres, ClickHouse, Redis, MinIO, plus the `api`, `worker`, and `web` containers — with migrations and object storage setup handled automatically on boot. Once `docker compose ps` shows everything healthy, generate the one-time owner setup code:

```sh
docker compose exec api node apps/api/dist/src/scripts/owner-setup.js
```

Open `http://localhost:8080/setup`, paste the code, and create your owner account. The code proves that you control this installation, expires quickly, and works once. Owner access uses an HttpOnly browser session and is separate from machine credentials.

After signing in, create the first project in the UI. Ironside commits the
project and its initial scoped `ironside_sc_...` Ingest credential atomically
and shows the plaintext once. The project's **Connections** page creates
least-privilege Ingest or Integration credentials and provides exact setup
snippets. Copy a token into your SDK/exporter; the browser itself uses only the
owner session and explicit project URLs. See
[`docs/self-hosting.md`](./docs/self-hosting.md) for upgrades, owner recovery,
credential rotation, configuration, and production considerations.

Within a project, environments are automatically observed trace attributes and
an exact, shareable `?environment=...` filter—not access or retention scopes.
The global picker and Configuration page discover/hide retained values; use a
separate project whenever credentials, access, quotas, retention, or isolation
must differ. See [`spec/environments-v1.md`](./spec/environments-v1.md).

## Instrument your app

For third-party frameworks and services, **OTLP/HTTP with OpenTelemetry's `gen_ai.*` semantic conventions is the canonical integration path**. Point the trace exporter at Ironside's signal-specific endpoint:

```sh
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:8788/v1/otel/traces
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="authorization=Bearer%20${IRONSIDE_API_KEY}"
```

Use the signal-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`; Ironside's route is `/v1/otel/traces`, not the usual base-endpoint-derived `/v1/traces`. Standard `gen_ai.*` model, usage, operation, and request attributes are mapped into typed Ironside fields, while all attributes are retained in metadata. OTLP has no standard representation for computed cost or eval/human-feedback scores, so applications that need those should use the SDK or native JSON ingest alongside it. See [`spec/integration-contract-v1.md`](./spec/integration-contract-v1.md) and [`spec/otlp-ingest-v1.md`](./spec/otlp-ingest-v1.md).

For Node.js applications, the `ironside` package is the ergonomic native integration. Install it with your provider's SDK:

```sh
npm install ironside openai
```

Then wrap the provider client:

```ts
import OpenAI from "openai";
import { init, wrapOpenAI } from "ironside";

const ironside = init({ apiKey: process.env.IRONSIDE_API_KEY, host: "http://localhost:8788" });
const openai = wrapOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), ironside);

// use `openai` exactly as you would the normal OpenAI client — every
// chat.completions.create() call is now automatically traced.
const completion = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "hello" }]
});

await ironside.shutdown(); // flush before the process exits
```

`wrapAnthropic` works the same way for `@anthropic-ai/sdk`, capturing model, input/output, token usage, and request sampling parameters (temperature, max_tokens, etc.) automatically. For manual instrumentation, or the Vercel AI SDK, use `init()`'s `trace()`/`span()`/`generation()` directly, or `recordGenerateTextResult()` — see the [`ironside` SDK guide](./packages/sdk/README.md) and runnable [`examples/chatbot`](./examples/chatbot). Every trace/span/generation handle also exposes `score()`, for recording human feedback or eval results directly against a trace.

OTLP is the portable default for third parties; the SDK is the native Node.js convenience layer; and plain JSON `POST /api/v1/ingest` is the low-level escape hatch for the complete wire contract. All three converge on the same durable ingest pipeline (see [`spec/trace-envelope-v1.md`](./spec/trace-envelope-v1.md)). LangFuse/LangSmith compatibility and importers (below) exist specifically for teams **migrating off another platform**, not as the recommended integration path for new instrumentation.

Already storing traces in LangFuse or LangSmith and want them in Ironside too? Point their SDKs at Ironside's compatible endpoints instead of standing up new instrumentation (`spec/langfuse-compat-v1.md`), or backfill your existing history with the pull-based importers (`spec/langfuse-importer-v1.md`, `spec/langsmith-importer-v1.md`) — both capture full observation trees and scores, not just trace summaries.

## Architecture

```
        ┌─ native JSON ──┐
clients ┼─ OTLP http ────┼→ api (Hono, fast ACK)
        └─ LF-compat ────┘       │
                   raw event → MinIO/S3 (immutable log)
                   reference → Redis (BullMQ)
                                 │
                              worker ──→ ClickHouse (traces/observations/scores)
                                 │
                   exports: Parquet → bucket / OTLP forward / webhooks

web (React SPA, nginx) ──→ api: trace viewer, Connections, project management
Postgres: orgs, projects, scoped credentials, bounded environment discovery, configs/quotas
```

## Development

Requires Node ≥24, pnpm 10, Docker. This runs the apps on the host (fast rebuild/reload) against Dockerized infra only — for running the full containerized stack instead, see "Run it" above.

```sh
pnpm install
docker compose up -d postgres clickhouse redis minio
pnpm build && pnpm test
pnpm --filter @ironside/api dev     # in one terminal
pnpm --filter @ironside/worker dev  # in another
pnpm --filter @ironside/web dev     # in a third — http://localhost:5174
```
