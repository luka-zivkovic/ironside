import {
  MAX_ENVIRONMENT_NAME_LENGTH,
  environmentNameSchema,
  normalizeEnvironment
} from "../src/environment.js";
import { describe, expect, it } from "vitest";

describe("environment normalization", () => {
  it("trims and NFC-normalizes while preserving case", () => {
    expect(normalizeEnvironment("  Produc\u0065\u0301tion  ")).toBe("Producétion");
    expect(normalizeEnvironment("Production")).not.toBe(normalizeEnvironment("production"));
  });

  it("rejects empty, control/format characters, and overlong values", () => {
    expect(normalizeEnvironment("   ")).toBeNull();
    expect(normalizeEnvironment("prod\nblue")).toBeNull();
    expect(normalizeEnvironment("prod\u200E")).toBeNull();
    expect(normalizeEnvironment("prod\ud800")).toBeNull();
    expect(normalizeEnvironment("prod\udc00")).toBeNull();
    const boundary = "🌍".repeat(MAX_ENVIRONMENT_NAME_LENGTH);
    expect(normalizeEnvironment(boundary)).toBe(boundary);
    expect(normalizeEnvironment("🌍".repeat(MAX_ENVIRONMENT_NAME_LENGTH + 1))).toBeNull();
  });

  it("uses the same strict contract for query/input schemas", () => {
    expect(environmentNameSchema.parse(" staging ")).toBe("staging");
    expect(() => environmentNameSchema.parse("x".repeat(MAX_ENVIRONMENT_NAME_LENGTH + 1))).toThrow();
  });
});
