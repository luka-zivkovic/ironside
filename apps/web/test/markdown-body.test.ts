import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownBody } from "../src/components/markdown-body.js";
import {
  MAX_MARKDOWN_SOURCE_LENGTH,
  MAX_MARKDOWN_STRUCTURE_TOKENS
} from "../src/lib/markdown.js";

describe("MarkdownBody", () => {
  it("renders the issue fixture as compact Markdown", () => {
    const html = renderToStaticMarkup(createElement(MarkdownBody, {
      source: "## PR #148 review\n\n**Verdict: no blocking findings.**\n\n- Safe\n- Focused\n\nUse `pnpm test`."
    }));

    expect(html).toContain("<h2");
    expect(html).toContain("<strong>Verdict: no blocking findings.</strong>");
    expect(html).toContain("<ul");
    expect(html).toContain("payload-markdown-code");
  });

  it("supports bounded GFM without interactive task controls", () => {
    const html = renderToStaticMarkup(createElement(MarkdownBody, {
      source: [
        "~~old~~",
        "",
        "- [x] reviewed",
        "",
        "| Check | Result |",
        "| --- | --- |",
        "| CI | pass |",
        "",
        "https://example.com"
      ].join("\n")
    }));

    expect(html).toContain("<del>old</del>");
    expect(html).toMatch(/<input[^>]+type="checkbox"[^>]+disabled=""/);
    expect(html).toContain("payload-markdown-table-scroll");
    expect(html).toContain('aria-label="Markdown table"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('href="https://example.com/"');
  });

  it("drops raw HTML and never emits active image content", () => {
    const html = renderToStaticMarkup(createElement(MarkdownBody, {
      source: [
        "## Hostile",
        "<script>alert(1)</script>",
        "<iframe src=\"https://attacker.example/frame\"></iframe>",
        "<img src=\"https://attacker.example/raw.png\" onerror=\"alert(1)\">",
        "![beacon](https://attacker.example/markdown.png)",
        "![<unsafe>](javascript:alert(1))"
      ].join("\n\n")
    }));

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("attacker.example");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Image not loaded");
  });

  it("makes unsafe links inert and hardens allowed external links", () => {
    const html = renderToStaticMarkup(createElement(MarkdownBody, {
      source: "[unsafe](javascript:alert(1)) [relative](/settings) [safe](https://example.com/path)"
    }));

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('href="/settings"');
    expect(html).toContain('href="https://example.com/path"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
    expect(html.match(/payload-markdown-inert-link/g)).toHaveLength(2);
  });

  it("keeps fenced code inert and horizontally scrollable", () => {
    const html = renderToStaticMarkup(createElement(MarkdownBody, {
      source: "```html\n<script>alert(1)</script>\n```"
    }));

    expect(html).toContain("payload-markdown-code-block");
    expect(html).toContain('aria-label="Markdown code block"');
    expect(html).toContain("language-html");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("does not parse over-limit content", () => {
    const html = renderToStaticMarkup(createElement(MarkdownBody, {
      source: `## title\n${"x".repeat(MAX_MARKDOWN_SOURCE_LENGTH)}`
    }));

    expect(html).toContain("too large or deeply nested");
    expect(html).not.toContain("<h2");
  });

  it("rejects delimiter-heavy and carriage-return-heavy input before Markdown parsing", () => {
    const delimiterHeavy = renderToStaticMarkup(createElement(MarkdownBody, {
      source: `${"*a* ".repeat(Math.ceil(MAX_MARKDOWN_STRUCTURE_TOKENS / 2) + 1)}[safe](https://example.com)`
    }));
    const carriageReturnHeavy = renderToStaticMarkup(createElement(MarkdownBody, {
      source: "x\r\r".repeat(1_001)
    }));

    expect(delimiterHeavy).toContain("too large or deeply nested");
    expect(delimiterHeavy).not.toContain("<em>");
    expect(carriageReturnHeavy).toContain("too large or deeply nested");
  });
});
