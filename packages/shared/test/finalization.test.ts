import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRACE_QUIET_PERIOD_SECONDS,
  traceSettledBefore
} from "../src/finalization.js";

describe("trace finalization watermark", () => {
  it("defaults to five minutes and computes the cutoff from a supplied clock", () => {
    expect(DEFAULT_TRACE_QUIET_PERIOD_SECONDS).toBe(300);
    expect(
      traceSettledBefore(300, new Date("2026-08-17T12:05:00.000Z"))
    ).toBe("2026-08-17T12:00:00.000Z");
  });
});
