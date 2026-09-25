import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { init } from "../src/client.js";
import { wrapAnthropic } from "../src/wrappers/anthropic.js";
import { wrapOpenAI } from "../src/wrappers/openai.js";
import type { IngestRequestEvent } from "../src/types.js";

// create() in both SDKs returns an APIPromise, whose extra methods callers and
// the SDKs' own helpers use: Anthropic's messages.stream() calls withResponse()
// on it, OpenAI's chat.completions.parse() calls _thenUnwrap(). These run the
// real SDKs against a local server through the wrapped clients: every helper
// must work, and record its call once.

const completion = {
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "gpt-4o-2024-08-06",
  choices: [{ index: 0, message: { role: "assistant", content: "hello", refusal: null }, finish_reason: "stop", logprobs: null }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
};
const completionChunks = [
  { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-2024-08-06", choices: [{ index: 0, delta: { role: "assistant", content: "str" }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-2024-08-06", choices: [{ index: 0, delta: { content: "eamed" }, finish_reason: "stop" }] }
];
const message = {
  id: "m1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 8, output_tokens: 4 }
};
const messageEvents: [string, object][] = [
  ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "str" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "eamed" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }],
  ["message_stop", { type: "message_stop" }]
];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { model?: string; stream?: boolean };
      if (body.model === "fail") {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "api_error", message: "boom" } }));
        return;
      }
      const openai = req.url?.includes("/chat/completions");
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(openai ? completion : message));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        openai
          ? `${completionChunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
          : messageEvents.map(([event, payload]) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`).join("")
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

function mockIngest() {
  const requests: { events: IngestRequestEvent[] }[] = [];
  const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 202 });
  }) as unknown as typeof fetch;
  const ironside = init({ apiKey: "k", host: "http://localhost:8788", fetchImpl, flushIntervalMs: 60_000 });
  const endings = async () => {
    await ironside.flush();
    return requests
      .flatMap((r) => r.events)
      .filter((e) => e.type === "observation-upsert")
      .map((e) => e.body as Record<string, unknown>)
      .filter((b) => b.endTime !== undefined);
  };
  return { ironside, endings };
}

const anthropic = (ironside: ReturnType<typeof mockIngest>["ironside"]) =>
  wrapAnthropic(new Anthropic({ apiKey: "test-key", baseURL: baseUrl, maxRetries: 0 }), ironside);
const openai = (ironside: ReturnType<typeof mockIngest>["ironside"]) =>
  wrapOpenAI(new OpenAI({ apiKey: "test-key", baseURL: `${baseUrl}/v1`, maxRetries: 0 }), ironside);
const anthropicRequest = { model: "claude-sonnet-5", max_tokens: 64, messages: [{ role: "user" as const, content: "hi" }] };
const openaiRequest = { model: "gpt-4o", messages: [{ role: "user" as const, content: "hi" }] };

describe("wrapped create() keeps the SDKs' APIPromise", () => {
  it("@anthropic-ai/sdk messages.stream() works and is recorded once, with the streamed message", async () => {
    const { ironside, endings } = mockIngest();
    const stream = anthropic(ironside).messages.stream(anthropicRequest);
    const final = await stream.finalMessage();
    expect(final.content).toEqual([{ type: "text", text: "streamed" }]);

    const recorded = await endings();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      output: { content: [{ type: "text", text: "streamed" }] },
      usageDetails: { input_tokens: 8, output_tokens: 4 }
    });
  });

  it("@anthropic-ai/sdk create().withResponse() returns the message and the response, recorded once", async () => {
    const { ironside, endings } = mockIngest();
    const { data, response } = await anthropic(ironside).messages.create(anthropicRequest).withResponse();
    expect(data.content).toEqual([{ type: "text", text: "hello" }]);
    expect(response.status).toBe(200);
    expect(await endings()).toMatchObject([{ output: { content: [{ type: "text", text: "hello" }] } }]);
  });

  it("openai@6 chat.completions.parse() works and is recorded once", async () => {
    const { ironside, endings } = mockIngest();
    const parsed = await openai(ironside).chat.completions.parse(openaiRequest);
    expect(parsed.choices[0]?.message.content).toBe("hello");
    expect(await endings()).toMatchObject([{ output: { choices: [{ message: { content: "hello" } }] } }]);
  });

  it("openai@6 chat.completions.stream() and create().withResponse() work and are recorded once each", async () => {
    const helper = mockIngest();
    const stream = openai(helper.ironside).chat.completions.stream(openaiRequest);
    expect((await stream.finalChatCompletion()).choices[0]?.message.content).toBe("streamed");
    expect(await helper.endings()).toMatchObject([{ output: { content: "streamed" } }]);

    const direct = mockIngest();
    const { data, response } = await openai(direct.ironside).chat.completions.create(openaiRequest).withResponse();
    expect(data.choices[0]?.message.content).toBe("hello");
    expect(response.status).toBe(200);
    expect(await direct.endings()).toHaveLength(1);
  });

  it("asResponse() returns the raw response with its body unread", async () => {
    const { ironside, endings } = mockIngest();
    const response = await openai(ironside).chat.completions.create(openaiRequest).asResponse();
    expect(await response.json()).toMatchObject({ id: "c1" });
    // The result is never parsed, so nothing ends the generation: it stays open, like an unread stream.
    expect(await endings()).toHaveLength(0);
  });

  it("records a failed request once, as an error, and still rejects", async () => {
    const failing = mockIngest();
    await expect(openai(failing.ironside).chat.completions.create({ ...openaiRequest, model: "fail" })).rejects.toThrow(/500/);
    await expect(anthropic(failing.ironside).messages.create({ ...anthropicRequest, model: "fail" })).rejects.toThrow(/500/);
    const recorded = await failing.endings();
    expect(recorded).toHaveLength(2);
    expect(recorded.every((ending) => ending.level === "error")).toBe(true);

    // Also when nobody reads the result: the failure is seen without awaiting create(), and
    // nothing is left unhandled (an APIPromise rejects only when read; .catch() would read it).
    const unread = mockIngest();
    void openai(unread.ironside).chat.completions.create({ ...openaiRequest, model: "fail" });
    await vi.waitFor(async () => expect(await unread.endings()).toMatchObject([{ level: "error" }]));
  });
});
