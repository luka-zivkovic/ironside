import { describe, expect, it, vi } from "vitest";
import { init } from "../src/client.js";
import { recordGenerateTextResult } from "../src/wrappers/vercel-ai.js";
import { wrapAnthropic } from "../src/wrappers/anthropic.js";
import { wrapOpenAI } from "../src/wrappers/openai.js";
import type { IngestRequestEvent } from "../src/types.js";

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

describe("wrapOpenAI", () => {
  it("records a generation with model, input, output, and normalized usage (prompt_tokens/completion_tokens -> input_tokens/output_tokens)", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);

    const fakeOpenAI = {
      chat: {
        completions: {
          create: vi.fn(async (..._args: unknown[]) => ({
            model: "gpt-4o",
            choices: [{ message: { content: "hi" } }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
          }))
        }
      }
    };

    const wrapped = wrapOpenAI(fakeOpenAI, ironside);
    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }]
    });
    await ironside.flush();

    const events = requests.flatMap((r) => r.events);
    const generationEvent = [...events].reverse().find((e) => e.type === "observation-upsert");
    const body = generationEvent?.body as {
      model: string;
      input: unknown;
      output: unknown;
      usageDetails: Record<string, number>;
    };
    expect(body.model).toBe("gpt-4o");
    expect(body.input).toEqual([{ role: "user", content: "hello" }]);
    expect(body.usageDetails).toEqual({ input_tokens: 10, output_tokens: 20 });
  });

  it("records request sampling parameters (temperature, max_tokens, ...) as modelParameters", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const fakeOpenAI = {
      chat: {
        completions: {
          create: vi.fn(async (..._args: unknown[]) => ({
            model: "gpt-4o",
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          }))
        }
      }
    };

    const wrapped = wrapOpenAI(fakeOpenAI, ironside);
    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      temperature: 0.7,
      max_tokens: 512,
      top_p: 0.9,
      seed: 42
    });
    await ironside.flush();

    const events = requests.flatMap((r) => r.events);
    const generationEvent = [...events].reverse().find((e) => e.type === "observation-upsert");
    const body = generationEvent?.body as { modelParameters: Record<string, unknown> };
    expect(body.modelParameters).toEqual({ temperature: 0.7, max_tokens: 512, top_p: 0.9, seed: 42 });
  });

  it("omits modelParameters entirely when no sampling parameters were passed on the request", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const fakeOpenAI = {
      chat: { completions: { create: vi.fn(async (..._args: unknown[]) => ({ model: "gpt-4o", usage: {} })) } }
    };

    const wrapped = wrapOpenAI(fakeOpenAI, ironside);
    await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });
    await ironside.flush();

    const events = requests.flatMap((r) => r.events);
    const generationEvent = [...events].reverse().find((e) => e.type === "observation-upsert");
    expect((generationEvent?.body as { modelParameters?: unknown }).modelParameters).toBeUndefined();
  });

  it("returns the same client reference (patches in place) rather than a copy", () => {
    const { fetchImpl } = mockFetch();
    const ironside = testClient(fetchImpl);
    const fakeOpenAI = { chat: { completions: { create: vi.fn() } } };

    const wrapped = wrapOpenAI(fakeOpenAI, ironside);
    expect(wrapped).toBe(fakeOpenAI);
  });

  it("still returns the underlying result to the caller, unmodified", async () => {
    const { fetchImpl } = mockFetch();
    const ironside = testClient(fetchImpl);
    const expectedResult = { model: "gpt-4o", choices: [{ message: { content: "hi" } }] };
    const fakeOpenAI = {
      chat: { completions: { create: vi.fn(async (..._args: unknown[]) => expectedResult) } }
    };

    const wrapped = wrapOpenAI(fakeOpenAI, ironside);
    const result = await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });
    expect(result).toBe(expectedResult);
  });

  it("records an error-level generation and still rethrows when the underlying call fails", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const fakeOpenAI = {
      chat: {
        completions: {
          create: vi.fn(async (..._args: unknown[]) => {
            throw new Error("rate limited");
          })
        }
      }
    };

    const wrapped = wrapOpenAI(fakeOpenAI, ironside);
    await expect(
      wrapped.chat.completions.create({ model: "gpt-4o", messages: [] })
    ).rejects.toThrow("rate limited");
    await ironside.flush();

    const events = requests.flatMap((r) => r.events);
    const generationEvent = [...events].reverse().find((e) => e.type === "observation-upsert");
    const body = generationEvent?.body as { level: string; statusMessage: string };
    expect(body.level).toBe("error");
    expect(body.statusMessage).toBe("rate limited");
  });

  it("attaches the generation to a caller-supplied trace instead of creating a new one", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const trace = ironside.trace({ name: "checkout" });
    const fakeOpenAI = {
      chat: { completions: { create: vi.fn(async (..._args: unknown[]) => ({ model: "gpt-4o", usage: {} })) } }
    };

    const wrapped = wrapOpenAI(fakeOpenAI, ironside, { trace });
    await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });
    await ironside.flush();

    const events = requests.flatMap((r) => r.events);
    const generationEvent = [...events].reverse().find((e) => e.type === "observation-upsert");
    const traceEvents = events.filter((e) => e.type === "trace-upsert");
    // Exactly one trace-upsert (the caller-supplied one) — no second,
    // auto-created trace.
    expect(traceEvents).toHaveLength(1);
    expect((generationEvent?.body as { traceId: string }).traceId).toBe(trace.id);
  });

  it("wrapping the same client twice does not double-record a call (regression: re-wrapping would otherwise nest a second wrapper around the first, doubling every trace/generation)", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const fakeOpenAI = {
      chat: {
        completions: {
          create: vi.fn(async (..._args: unknown[]) => ({ model: "gpt-4o", usage: {} }))
        }
      }
    };
    const originalCreate = fakeOpenAI.chat.completions.create;

    wrapOpenAI(fakeOpenAI, ironside);
    wrapOpenAI(fakeOpenAI, ironside); // second call on the same client

    await fakeOpenAI.chat.completions.create({ model: "gpt-4o", messages: [] });
    await ironside.flush();

    expect(originalCreate).toHaveBeenCalledOnce();
    const events = requests.flatMap((r) => r.events);
    expect(events.filter((e) => e.type === "trace-upsert")).toHaveLength(1);
    // One real call -> generation() (start) + end() (final) = 2
    // observation-upsert events for the SAME observation id, not 4 across
    // two independently-tracked observations from a nested double-wrap.
    const observationEvents = events.filter((e) => e.type === "observation-upsert");
    expect(observationEvents).toHaveLength(2);
    const ids = new Set(observationEvents.map((e) => (e.body as { id: string }).id));
    expect(ids.size).toBe(1);
  });

  it("a streaming call returns the SAME stream object, instrumented in place (full behavior in streaming.test.ts)", async () => {
    const { fetchImpl } = mockFetch();
    const ironside = testClient(fetchImpl);
    const streamSentinel = {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "x" } }] };
      }
    };
    const fakeOpenAI = {
      chat: { completions: { create: vi.fn(async (..._args: unknown[]) => streamSentinel) } }
    };

    const wrapped = wrapOpenAI(fakeOpenAI, ironside);
    const result = await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      stream: true
    });

    expect(result).toBe(streamSentinel);
  });
});

