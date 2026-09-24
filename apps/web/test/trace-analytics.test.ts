import { describe, expect, it } from "vitest";
import {
  formatCompactNumber,
  formatLatency,
  formatTraceCost,
  formatUsd,
  parseTimeRange,
  rangeFrom,
  summarizeCost,
  summarizeTokens,
  summaryTiles
} from "../src/lib/trace-analytics.js";

describe("trace analytics helpers", () => {
  it("parses only known range presets and falls back to all time", () => {
    expect(parseTimeRange("24h")).toBe("24h");
    expect(parseTimeRange("7d")).toBe("7d");
    expect(parseTimeRange("bogus")).toBe("");
    expect(parseTimeRange(null)).toBe("");
  });

  it("derives an ISO lower bound from the preset", () => {
    const now = new Date("2026-09-11T12:00:00.000Z");
    expect(rangeFrom("", now)).toBeUndefined();
    expect(rangeFrom("1h", now)).toBe("2026-09-11T11:00:00.000Z");
    expect(rangeFrom("24h", now)).toBe("2026-09-10T12:00:00.000Z");
    expect(rangeFrom("7d", now)).toBe("2026-09-04T12:00:00.000Z");
    expect(rangeFrom("30d", now)).toBe("2026-08-12T12:00:00.000Z");
  });

  it("formats numbers in the compact stat-tile convention", () => {
    expect(formatCompactNumber(0)).toBe("0");
    expect(formatCompactNumber(1284)).toBe("1,284");
    expect(formatCompactNumber(12_940)).toBe("12.9K");
    expect(formatCompactNumber(12_000)).toBe("12K");
    expect(formatCompactNumber(412_000)).toBe("412K");
    expect(formatCompactNumber(4_200_000)).toBe("4.2M");
    expect(formatCompactNumber(1_100_000_000)).toBe("1.1B");
  });

  it("formats USD without hiding sub-cent spend", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.0312)).toBe("$0.0312");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(4200)).toBe("$4,200");
    expect(formatUsd(42_000)).toBe("$42K");
  });

  it("formats one trace's cost to four decimals below a dollar", () => {
    expect(formatTraceCost(0)).toBe("$0.00");
    expect(formatTraceCost(0.00004)).toBe("<$0.0001");
    expect(formatTraceCost(0.0061)).toBe("$0.0061");
    expect(formatTraceCost(0.1875)).toBe("$0.1875");
    expect(formatTraceCost(12.5)).toBe("$12.50");
  });

  it("formats latency across ms, seconds and minutes", () => {
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(412.4)).toBe("412ms");
    expect(formatLatency(1830)).toBe("1.83s");
    expect(formatLatency(12_300)).toBe("12.3s");
    expect(formatLatency(90_000)).toBe("1.5m");
  });

  it("collapses native, LangFuse and OTLP usage vocabularies", () => {
    expect(summarizeTokens({ input_tokens: 100, output_tokens: 40, total_tokens: 140 })).toEqual({
      total: 140,
      input: 100,
      output: 40
    });
    expect(summarizeTokens({ input: 10, output: 5 })).toEqual({ total: 15, input: 10, output: 5 });
    expect(summarizeTokens({ "gen_ai.usage.input_tokens": 7, "gen_ai.usage.output_tokens": 3 })).toEqual({
      total: 10,
      input: 7,
      output: 3
    });
    expect(summarizeTokens({ cache_read: 20, reasoning: 5 })).toEqual({ total: 25, input: null, output: null });
    expect(summarizeTokens({})).toEqual({ total: null, input: null, output: null });
  });

  it("prefers a reported total when summarizing cost", () => {
    expect(summarizeCost({ input: 0.1, output: 0.2, total: 0.3 })).toBe(0.3);
    expect(summarizeCost({ input: 0.1, output: 0.2 })).toBeCloseTo(0.3);
    expect(summarizeCost({ embedding: 0.05 })).toBe(0.05);
    expect(summarizeCost({})).toBeNull();
  });

  it("always yields four tiles, with dashes when a measure is absent", () => {
    const empty = summaryTiles({
      traceCount: 0,
      tokenTotals: {},
      costTotals: {},
      latencyMsPercentiles: { p50: null, p95: null, p99: null }
    });
    expect(empty.map((tile) => tile.label)).toEqual(["Traces", "Tokens", "Cost", "Latency p50"]);
    expect(empty.map((tile) => tile.value)).toEqual(["0", "—", "—", "—"]);
    expect(empty.every((tile) => tile.detail === undefined)).toBe(true);

    const populated = summaryTiles({
      traceCount: 1284,
      tokenTotals: { input_tokens: 12_000, output_tokens: 940 },
      costTotals: { total: 3.5 },
      latencyMsPercentiles: { p50: 820, p95: 2400, p99: 5100 }
    });
    expect(populated[0]).toEqual({ label: "Traces", value: "1,284" });
    expect(populated[1]).toEqual({ label: "Tokens", value: "12.9K", detail: "12K in · 940 out" });
    expect(populated[2]).toEqual({ label: "Cost", value: "$3.50" });
    expect(populated[3]).toEqual({ label: "Latency p50", value: "820ms", detail: "p95 2.40s · p99 5.10s" });
  });
});
