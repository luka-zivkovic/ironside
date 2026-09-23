# Install Ironside with your coding agent

[← README](../README.md) · [Self-hosting](self-hosting.md) · [SDK guide](../packages/sdk/README.md)

Ironside runs as a Docker Compose stack. Claude Code, Codex, or another coding
agent with a shell can clone it, start the services, and help instrument your
application. This does not require MCP.

## Claude Code: install the plugin

Ironside publishes a Claude Code plugin marketplace from this repository. In
Claude Code, run:

```text
/plugin marketplace add luka-zivkovic/ironside
/plugin install ironside@ironside
```

Then run `/ironside:setup` in your projects directory (or an existing
checkout). The `setup` skill follows the steps in this guide: it checks Git,
Docker Compose v2, and port collisions, clones or reuses a checkout, starts
the stack, verifies health, guides owner setup and project creation, and
instruments your application with the SDK or OTLP. It keeps setup codes and
credentials out of chat and Git and asks before anything destructive. The
plugin source lives in [`plugins/ironside`](../plugins/ironside).

## Other agents: paste a prompt

Open the agent in your projects directory and paste:

```text
Install Ironside locally from https://github.com/luka-zivkovic/ironside.
Read README.md and docs/agent-setup.md first. Check Git, Docker with Compose
v2, and the port mappings in docker-compose.yml. Preserve existing
checkouts, configuration, volumes, and running services.

Build and start the Compose stack. Verify docker compose ps and the API
health endpoint, then guide me through owner setup and project creation.
Keep setup codes and credentials out of chat and Git. Help me instrument
my application with the SDK or OTLP and verify one trace in the viewer.
Explain where each process runs.
```

For **Codex CLI**, run `codex`; in a desktop or IDE harness, open the
directory and start a task there. Other harnesses use the same prompt if they
can read files and execute commands. Claude Code users can also paste this
prompt instead of installing the plugin.

You need Git and Docker with Compose v2. Node.js and pnpm are only needed on
the host for developing Ironside itself. Commands below assume a POSIX shell.

## What the agent will run

```sh
git clone https://github.com/luka-zivkovic/ironside.git
cd ironside
docker compose up -d --build
docker compose ps
curl --fail http://localhost:8788/health
```

First boot builds the application and initializes storage. Wait until the
services report healthy. The stack contains Postgres, ClickHouse, Redis,
MinIO, and the API, worker, and web services.

| Surface | Local address | Purpose |
| --- | --- | --- |
| Web app | `http://localhost:8080` | Owner setup, projects, trace viewer, and Connections. |
| API | `http://localhost:8788` | Native ingestion, OTLP, integrations, and health. |

These are localhost development defaults. Compose also maps infrastructure
ports and uses development credentials. Review
[production considerations](self-hosting.md#production-considerations) before
exposing an installation on a network.

## Create your owner account and project

Generate the setup code in a private local terminal:

```sh
docker compose exec api node apps/api/dist/src/scripts/owner-setup.js
```

Open `http://localhost:8080/setup`, enter the one-time code, and create the
owner account. The code expires after 15 minutes by default. Create a project
in the UI and save its initial **Ingest** credential when it is shown. The
plaintext is returned once.

The project's **Connections** page offers two presets:

| Preset | Capabilities | Use it for |
| --- | --- | --- |
| Ingest | `ingest`, `media:write` | SDKs, OTLP exporters, and session importers. |
| Integration | `traces:read`, `scores:write` | Evaluator integrations such as Rubrist. |

Keep the credential in your application's local environment or secret store
as `IRONSIDE_API_KEY`. It is separate from the owner's browser session and
any model-provider key. Copy the exact connection snippet from the UI.

## Send and inspect one trace

For a Node.js application, follow the [SDK example](../README.md#instrument-your-app)
to wrap OpenAI or Anthropic calls. For a framework with an OpenTelemetry trace
exporter, set these in the **application's** environment:

```sh
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:8788/v1/otel/traces
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="authorization=Bearer%20${IRONSIDE_API_KEY:?Set IRONSIDE_API_KEY first}"
```

Use the signal-specific endpoint exactly as shown: `/v1/otel/traces`. These
variables configure an existing exporter; they do not instrument an app that
has no exporter installed.

Run one application interaction, flush the SDK/exporter before a short-lived
process exits, and find the trace in the viewer. If the caller runs in another
container or machine, replace `localhost` with an address it can reach. A
remote agent cannot use its own `localhost` to reach your laptop's services.

## Capture coding-agent sessions

Installing Ironside does not automatically record the agent that installed
it. Overclock's optional
[eval-stack plugin](https://github.com/luka-zivkovic/overclock/tree/master/plugins/eval-stack)
provides a separate setup workflow, Claude Code and Codex session importers,
and a pi tracing extension.

In Claude Code:

```text
/plugin marketplace add luka-zivkovic/overclock
/plugin install eval-stack@overclock
```

Then ask it to read the installed `local-eval-stack` skill and connect the chosen
session source to your existing local Ironside instance. For Codex or another
Agent Skills host, install the complete
[`local-eval-stack` skill folder](https://github.com/luka-zivkovic/overclock/tree/master/plugins/eval-stack/skills/local-eval-stack)
using that host's documented installation method. Read its current
instructions before configuring capture: source formats and capture modes
differ by harness. This is an Overclock workflow, not an Ironside component.

## Where MCP fits

**Ironside currently has no bundled Model Context Protocol (MCP) server.**
Do not register its API origin, native ingest route, or OTLP endpoint as an
HTTP MCP server: those endpoints speak different protocols.

| Need | Current route |
| --- | --- |
| Install a local instance with an agent | Shell and Compose. |
| Send application traces | Native SDK, JSON ingest, or OTLP. |
| Capture coding-agent sessions | Overclock's optional importers or tracing extension. |
| Let an evaluator read traces and write scores | Ironside's versioned evaluator API with an Integration credential. |
| Call evaluation tools through MCP | A separate Rubrist instance and its stdio MCP server. |

Connect the Ironside project in **Rubrist's Integrations** screen using an
Ironside Integration credential and an evaluator selection. Then register
[Rubrist's MCP server](https://github.com/luka-zivkovic/rubrist/tree/main/tools/mcp)
in your harness using a **Rubrist project key**. This exposes Rubrist tools;
it does not expose Ironside's entire API or manage Ironside through MCP.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Port conflict | Compare running services with `docker-compose.yml`; preserve unrelated services. |
| Unhealthy container | Inspect `docker compose logs api worker` and the affected infrastructure service. |
| Rejected setup code | Generate a fresh code from this installation; it is single-use and expires. |
| Unauthorized ingestion | Use the project's current Ingest credential, not an Integration credential. |
| Missing trace | Check the caller's network address, flush the exporter, and inspect API/worker logs. |
| Incompatible database baseline | Consult the [schema policy](pre-production-schema.md); do not automatically delete volumes. |

See [self-hosting](self-hosting.md) for recovery, credential rotation, backups,
and persistent deployment options.
