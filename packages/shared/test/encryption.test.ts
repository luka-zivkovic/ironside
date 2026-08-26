import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/encryption.js";

describe("encryptSecret / decryptSecret", () => {
  const originalSecret = process.env.IRONSIDE_ENCRYPTION_SECRET;

  beforeEach(() => {
    process.env.IRONSIDE_ENCRYPTION_SECRET = "test-encryption-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.IRONSIDE_ENCRYPTION_SECRET;
    else process.env.IRONSIDE_ENCRYPTION_SECRET = originalSecret;
  });

  it("round-trips a plaintext value", () => {
    const ciphertext = encryptSecret("sk-super-secret-value");
    expect(decryptSecret(ciphertext)).toBe("sk-super-secret-value");
  });

  it("produces different ciphertext for the same plaintext on repeated calls (random IV)", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-value");
    expect(decryptSecret(b)).toBe("same-value");
  });

  it("rejects a payload with a tampered auth tag (AEAD integrity check)", () => {
    const ciphertext = encryptSecret("tamper-me");
    const parts = ciphertext.split(":");
    // parts: ["aes-256-gcm", "v1", iv, tag, ciphertext] — corrupt the tag.
    parts[3] = Buffer.from("not-the-real-tag").toString("base64url");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("rejects a payload with an unrecognized version prefix", () => {
    expect(() => decryptSecret("plaintext-not-encrypted-at-all")).toThrow(/unrecognized or missing version prefix/);
  });

  it("throws when IRONSIDE_ENCRYPTION_SECRET is not set", () => {
    delete process.env.IRONSIDE_ENCRYPTION_SECRET;
    expect(() => encryptSecret("anything")).toThrow(/IRONSIDE_ENCRYPTION_SECRET is required/);
  });
});
