import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Ported from coeval's apps/api/src/lib/encryption.ts (same author, same
// pattern) — encrypts destination credentials (export S3 secret keys,
// OTLP forward auth headers, webhook signing secrets) at the application
// layer before they reach Postgres, so a database dump/leak never exposes
// a customer's credential in plaintext. Lives in @ironside/shared (not
// apps/api) because both the API (encrypting on create) and the worker
// (decrypting to actually run a scheduled export/forward/webhook) need
// it — a plain crypto utility with no framework dependency, safe to share.

const PREFIX = "aes-256-gcm:v1";

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptSecret(value: string): string {
  if (!value.startsWith(`${PREFIX}:`)) {
    throw new Error("Encrypted credential payload has an unrecognized or missing version prefix");
  }

  // PREFIX itself contains a colon ("aes-256-gcm:v1"), so slice it off
  // before splitting; splitting the complete value would incorrectly read
  // "v1" as the IV.
  const [ivPart, tagPart, ciphertextPart] = value.slice(PREFIX.length + 1).split(":");
  if (!ivPart || !tagPart || !ciphertextPart) {
    throw new Error("Encrypted credential payload is malformed");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

function encryptionKey(): Buffer {
  const secret = process.env.IRONSIDE_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error("IRONSIDE_ENCRYPTION_SECRET is required to encrypt/decrypt stored destination credentials");
  }
  return createHash("sha256").update(secret).digest();
}
