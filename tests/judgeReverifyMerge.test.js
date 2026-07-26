// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Regression for the verify-slot clobber found in the gpt-oss-120b e2e:
// when judge re-runs the sim during a fix iteration it used to REPLACE the
// verify slot with a bare re-sim result, destroying the verify stage's own
// verifyHistory + _llms (cost ledger) — blinding the bench and the Verify UI.
// mergeReverifyIntoVerify overlays the fresh numbers while preserving provenance.

import { describe, it, expect } from "vitest";
import { mergeReverifyIntoVerify, betterJudgeState, verifyPassOf, championRestoreOf } from "../src/pipeline/nodes/judge.js";

describe("mergeReverifyIntoVerify", () => {
  const priorVerify = {
    pass: 0, total: 1, fail: 1, cli: true,
    verifyHistory: [{ iter: 1, status: "FAIL" }, { iter: 2, status: "FAIL" }],
    _llms: [{ stage: "verify-triage-1", tokensIn: 500, tokensOut: 80 }],
    _ledger: { greenMust: 0, totalMust: 3 },
    _fixes: [{ text: "tightened reset", iter: 1 }],
  };
  const vd2 = { pass: 1, total: 1, fail: 0, cli: true, tests: [{ name: "t_basic", status: "PASS" }] };

  it("keeps the fresh re-sim numbers (vd2 wins on shared keys)", () => {
    const m = mergeReverifyIntoVerify(priorVerify, vd2);
    expect(m.pass).toBe(1);
    expect(m.fail).toBe(0);
    expect(m.tests).toEqual([{ name: "t_basic", status: "PASS" }]);
  });

  it("preserves the verify stage's provenance that the bare re-sim lacks", () => {
    const m = mergeReverifyIntoVerify(priorVerify, vd2);
    expect(m.verifyHistory).toHaveLength(2);            // was nulled by the clobber
    expect(m._llms).toEqual(priorVerify._llms);          // cost ledger survives
    expect(m._ledger).toEqual({ greenMust: 0, totalMust: 3 });
    expect(m._fixes).toHaveLength(1);
  });

  it("does not mutate the inputs", () => {
    const m = mergeReverifyIntoVerify(priorVerify, vd2);
    expect(m).not.toBe(priorVerify);
    expect(priorVerify.pass).toBe(0);                    // untouched
  });

  it("tolerates a null prior verify (first re-verify with nothing to preserve)", () => {
    expect(mergeReverifyIntoVerify(null, vd2)).toEqual(vd2);
    expect(mergeReverifyIntoVerify(undefined, vd2).pass).toBe(1);
  });
});

// Run 28: the judge's fix loop regressed verify 71/79 → 54/79, but both
// states scored 33 on the eval gate (pass-rate criteria are binary at their
// threshold), so a strict score comparison neither banked the better state
// nor restored it — the regressed artifacts shipped as final. Verify pass
// count is the tiebreaker at equal score.
describe("betterJudgeState — score ties break on verify pass count (run 28)", () => {
  it("higher score wins regardless of pass count", () => {
    expect(betterJudgeState(50, 10, 33, 71)).toBe(true);
    expect(betterJudgeState(33, 71, 50, 10)).toBe(false);
  });

  it("equal score: more verify passes wins (the run 28 case)", () => {
    // Candidate = final regressed state (33, 54); champion = best (33, 71):
    // the final state is NOT better, so the restore fires.
    expect(betterJudgeState(33, 54, 33, 71)).toBe(false);
    expect(betterJudgeState(33, 71, 33, 54)).toBe(true);
  });

  it("full tie is not an improvement (no churn, keeps the earlier state)", () => {
    expect(betterJudgeState(33, 71, 33, 71)).toBe(false);
  });

  it("initial sentinel (-1, -1) always loses to a real verdict", () => {
    expect(betterJudgeState(0, 0, -1, -1)).toBe(true);
  });
});

describe("verifyPassOf", () => {
  it("reads state.verify.pass and defaults to 0 when absent or malformed", () => {
    expect(verifyPassOf({ verify: { pass: 71 } })).toBe(71);
    expect(verifyPassOf({ verify: {} })).toBe(0);
    expect(verifyPassOf({})).toBe(0);
    expect(verifyPassOf(null)).toBe(0);
    expect(verifyPassOf({ verify: { pass: "71" } })).toBe(0);
  });
});

describe("championRestoreOf (run-level shipping gate)", () => {
  const champ = { pass: 71, total: 79, fail: 8, rtl: "module m; endmodule", tb: "module tb; endmodule", tests: [] };

  it("restores when the champion measured strictly more passing tests (run 28 shape)", () => {
    const state = { verify: { pass: 54, total: 79, champion: champ } };
    expect(championRestoreOf(state)).toBe(champ);
  });

  it("never restores at equal or better pass counts (no churn on the good path)", () => {
    expect(championRestoreOf({ verify: { pass: 71, total: 79, champion: champ } })).toBe(null);
    expect(championRestoreOf({ verify: { pass: 79, total: 79, champion: champ } })).toBe(null);
  });

  it("ignores missing/empty champions and champions without code snapshots", () => {
    expect(championRestoreOf({ verify: { pass: 5 } })).toBe(null);
    expect(championRestoreOf(null)).toBe(null);
    expect(championRestoreOf({ verify: { pass: 5, champion: { pass: 9, total: 9, rtl: "", tb: "x" } } })).toBe(null);
    expect(championRestoreOf({ verify: { pass: 5, champion: { pass: 9, total: 0, rtl: "x", tb: "x" } } })).toBe(null);
  });
});
