import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  clearLocalFilters,
  filtersFromSearchParams,
  hasFilters,
  MAX_MIN_LATENCY_SECONDS,
  parseCostFloor,
  parseFloor,
  parseLatencyFloor,
  searchParamsFromFilters,
  toParams,
  type Filters
} from "../src/lib/trace-filters.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");

function filters(overrides: Partial<Filters>): Filters {
  return { ...EMPTY_FILTERS, ...overrides };
}

describe("trace explorer filters", () => {
  it("round-trips search, level, model and floors through the URL", () => {
    const applied = filters({
      search: "  refund ",
      level: "error",
      model: " gpt-4o ",
      minLatencySeconds: "2.5",
      minCost: "0.05"
    });
    const search = searchParamsFromFilters(applied);
    expect(search.toString()).toBe("q=refund&level=error&model=gpt-4o&minLatency=2.5&minCost=0.05");
    expect(filtersFromSearchParams(search)).toEqual(
      filters({ search: "refund", level: "error", model: "gpt-4o", minLatencySeconds: "2.5", minCost: "0.05" })
    );
  });

  it("drops an unknown level and invalid floors instead of sharing a filter the list ignores", () => {
    expect(filtersFromSearchParams(new URLSearchParams("level=fatal")).level).toBe("");
    expect(searchParamsFromFilters(filters({ minLatencySeconds: "-1", minCost: "cheap" })).toString()).toBe("");
  });

  it("converts the latency floor to milliseconds and passes the rest through trimmed", () => {
    expect(
      toParams(
        filters({ search: " refund ", level: "warning", model: "gpt-4o", minLatencySeconds: "1.25", minCost: "0" }),
        null,
        NOW
      )
    ).toEqual({ limit: 30, search: "refund", level: "warning", model: "gpt-4o", minDurationMs: 1250, minCost: 0 });
    expect(toParams(filters({ range: "1h", minCost: "-2" }), "cursor_1", NOW)).toEqual({
      limit: 30,
      from: "2026-09-24T11:00:00.000Z",
      cursor: "cursor_1"
    });
  });

  it("parses only numbers from 0 to the API's limit as floors", () => {
    expect(parseFloor("", 10)).toBeUndefined();
    expect(parseFloor("  ", 10)).toBeUndefined();
    expect(parseFloor("-0.1", 10)).toBeUndefined();
    expect(parseFloor("abc", 10)).toBeUndefined();
    expect(parseFloor("Infinity", 10)).toBeUndefined();
    expect(parseFloor("10.5", 10)).toBeUndefined();
    expect(parseFloor("0", 10)).toBe(0);
    expect(parseFloor(" 1.5 ", 10)).toBe(1.5);
    // Floors the API would reject with 400 are never sent.
    expect(parseCostFloor("1e13")).toBeUndefined();
    expect(parseLatencyFloor(String(MAX_MIN_LATENCY_SECONDS))).toBe(MAX_MIN_LATENCY_SECONDS);
    expect(parseLatencyFloor(String(MAX_MIN_LATENCY_SECONDS + 1))).toBeUndefined();
  });

  it("counts every narrowing filter, and clearing keeps only the time range and environment", () => {
    expect(hasFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasFilters(filters({ range: "7d" }))).toBe(false);
    for (const narrowed of [
      filters({ search: "refund" }),
      filters({ level: "error" }),
      filters({ model: "gpt-4o" }),
      filters({ minLatencySeconds: "0" }),
      filters({ minCost: "1" })
    ]) {
      expect(hasFilters(narrowed)).toBe(true);
    }
    expect(hasFilters(filters({ minCost: "-1" }))).toBe(false);

    const everything = filters({
      search: "refund",
      userId: "user_1",
      tags: "prod",
      level: "error",
      model: "gpt-4o",
      minCost: "1",
      environment: "production",
      range: "24h"
    });
    expect(clearLocalFilters(everything)).toEqual(filters({ environment: "production", range: "24h" }));
  });
});
