# Tracing n8n AI workflows with Ironside

n8n has no native tracing integration, but its ecosystem's standard answer — the
[`n8n-nodes-openai-langfuse`](https://www.npmjs.com/package/n8n-nodes-openai-langfuse)
community node — speaks the LangFuse ingestion protocol, which Ironside
implements. Point its "Langfuse Base URL" at Ironside and every model call in
your workflows lands as a full trace: input/output, model, token usage,
session and user IDs, and your custom metadata.

Everything below was verified against a real n8n (v2.29) container running the
real community node — not against fixtures. No Ironside-side changes were
needed; the wire traffic worked as-is.

## 1. Install the community node

Self-hosted n8n (Settings → Community Nodes → Install, or on the host):

```sh
cd ~/.n8n/nodes   # create it if it doesn't exist
npm install n8n-nodes-openai-langfuse
# restart n8n
```

## 2. Create the credential

Add an **OpenAI With Langfuse** credential in n8n:

| Field | Value |
|---|---|
| OpenAI API Key | your real provider key |
| OpenAI Base URL | `https://api.openai.com/v1` (or any OpenAI-compatible endpoint) |
| Langfuse Base URL | your Ironside host, e.g. `https://ironside.example.com` |
| Langfuse Public Key | anything (e.g. `pk-ironside`) — **ignored by Ironside** |
| Langfuse Secret Key | an Ironside Ingest credential (`ironside_sc_...`) |

Ironside has no public/secret key pair: LangFuse-style Basic auth is accepted
with the real `ironside_sc_*` credential in the secret slot and the public slot
ignored (see `spec/langfuse-compat-v1.md`).

## 3. Use the model node in your workflow

In any AI Agent / LLM Chain workflow, use **OpenAI Langfuse Model** as the
language-model sub-node instead of the stock OpenAI model node. Its
**Langfuse Metadata** section takes `sessionId`, `userId`, and a custom
metadata JSON object — all of which land on the Ironside trace as
`session_id`, `user_id`, and metadata keys, alongside what LangChain itself
reports (`ls_provider`, `ls_model_name`, node name, execution id).

What the verified trace looks like in Ironside:

- **trace**: name `[<workflow name>] <node name>`, `user_id`/`session_id` from
  the metadata section, custom metadata merged in
- **generation**: model, full input/output messages, canonical usage keys
  (`input_tokens`/`output_tokens`/`total_tokens`) — cross-source aggregation
  works out of the box

## 4. Record eval / feedback scores from n8n

Ironside stores scores (it never computes them — bring your own judge, human
feedback, or eval system). From n8n, a plain HTTP Request node posts to the
LangFuse-compatible scores endpoint:

- **URL**: `POST https://<your-ironside-host>/api/public/scores`
- **Auth**: Generic Credential → HTTP Basic Auth (username: anything,
  password: your `ironside_sc_*` Integration credential)
- **Body**: `{ "traceId": "...", "name": "user-feedback", "value": 1, "comment": "..." }`
  (`value` takes a number for numeric scores or a string for categorical ones —
  same convention as LangFuse's own API)

[`n8n-score-template.json`](./n8n-score-template.json) is a ready-to-import
two-node workflow (Webhook → HTTP Request) that accepts
`{traceId, value, name?, comment?}` on a webhook and records it as a score —
wire your feedback UI, eval workflow, or a downstream judge to it. After
importing: set the URL to your Ironside host and attach your Basic-auth
credential. Verified live: a POST to the webhook produced the score row in
Ironside, attached to the right trace.

## Caveats

- **Traces flush on an interval.** The langfuse SDK inside the community node
  batches events (up to 15 events / ~10s). A long-running n8n server delivers
  everything; one-shot `n8n execute` CLI runs exit before the flush fires and
  lose the trace (verified — this is an n8n-CLI-lifecycle artifact, not an
  ingestion failure). If you script workflows headlessly, keep the process
  alive a few seconds past completion.
- The community node covers OpenAI-compatible chat models. For other model
  nodes, the same LangFuse credential pattern works with any
  `langfuse-langchain` CallbackHandler you attach in a LangChain Code node.
- n8n's own AI Builder / evaluation features don't emit external traces today;
  when they grow an export, Ironside's LangFuse-compat and OTLP endpoints are
  the natural targets.
