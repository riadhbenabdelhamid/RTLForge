// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Tests for src/utils/diff.js
//
// Pins the behaviour of the line-level LCS diff. The key invariant: applying
// the diff against the "before" file recovers the "after" file. Boundary
// cases for empty inputs, identical inputs, additions/removals only, and
// the side-by-side row pairing.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";
import { diffLines, diffToSideBySide, diffStats } from "../src/utils/diff.js";

describe("diffLines", function() {
  it("returns empty for two empty strings", function() {
    expect(diffLines("", "")).toEqual([]);
  });

  it("identical inputs produce all-equal segments", function() {
    const segs = diffLines("a\nb\nc", "a\nb\nc");
    expect(segs).toHaveLength(3);
    segs.forEach(function(s) { expect(s.type).toBe("equal"); });
    expect(segs[0]).toEqual({ type: "equal", left: 1, right: 1, content: "a" });
    expect(segs[2]).toEqual({ type: "equal", left: 3, right: 3, content: "c" });
  });

  it("pure addition: empty before, content after", function() {
    const segs = diffLines("", "a\nb");
    expect(segs).toEqual([
      { type: "add", left: null, right: 1, content: "a" },
      { type: "add", left: null, right: 2, content: "b" },
    ]);
  });

  it("pure deletion: content before, empty after", function() {
    const segs = diffLines("a\nb", "");
    expect(segs).toEqual([
      { type: "del", left: 1, right: null, content: "a" },
      { type: "del", left: 2, right: null, content: "b" },
    ]);
  });

  it("middle insertion preserves surrounding equal segments", function() {
    const segs = diffLines("a\nc", "a\nb\nc");
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ type: "equal", left: 1, right: 1, content: "a" });
    expect(segs[1]).toEqual({ type: "add",   left: null, right: 2, content: "b" });
    expect(segs[2]).toEqual({ type: "equal", left: 2, right: 3, content: "c" });
  });

  it("middle deletion", function() {
    const segs = diffLines("a\nb\nc", "a\nc");
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ type: "equal", left: 1, right: 1, content: "a" });
    expect(segs[1]).toEqual({ type: "del",   left: 2, right: null, content: "b" });
    expect(segs[2]).toEqual({ type: "equal", left: 3, right: 2, content: "c" });
  });

  it("substitution: del+add for changed line", function() {
    const segs = diffLines("a\nx\nc", "a\ny\nc");
    expect(segs).toHaveLength(4);
    expect(segs[0].type).toBe("equal");
    expect(segs[3].type).toBe("equal");
    // Middle two are one del + one add (order can be either, depending on
    // LCS backtrace choice when ties are equal)
    const middle = [segs[1], segs[2]];
    const types = middle.map(function(s) { return s.type; }).sort();
    expect(types).toEqual(["add", "del"]);
    const delSeg = middle.find(function(s) { return s.type === "del"; });
    const addSeg = middle.find(function(s) { return s.type === "add"; });
    expect(delSeg.content).toBe("x");
    expect(addSeg.content).toBe("y");
  });

  it("applying the diff to before recovers after (round-trip property)", function() {
    const before = "module x;\n  logic q;\n  always_ff @(posedge clk) q <= d;\nendmodule";
    const after  = "module x;\n  logic q, q2;\n  always_ff @(posedge clk) begin q <= d; q2 <= q; end\nendmodule";
    const segs = diffLines(before, after);
    // Reconstruct after from segments
    const reconstructed = segs
      .filter(function(s) { return s.type !== "del"; })
      .map(function(s) { return s.content; })
      .join("\n");
    expect(reconstructed).toBe(after);
    // Reconstruct before from segments
    const beforeReconstructed = segs
      .filter(function(s) { return s.type !== "add"; })
      .map(function(s) { return s.content; })
      .join("\n");
    expect(beforeReconstructed).toBe(before);
  });

  it("handles \\r\\n line endings (treats them as part of the line, not a split point)", function() {
    // We split on \n only — \r stays as a trailing char on the line. Two
    // identical files with consistent \r\n endings still match line-for-line.
    const segs = diffLines("a\r\nb", "a\r\nb");
    expect(segs).toHaveLength(2);
    segs.forEach(function(s) { expect(s.type).toBe("equal"); });
  });
});

describe("diffToSideBySide", function() {
  it("equal segments become equal rows with both sides set", function() {
    const segs = [
      { type: "equal", left: 1, right: 1, content: "a" },
      { type: "equal", left: 2, right: 2, content: "b" },
    ];
    const rows = diffToSideBySide(segs);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      left:  { n: 1, content: "a" },
      right: { n: 1, content: "a" },
      type:  "equal",
    });
  });

  it("paired del+add becomes a single 'change' row", function() {
    const segs = [
      { type: "del", left: 1, right: null, content: "old" },
      { type: "add", left: null, right: 1, content: "new" },
    ];
    const rows = diffToSideBySide(segs);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("change");
    expect(rows[0].left.content).toBe("old");
    expect(rows[0].right.content).toBe("new");
  });

  it("unpaired deletion appears as del row with right=null", function() {
    const segs = [
      { type: "del", left: 1, right: null, content: "removed" },
    ];
    const rows = diffToSideBySide(segs);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("del");
    expect(rows[0].left.content).toBe("removed");
    expect(rows[0].right).toBeNull();
  });

  it("unpaired addition appears as add row with left=null", function() {
    const segs = [
      { type: "add", left: null, right: 1, content: "added" },
    ];
    const rows = diffToSideBySide(segs);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("add");
    expect(rows[0].right.content).toBe("added");
    expect(rows[0].left).toBeNull();
  });

  it("hunk with 3 dels + 1 add becomes 1 change + 2 del rows", function() {
    const segs = [
      { type: "del", left: 1, right: null, content: "d1" },
      { type: "del", left: 2, right: null, content: "d2" },
      { type: "del", left: 3, right: null, content: "d3" },
      { type: "add", left: null, right: 1, content: "a1" },
    ];
    const rows = diffToSideBySide(segs);
    expect(rows).toHaveLength(3);
    expect(rows[0].type).toBe("change");
    expect(rows[1].type).toBe("del");
    expect(rows[2].type).toBe("del");
  });
});

describe("diffStats", function() {
  it("counts add/del/equal segments", function() {
    const segs = [
      { type: "equal", left: 1, right: 1, content: "x" },
      { type: "del",   left: 2, right: null, content: "y" },
      { type: "add",   left: null, right: 2, content: "z" },
      { type: "add",   left: null, right: 3, content: "w" },
    ];
    expect(diffStats(segs)).toEqual({
      added: 2, removed: 1, equal: 1, totalChanged: 3,
    });
  });

  it("zero stats for empty diff", function() {
    expect(diffStats([])).toEqual({ added: 0, removed: 0, equal: 0, totalChanged: 0 });
  });
});
