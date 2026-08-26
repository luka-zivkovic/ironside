# Ironside roadmap

Ironside is a self-hosted system of record for AI interaction data: ingest
traces from standard and native interfaces, preserve the raw event log, make
traces useful in a focused viewer, and move the data back out without locking
it into the product.

This roadmap describes direction, not a compatibility or delivery guarantee.
Ironside remains pre-release until the operational and schema commitments
below are complete.

## Available in v0.1

- Native JSON, OTLP/HTTP, and LangFuse-compatible ingest paths converging on
  the same durable pipeline.
- Immutable raw events in S3-compatible storage, asynchronous processing, and
  trace/observation/score projections in ClickHouse.
- A React trace viewer with project context, environment filters, structured
  payload views, safe Markdown rendering, and raw-event inspection.
- Owner sessions and least-privilege, project-scoped machine credentials.
- Node.js instrumentation through the `ironside` package, including OpenAI and
  Anthropic wrappers plus manual trace, span, generation, and score APIs.
- Pull-based LangFuse and LangSmith history importers with resumable
  checkpoints.
- Scheduled S3-compatible exports, OTLP forwarding, and signed webhooks.
- Quotas, retention planning, dead-letter visibility, metrics, and recovery
  paths for pending ingest.
- A Docker Compose self-hosting path covering the API, worker, web app,
  Postgres, ClickHouse, Redis, and MinIO.

## Before a stable release

- Validate the LangSmith importer against a representative live account.
- Replace the temporary pre-production schema reset policy with append-only,
  forward migrations and documented rollback expectations.
- Complete fresh-machine installation, upgrade, backup, and recovery drills
  against the published container images.
- Expand production deployment guidance for TLS, secret management, object
  storage, scaling, and observability.
- Publish explicit compatibility and deprecation policies for APIs, stored
  data, the SDK, and container releases.
- Continue security review of authentication, scoped credentials, import and
  export destinations, payload rendering, and retention execution.

## Planned follow-ups

- Replay jobs that re-enqueue selected immutable raw batches through the
  normal processing pipeline.
- Streaming-aware provider wrappers and broader SDK coverage.
- End-user feedback capture for ratings, comments, and other trace-linked
  scores.
- Additional export formats and operational controls in the web interface.
- More interoperability fixtures for OpenTelemetry semantic conventions and
  migration sources.

For implemented behavior and its invariants, see [`spec/`](./spec). For
deployment guidance, see [`docs/self-hosting.md`](./docs/self-hosting.md).
