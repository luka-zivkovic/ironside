import { describe, expect, it } from "vitest";
import { loadConfig, optionalRubristUrl } from "../src/config.js";

describe("IRONSIDE_RUBRIST_URL", () => {
  it("is disabled when unset or blank", () => {
    expect(loadConfig({}).rubristUrl).toBeNull();
    expect(loadConfig({ IRONSIDE_RUBRIST_URL: "  " }).rubristUrl).toBeNull();
  });

  it("normalizes an absolute http(s) base, keeping a path prefix", () => {
    expect(loadConfig({ IRONSIDE_RUBRIST_URL: "https://rubrist.example.com/" }).rubristUrl).toBe(
      "https://rubrist.example.com"
    );
    expect(optionalRubristUrl(" http://localhost:5173/rubrist// ")).toBe("http://localhost:5173/rubrist");
  });

  it("rejects relative, non-http, credentialed, query, and fragment values at startup", () => {
    for (const value of [
      "rubrist.example.com",
      "/rubrist",
      "javascript:alert(1)",
      "ftp://rubrist.example.com",
      "https://user:pass@rubrist.example.com",
      "https://rubrist.example.com/?a=1",
      "https://rubrist.example.com/#x"
    ]) {
      expect(() => optionalRubristUrl(value), value).toThrow(/IRONSIDE_RUBRIST_URL/);
    }
  });
});
