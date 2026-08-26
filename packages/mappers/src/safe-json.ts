/**
 * Parses a stored JSON string, returning null on failure instead of
 * throwing. Insert paths always JSON.stringify input/output, so a parse
 * failure here would indicate corrupt data, not a normal condition — the
 * query path should degrade to null rather than 500 the whole trace.
 */
export function safeJsonParse(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
