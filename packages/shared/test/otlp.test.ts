import { describe, expect, it } from "vitest";
import { otlpExportTraceServiceRequestSchema, unixNanoToIso } from "../src/otlp.js";

describe("unixNanoToIso", () => {
  it("converts a positive nanosecond timestamp correctly", () => {
    expect(unixNanoToIso("1700000000000000000")).toBe("2023-11-14T22:13:20.000Z");
  });

  it("floors (not truncates-toward-zero) for a negative/pre-1970 timestamp", () => {
    // -1.5ms in nanoseconds. Truncation-toward-zero (plain BigInt division)
    // would give -1ms (1969-12-31T23:59:59.999Z); floor gives -2ms
    // (1969-12-31T23:59:59.998Z) — the mathematically correct answer for
    // "which millisecond does this nanosecond instant fall in".
    expect(unixNanoToIso("-1500000")).toBe("1969-12-31T23:59:59.998Z");
  });

  it("handles exact millisecond boundaries for negative values without an off-by-one", () => {
    expect(unixNanoToIso("-1000000")).toBe("1969-12-31T23:59:59.999Z");
  });
});

describe("otlpExportTraceServiceRequestSchema — attribute value depth limit", () => {
  function nestedArrayValue(depth: number): unknown {
    let value: unknown = { stringValue: "leaf" };
    for (let i = 0; i < depth; i++) {
      value = { arrayValue: { values: [value] } };
    }
    return value;
  }

  function requestWithAttributeValue(value: unknown) {
    return {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "5b8efff798038103d269b633813fc60",
                  spanId: "eee19b7ec3c1b174",
                  startTimeUnixNano: "1700000000000000000",
                  attributes: [{ key: "deep", value }]
                }
              ]
            }
          ]
        }
      ]
    };
  }

  it("accepts attribute values nested well within the depth limit", () => {
    const result = otlpExportTraceServiceRequestSchema.safeParse(
      requestWithAttributeValue(nestedArrayValue(10))
    );
    expect(result.success).toBe(true);
  });

  it("does not stack-overflow on a pathologically deep attribute value, and rejects past the cap", () => {
    // 10,000 levels would blow the call stack on an unbounded recursive
    // schema; if this test hangs or crashes the process, the depth guard
    // has regressed. A malformed-shape rejection (not a crash) is correct.
    const result = otlpExportTraceServiceRequestSchema.safeParse(
      requestWithAttributeValue(nestedArrayValue(10_000))
    );
    expect(result.success).toBe(false);
  });
});
