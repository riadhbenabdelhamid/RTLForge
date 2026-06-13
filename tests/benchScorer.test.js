// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// bench/scorer — turning a pipeline finalState into comparable metrics.
//
// Synthetic finalStates use the real field shapes the nodes emit
// (lint.iterations, verify.verifyHistory/mutation/sva, judge.judgeHistory),
// so these pin the contract the benchmark report depends on.

import { describe, it, expect } from "vitest";
import { scoreRun } from "../bench/scorer.mjs";

const ll = (tin, tout) => ({ tokensIn: tin, tokensOut: tout, provider: "anthropic", model: "m" });

describe("scoreRun", () => {
  it("clean run: first-pass everywhere, zero fix iters, real PASS", () => {
    const m = scoreRun({
      spec: { _llms: [ll(800, 400)] },
      lint: { status: "PASS", iterations: [{ iter: 1, status: "PASS" }], _llms: [ll(800, 400)] },
      verify: {
        pass: 6, fail: 0, total: 6, cli: true, cov: { line: 100, branch: 95, toggle: 90 },
        verifyHistory: [{ iter: 1, status: "PASS" }],
        sva: { bound: ["A", "B"], skipped: [], bindFailed: false },
        mutation: { total: 5, invalid: 0, killed: 5, survived: [], score: 100 },
        _llms: [ll(800, 400)],
      },
      judge: {
        overall: "PASS", score: 100, verified: true, evalOverall: "PASS",
        judgeHistory: [{ iter: 1, overall: "PASS" }], _llms: [ll(100, 50)],
      },
    });
    expect(m.completed).toBe(true);
    expect(m.verdict).toBe("PASS");
    expect(m.verified).toBe(true);
    expect(m.score).toBe(100);
    expect(m.firstPass).toEqual({ lint: true, lint_test: null, verify: true, judge: true });
    expect(m.fixIters.lint).toBe(0);
    expect(m.fixIters.verify).toBe(0);
    expect(m.fixIters.judge).toBe(0);
    expect(m.fixIters.rtl_review).toBeNull();
    expect(m.verify).toMatchObject({ pass: 6, total: 6, cli: true });
    expect(m.verify.coverage.line).toBe(100);
    expect(m.mutation).toEqual({ score: 100, killed: 5, total: 5, invalid: 0, survived: 0 });
    expect(m.sva).toEqual({ bound: 2, skipped: 0, bindFailed: false });
    expect(m.tokens).toEqual({ in: 2500, out: 1250, calls: 4 });
    // 3 calls @ (800,400)=$0.0084 + 1 call (100,50)=$0.00105 ≈ $0.0263
    expect(m.costUsd).toBeGreaterThan(0.026);
    expect(m.costUsd).toBeLessThan(0.027);
    expect(m.byStage.verify.calls).toBe(1);
    expect(Object.keys(m.byStage).sort()).toEqual(["judge", "lint", "spec", "verify"]);
  });

  it("fix-loop run: counts iterations as fixes and flags non-first-pass", () => {
    const m = scoreRun({
      lint: {
        status: "PASS",
        iterations: [{ iter: 1, status: "FAIL" }, { iter: 2, status: "PASS" }],
        _llms: [ll(800, 400), ll(800, 400)],
      },
      verify: {
        pass: 5, fail: 0, total: 5, cli: true,
        verifyHistory: [{ iter: 1, status: "FAIL" }, { iter: 2, status: "PASS" }],
        _llms: [ll(800, 400)],
      },
      rtl_review: { _iterations: [{ iter: 1 }, { iter: 2 }], _llms: [ll(500, 200)] },
      judge: { overall: "PASS", score: 92, verified: true, evalOverall: "PASS",
        judgeHistory: [{ iter: 1, overall: "PASS" }], _llms: [ll(100, 50)] },
    });
    expect(m.firstPass.lint).toBe(false);
    expect(m.firstPass.verify).toBe(false);
    expect(m.fixIters.lint).toBe(1);
    expect(m.fixIters.verify).toBe(1);
    expect(m.fixIters.rtl_review).toBe(1);
    expect(m.fixIters.judge).toBe(0);
    expect(m.tokens.calls).toBe(5);
  });

  it("UNVERIFIED run: verdict downgraded, verified false, evalVerdict preserved", () => {
    const m = scoreRun({
      verify: { pass: 4, fail: 0, total: 4, cli: false,
        verifyHistory: [{ iter: 1, status: "PASS" }], _llms: [ll(800, 400)] },
      judge: { overall: "UNVERIFIED", score: 100, verified: false, evalOverall: "PASS",
        judgeHistory: [{ iter: 1, overall: "PASS" }], _llms: [ll(100, 50)] },
    });
    expect(m.verdict).toBe("UNVERIFIED");
    expect(m.verified).toBe(false);
    expect(m.evalVerdict).toBe("PASS");
    expect(m.verify.cli).toBe(false);
    expect(m.mutation).toBeNull();
    expect(m.sva).toBeNull();
  });

  it("halted/empty run: completed false, every stage metric null", () => {
    const m = scoreRun({});
    expect(m.completed).toBe(false);
    expect(m.verdict).toBeNull();
    expect(m.verified).toBeNull();
    expect(m.score).toBeNull();
    expect(m.firstPass).toEqual({ lint: null, lint_test: null, verify: null, judge: null });
    expect(m.fixIters.verify).toBeNull();
    expect(m.verify).toBeNull();
    expect(m.tokens).toEqual({ in: 0, out: 0, calls: 0 });
    expect(m.costUsd).toBe(0);
  });

  it("verify-history fallback: clean fail=0 counts as first-pass when no history", () => {
    const m = scoreRun({ verify: { pass: 3, fail: 0, total: 3, cli: true, _llms: [] } });
    expect(m.firstPass.verify).toBe(true);
    const m2 = scoreRun({ verify: { pass: 1, fail: 2, total: 3, cli: true, _llms: [] } });
    expect(m2.firstPass.verify).toBe(false);
  });
});
