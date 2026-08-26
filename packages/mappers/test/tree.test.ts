import type { ObservationRow } from "@ironside/clickhouse";
import { describe, expect, it } from "vitest";
import { buildObservationTree } from "../src/tree.js";

function row(overrides: Partial<ObservationRow> = {}): ObservationRow {
  return {
    id: "obs_1",
    trace_id: "trace_1",
    parent_observation_id: null,
    type: "span",
    name: null,
    start_time: "2026-07-12T00:00:00.000Z",
    end_time: null,
    level: "default",
    status_message: null,
    model: null,
    model_parameters: {},
    input: null,
    output: null,
    usage_details: {},
    cost_details: {},
    completion_start_time: null,
    metadata: {},
    ...overrides
  };
}

describe("buildObservationTree", () => {
  it("nests children under their parent", () => {
    const rows = [
      row({ id: "root" }),
      row({ id: "child", parent_observation_id: "root" }),
      row({ id: "grandchild", parent_observation_id: "child" })
    ];
    const tree = buildObservationTree(rows);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.id).toBe("root");
    expect(tree[0]?.children[0]?.id).toBe("child");
    expect(tree[0]?.children[0]?.children[0]?.id).toBe("grandchild");
  });

  it("sorts siblings by startTime", () => {
    const rows = [
      row({ id: "a", start_time: "2026-07-12T00:00:03.000Z" }),
      row({ id: "b", start_time: "2026-07-12T00:00:01.000Z" }),
      row({ id: "c", start_time: "2026-07-12T00:00:02.000Z" })
    ];
    const tree = buildObservationTree(rows);
    expect(tree.map((n) => n.id)).toEqual(["b", "c", "a"]);
  });

  it("promotes an observation with a missing parent to root instead of dropping it", () => {
    const rows = [row({ id: "orphan", parent_observation_id: "does_not_exist" })];
    const tree = buildObservationTree(rows);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.id).toBe("orphan");
  });

  it("promotes a cyclic chain to root instead of infinite-looping", () => {
    const rows = [
      row({ id: "a", parent_observation_id: "b" }),
      row({ id: "b", parent_observation_id: "a" })
    ];
    const tree = buildObservationTree(rows);
    // Neither node should be lost; a cycle can't have a stable "correct"
    // structure, so both surface at root rather than one being dropped.
    expect(tree.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  it("parses JSON input/output, defaulting to null on malformed data instead of throwing", () => {
    const rows = [
      row({ id: "ok", input: '{"x":1}' }),
      row({ id: "bad", input: "not json" })
    ];
    const tree = buildObservationTree(rows);
    expect(tree.find((n) => n.id === "ok")?.input).toEqual({ x: 1 });
    expect(tree.find((n) => n.id === "bad")?.input).toBeNull();
  });

  it("returns an empty tree for no observations", () => {
    expect(buildObservationTree([])).toEqual([]);
  });

  it("detects a multi-hop cycle that does not include the checked node itself", () => {
    // d -> a -> b -> c -> b (cycle is b<->c, several hops above d and a)
    const rows = [
      row({ id: "d", parent_observation_id: "a" }),
      row({ id: "a", parent_observation_id: "b" }),
      row({ id: "b", parent_observation_id: "c" }),
      row({ id: "c", parent_observation_id: "b" })
    ];
    const tree = buildObservationTree(rows);
    // Every node's ancestor chain passes through the b<->c cycle, so all
    // four are promoted to root rather than d/a hanging off a broken chain.
    expect(tree.map((n) => n.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("handles a long linear chain efficiently and produces a single nested root (no false-positive cycle)", () => {
    const depth = 2000;
    const rows = Array.from({ length: depth }, (_, i) =>
      row({
        id: `n${i}`,
        parent_observation_id: i === 0 ? null : `n${i - 1}`,
        start_time: `2026-07-12T00:00:${String(i % 60).padStart(2, "0")}.${String(
          Math.floor(i / 60)
        ).padStart(3, "0")}Z`
      })
    );
    const start = performance.now();
    const tree = buildObservationTree(rows);
    const elapsedMs = performance.now() - start;

    expect(tree).toHaveLength(1);
    expect(tree[0]?.id).toBe("n0");
    // A quadratic implementation over 2000 linear nodes is orders of
    // magnitude slower than this; a generous bound catches a regression
    // without being a flaky timing assertion.
    expect(elapsedMs).toBeLessThan(1000);
  });
});
