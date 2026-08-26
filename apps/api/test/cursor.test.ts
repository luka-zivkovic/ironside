import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/lib/cursor.js";

describe("cursor", () => {
  it("round-trips a cursor", () => {
    const cursor = { timestamp: "2026-07-12T00:00:00.000Z", id: "trace_1" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("returns null for garbage input instead of throwing", () => {
    expect(decodeCursor("not-base64url-json")).toBeNull();
    expect(decodeCursor(Buffer.from("null").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("{}").toString("base64url"))).toBeNull();
    expect(
      decodeCursor(Buffer.from(JSON.stringify({ timestamp: 1, id: "x" })).toString("base64url"))
    ).toBeNull();
  });
});
