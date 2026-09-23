import { describe, expect, it } from "vitest";
import { rubristTraceLink, ironsideTracePath } from "../src/lib/rubrist-link.js";

describe("Rubrist trace deep link", () => {
  it("builds the shared /links/trace contract with encoded identity", () => {
    expect(
      rubristTraceLink("https://rubrist.example.com", {
        projectId: "proj 1",
        traceId: "trace/a&b",
        traceVersion: "2026-09-22T10:00:00.123456Z"
      })
    ).toBe(
      "https://rubrist.example.com/links/trace?source=ironside&project=proj+1&trace=trace%2Fa%26b&version=2026-09-22T10%3A00%3A00.123456Z"
    );
  });

  it("omits an unknown version and tolerates a trailing slash or path prefix", () => {
    expect(rubristTraceLink("https://rubrist.example.com/app/", { projectId: "p", traceId: "t" })).toBe(
      "https://rubrist.example.com/app/links/trace?source=ironside&project=p&trace=t"
    );
    expect(rubristTraceLink("http://localhost:5173", { projectId: "p", traceId: "t", traceVersion: null })).toBe(
      "http://localhost:5173/links/trace?source=ironside&project=p&trace=t"
    );
  });

  it("returns the stable Ironside viewer path for inbound links", () => {
    expect(ironsideTracePath("proj_1", "trace/a b")).toBe("/projects/proj_1/traces/trace%2Fa%20b");
  });
});
