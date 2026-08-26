import { describe, expect, it } from "vitest";
import { interpretPayload, stringifyPayload } from "../src/lib/payload.js";

describe("interpretPayload", () => {
  it("recognizes a direct role/content message array", () => {
    expect(
      interpretPayload([
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" }
      ])
    ).toEqual({
      kind: "messages",
      messages: [
        { role: "system", name: null, content: "Be concise.", contentFormat: "legacy", toolCallId: null, toolCalls: [], unrecognizedToolCalls: [] },
        { role: "user", name: null, content: "Hello", contentFormat: "legacy", toolCallId: null, toolCalls: [], unrecognizedToolCalls: [] }
      ]
    });
  });

  it("recognizes messages wrapped in an object", () => {
    const result = interpretPayload({
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "lookup" }]
    });

    expect(result.kind).toBe("messages");
  });

  it("recognizes standard OpenTelemetry role/parts messages", () => {
    const parts = [
      { type: "text", content: "Weather in Paris?" },
      { type: "tool_call", id: "call_1", name: "weather", arguments: { city: "Paris" } }
    ];

    expect(interpretPayload([{ role: "participant", name: "planner", parts }])).toEqual({
      kind: "messages",
      messages: [
        {
          role: "participant",
          name: "planner",
          content: parts,
          contentFormat: "otel",
          toolCallId: null,
          toolCalls: [],
          unrecognizedToolCalls: []
        }
      ]
    });
  });

  it("keeps standard parts authoritative when optional legacy fields overlap", () => {
    const parts = [{ type: "text", content: "authoritative", text: "unrelated legacy field" }];
    const result = interpretPayload([{ role: "user", parts, content: null }]);

    expect(result.kind === "messages" && result.messages[0]?.content).toEqual(parts);
  });

  it("does not normalize legacy tool fields on standard OpenTelemetry messages", () => {
    const result = interpretPayload([{
      role: "participant",
      parts: [{ type: "text", content: "standard-content" }],
      tool_call_id: "legacy-call-id",
      tool_calls: [{ name: "legacy_lookup", arguments: { q: "spoofed" } }]
    }]);

    expect(result.kind === "messages" && result.messages[0]).toMatchObject({
      contentFormat: "otel",
      toolCallId: null,
      toolCalls: [],
      unrecognizedToolCalls: []
    });
  });

  it("preserves standard OpenTelemetry output candidates as choices", () => {
    const result = interpretPayload([
      {
        role: "assistant",
        parts: [{ type: "text", content: "Rainy." }],
        finish_reason: "stop"
      },
      {
        role: "assistant",
        parts: [{ type: "text", content: "Bring an umbrella." }],
        finish_reason: "length"
      }
    ]);

    expect(result.kind).toBe("choices");
    expect(result.kind === "choices" && result.choices.map((choice) => ({
      index: choice.index,
      finishReason: choice.finishReason,
      content: choice.message.content
    }))).toEqual([
      { index: 0, finishReason: "stop", content: [{ type: "text", content: "Rainy." }] },
      { index: 1, finishReason: "length", content: [{ type: "text", content: "Bring an umbrella." }] }
    ]);
  });

  it("falls back to JSON for malformed or mixed standard candidate arrays", () => {
    expect(interpretPayload([{ role: "user", parts: [{ content: "missing type" }] }])).toEqual({ kind: "json" });
    expect(interpretPayload([
      { role: "assistant", parts: [], finish_reason: "stop" },
      { role: "assistant", parts: [] }
    ])).toEqual({ kind: "json" });
    expect(interpretPayload({ role: "participant", content: "not a standard message" })).toEqual({ kind: "json" });
  });

  it("normalizes OpenAI tool calls without parsing serialized arguments", () => {
    const result = interpretPayload({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "lookup_order", arguments: '{"order_id":"A-12"}' }
        }
      ]
    });

    expect(result).toEqual({
      kind: "messages",
      messages: [
        {
          role: "assistant",
          name: null,
          content: null,
          contentFormat: "legacy",
          toolCallId: null,
          toolCalls: [{ id: "call_1", name: "lookup_order", arguments: '{"order_id":"A-12"}' }],
          unrecognizedToolCalls: []
        }
      ]
    });
  });

  it("preserves serialized tool arguments exactly, including unsafe integers", () => {
    const argumentsText = '{"id":9007199254740993}';
    const result = interpretPayload({
      role: "assistant",
      content: null,
      tool_calls: [{ name: "lookup", arguments: argumentsText }]
    });

    expect(result.kind === "messages" && result.messages[0]?.toolCalls[0]?.arguments).toBe(argumentsText);
  });

  it("keeps unrecognized tool calls visible alongside recognized calls", () => {
    const unknown = { toolName: "vendor_lookup", args: { q: 1 } };
    const result = interpretPayload({
      role: "assistant",
      content: "Checking",
      tool_calls: [
        { id: "call_1", function: { name: "lookup", arguments: "{}" } },
        unknown
      ]
    });

    expect(result.kind === "messages" && result.messages[0]?.toolCalls).toHaveLength(1);
    expect(result.kind === "messages" && result.messages[0]?.unrecognizedToolCalls).toEqual([unknown]);
  });

  it("keeps tool result correlation", () => {
    const result = interpretPayload({ role: "tool", tool_call_id: "call_1", content: { found: true } });

    expect(result.kind === "messages" && result.messages[0]?.toolCallId).toBe("call_1");
  });

  it("preserves choice boundaries in the OpenAI completion shape", () => {
    const result = interpretPayload({
      id: "chatcmpl_1",
      choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: "First" } },
        { index: 1, finish_reason: "stop", message: { role: "assistant", content: "Second" } }
      ]
    });

    expect(result.kind).toBe("choices");
    expect(result.kind === "choices" && result.choices).toEqual([
      {
        index: 0,
        finishReason: "stop",
        message: {
          role: "assistant",
          name: null,
          content: "First",
          contentFormat: "legacy",
          toolCallId: null,
          toolCalls: [],
          unrecognizedToolCalls: []
        }
      },
      {
        index: 1,
        finishReason: "stop",
        message: {
          role: "assistant",
          name: null,
          content: "Second",
          contentFormat: "legacy",
          toolCallId: null,
          toolCalls: [],
          unrecognizedToolCalls: []
        }
      }
    ]);
  });

  it("rejects ambiguous role/content objects and empty tool-call shells", () => {
    expect(interpretPayload({ role: "admin", content: "policy" })).toEqual({ kind: "json" });
    expect(interpretPayload({ role: "assistant", content: null, tool_calls: [] })).toEqual({ kind: "json" });
  });

  it("bounds formatted histories", () => {
    const messages = Array.from({ length: 201 }, (_, index) => ({ role: "user", content: String(index) }));
    expect(interpretPayload(messages)).toEqual({ kind: "json" });
  });

  it("falls back to JSON for compact payloads with excessive tool calls", () => {
    const payload = { role: "assistant", content: null, tool_calls: Array.from({ length: 5_000 }, () => null) };

    expect(stringifyPayload(payload).length).toBeLessThan(100_000);
    expect(interpretPayload(payload)).toEqual({ kind: "json" });
  });

  it("falls back to JSON for compact payloads with excessive content parts", () => {
    const payload = {
      messages: Array.from({ length: 25 }, () => ({
        role: "user",
        content: Array.from({ length: 200 }, () => null)
      }))
    };

    expect(stringifyPayload(payload).length).toBeLessThan(100_000);
    expect(interpretPayload(payload)).toEqual({ kind: "json" });
  });

  it("bounds standard OpenTelemetry parts across the full message array", () => {
    const payload = Array.from({ length: 25 }, () => ({
      role: "user",
      parts: Array.from({ length: 200 }, () => ({ type: "custom" }))
    }));

    expect(interpretPayload(payload)).toEqual({ kind: "json" });
  });

  it("bounds standard OpenTelemetry parts inside completion choice wrappers", () => {
    const payload = {
      choices: Array.from({ length: 10 }, (_, index) => ({
        index,
        finish_reason: "stop",
        message: {
          role: "assistant",
          parts: Array.from({ length: 200 }, () => ({ type: "x" }))
        }
      }))
    };

    expect(stringifyPayload(payload).length).toBeLessThan(100_000);
    expect(interpretPayload(payload)).toEqual({ kind: "json" });
  });

  it("leaves arbitrary JSON in the raw view", () => {
    expect(interpretPayload({ records: [{ status: "ok" }] })).toEqual({ kind: "json" });
    expect(interpretPayload([{ status: "ok" }])).toEqual({ kind: "json" });
    expect(interpretPayload([])).toEqual({ kind: "json" });
  });
});

describe("stringifyPayload", () => {
  it("formats JSON and handles undefined", () => {
    expect(stringifyPayload({ ok: true })).toBe('{\n  "ok": true\n}');
    expect(stringifyPayload(undefined)).toBe("undefined");
  });
});
