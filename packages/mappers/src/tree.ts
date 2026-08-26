import type { ObservationRow } from "@ironside/clickhouse";
import type { ObservationNode } from "@ironside/shared";
import { safeJsonParse } from "./safe-json.js";

/**
 * Nests a flat list of observations by parentObservationId. Observations
 * whose declared parent isn't present in the same trace (client bug, or the
 * parent was never ingested) are promoted to root-level rather than
 * dropped — losing data silently would be worse than an unexpected root.
 * A defensive cycle guard prevents a corrupt parent chain (should never
 * happen, but a malicious/buggy payload must not hang the request) from
 * infinite-looping; any node whose ancestor chain passes through a cycle
 * (however far up) is also promoted to root instead of being dropped.
 *
 * Cycle status is memoized per node (`status`) so each node's ancestor path
 * is walked at most once across the whole call, not once per node — O(n)
 * total rather than O(n^2) for a long linear/well-formed chain, which is a
 * realistic shape for LLM traces (sequential agent/tool-call steps) and
 * must stay cheap on every request, not just the rare cyclic case.
 *
 * Shared by apps/api's trace-detail route and apps/worker's OTLP forwarder
 * — both need to reconstruct the same tree shape from a flat observation
 * list.
 */
export function buildObservationTree(rows: ObservationRow[]): ObservationNode[] {
  const nodes = new Map<string, ObservationNode>();
  for (const row of rows) {
    nodes.set(row.id, {
      id: row.id,
      parentObservationId: row.parent_observation_id,
      type: row.type as ObservationNode["type"],
      name: row.name,
      startTime: row.start_time,
      endTime: row.end_time,
      level: row.level,
      statusMessage: row.status_message,
      model: row.model,
      modelParameters: row.model_parameters,
      input: safeJsonParse(row.input),
      output: safeJsonParse(row.output),
      usageDetails: row.usage_details,
      costDetails: row.cost_details,
      completionStartTime: row.completion_start_time,
      metadata: row.metadata,
      children: []
    });
  }

  // "in-progress" marks nodes on the current walk (for cycle detection);
  // "clean"/"cyclic" are memoized final results reused by later walks.
  const status = new Map<string, "in-progress" | "clean" | "cyclic">();

  function isCyclic(startId: string): boolean {
    const path: string[] = [];
    let current: string | null = startId;

    while (current) {
      const known = status.get(current);
      if (known === "clean") break;
      if (known === "cyclic" || known === "in-progress") {
        for (const id of path) status.set(id, "cyclic");
        status.set(current, "cyclic");
        return true;
      }
      status.set(current, "in-progress");
      path.push(current);
      current = nodes.get(current)?.parentObservationId ?? null;
    }

    for (const id of path) status.set(id, "clean");
    return false;
  }

  const roots: ObservationNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.parentObservationId;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent && !isCyclic(node.id)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const byStartTime = (a: ObservationNode, b: ObservationNode) =>
    a.startTime.localeCompare(b.startTime);
  roots.sort(byStartTime);
  for (const node of nodes.values()) node.children.sort(byStartTime);

  return roots;
}