describe("wrapAnthropic", () => {
  it("records a generation with normalized usage (already input_tokens/output_tokens on Anthropic)", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const fakeAnthropic = {
      messages: {
        create: vi.fn(async (..._args: unknown[]) => ({
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 15, output_tokens: 25 }
        }))
      }
    };

    const wrapped = wrapAnthropic(fakeAnthropic, ironside);
    await wrapped.messages.create({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "hello" }]
    });
    await ironside.flush();

    const events = requests.flatMap((r) => r.events);
    const generationEvent = [...events].reverse().find((e) => e.type === "observation-upsert");
    const body = generationEvent?.body as { model: string; usageDetails: Record<string, number> };
    expect(body.model).toBe("claude-opus-4-6");
    expect(body.usageDetails).toEqual({ input_tokens: 15, output_tokens: 25 });
  });

  it("records request sampling parameters (temperature, top_k, ...) as modelParameters", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const fakeAnthropic = {
      messages: {
        create: vi.fn(async (..._args: unknown[]) => ({
          model: "claude-opus-4-6",
          usage: { input_tokens: 1, output_tokens: 1 }
        }))
      }
    };

    const wrapped = wrapAnthropic(fakeAnthropic, ironside);
    await wrapped.messages.create({
      model: "claude-opus-4-6",
      messages: [],
      temperature: 0.5,
      top_k: 40,
      max_tokens: 1024
    });
    await ironside.flush();

    const events = requests.flatMap((r) => r.events);
    const generationEvent = [...events].reverse().find((e) => e.type === "observation-upsert");
    const body = generationEvent?.body as { modelParameters: Record<string, unknown> };
    expect(body.modelParameters).toEqual({ temperature: 0.5, top_k: 40, max_tokens: 1024 });
  });

  it("wrapping the same client twice does not double-record a call", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);
    const fakeAnthropic = {
      messages: {
        create: vi.fn(async (..._args: unknown[]) => ({ model: "claude-opus-4-6", usage: {} }))
      }
    };
    const originalCreate = fakeAnthropic.messages.create;

    wrapAnthropic(fakeAnthropic, ironside);
    wrapAnthropic(fakeAnthropic, ironside);

    await fakeAnthropic.messages.create({ model: "claude-opus-4-6", messages: [] });
    await ironside.flush();

    expect(originalCreate).toHaveBeenCalledOnce();
    const events = requests.flatMap((r) => r.events);
    expect(events.filter((e) => e.type === "trace-upsert")).toHaveLength(1);
    // One real call -> generation() (start) + end() (final) = 2
    // observation-upsert events for the SAME observation id, not 4 across
    // two independently-tracked observations from a nested double-wrap.
    const observationEvents = events.filter((e) => e.type === "observation-upsert");
    expect(observationEvents).toHaveLength(2);
    const ids = new Set(observationEvents.map((e) => (e.body as { id: string }).id));
    expect(ids.size).toBe(1);
  });

  it("a streaming call returns the SAME stream object, instrumented in place (full behavior in streaming.test.ts)", async () => {
    const { fetchImpl } = mockFetch();
    const ironside = testClient(fetchImpl);
    const streamSentinel = {
      async *[Symbol.asyncIterator]() {
        yield { type: "message_stop" };
      }
    };
    const fakeAnthropic = {
      messages: { create: vi.fn(async (..._args: unknown[]) => streamSentinel) }
    };

    const wrapped = wrapAnthropic(fakeAnthropic, ironside);
    const result = await wrapped.messages.create({
      model: "claude-opus-4-6",
      messages: [],
      stream: true
    });

    expect(result).toBe(streamSentinel);
  });
});

