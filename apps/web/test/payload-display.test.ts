import { describe, expect, it } from "vitest";
import { presentStringPayload } from "../src/lib/payload-display.js";

describe("presentStringPayload", () => {
  it("shows ordinary multiline text directly and keeps raw JSON forensic", () => {
    const value = "first line\nsecond line\tindented";
    expect(presentStringPayload(value)).toEqual({
      defaultMode: "source",
      modes: ["rendered", "source", "raw"],
      renderedKind: "markdown",
      markdownDetected: false,
      markdownUnavailableReason: null,
      prettyText: null,
      sourceText: value,
      rawJsonText: '"first line\\nsecond line\\tindented"'
    });
  });

  it("pretty-prints JSON stored as a string without rounding numeric tokens", () => {
    const presentation = presentStringPayload('{"id":9223372036854775807,"ok":true}');
    expect(presentation.defaultMode).toBe("pretty");
    expect(presentation.modes).toEqual(["pretty", "source", "raw"]);
    expect(presentation.renderedKind).toBe("json");
    expect(presentation.prettyText).toBe(
      '{\n  "id": 9223372036854775807,\n  "ok": true\n}'
    );
    expect(presentation.sourceText).toBe('{"id":9223372036854775807,"ok":true}');
  });

  it("unwraps at most two complete JSON string layers", () => {
    expect(presentStringPayload('"hello\\nworld"').sourceText).toBe("hello\nworld");

    const twiceEncoded = JSON.stringify(JSON.stringify({ value: "ok" }));
    const presentation = presentStringPayload(twiceEncoded);
    expect(presentation.sourceText).toBe('{"value":"ok"}');
    expect(presentation.prettyText).toBe('{\n  "value": "ok"\n}');

    const threeTimesEncoded = JSON.stringify(twiceEncoded);
    expect(presentStringPayload(threeTimesEncoded).sourceText).toBe(JSON.stringify({ value: "ok" }));
  });

  it("never manually replaces escapes in ordinary strings", () => {
    const source = String.raw`C:\new\trace literal\n / pattern \\d+`;
    expect(presentStringPayload(source).sourceText).toBe(source);
  });

  it("falls back to source for malformed, deep, and oversized JSON candidates", () => {
    expect(presentStringPayload('{"broken":}').prettyText).toBeNull();

    const deep = `${"[".repeat(65)}0${"]".repeat(65)}`;
    expect(presentStringPayload(deep).sourceText).toBe(deep);
    expect(presentStringPayload(deep).prettyText).toBeNull();

    const oversized = `{"value":"${"x".repeat(100_001)}"}`;
    expect(presentStringPayload(oversized).sourceText).toBe(oversized);
    expect(presentStringPayload(oversized).prettyText).toBeNull();
  });

  it("preserves empty and markdown-like source as text", () => {
    const empty = presentStringPayload("");
    expect(empty.sourceText).toBe("");
    expect(empty.modes).toEqual(["source", "raw"]);

    const markdown = presentStringPayload("## Review\n\n- **safe** `code`");
    expect(markdown.sourceText).toBe(
      "## Review\n\n- **safe** `code`"
    );
    expect(markdown.defaultMode).toBe("rendered");
    expect(markdown.markdownDetected).toBe(true);
    expect(markdown.modes).toEqual(["rendered", "source", "raw"]);
  });
});
