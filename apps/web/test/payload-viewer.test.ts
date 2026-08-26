import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PayloadViewer } from "../src/components/payload-viewer.js";

describe("PayloadViewer", () => {
  it("renders string source with real whitespace by default and keeps Raw JSON available", () => {
    const html = renderToStaticMarkup(createElement(PayloadViewer, {
      value: "first line\nsecond line"
    }));

    expect(html).toContain("first line\nsecond line");
    expect(html).not.toContain("first line\\nsecond line");
    expect(html).toContain("Source");
    expect(html).toContain("Raw JSON");
  });

  it("pretty-prints JSON strings and safely renders detected Markdown by default", () => {
    const jsonHtml = renderToStaticMarkup(createElement(PayloadViewer, {
      value: '{"path":"/tmp/file","id":9223372036854775807}'
    }));
    expect(jsonHtml).toContain("Pretty");
    expect(jsonHtml).toContain("9223372036854775807");
    expect(jsonHtml).not.toContain("{\\\"path\\\"");

    const textHtml = renderToStaticMarkup(createElement(PayloadViewer, {
      value: "## Review\n\n**Verdict: safe.**\n\n- one\n- two\n\n<script>alert(1)</script>"
    }));
    expect(textHtml).toContain("<h2");
    expect(textHtml).toContain("<strong>Verdict: safe.</strong>");
    expect(textHtml).not.toContain("<script");
    expect(textHtml).toContain("Rendered");
    expect(textHtml).toContain("Source");
  });

  it("makes an empty string explicit", () => {
    const html = renderToStaticMarkup(createElement(PayloadViewer, { value: "" }));
    expect(html).toContain("Empty string");
  });

  it("renders an arbitrary tool response as one JSON block", () => {
    const response = Array.from({ length: 5_000 }, () => null);
    const html = renderToStaticMarkup(createElement(PayloadViewer, {
      value: [{ role: "tool", parts: [{ type: "tool_call_response", response }] }]
    }));

    expect(html.match(/<pre/g)).toHaveLength(1);
    expect(html).toContain("payload-scroll");
    expect(html).not.toContain("max-h-[420px]");
  });

  it("renders standard text content instead of an overlapping legacy text field", () => {
    const html = renderToStaticMarkup(createElement(PayloadViewer, {
      value: [{
        role: "user",
        parts: [{ type: "text", content: "authoritative", text: "spoofed" }],
        content: null
      }]
    }));

    expect(html).toContain("authoritative");
    expect(html).not.toContain("spoofed");
  });

  it("renders detected Markdown in known message text without interpreting tool arguments", () => {
    const html = renderToStaticMarkup(createElement(PayloadViewer, {
      value: [{
        role: "assistant",
        content: "## Result\n\n- first\n- second",
        tool_calls: [{ name: "shell", arguments: "## not-a-heading\n- source argument" }]
      }]
    }));

    expect(html).toContain("<h2");
    expect(html).toContain("Result");
    expect(html).toContain("## not-a-heading");
    expect(html).not.toContain("<h2>not-a-heading</h2>");
  });

  it("keeps unknown and malformed OpenTelemetry parts in raw JSON", () => {
    const html = renderToStaticMarkup(createElement(PayloadViewer, {
      value: [{
        role: "participant",
        parts: [
          { type: "input_text", text: "projected", forensic_extra: "unknown-marker" },
          { type: "text", content: 123, text: "legacy-spoof", forensic_extra: "malformed-marker" }
        ]
      }]
    }));

    expect(html.match(/<pre/g)).toHaveLength(2);
    expect(html).toContain("unknown-marker");
    expect(html).toContain("malformed-marker");
  });

  it("does not render legacy tool fields on an OpenTelemetry message", () => {
    const html = renderToStaticMarkup(createElement(PayloadViewer, {
      value: [{
        role: "participant",
        parts: [{ type: "text", content: "standard-content" }],
        tool_call_id: "legacy-call-id",
        tool_calls: [{ name: "legacy_lookup", arguments: { q: "spoofed" } }]
      }]
    }));

    expect(html).toContain("standard-content");
    expect(html).not.toContain("legacy-call-id");
    expect(html).not.toContain("legacy_lookup");
  });

  it("falls back to one JSON block for over-budget OpenTelemetry parts in wrapped choices", () => {
    const value = {
      choices: Array.from({ length: 10 }, (_, index) => ({
        index,
        finish_reason: "stop",
        message: {
          role: "assistant",
          parts: Array.from({ length: 200 }, () => ({ type: "x" }))
        }
      }))
    };
    const html = renderToStaticMarkup(createElement(PayloadViewer, { value }));

    expect(html.match(/<pre/g)).toHaveLength(1);
  });
});
