import { describe, expect, it } from "vitest";
import {
  decodeEvaluatorCursor,
  encodeEvaluatorCursor,
  initialLiveEvaluatorCursor
} from "../src/lib/evaluator-cursor.js";

describe("evaluator cursor", () => {
  it("round-trips bootstrap and live cursors and rejects malformed values", () => {
    const bootstrap = {
      v: 1 as const,
      kind: "bootstrap" as const,
      through: "2026-08-30T12:00:00.000Z",
      afterVersion: "2026-08-30T11:00:00.000Z",
      afterTraceId: "trace_1"
    };
    expect(decodeEvaluatorCursor(encodeEvaluatorCursor(bootstrap))).toEqual(bootstrap);
    expect(decodeEvaluatorCursor(encodeEvaluatorCursor(initialLiveEvaluatorCursor())))
      .toEqual({ v: 1, kind: "live", publishedAt: null, traceId: null });
    expect(decodeEvaluatorCursor("not-a-cursor")).toBeNull();
  });
});
