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
  costDetails: { total_usd: 0.00012 }
});

trace.score({ name: "correctness", value: 1, source: "eval" });
trace.update({ output: { answer: "Rayleigh scattering." } });

await ironside.shutdown();
```

Instrumentation calls buffer events and do not block application requests. Call `flush()` at a lifecycle boundary when needed, and always call `shutdown()` during graceful process termination so buffered and in-flight events finish sending. Failed background batches are reported through `onError`; they are not thrown into the instrumented request path.

`recordGenerateTextResult()` is available for results returned by the Vercel AI SDK. `uploadMedia()` stores binary content separately and returns an `ironside://media/...` reference suitable for trace input or output.

## Choosing an integration

This package is the ergonomic Node.js integration and supports Ironside-specific cost and score fields. Third-party frameworks and non-Node runtimes should prefer Ironside's canonical OTLP/HTTP endpoint with OpenTelemetry `gen_ai.*` attributes. Low-level integrations can send the native JSON envelope directly at `POST /api/v1/ingest`.

## License

[Ironside Sustainable Use License v1.0](./LICENSE.md), including its SDK Integration Exception for embedding and distributing this package as part of commercial applications that send telemetry to Ironside.
