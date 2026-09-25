# SDK Streaming v1

Status: implemented. Owner: `packages/sdk/src/wrappers/streaming.ts`, `packages/sdk/src/wrappers/openai.ts`, `packages/sdk/src/wrappers/anthropic.ts`.

## Purpose

`wrapOpenAI` and `wrapAnthropic` record streamed calls (`create({ ..., stream: true })`) as generations, with output, tool calls and usage, without changing the stream the caller receives. The wrapped `create` returns the SDK's own `APIPromise`, so `.withResponse()`, `.asResponse()` and the SDKs' helpers built on them work through a wrapper (see "APIPromise" below). Chat applications usually stream, so a wrapper that only recorded non-streaming calls would miss most real traffic.

## Instrumentation

`create()` returns the provider SDK's own `Stream` object, instrumented in place (`instrumentAsyncIterable`). Both SDKs' `Stream` classes have API beyond iteration, such as `.tee()`, `.controller` and `.toReadableStream()`, which a wrapper generator would break. Both keep their iterator factory as an instance `iterator` method, which `[Symbol.asyncIterator]()` and `tee()` call and `toReadableStream()` reaches through `[Symbol.asyncIterator]`, so the wrapper instruments `iterator`: every way of reading the stream is recorded, and a tee'd stream once, since `tee()` reads the one underlying iterator for both branches. `[Symbol.asyncIterator]` is patched as well, in case a stream's does not go through `iterator`; an iterator the patched `iterator` already made is passed through, so each chunk is recorded once either way. Any other async iterable gets only `[Symbol.asyncIterator]` patched.

