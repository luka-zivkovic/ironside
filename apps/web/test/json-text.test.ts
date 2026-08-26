import { describe, expect, it } from "vitest";
import { formatJsonText } from "../src/lib/json-text.js";

describe("formatJsonText", () => {
  it("formats nested object and array strings", () => {
    expect(formatJsonText('{"role":"user","parts":[{"type":"text","content":"hello"}]}')).toBe(
      '{\n  "role": "user",\n  "parts": [\n    {\n      "type": "text",\n      "content": "hello"\n    }\n  ]\n}'
    );
  });

  it("preserves exact numeric and string tokens", () => {
    const source = '{"id":9223372036854775807,"text":"comma, brace } and \\"quote\\""}';
    const formatted = formatJsonText(source);
    expect(formatted).toContain("9223372036854775807");
    expect(formatted).toContain('"comma, brace } and \\"quote\\""');
  });

  it("keeps empty containers compact", () => {
    expect(formatJsonText('{"items":[],"config":{}}')).toBe(
      '{\n  "items": [],\n  "config": {}\n}'
    );
  });

  it("rejects invalid JSON and JSON primitives", () => {
    expect(formatJsonText('{"broken":}')).toBeNull();
    expect(formatJsonText('"just a string"')).toBeNull();
    expect(formatJsonText("42")).toBeNull();
  });

  it("rejects over-sized and deeply nested input", () => {
    expect(formatJsonText(`["${"x".repeat(32_768)}"]`)).toBeNull();
    expect(formatJsonText(`${"[".repeat(33)}0${"]".repeat(33)}`)).toBeNull();
  });

  it("rejects compact JSON whose formatted output would exceed the display budget", () => {
    const denseNestedArray = `${"[".repeat(32)}${Array(2_000).fill("0").join(",")}${"]".repeat(32)}`;
    expect(formatJsonText(denseNestedArray)).toBeNull();
  });

  it("accepts explicit payload-sized limits without changing metadata defaults", () => {
    const source = `{"value":"${"x".repeat(40_000)}"}`;
    expect(formatJsonText(source)).toBeNull();
    expect(formatJsonText(source, {
      maxSourceLength: 50_000,
      maxDepth: 32,
      maxOutputLength: 60_000
    })).toContain("x".repeat(40_000));
  });
});