describe("recordGenerateTextResult", () => {
  it("records a generation from an AI SDK result with camelCase usage normalized to the wire format", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);

    recordGenerateTextResult(
      ironside,
      { text: "hello", usage: { inputTokens: 8, outputTokens: 16 } },
      { model: "gpt-4o", input: "say hi" }
    );
    await ironside.flush();

    const events = requests.flatMap((r) => r.events);
    const generationEvent = [...events].reverse().find((e) => e.type === "observation-upsert");
    const body = generationEvent?.body as {
      model: string;
      output: string;
      usageDetails: Record<string, number>;
    };
    expect(body.model).toBe("gpt-4o");
    expect(body.output).toBe("hello");
    expect(body.usageDetails).toEqual({ input_tokens: 8, output_tokens: 16 });
  });

  it("records caller-supplied modelParameters, since this recorder doesn't intercept the call and can't read them off the result", async () => {
    const { fetchImpl, requests } = mockFetch();
    const ironside = testClient(fetchImpl);

    recordGenerateTextResult(
      ironside,
      { text: "hello", usage: { inputTokens: 8, outputTokens: 16 } },
      { model: "gpt-4o", input: "say hi", modelParameters: { temperature: 0.3, maxOutputTokens: 200 } }
    );
    await ironside.flush();

    const events = requests.flatMap((r) => r.events);
    const generationEvent = [...events].reverse().find((e) => e.type === "observation-upsert");
    const body = generationEvent?.body as { modelParameters: Record<string, unknown> };
    expect(body.modelParameters).toEqual({ temperature: 0.3, maxOutputTokens: 200 });
  });
});
