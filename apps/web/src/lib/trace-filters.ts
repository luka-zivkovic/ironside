import type { ListTracesParams } from "@/lib/api";
import { parseTimeRange, rangeFrom, type TimeRange } from "@/lib/trace-analytics";

/** Levels the explorer can narrow to: traces with at least one observation at that level. */
export type LevelFilter = "" | "error" | "warning";

export const LEVEL_OPTIONS: { value: LevelFilter; label: string }[] = [
  { value: "", label: "Any level" },
  { value: "error", label: "Has errors" },
  { value: "warning", label: "Has warnings" }
];

/**
 * The explorer's filters as they appear in the form and the URL. Text fields
 * hold what was typed; the latency floor is in seconds and the cost floor in
 * USD, converted to the API's units only when a request is built.
 */
export interface Filters {
  search: string;
  userId: string;
  sessionId: string;
  tags: string;
  environment: string;
  range: TimeRange;
  level: LevelFilter;
  model: string;
  minLatencySeconds: string;
  minCost: string;
}

export const EMPTY_FILTERS: Filters = {
  search: "",
  userId: "",
  sessionId: "",
  tags: "",
  environment: "",
  range: "",
  level: "",
  model: "",
  minLatencySeconds: "",
  minCost: ""
};

function parseLevel(value: string | null): LevelFilter {
  return value === "error" || value === "warning" ? value : "";
}

/** A typed floor, or undefined when it is empty or not a non-negative number. */
export function parseFloor(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function splitTags(tags: string): string[] {
  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** True when anything beyond the time range and the global environment narrows the list. */
export function hasFilters(filters: Filters): boolean {
  return Boolean(
    filters.search.trim() ||
      filters.userId.trim() ||
      filters.sessionId.trim() ||
      filters.tags.trim() ||
      filters.environment.trim() ||
      filters.level ||
      filters.model.trim() ||
      parseFloor(filters.minLatencySeconds) !== undefined ||
      parseFloor(filters.minCost) !== undefined
  );
}

/** The same filters with the local ones cleared; the time range and global environment stay. */
export function clearLocalFilters(filters: Filters): Filters {
  return { ...EMPTY_FILTERS, environment: filters.environment, range: filters.range };
}

export function toParams(filters: Filters, cursor: string | null, now: Date = new Date()): ListTracesParams {
  const tags = splitTags(filters.tags);
  const from = rangeFrom(filters.range, now);
  const minLatencySeconds = parseFloor(filters.minLatencySeconds);
  const minCost = parseFloor(filters.minCost);
  return {
    limit: 30,
    ...(from !== undefined && { from }),
    ...(filters.search.trim() && { search: filters.search.trim() }),
    ...(filters.userId.trim() && { userId: filters.userId.trim() }),
    ...(filters.sessionId.trim() && { sessionId: filters.sessionId.trim() }),
    ...(filters.environment.trim() && { environment: filters.environment.trim() }),
    ...(tags.length > 0 && { tags }),
    ...(filters.level && { level: filters.level }),
    ...(filters.model.trim() && { model: filters.model.trim() }),
    ...(minLatencySeconds !== undefined && { minDurationMs: Math.round(minLatencySeconds * 1000) }),
    ...(minCost !== undefined && { minCost }),
    ...(cursor && { cursor })
  };
}

export function filtersFromSearchParams(search: URLSearchParams): Filters {
  return {
    search: search.get("q") ?? "",
    userId: search.get("userId") ?? "",
    sessionId: search.get("sessionId") ?? "",
    tags: search.getAll("tags").join(", "),
    environment: search.get("environment") ?? "",
    range: parseTimeRange(search.get("range")),
    level: parseLevel(search.get("level")),
    model: search.get("model") ?? "",
    minLatencySeconds: search.get("minLatency") ?? "",
    minCost: search.get("minCost") ?? ""
  };
}

export function searchParamsFromFilters(filters: Filters): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.search.trim()) search.set("q", filters.search.trim());
  if (filters.userId.trim()) search.set("userId", filters.userId.trim());
  if (filters.sessionId.trim()) search.set("sessionId", filters.sessionId.trim());
  if (filters.environment.trim()) search.set("environment", filters.environment.trim());
  if (filters.range) search.set("range", filters.range);
  if (filters.level) search.set("level", filters.level);
  if (filters.model.trim()) search.set("model", filters.model.trim());
  // Only valid floors reach the URL, so a shared link never carries one the list ignores.
  if (parseFloor(filters.minLatencySeconds) !== undefined) {
    search.set("minLatency", filters.minLatencySeconds.trim());
  }
  if (parseFloor(filters.minCost) !== undefined) search.set("minCost", filters.minCost.trim());
  for (const tag of splitTags(filters.tags)) search.append("tags", tag);
  return search;
}
