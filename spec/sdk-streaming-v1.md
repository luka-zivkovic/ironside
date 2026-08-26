# SDK Streaming Support v1 (M9-07)

Status: implemented. Owner: `packages/sdk/src/wrappers/streaming.ts`, `openai.ts`, `anthropic.ts`.

## Problem

Real chat apps stream by default. Before this, `wrapOpenAI`/`wrapAnthropic` detected `stream: true` and skipped recording entirely (one-time warning) — the biggest first-user gap in the primary SDK path (flagged in spec/direct-ingest-primacy-v1.md).

## Design

**The stream's `[Symbol.asyncIterator]` is patched in place and the same object is returned.** Both provider SDKs return a `Stream` class with API surface beyond iteration (`.tee()`, `.controller`, `.toReadableStream()`); returning a wrapper generator would silently break all of it. In-place patching preserves object identity — proven by a conformance test that calls `.tee()` on a wrapped real `openai@6` Stream and consumes both branches.

Accumulation happens as the **caller** iterates (the wrapper never consumes the stream itself — no buffering, no backpressure change). Three exits funnel into exactly one `generation.end()`:

- **done** → end with accumulated output/usage
- **early `break`** (iterator `return()`) → end with the partial output accumulated so far — the honest record of what the caller actually received
- **mid-stream error** (`next()` rejection or `throw()`) → end with `level: "error"` and the message, then rethrow to the caller

A stream the caller **never iterates** records its start event but never ends — visible as a dangling in-progress generation, which is the true representation (nothing was ever received).

### OpenAI (`ChatCompletionChunk`)

- Choices are accumulated **per `choice.index`** — an `n>1` request streams every choice's deltas interleaved, so reading only `choices[0]` would silently truncate the response (review finding, fixed + regression-tested). Single choice (the common case) records the assistant message directly as output; `n>1` records `{choices: [{index, message, finish_reason}]}` mirroring the non-streaming shape.
- Text: `delta.content` concatenated per choice.
- Tool calls: `delta.tool_calls` fragments merged by `index` slot (`function.arguments` string fragments concatenated) — agents stream tool calls constantly; dropping them would gut the feature.
- Usage: from the final empty-`choices` chunk — **only present when the caller set `stream_options: {include_usage: true}`**. The wrapper deliberately does NOT inject that option: a tracing wrapper mutating the wire request can break OpenAI-compatible backends that reject unknown fields. Without it, output is recorded but `usageDetails` is absent.
- Recorded output shape: `{ role: "assistant", content: string|null, tool_calls?: [...] }`; the response-model snapshot and `finish_reason` go to metadata (`response_model`, `finish_reason`), and every streamed generation carries `metadata.streamed: "true"`.

### Anthropic (`RawMessageStreamEvent` protocol)

Reassembles the Message from the event protocol: `message_start` (model, `usage.input_tokens`), `content_block_start`/`content_block_delta` (text blocks via `text_delta`; `tool_use` blocks via `input_json_delta` `partial_json` fragments, parsed at the end), `message_delta` (cumulative `usage.output_tokens`, `stop_reason`). Extended-thinking blocks are fully supported: `thinking_delta` text accumulates and the final `signature_delta` is captured — the signature is required to round-trip a thinking block in later turns, so dropping it would make the recorded output unusable as replay input (review finding, fixed + regression-tested). `redacted_thinking` blocks arrive complete at `content_block_start` and are kept via the unknown-block fallback. Unlike OpenAI, **streamed Anthropic calls always record full usage** — the protocol carries it unconditionally. An early break mid-tool-call keeps the raw fragment as `{__partial_json: "..."}` rather than throwing in the finalizer or dropping it. Unknown future block types are kept as-is (their deltas aren't understood, but the block's existence is data).

Not covered: Anthropic's `messages.stream()` helper (separate request path — only `create()` is patched) and OpenAI's Responses API (`client.responses.create`, same status as the non-streaming wrapper). `recordGenerateTextResult` (Vercel AI SDK) is unchanged — it records a completed result and has no interception point; a `streamText` recorder would be a new API, out of M9 scope.

## Known limits (deliberate)

- **`.tee()` + wrapped**: both branches iterate through the patched iterator, so one accumulator sees chunks twice (double-counted text). `finalize` still fires exactly once. Correct-single-stream beats a per-iterator accumulator that couldn't merge usage sanely.
- **`toReadableStream()`/direct reader consumption** bypasses the async iterator → the generation dangles unfinished (same as never iterating).
- No `stream_options.include_usage` auto-injection (above).

## Review findings (PR #39)

Two must-fix data-loss findings, both fixed with regression tests: (1) OpenAI `n>1` streams truncated to `choices[0]`; (2) Anthropic `thinking_delta`/`signature_delta` silently dropped for extended-thinking models. Reviewer also verified: `finishOnce`-before-`inner.return()` doesn't break the SDKs' connection-abort cleanup (openai's generator `finally` still fires); the `!consumed` fallback doesn't lose input (`end()` re-emits `startOptions.input`); sparse tool-call arrays densify safely; the `never[]` constraint isn't vacuous (structurally wrong clients still fail to type-check). A second sequential full iteration of an already-consumed stream double-feeds the accumulator without re-finalizing — unreachable through the real SDKs (both throw "Cannot iterate over a consumed stream"), noted here for completeness.

## Verification

- `packages/sdk/test/streaming.test.ts` — unit: text+usage accumulation, fragmented tool-call assembly, early break (partial output, `level: default`), mid-stream error (`level: error` + rethrow), non-streaming regression, finalize-exactly-once, non-iterable fallback.
- `packages/sdk/test/streaming-conformance.test.ts` — the REAL `openai@6` and `@anthropic-ai/sdk@0.111` clients (devDeps) parse real SSE from a local HTTP server through the wrapped clients: proves the in-place patch works on the SDKs' actual Stream classes and the accumulated shapes are what those SDKs actually yield; includes the `.tee()`-still-works proof.
- Full suite green.
