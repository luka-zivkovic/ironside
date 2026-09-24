import type { AggregatesResponse } from "@ironside/shared/browser";

/** Preset windows for the trace explorer. "" means the whole retained record. */
export type TimeRange = "" | "1h" | "24h" | "7d" | "30d";

export const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "", label: "All time" }
];

const RANGE_MS: Record<Exclude<TimeRange, "">, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
};

export function parseTimeRange(value: string | null): TimeRange {
  return value && value in RANGE_MS ? (value as TimeRange) : "";
}

/** ISO lower bound for a preset, or undefined for all time. */
export function rangeFrom(range: TimeRange, now: Date = new Date()): string | undefined {
  if (range === "") return undefined;
  return new Date(now.getTime() - RANGE_MS[range]).toISOString();
}

/** 1,284 · 12.9K · 4.2M · 1.1B — the auto-compact stat-tile convention. */
export function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs < 10_000) return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"]
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = value / size;
      return `${scaled.toFixed(scaled < 100 ? 1 : 0).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return String(value);
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  if (value >= 1000) return `$${formatCompactNumber(value)}`;
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

/**
 * One trace's cost. A single request usually costs less than a cent, so this
 * keeps four decimals where formatUsd would show "<$0.01".
 */
export function formatTraceCost(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.0001) return "<$0.0001";
  if (value < 1) return `$${value.toFixed(4)}`;
  return formatUsd(value);
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export interface TokenSummary {
  total: number | null;
  input: number | null;
  output: number | null;
}

function firstPresent(totals: Record<string, number>, keys: string[]): number | null {
  for (const key of keys) {
    const value = totals[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function sumAll(totals: Record<string, number>): number | null {
  const values = Object.values(totals).filter((value) => Number.isFinite(value));
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

/**
 * Collapse per-key usage sums into total / input / output. Sources disagree on
 * key names (native `input_tokens`, LangFuse `input`, OTLP `gen_ai.usage.*`);
 * a reported total wins, then input + output, then the sum of whatever keys
 * exist so an unknown vocabulary still yields a number instead of a blank.
 */
export function summarizeTokens(totals: Record<string, number>): TokenSummary {
  const input = firstPresent(totals, ["input_tokens", "input", "prompt_tokens", "gen_ai.usage.input_tokens"]);
  const output = firstPresent(totals, [
    "output_tokens",
    "output",
    "completion_tokens",
    "gen_ai.usage.output_tokens"
  ]);
  const reportedTotal = firstPresent(totals, ["total_tokens", "total"]);
  const total =
    reportedTotal ?? (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : sumAll(totals));
  return { total, input, output };
}

/** Same collapse for cost_details; only the total is displayed. */
export function summarizeCost(totals: Record<string, number>): number | null {
  const reportedTotal = firstPresent(totals, ["total", "total_cost", "totalCost"]);
  if (reportedTotal !== null) return reportedTotal;
  const input = firstPresent(totals, ["input", "input_cost", "prompt"]);
  const output = firstPresent(totals, ["output", "output_cost", "completion"]);
  if (input !== null || output !== null) return (input ?? 0) + (output ?? 0);
  return sumAll(totals);
}

export interface SummaryTile {
  label: string;
  value: string;
  detail?: string;
}

/** The KPI row for a filtered trace set. Always four tiles so the row is stable across filters. */
export function summaryTiles(aggregates: AggregatesResponse): SummaryTile[] {
  const tokens = summarizeTokens(aggregates.tokenTotals);
  const cost = summarizeCost(aggregates.costTotals);
  const { p50, p95, p99 } = aggregates.latencyMsPercentiles;

  const tokenDetail =
    tokens.input !== null || tokens.output !== null
      ? `${formatCompactNumber(tokens.input ?? 0)} in · ${formatCompactNumber(tokens.output ?? 0)} out`
      : undefined;

  return [
    { label: "Traces", value: formatCompactNumber(aggregates.traceCount) },
    {
      label: "Tokens",
      value: tokens.total === null ? "—" : formatCompactNumber(tokens.total),
      ...(tokenDetail !== undefined && { detail: tokenDetail })
    },
    { label: "Cost", value: cost === null ? "—" : formatUsd(cost) },
    {
      label: "Latency p50",
      value: formatLatency(p50),
      ...(p95 !== null && { detail: `p95 ${formatLatency(p95)} · p99 ${formatLatency(p99)}` })
    }
  ];
}
