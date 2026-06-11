// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// budget — run-level token/cost ceiling (pipeline/budget.js).
//
// Pins the guard math the stage-boundary and in-stage gates rely on:
// base spend comes from the reducer ledger ({tIn, tOut, cost}), in-flight
// spend from a node's _llms records ({tokensIn, tokensOut, provider}).

import { describe, it, expect } from "vitest";
import { createBudgetGuard } from "../src/pipeline/budget.js";

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
