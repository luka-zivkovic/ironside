import { describe, expect, it } from "vitest";
import { loadConfig, optionalCoevalUrl } from "../src/config.js";

describe("IRONSIDE_COEVAL_URL", () => {
  it("is disabled when unset or blank", () => {
    expect(loadConfig({}).coevalUrl).toBeNull();
    expect(loadConfig({ IRONSIDE_COEVAL_URL: "  " }).coevalUrl).toBeNull();
  });

  it("normalizes an absolute http(s) base, keeping a path prefix", () => {
    expect(loadConfig({ IRONSIDE_COEVAL_URL: "https://coeval.example.com/" }).coevalUrl).toBe(
      "https://coeval.example.com"
    );
    expect(optionalCoevalUrl(" http://localhost:5173/coeval// ")).toBe("http://localhost:5173/coeval");
  });

  it("rejects relative, non-http, credentialed, query, and fragment values at startup", () => {
    for (const value of [
      "coeval.example.com",
      "/coeval",
      "javascript:alert(1)",
      "ftp://coeval.example.com",
      "https://user:pass@coeval.example.com",
      "https://coeval.example.com/?a=1",
      "https://coeval.example.com/#x"
    ]) {
      expect(() => optionalCoevalUrl(value), value).toThrow(/IRONSIDE_COEVAL_URL/);
    }
  });
});
