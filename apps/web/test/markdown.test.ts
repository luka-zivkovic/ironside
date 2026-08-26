import { describe, expect, it } from "vitest";
import {
  MAX_MARKDOWN_AST_NODES,
  MAX_MARKDOWN_SOURCE_LENGTH,
  MAX_MARKDOWN_STRUCTURE_TOKENS,
  limitMarkdownAst,
  looksLikeMarkdown,
  markdownComplexityNotice,
  markdownEligibility,
  safeMarkdownHref
} from "../src/lib/markdown.js";

describe("Markdown display policy", () => {
  it("detects the issue fixture and high-confidence block Markdown", () => {
    expect(looksLikeMarkdown([
      "## PR #148 review",
      "",
      "**Verdict: no blocking findings.**",
      "",
      "- Keeps the contract intact",
      "- Adds `safe handling`"
    ].join("\n"))).toBe(true);
    expect(looksLikeMarkdown("```ts\nconst answer = 42;\n```" )).toBe(true);
    expect(looksLikeMarkdown("| Name | Result |\n| --- | --- |\n| Build | Pass |" )).toBe(true);
    expect(looksLikeMarkdown("- [x] reviewed" )).toBe(true);
    expect(looksLikeMarkdown("## First section\n## Second section" )).toBe(true);
  });

  it("keeps ambiguous source and log fixtures in Source by default", () => {
    const fixtures = [
      "plain prose with https://example.com and no markup",
      "#!/bin/bash\n# comment\nprintf '%s\\n' done",
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n- old\n+ new",
      "2026-08-25T19:04:01Z worker-1 --retry_count=2",
      String.raw`C:\Users\agent\output\review.md`,
      String.raw`/^foo_*\\d+$/`,
      "one * incidental marker",
      "`single inline token`",
      "const __DEV__ = `production`;",
      "# Configure the client\n# Keep retries bounded",
      "# deployment settings\n# do not edit by hand",
      "Test Results\n------------\n12 passed"
    ];

    for (const fixture of fixtures) expect(looksLikeMarkdown(fixture)).toBe(false);
  });

  it("bounds source length, every line-ending form, structure, and estimated nesting before parsing", () => {
    expect(markdownEligibility("## Fine\n\n- one\n- two").eligible).toBe(true);
    expect(markdownEligibility("x".repeat(MAX_MARKDOWN_SOURCE_LENGTH + 1))).toEqual({
      eligible: false,
      reason: "length"
    });
    expect(markdownEligibility("x\n".repeat(2_000))).toEqual({ eligible: false, reason: "lines" });
    expect(markdownEligibility("x\r".repeat(2_000))).toEqual({ eligible: false, reason: "lines" });
    expect(markdownEligibility("x\r\n".repeat(2_000))).toEqual({ eligible: false, reason: "lines" });
    expect(markdownEligibility("*".repeat(MAX_MARKDOWN_STRUCTURE_TOKENS + 1))).toEqual({
      eligible: false,
      reason: "complexity"
    });
    expect(markdownEligibility(`${"> ".repeat(65)}deep`)).toEqual({ eligible: false, reason: "depth" });
  });

  it("allows only absolute HTTP(S) links", () => {
    expect(safeMarkdownHref("https://example.com/a?q=1")).toBe("https://example.com/a?q=1");
    expect(safeMarkdownHref("HTTP://EXAMPLE.COM/path")).toBe("http://example.com/path");

    for (const unsafe of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.com/id",
      "mailto:owner@example.com",
      "//example.com/path",
      "/relative/path",
      "#fragment",
      "%6a%61vascript:alert(1)",
      "https://"
    ]) expect(safeMarkdownHref(unsafe)).toBeNull();
  });

  it("replaces an excessive AST without recursive traversal", () => {
    const tree = {
      type: "root" as const,
      children: Array.from({ length: MAX_MARKDOWN_AST_NODES + 1 }, () => ({ type: "text", value: "x" }))
    };

    limitMarkdownAst()(tree);

    expect(tree.children).toEqual([{
      type: "paragraph",
      children: [{ type: "text", value: markdownComplexityNotice() }]
    }]);
  });
});
