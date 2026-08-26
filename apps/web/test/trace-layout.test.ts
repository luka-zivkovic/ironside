import { describe, expect, it } from "vitest";
import {
  DEFAULT_TREE_SHARE,
  MAX_TREE_SHARE,
  MIN_TREE_SHARE,
  PAYLOAD_TREE_SHARE,
  SPLITTER_WIDTH_PX,
  clampTreeShare,
  preferredTreeShare,
  treeShareFromPointer
} from "../src/lib/trace-layout.js";

describe("trace record split layout", () => {
  it("gives the inspector a larger default share, especially for payload-bearing records", () => {
    expect(preferredTreeShare(false)).toBe(DEFAULT_TREE_SHARE);
    expect(preferredTreeShare(true)).toBe(PAYLOAD_TREE_SHARE);
    expect(DEFAULT_TREE_SHARE).toBeLessThan(50);
    expect(PAYLOAD_TREE_SHARE).toBeLessThan(DEFAULT_TREE_SHARE);
  });

  it("keeps both panes usable when a pointer is dragged to either edge", () => {
    expect(clampTreeShare(-100, 2_000)).toBe(MIN_TREE_SHARE);
    expect(clampTreeShare(100, 2_000)).toBe(MAX_TREE_SHARE);

    const constrainedMinimum = clampTreeShare(0, 800);
    const constrainedMaximum = clampTreeShare(100, 800);
    expect(constrainedMinimum).toBeGreaterThan(MIN_TREE_SHARE);
    expect(constrainedMaximum).toBeLessThan(MAX_TREE_SHARE);
  });

  it("converts pointer position into a bounded tree share", () => {
    expect(treeShareFromPointer(500, 100, 1_000)).toBeCloseTo(39.4, 1);
    expect(treeShareFromPointer(-1_000, 100, 1_000)).toBe(clampTreeShare(0, 1_000));
    expect(treeShareFromPointer(5_000, 100, 1_000)).toBe(clampTreeShare(100, 1_000));
  });

  it("round-trips a rendered handle center without ratcheting the split", () => {
    const containerLeft = 100;
    const containerWidth = 2_000;

    for (const share of [PAYLOAD_TREE_SHARE, DEFAULT_TREE_SHARE, 60]) {
      const handleCenter = containerLeft + (share / 100) * containerWidth + SPLITTER_WIDTH_PX / 2;
      expect(treeShareFromPointer(handleCenter, containerLeft, containerWidth)).toBeCloseTo(share, 8);
    }
  });
});
