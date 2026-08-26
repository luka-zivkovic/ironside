# Ironside example: minimal chatbot

Demonstrates the exact quickstart from the root [README](../../README.md) — `init()` + `wrapOpenAI()` in 3 lines — against a runnable chatbot backend. `index.js` marks the 3 instrumentation lines with `// [ironside]` comments; everything else is the chatbot as it would exist with zero observability.

## Run it

```sh
# from the repo root
docker compose up -d
pnpm --filter @ironside/api seed   # prints an ironside_sc_... Ingest credential

IRONSIDE_API_KEY=<key printed above> pnpm --filter ironside-example-chatbot start
```

Then open `http://localhost:8080`, sign in as the deployment owner, and select the
project's Trace explorer. Once the worker processes the queued batch, you should
see a trace named `openai.chat.completions.create`; open it to inspect the nested
`generation` observation with the model, input messages, output, and token usage.

`index.js` also demonstrates `trace.score()` — not part of the 3-line quickstart, but every `trace()`/`span()`/`generation()` handle exposes `score()` for recording human feedback or eval results directly (the SDK equivalent of what the LangFuse/LangSmith importers pull in as Score rows). A second trace in the example records a `thumbs-up` score against itself; inspect it in the same Trace explorer.

Known gap in this instrumentation path today (see `ROADMAP.md`'s direct-ingest primacy audit): `wrapOpenAI`/`wrapAnthropic` capture token usage and common sampling parameters (`temperature`, `top_p`, `max_tokens`, etc.) automatically, but not cost — no pricing table exists, since provider per-token pricing changes independently of Ironside releases; pass `costDetails` via a manual `generation.end()` call if you need it. Streaming calls (`stream: true`) are not traced yet.
