import type { ObservationNode } from "@ironside/shared/browser";
import { describe, expect, it } from "vitest";
import { flattenVisibleObservations, traceTreeCommand } from "../src/lib/trace-tree-nav.js";

function observation(id: string, children: ObservationNode[] = []): ObservationNode {
  return {
    id,
    parentObservationId: null,
    type: "span",
    name: id,
    startTime: "2026-08-25T00:00:00.000Z",
    endTime: null,
    level: "DEFAULT",
    statusMessage: null,
    model: null,
    modelParameters: {},
    input: null,
    output: null,
    usageDetails: {},
    costDetails: {},
    completionStartTime: null,
    metadata: {},
    children
  };
}

const tree = [
  observation("a", [observation("a-1"), observation("a-2", [observation("a-2-1")])]),
  observation("b")
];

describe("trace tree keyboard navigation", () => {
  it("flattens the expanded tree in visual depth-first order", () => {
    expect(flattenVisibleObservations(tree, new Set()).map(({ node, parentId, depth }) => [node.id, parentId, depth])).toEqual([
      ["a", null, 0],
      ["a-1", "a", 1],
      ["a-2", "a", 1],
      ["a-2-1", "a-2", 2],
      ["b", null, 0]
    ]);
  });

  it("excludes every descendant of a collapsed observation", () => {
    expect(flattenVisibleObservations(tree, new Set(["a"])).map(({ node }) => node.id)).toEqual(["a", "b"]);
    expect(flattenVisibleObservations(tree, new Set(["a-2"])).map(({ node }) => node.id)).toEqual([
      "a", "a-1", "a-2", "b"
    ]);
  });

  it("moves without wrapping and supports Home and End", () => {
    const visible = flattenVisibleObservations(tree, new Set());
    expect(traceTreeCommand("ArrowDown", "a", visible, new Set())).toEqual({ type: "focus", id: "a-1" });
    expect(traceTreeCommand("ArrowUp", "a-2", visible, new Set())).toEqual({ type: "focus", id: "a-1" });
    expect(traceTreeCommand("Home", "b", visible, new Set())).toEqual({ type: "focus", id: "a" });
    expect(traceTreeCommand("End", "a", visible, new Set())).toEqual({ type: "focus", id: "b" });
    expect(traceTreeCommand("ArrowUp", "a", visible, new Set())).toBeNull();
    expect(traceTreeCommand("ArrowDown", "b", visible, new Set())).toBeNull();
  });

  it("expands, enters, collapses, and returns to parents with horizontal arrows", () => {
    const collapsed = new Set(["a"]);
    const collapsedVisible = flattenVisibleObservations(tree, collapsed);
    expect(traceTreeCommand("ArrowRight", "a", collapsedVisible, collapsed)).toEqual({ type: "expand", id: "a" });

    const visible = flattenVisibleObservations(tree, new Set());
    expect(traceTreeCommand("ArrowRight", "a", visible, new Set())).toEqual({ type: "focus", id: "a-1" });
    expect(traceTreeCommand("ArrowLeft", "a", visible, new Set())).toEqual({ type: "collapse", id: "a" });
    expect(traceTreeCommand("ArrowLeft", "a-1", visible, new Set())).toEqual({ type: "focus", id: "a" });
    expect(traceTreeCommand("ArrowRight", "b", visible, new Set())).toBeNull();
  });
});
