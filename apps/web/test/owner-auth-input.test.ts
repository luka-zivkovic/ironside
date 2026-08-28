import { describe, expect, it } from "vitest";
import { extractOwnerCapability, safeNextPath } from "../src/lib/owner-auth-input.js";

describe("owner auth browser input", () => {
  it("extracts only the requested complete capability from pasted command output", () => {
    const setup = `ironside_setup_${"a".repeat(43)}`;
    const recovery = `ironside_recovery_${"b".repeat(43)}`;
    expect(extractOwnerCapability(`One-time owner setup code:\n${setup}\nExpires soon`, "setup")).toBe(setup);
    expect(extractOwnerCapability(recovery, "setup")).toBeNull();
    expect(extractOwnerCapability(`token=${recovery}`, "recovery")).toBe(recovery);
    expect(extractOwnerCapability(`ironside_setup_${"a".repeat(42)}`, "setup")).toBeNull();
  });

  it("accepts local redirect paths but rejects protocol-relative redirects", () => {
    expect(safeNextPath("/traces/abc?tab=raw")).toBe("/traces/abc?tab=raw");
    expect(safeNextPath("//attacker.example/path")).toBeNull();
    expect(safeNextPath("https://attacker.example/path")).toBeNull();
    expect(safeNextPath(null)).toBeNull();
  });
});
