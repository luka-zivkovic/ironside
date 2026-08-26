import type { ObservationNode } from "@ironside/shared/browser";

export interface VisibleObservation {
  node: ObservationNode;
  parentId: string | null;
  depth: number;
}

export type TraceTreeCommand =
  | { type: "focus"; id: string }
  | { type: "expand"; id: string }
  | { type: "collapse"; id: string };

/** Returns the depth-first order exposed by the current expanded tree. */
export function flattenVisibleObservations(
  roots: ObservationNode[],
  collapsedIds: ReadonlySet<string>
): VisibleObservation[] {
  const visible: VisibleObservation[] = [];

  function visit(nodes: ObservationNode[], parentId: string | null, depth: number) {
    for (const node of nodes) {
      visible.push({ node, parentId, depth });
      if (node.children.length > 0 && !collapsedIds.has(node.id)) {
        visit(node.children, node.id, depth + 1);
      }
    }
  }

  visit(roots, null, 0);
  return visible;
}

/** Implements the navigation portion of the WAI-ARIA vertical tree pattern. */
export function traceTreeCommand(
  key: string,
  currentId: string,
  visible: VisibleObservation[],
  collapsedIds: ReadonlySet<string>
): TraceTreeCommand | null {
  const index = visible.findIndex(({ node }) => node.id === currentId);
  if (index < 0) return null;

  const current = visible[index]!;
  if (key === "ArrowDown" && index < visible.length - 1) {
    return { type: "focus", id: visible[index + 1]!.node.id };
  }
  if (key === "ArrowUp" && index > 0) {
    return { type: "focus", id: visible[index - 1]!.node.id };
  }
  if (key === "Home" && index > 0) {
    return { type: "focus", id: visible[0]!.node.id };
  }
  if (key === "End" && index < visible.length - 1) {
    return { type: "focus", id: visible[visible.length - 1]!.node.id };
  }
  if (key === "ArrowRight" && current.node.children.length > 0) {
    if (collapsedIds.has(current.node.id)) return { type: "expand", id: current.node.id };
    return { type: "focus", id: current.node.children[0]!.id };
  }
  if (key === "ArrowLeft") {
    if (current.node.children.length > 0 && !collapsedIds.has(current.node.id)) {
      return { type: "collapse", id: current.node.id };
    }
    if (current.parentId !== null) return { type: "focus", id: current.parentId };
  }

  return null;
}
