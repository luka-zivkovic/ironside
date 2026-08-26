import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_MAXMEM_BYTES = 64 * 1024 * 1024;
const MAX_PASSWORD_BYTES = 1_024;

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function assertPasswordSize(password: string): void {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error("password exceeds maximum encoded length");
  }
}

export async function hashOwnerPassword(password: string): Promise<string> {
  assertPasswordSize(password);
  const salt = randomBytes(16);
  const derived = await deriveKey(password, salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM_BYTES
  });
  return [
    "scrypt",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64url"),
    derived.toString("base64url")
  ].join("$");
}

export async function verifyOwnerPassword(password: string, encoded: string): Promise<boolean> {
  try {
    assertPasswordSize(password);
    const [algorithm, nRaw, rRaw, pRaw, saltRaw, hashRaw, extra] = encoded.split("$");
    if (algorithm !== "scrypt" || !nRaw || !rRaw || !pRaw || !saltRaw || !hashRaw || extra) return false;

    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    // Refuse parameters outside the one version we issue. Besides making
    // upgrades deliberate, this prevents a corrupted DB row from turning a
    // login request into an unbounded KDF allocation.
    if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;

    const salt = Buffer.from(saltRaw, "base64url");
    const expected = Buffer.from(hashRaw, "base64url");
    if (salt.length !== 16 || expected.length !== SCRYPT_KEY_BYTES) return false;
    const actual = await deriveKey(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM_BYTES
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
