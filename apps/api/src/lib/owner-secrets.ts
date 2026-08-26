import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type OwnerChallengeTokenKind = "setup" | "recovery";

export function generateOwnerChallengeToken(kind: OwnerChallengeTokenKind): {
  token: string;
  tokenHash: string;
} {
  const token = `ironside_${kind}_${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashOwnerSecret(token) };
}

export function generateOwnerSessionToken(): { token: string; tokenHash: string } {
  const token = `ironside_session_${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashOwnerSecret(token) };
}

export function hashOwnerSecret(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Challenges are selected with a constant-time comparison of their stored
 * hashes before the chosen row is claimed transactionally. The tokens carry
 * 256 bits of entropy, but avoiding an early-return string comparison also
 * keeps the comparison contract explicit and testable.
 */
export function constantTimeHashMatch(candidateHash: string, storedHash: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(candidateHash) || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(candidateHash, "hex"), Buffer.from(storedHash, "hex"));
}
