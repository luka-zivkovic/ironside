import { describe, expect, it } from "vitest";
import { buildConnectionSnippets, buildNativeIngestCurl } from "../src/lib/connection-snippets.js";

describe("connection snippets", () => {
  it("uses the displayed deployment host and exact machine endpoints", () => {
    const snippets = buildConnectionSnippets("https://ironside.example.com/");
    const code = snippets.map((snippet) => snippet.code).join("\n");

    expect(code).toContain('host: "https://ironside.example.com"');
    expect(code).toContain("https://ironside.example.com/v1/otel/traces");
    expect(code).toContain("https://ironside.example.com/api/v1/evaluator/context");
    expect(code).toContain("https://ironside.example.com/api/v1/evaluator/scores");
    expect(code).toContain("authorization=Bearer%20${IRONSIDE_API_KEY}");
    expect(code).toContain("LANGFUSE_BASEURL=https://ironside.example.com");
    expect(code).toContain('LANGFUSE_SECRET_KEY="${IRONSIDE_API_KEY}"');
  });

  it("keeps secrets and project ids out of generated snippets", () => {
    const snippets = buildConnectionSnippets("http://localhost:5174");
    const code = snippets.map((snippet) => snippet.code).join("\n");

    expect(code).toContain("${IRONSIDE_API_KEY}");
    expect(code).not.toContain("ironside_sc_");
    expect(code).not.toContain("proj_");
    expect(snippets.filter((snippet) => snippet.preset === "ingest")).toHaveLength(3);
    expect(snippets.filter((snippet) => snippet.preset === "integration")).toHaveLength(1);
  });

  it("uses shell-expandable environment-variable quoting in the first-trace curl", () => {
    const curl = buildNativeIngestCurl("https://ironside.example.com/", '{"events":[]}');
    expect(curl).toContain('-H "Authorization: Bearer ${IRONSIDE_API_KEY}"');
    expect(curl).not.toContain("-H 'Authorization: Bearer ${IRONSIDE_API_KEY}'");
    expect(curl).toContain("https://ironside.example.com/api/v1/ingest");
  });
});
