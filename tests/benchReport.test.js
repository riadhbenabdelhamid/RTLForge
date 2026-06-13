// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// bench/report — aggregating scored runs and diffing against a baseline.
// Pins that averages skip null metrics (absent ≠ zero) and that deltas are
// computed in the right direction.

import { describe, it, expect } from "vitest";
import { aggregate, compare, formatRunTable, formatAggregate, formatComparison } from "../bench/report.mjs";

// Minimal records: { specId, ok, durationMs, metrics }.
function rec(specId, metrics, durationMs) {
  return { specId, ok: true, durationMs: durationMs == null ? 1000 : durationMs, metrics };
}

const PASS = {
  completed: true, verdict: "PASS", verified: true, score: 100,
  firstPass: { lint: true, lint_test: null, verify: true, judge: true },
  fixIters: { lint: 0, lint_test: null, verify: 0, judge: 0, rtl_review: null, test_review: null },
  mutation: { score: 100 }, costUsd: 0.05, tokens: { in: 1000, out: 500, calls: 3 },
};
const FIXED = {
  completed: true, verdict: "PASS", verified: true, score: 90,
  firstPass: { lint: false, lint_test: null, verify: false, judge: true },
  fixIters: { lint: 1, lint_test: null, verify: 2, judge: 0, rtl_review: null, test_review: null },
  mutation: { score: 60 }, costUsd: 0.09, tokens: { in: 3000, out: 1500, calls: 6 },
};
const UNVER = {
  completed: true, verdict: "UNVERIFIED", verified: false, score: 100,
  firstPass: { lint: true, lint_test: null, verify: true, judge: true },
  fixIters: { lint: 0, lint_test: null, verify: 0, judge: 0, rtl_review: null, test_review: null },
  mutation: null, costUsd: 0.04, tokens: { in: 900, out: 450, calls: 2 },
};

describe("aggregate", () => {
  const agg = aggregate([rec("a", PASS), rec("b", FIXED), rec("c", UNVER)]);

  it("counts verdicts and rates", () => {
    expect(agg.n).toBe(3);
    expect(agg.verdicts).toEqual({ PASS: 2, UNVERIFIED: 1, FAIL: 0, none: 0 });
    expect(agg.passRate).toBeCloseTo(2 / 3, 2);
    expect(agg.verifiedRate).toBeCloseTo(2 / 3, 2);
    expect(agg.meanScore).toBeCloseTo((100 + 90 + 100) / 3, 1);
  });

  it("first-pass rate counts true over non-null only", () => {
    // lint firstPass: true, false, true → 2/3
    expect(agg.firstPassRate.lint).toBeCloseTo(2 / 3, 2);
    // verify firstPass: true, false, true → 2/3
    expect(agg.firstPassRate.verify).toBeCloseTo(2 / 3, 2);
  });

  it("mean fix iters averages numbers, ignoring null stages", () => {
    expect(agg.meanFixIters.verify).toBeCloseTo((0 + 2 + 0) / 3, 2);
    // lint_test never ran in any record → mean is null, not 0
    expect(agg.meanFixIters.lint_test).toBeNull();
  });

  it("mean mutation score skips runs with no mutation data", () => {
    // PASS 100, FIXED 60, UNVER null → mean of [100, 60]
    expect(agg.meanMutationScore).toBeCloseTo(80, 1);
  });

  it("sums cost and tokens", () => {
    expect(agg.totalCostUsd).toBeCloseTo(0.18, 4);
    expect(agg.totalTokens).toEqual({ in: 4900, out: 2450 });
  });
});

describe("compare", () => {
  it("deltas current minus baseline", () => {
    const cur = aggregate([rec("a", PASS), rec("b", PASS)]);     // passRate 1.0
    const base = aggregate([rec("a", PASS), rec("b", FIXED)]);   // passRate 1.0, but worse fp
    const c = compare(cur, base);
    expect(c.passRate).toBe(0);
    // current fp verify 1.0 vs base 0.5 → +0.5
    expect(c.firstPassRate.verify).toBeCloseTo(0.5, 2);
    // current mean verify fix iters 0 vs base 1 → -1 (improvement; lower better)
    expect(c.meanFixIters.verify).toBeCloseTo(-1, 2);
  });
});

describe("formatters", () => {
  it("run table has a row per spec with verdict and score", () => {
    const t = formatRunTable([rec("fifo_sync", PASS), rec("uart_rx", UNVER)]);
    expect(t).toContain("fifo_sync");
    expect(t).toContain("PASS");
    expect(t).toContain("uart_rx");
    expect(t).toContain("UNVERIFIED");
  });

  it("aggregate summary and comparison render without throwing", () => {
    const a = aggregate([rec("a", PASS), rec("b", FIXED)]);
    const b = aggregate([rec("a", UNVER)]);
    expect(formatAggregate(a)).toContain("Pass rate:");
    const cmp = formatComparison(a, b);
    expect(cmp).toContain("Δ pass rate:");
    expect(cmp).toMatch(/good|worse|=0|—/);
  });

  it("error rows render as ERROR", () => {
    const t = formatRunTable([{ specId: "x", ok: false, error: "boom", durationMs: 0, metrics: { firstPass: {}, fixIters: {} } }]);
    expect(t).toContain("ERROR");
  });
});
