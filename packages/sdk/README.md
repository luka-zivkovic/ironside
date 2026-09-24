# `ironside`

The official Node.js/TypeScript client for sending LLM traces directly to Ironside. It provides automatic OpenAI and Anthropic instrumentation, manual trace/span/generation handles, media uploads, and score recording.

Requires Node.js 20 or newer. The package is ESM-only.

## Install

Install the SDK together with whichever provider client your application uses:

```sh
npm install ironside openai
# or: npm install ironside @anthropic-ai/sdk
```

Provider packages are not runtime dependencies of `ironside`; the wrappers accept the client instance already used by your application.

## Provider wrappers

```ts
import OpenAI from "openai";
import { init, wrapOpenAI } from "ironside";

const ironside = init({
  apiKey: process.env.IRONSIDE_API_KEY!,
  host: process.env.IRONSIDE_HOST ?? "http://localhost:8788",
  onError(error) {
    console.error("Ironside ingest failed", error);
  }
});

const openai = wrapOpenAI(
  new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  ironside
);

await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }]
});

await ironside.shutdown();
```

`wrapAnthropic(client, ironside)` instruments `messages.create()` in the same way. Both wrappers mutate and return the same provider client, preserve streaming behavior, and record input/output, model, token usage, and common sampling parameters. For OpenAI streaming token usage, request `stream_options: { include_usage: true }`.

## Manual instrumentation

```ts
import { init } from "ironside";

const ironside = init({
  apiKey: process.env.IRONSIDE_API_KEY!,
  host: "https://ironside.example.com"
});

const trace = ironside.trace({
  name: "answer-question",
  userId: "user-123",
  input: { question: "Why is the sky blue?" }
});

const generation = trace.generation({
  name: "generate-answer",
  model: "example-model",
  input: { prompt: "Why is the sky blue?" }
});

generation.end({
  output: { answer: "Rayleigh scattering." },
  usageDetails: { input_tokens: 8, output_tokens: 4 },
  // Optional: omit it and Ironside derives cost from usageDetails and the model name.
  costDetails: { input: 0.00008, output: 0.00004, total: 0.00012 }
});

trace.score({ name: "correctness", value: 1, source: "eval" });
trace.update({ output: { answer: "Rayleigh scattering." } });

await ironside.shutdown();
```

Instrumentation calls buffer events and do not block application requests. Call `flush()` at a lifecycle boundary when needed, and always call `shutdown()` during graceful process termination so buffered and in-flight events finish sending. Failed background batches are reported through `onError`; they are not thrown into the instrumented request path.

### Delivery and retries

A batch that fails with a network error, `408`, `429`, or a `5xx` response is retried with exponential backoff; a server `Retry-After` header sets the wait instead. Retries are safe: every event carries a client-generated id, so a batch the server already accepted updates the same records rather than duplicating them. Other `4xx` responses are not retried. A batch is reported through `onError` only after its last attempt fails.

| Option | Default | Effect |
| --- | --- | --- |
| `maxBatchSize` | `50` | Events per request; a full buffer is sent at once. At most `500`, the API's limit per request. |
| `flushIntervalMs` | `5000` | Sends the buffer at least this often. `Infinity` sends only when the buffer is full, on `flush()`, and on `shutdown()`. |
| `maxRetries` | `5` | Retries after the first attempt; `0` disables retrying. |
| `retryDelayMs` | `500` | Base backoff delay, doubled on each retry. |
| `maxQueuedEvents` | `10000` | Events held in memory while sends are pending. New events beyond it are dropped and reported through `onError` on the next flush. |
| `flushTimeoutMs` | `10000` | Longest `flush()` waits for delivery of everything buffered or already being sent. Events not yet delivered keep retrying in the background, so an awaited `flush()` cannot hold a request open through an outage. |
| `shutdownTimeoutMs` | `10000` | Longest `shutdown()` waits for sends and retries. When it expires, the pending request is cancelled and unsent batches are reported through `onError`. |

Both timeouts accept `Infinity` to wait indefinitely. A pending retry keeps the Node.js process alive the same way an in-flight request does. In serverless functions, set `flushTimeoutMs` and `shutdownTimeoutMs` below the platform's function timeout. An `onError` handler that throws or returns a rejected promise is ignored rather than stopping delivery.

`recordGenerateTextResult()` is available for results returned by the Vercel AI SDK. `uploadMedia()` stores binary content separately and returns an `ironside://media/...` reference suitable for trace input or output.

## Choosing an integration

This package is the ergonomic Node.js integration and supports Ironside-specific cost and score fields. Third-party frameworks and non-Node runtimes should prefer Ironside's canonical OTLP/HTTP endpoint with OpenTelemetry `gen_ai.*` attributes. Low-level integrations can send the native JSON envelope directly at `POST /api/v1/ingest`.

## License

[MIT License](./LICENSE.md).
