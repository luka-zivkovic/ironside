// Opaque base64 keyset cursor: (timestamp, id) of the last row of a page.
// Clients must treat it as opaque; encoding is an internal implementation
// detail so the query strategy (keyset vs offset, sort key) can change
// without breaking the API contract.

export interface Cursor {
  timestamp: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "timestamp" in parsed &&
      "id" in parsed &&
      typeof (parsed as Cursor).timestamp === "string" &&
      typeof (parsed as Cursor).id === "string"
    ) {
      return parsed as Cursor;
    }
    return null;
  } catch {
    return null;
  }
}
