import { describe, expect, it } from "vitest";
import { coevalTraceLink, ironsideTracePath } from "../src/lib/coeval-link.js";

describe("Coeval trace deep link", () => {
  it("builds the shared /links/trace contract with encoded identity", () => {
    expect(
      coevalTraceLink("https://coeval.example.com", {
        projectId: "proj 1",
        traceId: "trace/a&b",
        traceVersion: "2026-09-22T10:00:00.123456Z"
      })
    ).toBe(
      "https://coeval.example.com/links/trace?source=ironside&project=proj+1&trace=trace%2Fa%26b&version=2026-09-22T10%3A00%3A00.123456Z"
    );
  });

  it("omits an unknown version and tolerates a trailing slash or path prefix", () => {
    expect(coevalTraceLink("https://coeval.example.com/app/", { projectId: "p", traceId: "t" })).toBe(
      "https://coeval.example.com/app/links/trace?source=ironside&project=p&trace=t"
    );
    expect(coevalTraceLink("http://localhost:5173", { projectId: "p", traceId: "t", traceVersion: null })).toBe(
      "http://localhost:5173/links/trace?source=ironside&project=p&trace=t"
    );
  });

  it("returns the stable Ironside viewer path for inbound links", () => {
    expect(ironsideTracePath("proj_1", "trace/a b")).toBe("/projects/proj_1/traces/trace%2Fa%20b");
  });
});
