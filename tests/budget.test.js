// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// budget — run-level token/cost ceiling (pipeline/budget.js).
//
// Pins the guard math the stage-boundary and in-stage gates rely on:
// base spend comes from the reducer ledger ({tIn, tOut, cost}), in-flight
// spend from a node's _llms records ({tokensIn, tokensOut, provider}).

import { describe, it, expect } from "vitest";
import { createBudgetGuard, budgetHaltedStages } from "../src/pipeline/budget.js";

describe("createBudgetGuard", function() {
  it("is disabled (and never trips) without configured limits", function() {
    const g = createBudgetGuard({}, [{ tIn: 1e9, tOut: 1e9, cost: 1e6 }]);
    expect(g.enabled).toBe(false);
    expect(g.exceeded()).toBeNull();
    expect(g.overWith([{ tokensIn: 1e9, tokensOut: 1e9 }])).toBeNull();
  });

  it("token ceiling: trips on ledger spend alone (stage-boundary gate)", function() {
    const ledger = [
      { tIn: 60_000, tOut: 30_000, cost: 0.5 },
      { tIn: 8_000,  tOut: 4_000,  cost: 0.1 },
    ]; // 102k tokens total
    const g = createBudgetGuard({ maxRunTokens: 100_000 }, ledger);
    const over = g.exceeded();
    expect(over).not.toBeNull();
    expect(over.reason).toBe("tokens");
    expect(over.spentTokens).toBe(102_000);
    expect(over.message).toMatch(/maxRunTokens/);
  });

  it("token ceiling: in-stage calls push the total over (overWith gate)", function() {
    const g = createBudgetGuard({ maxRunTokens: 100_000 }, [{ tIn: 50_000, tOut: 30_000, cost: 0 }]);
    expect(g.exceeded()).toBeNull();                                  // 80k — fine
    expect(g.overWith([{ tokensIn: 10_000, tokensOut: 5_000 }])).toBeNull();   // 95k — fine
    const over = g.overWith([{ tokensIn: 15_000, tokensOut: 10_000 }]);        // 105k — over
    expect(over).not.toBeNull();
    expect(over.reason).toBe("tokens");
  });

  it("cost ceiling: estimates in-flight calls with provider rates", function() {
    // anthropic: $3/M in + $15/M out → 1M in + 1M out = $18
    const g = createBudgetGuard({ maxRunCostUsd: 10 }, [{ tIn: 0, tOut: 0, cost: 0 }]);
    const over = g.overWith([{ tokensIn: 1_000_000, tokensOut: 1_000_000, provider: "anthropic" }]);
    expect(over).not.toBeNull();
    expect(over.reason).toBe("cost");
    expect(over.spentCostUsd).toBeCloseTo(18, 2);
  });

  it("cost ceiling: free local providers never trip it", function() {
    const g = createBudgetGuard({ maxRunCostUsd: 0.01 }, []);
    expect(g.overWith([{ tokensIn: 5e6, tokensOut: 5e6, provider: "ollama" }])).toBeNull();
  });

  it("ignores invalid limit values (0, negative, non-numeric)", function() {
    for (const bad of [0, -5, "100", NaN, Infinity]) {
      const g = createBudgetGuard({ maxRunTokens: bad }, [{ tIn: 1e9, tOut: 0, cost: 0 }]);
      // Infinity is technically numeric but unbounded — numOrNull(v>0 &&
      // isFinite) rejects it, which is the safe interpretation.
      expect(g.enabled).toBe(false);
    }
  });

  it("tolerates sparse/malformed ledger and llms entries", function() {
    const g = createBudgetGuard({ maxRunTokens: 1000 }, [null, {}, { tIn: 500 }]);
    expect(g.exceeded()).toBeNull();                       // 500 < 1000
    expect(g.overWith([null, { tokensOut: 600 }])).not.toBeNull();  // 1100
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Run 52. A stage whose fix chain was budget-halted is indistinguishable, in
// every user-facing surface, from a stage whose model reviewed its own code and
// declined to change it. That difference is the whole difference between a
// model that cannot repair and a pipeline that never asked.
//
// rtl_review spent 49 minutes finding one critical and two major issues — more
// than the 20-minute maxStageMinutes the stage had — so every fix entry was
// recorded budget-halted with llmCount 0. The CLI printed
// "func-fail (needs fix) (49m 8s)" and nothing else, and the run was read as
// the model refusing to fix its own bugs.
// ═══════════════════════════════════════════════════════════════════════════
describe("budgetHaltedStages", function() {
  it("names the fix entries a stage skipped without calling the model", function() {
    // the exact shape run 52 recorded
    const stageData = {
      verdict: "NEEDS_FIX", score: 53,
      _chain: [{ iter: 1, mode: "smart", entries: [
        { stageKey: "rtl_generate", reason: "triage", status: "budget-halted", llmCount: 0 },
        { stageKey: "rtl_review",   reason: "always", status: "budget-halted", llmCount: 0 },
      ] }],
    };
    expect(budgetHaltedStages(stageData)).toEqual(["rtl_generate", "rtl_review"]);
  });

  it("says nothing when the chain actually ran", function() {
    expect(budgetHaltedStages({ _chain: [{ entries: [
      { stageKey: "rtl_generate", status: "ok", llmCount: 2 },
    ] }] })).toEqual([]);
  });

  it("is quiet on a stage with no chain at all", function() {
    expect(budgetHaltedStages({})).toEqual([]);
    expect(budgetHaltedStages(null)).toEqual([]);
    expect(budgetHaltedStages({ _chain: [] })).toEqual([]);
  });

  it("reports each skipped stage once even across several iterations", function() {
    expect(budgetHaltedStages({ _chain: [
      { entries: [{ stageKey: "rtl_generate", status: "budget-halted" }] },
      { entries: [{ stageKey: "rtl_generate", status: "budget-halted" },
                  { stageKey: "lint", status: "budget-halted" }] },
    ] })).toEqual(["rtl_generate", "lint"]);
  });
});

// The GUI's trace rows carry the chain in two shapes: judge passes a flat
// entry array, lint/verify/review pass per-iteration blocks. Both have to
// reach the same answer, or the badge appears on one kind of stage and not
// the other.
describe("budgetHaltedStages — GUI chain shapes", function() {
  const FLAT = [
    { stageKey: "rtl_generate", reason: "triage", status: "budget-halted", llmCount: 0 },
    { stageKey: "lint", reason: "always", status: "ran", llmCount: 1 },
  ];
  const BLOCKS = [{ iter: 1, mode: "smart", entries: FLAT }];

  it("reads the per-iteration block shape", function() {
    expect(budgetHaltedStages({ _chain: BLOCKS })).toEqual(["rtl_generate"]);
  });

  it("reads the flat shape once wrapped, as the GUI wraps it", function() {
    expect(budgetHaltedStages({ _chain: [{ entries: FLAT }] })).toEqual(["rtl_generate"]);
  });
});
