import { describe, expect, it, vi } from "vitest";
import { init } from "../src/client.js";
import { wrapAnthropic } from "../src/wrappers/anthropic.js";
import { wrapOpenAI } from "../src/wrappers/openai.js";
import { instrumentAsyncIterable } from "../src/wrappers/streaming.js";
import type { IngestRequestEvent } from "../src/types.js";

// M9-07: streamed calls through wrapOpenAI/wrapAnthropic. These unit tests
// use hand-built async iterables shaped like each SDK's chunk/event
// protocol; test/streaming-conformance.test.ts runs the same flows through
// the REAL openai/@anthropic-ai/sdk clients against a local SSE server.

function mockFetch() {
  const requests: { events: IngestRequestEvent[] }[] = [];
  const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 202 });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function testClient(fetchImpl: typeof fetch) {
  return init({ apiKey: "k", host: "http://localhost:8788", fetchImpl, flushIntervalMs: 60_000 });
}

function endedGeneration(requests: { events: IngestRequestEvent[] }[]) {
  const events = requests.flatMap((r) => r.events);
  return events
    .filter((e) => e.type === "observation-upsert")
    .map((e) => e.body as Record<string, unknown>)
    .find((b) => b.endTime !== undefined);
}

function asyncIterableOf(items: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    }
  };
}

const OPENAI_CHUNKS = [
  { model: "gpt-4o-2024-08-06", choices: [{ delta: { role: "assistant", content: "" } }] },
  { model: "gpt-4o-2024-08-06", choices: [{ delta: { content: "Hello" } }] },
  { model: "gpt-4o-2024-08-06", choices: [{ delta: { content: " world" } }] },
  { model: "gpt-4o-2024-08-06", choices: [{ delta: {}, finish_reason: "stop" }] },
  // stream_options.include_usage shape: final chunk, empty choices, usage.
  { model: "gpt-4o-2024-08-06", choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }
];

