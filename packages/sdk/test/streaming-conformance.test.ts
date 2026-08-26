import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { init } from "../src/client.js";
import { wrapAnthropic } from "../src/wrappers/anthropic.js";
import { wrapOpenAI } from "../src/wrappers/openai.js";
import type { IngestRequestEvent } from "../src/types.js";

// M9-07 conformance: the streaming unit tests use hand-built async
// iterables; these run the SAME flows through the REAL provider SDKs
// (openai@6, @anthropic-ai/sdk@0.111) parsing real SSE off a local HTTP
// server. What this proves that the unit tests can't: the in-place
// [Symbol.asyncIterator] patch works on the SDKs' actual Stream classes
// (not just plain generators), and the chunk/event shapes we accumulate
// are the shapes those SDKs actually yield.

function sse(...payloads: Array<string | object>): string {
  return payloads
    .map((p) => (typeof p === "string" ? p : `data: ${JSON.stringify(p)}\n\n`))
    .join("");
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.includes("/chat/completions")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(
          { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-2024-08-06", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
          { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-2024-08-06", choices: [{ index: 0, delta: { content: "str" }, finish_reason: null }] },
          { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-2024-08-06", choices: [{ index: 0, delta: { content: "eamed" }, finish_reason: null }] },
          { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-2024-08-06", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-2024-08-06", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
          "data: [DONE]\n\n"
        )
      );
      return;
    }
    if (req.url?.includes("/messages")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          ["message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "str" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "eamed" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }],
          ["message_stop", { type: "message_stop" }]
        ]
          .map(([event, payload]) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
          .join("")
      );
      return;
    }
    res.writeHead(404).end();
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
  const ended = () =>
    requests
      .flatMap((r) => r.events)
      .filter((e) => e.type === "observation-upsert")
      .map((e) => e.body as Record<string, unknown>)
      .find((b) => b.endTime !== undefined);
  return { ironside, ended };
}

describe("real-SDK streaming conformance", () => {
  it("openai@6 Stream: for-await through the wrapped client records text + final-chunk usage", async () => {
    const { ironside, ended } = mockIngest();
    const client = wrapOpenAI(
      new OpenAI({ apiKey: "test-key", baseURL: `${baseUrl}/v1` }),
      ironside
    );

    const stream = await client.chat.completions.create({
      model: "gpt-4o",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hi" }]
    });

    let text = "";
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? "";
    }
    expect(text).toBe("streamed"); // the caller's own view is untouched

    await ironside.flush();
    const body = ended()!;
    expect(body).toBeDefined();
    expect(body.output).toEqual({ role: "assistant", content: "streamed" });
    expect(body.usageDetails).toEqual({ input_tokens: 5, output_tokens: 2 });
    expect(body.metadata).toMatchObject({ streamed: "true", finish_reason: "stop" });
  });

  it("openai@6 Stream: tee() still exists and works after wrapping (in-place patch, same object)", async () => {
    const { ironside } = mockIngest();
    const client = wrapOpenAI(
      new OpenAI({ apiKey: "test-key", baseURL: `${baseUrl}/v1` }),
      ironside
    );
    const stream = await client.chat.completions.create({
      model: "gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "hi" }]
    });
    expect(typeof stream.tee).toBe("function");
    const [a, b] = stream.tee();
    let textA = "";
    for await (const chunk of a) textA += chunk.choices[0]?.delta?.content ?? "";
    let textB = "";
    for await (const chunk of b) textB += chunk.choices[0]?.delta?.content ?? "";
    expect(textA).toBe("streamed");
    expect(textB).toBe("streamed");
    await ironside.flush();
  });

  it("@anthropic-ai/sdk Stream: for-await through the wrapped client reassembles the message with full usage", async () => {
    const { ironside, ended } = mockIngest();
    const client = wrapAnthropic(
      new Anthropic({ apiKey: "test-key", baseURL: baseUrl }),
      ironside
    );

    const stream = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }]
    });

    let text = "";
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
      }
    }
    expect(text).toBe("streamed");

    await ironside.flush();
    const body = ended()!;
    expect(body).toBeDefined();
    expect(body.output).toEqual({
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "streamed" }],
      stop_reason: "end_turn"
    });
    expect(body.usageDetails).toEqual({ input_tokens: 8, output_tokens: 4 });
  });
});
