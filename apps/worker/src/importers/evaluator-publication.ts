import { createHash } from "node:crypto";
import type { Observation, Trace } from "@ironside/shared";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

/** Stable identity for the evaluator-visible part of one imported trace. */
export function importedTraceContentHash(
  trace: Trace,
  observations: Observation[]
): string {
  const snapshot = {
    trace,
    observations: [...observations].sort((a, b) => a.id.localeCompare(b.id))
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)))
    .digest("hex");
}