describe("wrapOpenAI streaming", () => {
  it("accumulates text deltas and the final usage chunk, ending the generation when iteration completes", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const stream = asyncIterableOf(OPENAI_CHUNKS);
    const fakeOpenAI = {
      chat: { completions: { create: vi.fn(async (..._args: unknown[]) => stream) } }
    };

    const wrapped = wrapOpenAI(fakeOpenAI, ironside);
    const result = (await wrapped.chat.completions.create({
      model: "gpt-4o",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hi" }]
    })) as AsyncIterable<unknown>;

    // Same object back — the wrapper must not replace the stream.
    expect(result).toBe(stream);

    const seen: unknown[] = [];
    for await (const chunk of result) seen.push(chunk);
    expect(seen).toHaveLength(OPENAI_CHUNKS.length); // caller sees every chunk untouched

    await ironside.flush();
    const body = endedGeneration(requests)!;
    expect(body).toBeDefined();
    expect(body.model).toBe("gpt-4o");
    expect(body.output).toEqual({ role: "assistant", content: "Hello world" });
    expect(body.usageDetails).toEqual({ input_tokens: 9, output_tokens: 2 });
    expect(body.metadata).toMatchObject({
      streamed: "true",
      response_model: "gpt-4o-2024-08-06",
      finish_reason: "stop"
    });
  });

  it("assembles streamed tool calls (fragmented arguments, indexed slots)", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const fakeOpenAI = {
      chat: {
        completions: {
          create: vi.fn(async (..._args: unknown[]) =>
            asyncIterableOf([
              { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] } }] },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
            ])
          )
        }
      }
    };

    const wrapped = wrapOpenAI(fakeOpenAI, ironside);
    const result = (await wrapped.chat.completions.create({ model: "gpt-4o", stream: true, messages: [] })) as AsyncIterable<unknown>;
    for await (const _ of result) void _;

    await ironside.flush();
    const body = endedGeneration(requests)!;
    expect(body.output).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }
      ]
    });
    // No usage chunk (caller didn't set include_usage): no usageDetails key.
    expect(body.usageDetails).toBeUndefined();
  });

  it("an n>1 stream records EVERY choice, not just index 0 (review finding)", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const fakeOpenAI = {
      chat: {
        completions: {
          create: vi.fn(async (..._args: unknown[]) =>
            asyncIterableOf([
              // Interleaved deltas across two choices, as the API streams them.
              { choices: [{ index: 0, delta: { content: "first " } }, { index: 1, delta: { content: "second " } }] },
              { choices: [{ index: 1, delta: { content: "answer" } }] },
              { choices: [{ index: 0, delta: { content: "answer" } }] },
              { choices: [{ index: 0, delta: {}, finish_reason: "stop" }, { index: 1, delta: {}, finish_reason: "stop" }] }
            ])
          )
        }
      }
    };

    const wrapped = wrapOpenAI(fakeOpenAI, ironside);
    const result = (await wrapped.chat.completions.create({ model: "gpt-4o", n: 2, stream: true, messages: [] })) as AsyncIterable<unknown>;
    for await (const _ of result) void _;

    await ironside.flush();
    const body = endedGeneration(requests)!;
    expect(body.output).toEqual({
      choices: [
        { index: 0, message: { role: "assistant", content: "first answer" }, finish_reason: "stop" },
        { index: 1, message: { role: "assistant", content: "second answer" }, finish_reason: "stop" }
      ]
    });
  });

  it("an early break still ends the generation with the partial output", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const fakeOpenAI = {
      chat: { completions: { create: vi.fn(async (..._args: unknown[]) => asyncIterableOf(OPENAI_CHUNKS)) } }
    };

    const wrapped = wrapOpenAI(fakeOpenAI, ironside);
    const result = (await wrapped.chat.completions.create({ model: "gpt-4o", stream: true, messages: [] })) as AsyncIterable<unknown>;
    let count = 0;
    for await (const _ of result) {
      void _;
      if (++count === 2) break; // stop after "Hello"
    }

    await ironside.flush();
    const body = endedGeneration(requests)!;
    expect(body.output).toEqual({ role: "assistant", content: "Hello" });
    expect(body.level).toBe("default");
  });

  it("a mid-stream error ends the generation as an error and rethrows to the caller", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "par" } }] };
        throw new Error("connection reset mid-stream");
      }
    };
    const fakeOpenAI = { chat: { completions: { create: vi.fn(async (..._args: unknown[]) => stream) } } };

    const wrapped = wrapOpenAI(fakeOpenAI, ironside);
    const result = (await wrapped.chat.completions.create({ model: "gpt-4o", stream: true, messages: [] })) as AsyncIterable<unknown>;

    await expect(async () => {
      for await (const _ of result) void _;
    }).rejects.toThrow("connection reset mid-stream");

    await ironside.flush();
    const body = endedGeneration(requests)!;
    expect(body.level).toBe("error");
    expect(body.statusMessage).toBe("connection reset mid-stream");
  });

  it("a non-streaming call is unaffected (regression)", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const fakeOpenAI = {
      chat: {
        completions: {
          create: vi.fn(async (..._args: unknown[]) => ({
            model: "gpt-4o",
            choices: [{ message: { content: "hi" } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 }
          }))
        }
      }
    };
    const wrapped = wrapOpenAI(fakeOpenAI, ironside);
    await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });
    await ironside.flush();
    const body = endedGeneration(requests)!;
    expect(body.usageDetails).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect((body.metadata as Record<string, string>).streamed).toBeUndefined();
  });
});

