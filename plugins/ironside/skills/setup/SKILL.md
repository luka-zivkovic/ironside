---
name: setup
description: "Install a local Ironside trace store with Docker Compose and connect one application to it: check Git, Docker Compose v2, and port collisions, clone or reuse a checkout, start the stack, verify health, guide owner setup and project creation, then instrument the app with the Node SDK or OTLP and confirm one trace in the viewer. Do not use for production deployment, upgrading an existing installation, or capturing coding-agent sessions. Use when someone wants to run Ironside on their machine, asks to set up Ironside, or wants their AI application's traces stored locally."
argument-hint: "[projects directory, existing checkout, or app to instrument]"
---

# Ironside setup

Ironside is a self-hosted store for AI traces: a Docker Compose stack with
Postgres, ClickHouse, Redis, MinIO, and the `api`, `worker`, and `web`
services. Work in the directory the user names; otherwise use the current
directory. Ask before anything destructive, and never remove volumes,
containers, or checkouts you did not create.

## 1. Check the host

```sh
git --version
docker compose version
docker compose ls
```

Compose v2 is the `docker compose` subcommand; `docker-compose` v1 is not
enough. Then check the default port mappings: `8080` (web), `8788` (api),
`5433` (Postgres), `8123` and `9000` (ClickHouse), `6380` (Redis), `9010` and
`9011` (MinIO). If one is taken, report which service owns it and let the
user decide; do not stop or reconfigure unrelated services.

## 2. Clone or reuse a checkout

Reuse an existing `ironside` checkout if there is one, reporting its branch
and `git status`; do not reset, pull, or discard local changes without asking.
Otherwise:

```sh
git clone https://github.com/luka-zivkovic/ironside.git
cd ironside
```

## 3. Start the stack and verify it

```sh
docker compose up -d --build
docker compose ps
curl --fail http://localhost:8788/health
```

First boot builds the images and initializes storage, which takes a few
minutes; wait until every container reports healthy. If one stays unhealthy,
read `docker compose logs api worker` and report what you found. Named
volumes (`pgdata`, `chdata`, `miniodata`) hold data from earlier runs; leave
them in place. On an incompatible database baseline, stop and point the user
to `docs/pre-production-schema.md` instead of deleting anything.

## 4. Owner setup and first project

Tell the user to generate the one-time setup code in their own terminal:

```sh
docker compose exec api node apps/api/dist/src/scripts/owner-setup.js
```

Do not run this yourself or ask the user to paste the code. It is single-use,
expires after about 15 minutes, and belongs at `http://localhost:8080/setup`,
where the user creates the owner account and then a project. Ironside shows
the project's initial Ingest credential (`ironside_sc_...`) once; it goes in
the application's local environment or secret store as `IRONSIDE_API_KEY`,
not in chat or any Git-tracked file. Check `.gitignore` covers the env file
they choose. The Connections page mints more credentials later: Ingest for
SDKs and exporters, Integration for evaluators.

## 5. Instrument the application

Pick the path that fits the user's app.

**Node.js with OpenAI or Anthropic:**

```sh
npm install ironside
```

```ts
import { init, wrapOpenAI } from "ironside";

const ironside = init({ apiKey: process.env.IRONSIDE_API_KEY, host: "http://localhost:8788" });
const openai = wrapOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), ironside);
// ... use `openai` as usual, then before exit:
await ironside.shutdown();
```

`wrapAnthropic` works the same way for `@anthropic-ai/sdk`. Show the diff
before applying it.

**Anything with an OpenTelemetry trace exporter:** set these in the
application's environment, not the agent's:

```sh
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:8788/v1/otel/traces
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="authorization=Bearer%20${IRONSIDE_API_KEY:?Set IRONSIDE_API_KEY first}"
```

The route is `/v1/otel/traces`, not the base-endpoint-derived `/v1/traces`.
These variables configure an exporter the app already has; they do not add
one. If the app runs in another container or machine, replace `localhost`
with an address it can reach.

## 6. Verify one trace

Have the user run one interaction, flush or shut down the SDK or exporter
before a short-lived process exits, and open the project's trace list at
`http://localhost:8080`. Report success only once the trace is visible. If it
is missing, check the caller's network address, that an Ingest credential
(not Integration) was used, and `docker compose logs api worker`.

## Mistakes to avoid

- Do not print, log, or commit setup codes or `ironside_sc_...` credentials.
- Do not run `docker compose down -v`, prune, or delete volumes to fix a
  problem; explain it and let the user decide.
- Do not register the API, ingest, or OTLP endpoints as an MCP server; they
  are HTTP ingestion APIs, and Ironside ships no MCP server.
- Do not present the localhost defaults as production-ready; point to
  `docs/self-hosting.md` for that.