- The wrapper never reads the stream itself. It accumulates chunks as the caller iterates, so buffering and backpressure are unchanged.
- The generation starts when `create()` is called, with the same name, model, input and sampling parameters as a non-streaming call (`spec/direct-ingest-primacy-v1.md`). It ends exactly once, on the first of:
  - completion: the accumulated output and usage;
  - early exit (`break`, which calls the iterator's `return()`): the partial output accumulated so far, with `level: "default"`. The wrapper then forwards `return()` to the SDK's iterator so its connection cleanup still runs;
  - error (`next()` rejects, or `throw()` is called): `level: "error"` with the error message as `statusMessage`, and the error is rethrown to the caller.
- If `create()` itself throws, the generation ends as an error and the error is rethrown, as for a non-streaming call.
- A stream the caller never iterates records its start and never ends. It appears as an in-progress generation, which is accurate: nothing was received.
- If the returned value is not async-iterable (an unexpected SDK shape), it is returned untouched and the generation ends at once, so the wrapper does not leave it open.
- A streamed generation that does not end in an error carries `metadata.streamed: "true"`. An error end records only the level and message.

## OpenAI

`ChatCompletionChunk` streams are accumulated per `choice.index`, because a request with `n > 1` interleaves every choice's deltas in one sequence.

- Text: `delta.content` is concatenated per choice. `content` is null when a choice received no content delta.
- Tool calls: `delta.tool_calls` fragments are merged by their `index` slot; `id`, `type` and `function.name` are taken when present, and `function.arguments` fragments are concatenated.
- Usage: read from the chunk that carries `usage` (the final chunk, with empty `choices`), which OpenAI sends only when the caller sets `stream_options: { include_usage: true }`. The wrapper does not add that option: changing the request could break OpenAI-compatible backends that reject unknown fields. Without it, output is recorded and `usageDetails` is absent. `prompt_tokens` and `completion_tokens` are stored as `input_tokens` and `output_tokens`.
- Output: with one choice (or none), the assistant message `{ role: "assistant", content: string | null, tool_calls?: [...] }`. With several, `{ choices: [{ index, message, finish_reason? }] }`, mirroring the non-streaming shape.
- Metadata: `streamed`, `response_model` (the model reported on the chunks), and for a single choice its `finish_reason`.

## Anthropic

The message is reassembled from the `RawMessageStreamEvent` protocol:

- `message_start`: the response model and `usage.input_tokens` (and `usage.output_tokens` when present).
- `content_block_start` opens a block at its index. `text`, `tool_use` (with `id` and `name`) and `thinking` blocks are accumulated. Any other block type, such as `redacted_thinking`, which arrives complete, is kept as sent.
- `content_block_delta`: `text_delta` appends text, `input_json_delta` appends `partial_json` to a tool-use block, `thinking_delta` appends thinking text, and `signature_delta` sets the thinking block's signature. The signature is required to send a thinking block back in a later turn, so the recorded output can be replayed.
- `message_delta`: the cumulative `usage.output_tokens` (and `usage.input_tokens` when present) and `stop_reason`.
- Output: `{ role: "assistant", model?, content: [...blocks], stop_reason? }`. A tool-use block's `input` is parsed from its accumulated JSON (`{}` when empty). JSON that does not parse, as after a break in the middle of a tool call, is kept as `{ __partial_json: "<fragment>" }` instead of throwing in the finalizer.
- Usage: `input_tokens` and `output_tokens` are always recorded, because the protocol carries them whether or not the caller asks. Anthropic's cache token counts are not recorded.
- Metadata: `streamed`.

## APIPromise

Both SDKs' `create()` returns an `APIPromise`, a `Promise` with extra methods that callers and the SDKs' own helpers use: Anthropic's `messages.stream()` calls `create({ ..., stream: true }).withResponse()`, and OpenAI's `chat.completions.parse()` calls `create(...)._thenUnwrap(...)`. The wrapped `create` is not `async`: it derives its result with the SDK's own `_thenUnwrap` (`wrappers/api-promise.ts`, `recordResult`), so the caller gets an `APIPromise` with every method, and the SDK helpers are recorded like the `create()` calls they make.

- The result is recorded when the caller reads it (awaiting it, `.withResponse()`, or a helper), as before.
- A failed request is recorded as an error through `.asResponse()`, which does not read the response body, also when the caller never reads the result.
- A caller that reads only the raw response (`.asResponse()`) never parses the result, so its generation stays open, like a stream that is never iterated. A response body that fails to parse is not recorded either.
- A value that is not an `APIPromise` (another SDK version, a test double) is handled as a plain promise.

## Not covered

- OpenAI's Responses API (`client.responses.create`) is not wrapped, streaming or not.
- `recordGenerateTextResult` (Vercel AI SDK) records a completed result. It has no interception point, so there is no streaming recorder for `streamText`.

## Known limits

- `.tee()`: the generation ends when the underlying iterator does. If no branch reads to the end, it never does, and the generation stays open like an unconsumed stream. The SDKs' tee branches have no `return()`, so a `break` in a branch neither records the partial output nor cancels the request; that is the SDKs' behavior with or without the wrapper.
- `.toReadableStream()` in both SDKs iterates through `[Symbol.asyncIterator]`, so a stream consumed that way is recorded like a `for await` loop.
- `stream_options.include_usage` is never injected (see OpenAI).

## Verified

`packages/sdk/test/streaming.test.ts` covers OpenAI text and usage accumulation, fragmented tool-call assembly, `n > 1` streams recording every choice, early break (partial output, `level: "default"`), a mid-stream error (`level: "error"` and rethrow), and an unaffected non-streaming call; Anthropic reassembly of text and tool-use blocks with usage from `message_start` and `message_delta`, a break in the middle of a tool call, thinking and signature deltas, and a mid-stream error; and `instrumentAsyncIterable` finishing exactly once and handling a non-iterable value. `packages/sdk/test/streaming-conformance.test.ts` runs the real `openai` 6 and `@anthropic-ai/sdk` 0.111 clients (dev dependencies) against SSE from a local HTTP server through the wrapped clients, proving the in-place patch works on their `Stream` classes and the recorded shapes match what they yield; its `.tee()` tests check, for both SDKs, that both branches yield the full stream and that a tee'd stream is recorded once, and an Anthropic stream read through `toReadableStream()` is recorded once as well. `streaming.test.ts` also checks that a stream-shaped object records each chunk once whether or not its `[Symbol.asyncIterator]` goes through its `iterator`. `packages/sdk/test/wrappers.test.ts` checks that a streaming call returns the same stream object. `packages/sdk/test/api-promise-conformance.test.ts` runs both real SDKs through the wrapped clients against a local server returning JSON, SSE or a 500: Anthropic's `messages.stream()` and `create().withResponse()`, OpenAI's `chat.completions.parse()`, `chat.completions.stream()` and `create().withResponse()` each work and are recorded once; `.asResponse()` returns the response with its body unread; and a failed request is recorded once as an error, also when its result is never read.

## History

- M9-07 added streaming support. Before it, the wrappers detected `stream: true`, skipped recording, and logged a one-time warning; the M4-05 audit listed this as the largest gap in the primary SDK path (`spec/direct-ingest-primacy-v1.md`).
- Review of PR #39 found two data-loss bugs, both fixed with regression tests: OpenAI `n > 1` streams were truncated to `choices[0]`, and Anthropic `thinking_delta`/`signature_delta` content was dropped for extended-thinking models.
- This spec earlier stated that `.tee()` branches feed one accumulator twice and that `.toReadableStream()` bypasses the patched iterator. Against `openai` 6.46.0 and `@anthropic-ai/sdk` 0.111.0 the reverse holds: `tee()` reads the instance `iterator` directly, and `.toReadableStream()` goes through `[Symbol.asyncIterator]` (see Instrumentation).
- A stream consumed only through `.tee()` branches used to be left unrecorded, because the wrapper patched `[Symbol.asyncIterator]`, which `tee()` does not call. The wrapper now instruments the streams' `iterator` method.
- The wrapped `create` used to be `async`, returning a plain `Promise`: Anthropic's `messages.stream()` and OpenAI's `chat.completions.parse()` threw on a wrapped client (`withResponse is not a function`, `_thenUnwrap is not a function`), and this spec wrongly said `messages.stream()` built its own request path. It now keeps the `APIPromise`.