const ANTHROPIC_EVENTS = [
  {
    type: "message_start",
    message: {
      model: "claude-sonnet-5",
      role: "assistant",
      usage: { input_tokens: 12, output_tokens: 1 }
    }
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " there" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "lookup" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"x"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
  { type: "message_stop" }
];

describe("wrapAnthropic streaming", () => {
  it("reassembles the message from the event protocol: model, text + tool_use blocks, usage from message_start + message_delta, stop_reason", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const stream = asyncIterableOf(ANTHROPIC_EVENTS);
    const fakeAnthropic = { messages: { create: vi.fn(async (..._args: unknown[]) => stream) } };

    const wrapped = wrapAnthropic(fakeAnthropic, ironside);
    const result = (await wrapped.messages.create({
      model: "claude-sonnet-5",
      stream: true,
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }]
    })) as AsyncIterable<unknown>;
    expect(result).toBe(stream);

    const seen: unknown[] = [];
    for await (const event of result) seen.push(event);
    expect(seen).toHaveLength(ANTHROPIC_EVENTS.length);

    await ironside.flush();
    const body = endedGeneration(requests)!;
    expect(body.output).toEqual({
      role: "assistant",
      model: "claude-sonnet-5",
      content: [
        { type: "text", text: "Hi there" },
        { type: "tool_use", id: "tu_1", name: "lookup", input: { q: "x" } }
      ],
      stop_reason: "tool_use"
    });
    expect(body.usageDetails).toEqual({ input_tokens: 12, output_tokens: 7 });
    expect(body.metadata).toMatchObject({ streamed: "true" });
  });

  it("an early break mid-tool-call keeps the raw JSON fragment instead of throwing in the finalizer", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const fakeAnthropic = {
      messages: { create: vi.fn(async (..._args: unknown[]) => asyncIterableOf(ANTHROPIC_EVENTS)) }
    };

    const wrapped = wrapAnthropic(fakeAnthropic, ironside);
    const result = (await wrapped.messages.create({ model: "m", stream: true, messages: [] })) as AsyncIterable<unknown>;
    let count = 0;
    for await (const _ of result) {
      void _;
      if (++count === 7) break; // stop after the FIRST input_json_delta ('{"q":')
    }

    await ironside.flush();
    const body = endedGeneration(requests)!;
    const output = body.output as { content: Array<Record<string, unknown>> };
    expect(output.content[1]).toEqual({
      type: "tool_use",
      id: "tu_1",
      name: "lookup",
      input: { __partial_json: '{"q":' }
    });
  });

  it("extended-thinking blocks accumulate thinking_delta text and the signature_delta (review finding)", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const fakeAnthropic = {
      messages: {
        create: vi.fn(async (..._args: unknown[]) =>
          asyncIterableOf([
            { type: "message_start", message: { model: "claude-sonnet-5", usage: { input_tokens: 3, output_tokens: 1 } } },
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me reason" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " step by step." } },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_abc123" } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }
          ])
        )
      }
    };

    const wrapped = wrapAnthropic(fakeAnthropic, ironside);
    const result = (await wrapped.messages.create({ model: "claude-sonnet-5", stream: true, messages: [] })) as AsyncIterable<unknown>;
    for await (const _ of result) void _;

    await ironside.flush();
    const body = endedGeneration(requests)!;
    const output = body.output as { content: unknown[] };
    expect(output.content).toEqual([
      { type: "thinking", thinking: "Let me reason step by step.", signature: "sig_abc123" },
      { type: "text", text: "Answer" }
    ]);
  });

  it("a mid-stream error ends the generation as an error", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield ANTHROPIC_EVENTS[0];
        throw new Error("overloaded_error");
      }
    };
    const fakeAnthropic = { messages: { create: vi.fn(async (..._args: unknown[]) => stream) } };
    const wrapped = wrapAnthropic(fakeAnthropic, ironside);
    const result = (await wrapped.messages.create({ model: "m", stream: true, messages: [] })) as AsyncIterable<unknown>;

    await expect(async () => {
      for await (const _ of result) void _;
    }).rejects.toThrow("overloaded_error");

    await ironside.flush();
    const body = endedGeneration(requests)!;
    expect(body.level).toBe("error");
  });
});

describe("instrumentAsyncIterable", () => {
  it("fires onFinish exactly once even when return() follows exhaustion", async () => {
    const finishes: unknown[] = [];
    const stream = instrumentAsyncIterable(
      asyncIterableOf([1, 2]),
      () => {},
      (outcome) => finishes.push(outcome)
    );
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await iterator.next(); // done -> finish
    await iterator.return?.(undefined); // must not re-finish
    expect(finishes).toEqual([{ consumed: true }]);
  });

  it("a non-iterable value is returned untouched and finishes immediately as unconsumed", () => {
    const finishes: Array<{ consumed: boolean }> = [];
    const value = { not: "a stream" };
    const result = instrumentAsyncIterable(value, () => {}, (o) => finishes.push(o));
    expect(result).toBe(value);
    expect(finishes).toEqual([{ consumed: false }]);
  });
});
