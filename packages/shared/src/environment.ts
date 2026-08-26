import { z } from "zod";

/**
 * Environment names are user-visible identifiers, not policy boundaries.
 * Keep identity case-sensitive, but remove presentation-only variance and
 * reject values that are unsafe or too large to expose in URLs and pickers.
 */
export const MAX_ENVIRONMENT_NAME_LENGTH = 64;
export const MAX_OBSERVED_ENVIRONMENTS_PER_PROJECT = 100;

const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\p{Cf}]/u;

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function normalizeEnvironment(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  if (
    !normalized ||
    hasLoneSurrogate(normalized) ||
    CONTROL_OR_FORMAT_CHARACTER.test(normalized)
  ) return null;
  if ([...normalized].length > MAX_ENVIRONMENT_NAME_LENGTH) return null;
  return normalized;
}

export const environmentNameSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeEnvironment(value);
  if (normalized === null) {
    ctx.addIssue({
      code: "custom",
      message: `environment must be non-empty, valid Unicode without control characters, and at most ${MAX_ENVIRONMENT_NAME_LENGTH} Unicode characters`
    });
    return z.NEVER;
  }
  return normalized;
});
