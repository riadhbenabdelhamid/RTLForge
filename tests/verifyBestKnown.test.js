// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Regression: the verify loop tracks best-known by score = pass - 2*fail, but
// the restore used to gate on `best.pass > final.pass` (pass-count only). When
// the final iteration tied on pass but regressed on FAIL, the strictly-better
// best-known state was NOT restored — verify reported avoidable failures and
// the judge re-triaged them (extra iterations). shouldRestoreBest aligns the
// restore with the tracking metric.

import { describe, it, expect } from "vitest";
import { shouldRestoreBest, betterChampion, oracleSuspect } from "../src/pipeline/nodes/verify.js";

describe("shouldRestoreBest", () => {
  it("RESTORES when final ties on pass but has MORE failures (the bug)", () => {
    // 5/0 best vs 5/3 final: old `pass > pass` was false → not restored.
    expect(shouldRestoreBest({ pass: 5, fail: 0 }, { pass: 5, fail: 3 })).toBe(true);
    expect(shouldRestoreBest({ pass: 5, fail: 1 }, { pass: 5, fail: 3 })).toBe(true);
  });

  it("does NOT restore when scores tie (no-op) or final is strictly better", () => {
    expect(shouldRestoreBest({ pass: 5, fail: 0 }, { pass: 5, fail: 0 })).toBe(false);
    expect(shouldRestoreBest({ pass: 3, fail: 0 }, { pass: 5, fail: 0 })).toBe(false); // final more pass
    expect(shouldRestoreBest({ pass: 4, fail: 1 }, { pass: 5, fail: 1 })).toBe(false); // final higher score
  });

  it("restores when best has more passing tests at equal failures", () => {
    expect(shouldRestoreBest({ pass: 6, fail: 1 }, { pass: 4, fail: 1 })).toBe(true);
  });

  it("returns false when there is no best-known", () => {
    expect(shouldRestoreBest(null, { pass: 1, fail: 0 })).toBe(false);
  });

  it("never rolls real sim results back to a compile-failure state (run 10)", () => {
    // Run 10 measured: best = the synthetic compile-fail entry (0/1, score -2),
    // final = a real 4/9 sim (score -6). Score alone restored the state with
    // no test signal and the stage reported "1 fail" for a 4/9 measurement.
    const compileFail = {
      pass: 0, fail: 1, total: 1,
      tests: [{ name: "compilation", st: "FAIL" }],
    };
    const realRun = {
      pass: 4, fail: 5, total: 9,
      tests: [{ name: "REQ-FUNC-001.1", st: "PASS" }, { name: "REQ-FUNC-001.2", st: "FAIL" }],
    };
    expect(shouldRestoreBest(compileFail, realRun)).toBe(false);
    // And the mirror: a compiling best IS restored over a compile-fail final.
    expect(shouldRestoreBest(realRun, compileFail)).toBe(true);
  });
});

describe("betterChampion (run-level champion banking)", () => {
  const C = (pass, total, fail, extra) => Object.assign(
    { pass, total, fail, rtl: "module m; endmodule", tb: "module tb; endmodule", tests: [{ name: "t", st: fail ? "FAIL" : "PASS" }] },
    extra || {});

  it("first real measurement always banks; more passing tests dethrones", () => {
    expect(betterChampion(C(5, 9, 4), null)).toBe(true);
    expect(betterChampion(C(6, 9, 3), C(5, 9, 4))).toBe(true);
    expect(betterChampion(C(4, 9, 5), C(5, 9, 4))).toBe(false);
  });

  it("run 28 shape: the 54/79 regression never dethrones the 71/79 champion", () => {
    expect(betterChampion(C(54, 79, 25), C(71, 79, 8))).toBe(false);
    expect(betterChampion(C(71, 79, 8), C(54, 79, 25))).toBe(true);
  });

  it("a pass tie breaks on fewer failures; a full tie keeps the incumbent", () => {
    expect(betterChampion(C(5, 9, 2), C(5, 9, 4))).toBe(true);
    expect(betterChampion(C(5, 9, 4), C(5, 9, 4))).toBe(false);   // no churn
  });

  it("compile-fail or empty candidates never qualify; a compile-fail incumbent is dethroned", () => {
    const cf = C(0, 1, 1, { tests: [{ name: "compilation", st: "FAIL" }] });
    expect(betterChampion(cf, null)).toBe(false);
    expect(betterChampion(C(0, 0, 0), null)).toBe(false);                       // no tests ran
    expect(betterChampion(C(1, 9, 8, { rtl: "" }), null)).toBe(false);          // no code snapshot
    expect(betterChampion(C(1, 9, 8), cf)).toBe(true);
  });
});

describe("oracleSuspect (TB-fix mutation acceptance)", () => {
  it("flags a mutation result with valid mutants and zero kills", () => {
    expect(oracleSuspect({ total: 5, invalid: 0, killed: 0 })).toBe(true);
    expect(oracleSuspect({ total: 5, invalid: 2, killed: 0 })).toBe(true);
  });
  it("any kill, all-invalid sweeps, and missing data are NOT suspect", () => {
    expect(oracleSuspect({ total: 5, invalid: 0, killed: 1 })).toBe(false);
    expect(oracleSuspect({ total: 3, invalid: 3, killed: 0 })).toBe(false);  // nothing valid ran
    expect(oracleSuspect(null)).toBe(false);
    expect(oracleSuspect(undefined)).toBe(false);
  });
});
