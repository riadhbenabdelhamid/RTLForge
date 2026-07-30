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

// ═══════════════════════════════════════════════════════════════════════════
// Compile tier (run 36). betterChampion required a compiled test signal, so a
// run where NOTHING ever compiles banks nothing — the champion is blind
// exactly when it is most needed, and the run ships whatever the last stage
// produced. Run 36 held a TB one declaration short of running and shipped one
// corrupted at two sites. Non-compiling pairs now rank by how far they are
// from compiling, and never displace a pair that compiled.
// ═══════════════════════════════════════════════════════════════════════════
describe("betterChampion compile tier (run 36)", () => {
  const broken = (blocking, tag) => ({
    rtl: "module m; endmodule", tb: "tb" + (tag || blocking),
    total: 1, pass: 0, fail: 1,
    tests: [{ name: "compilation", st: "FAIL" }],
    blocking: blocking,
  });
  const working = (pass, fail) => ({
    rtl: "r", tb: "t", total: pass + fail, pass: pass, fail: fail,
    tests: [{ name: "t1", st: "PASS" }],
  });

  it("banks a non-compiling pair when there is no champion at all", () => {
    expect(betterChampion(broken(1), null)).toBe(true);
  });

  it("the run-36 comparison: 2 errors never displaces 1 error", () => {
    expect(betterChampion(broken(2), broken(1))).toBe(false);
    expect(betterChampion(broken(1), broken(2))).toBe(true);
  });

  it("an equal distance keeps the incumbent (no churn)", () => {
    expect(betterChampion(broken(1, "a"), broken(1, "b"))).toBe(false);
  });

  it("a broken pair NEVER displaces one that compiled, however few its errors", () => {
    expect(betterChampion(broken(0), working(1, 9))).toBe(false);
    expect(betterChampion(broken(1), working(0, 1))).toBe(false);
  });

  it("a compiling pair always promotes over a broken champion", () => {
    expect(betterChampion(working(1, 9), broken(1))).toBe(true);
  });

  it("an unknown distance banks nothing (never guess at ranking)", () => {
    expect(betterChampion({ rtl: "r", tb: "t", total: 1, pass: 0, fail: 1,
      tests: [{ name: "compilation", st: "FAIL" }] }, null)).toBe(false);
  });

  it("compiling-vs-compiling ordering is unchanged", () => {
    expect(betterChampion(working(9, 1), working(5, 5))).toBe(true);
    expect(betterChampion(working(5, 5), working(9, 1))).toBe(false);
  });
});

// The champion snapshot is written back into the verify slot by
// championRestoreOf, and req_func_must measures per-requirement greenness from
// test.req. Run 38: the judge's iterations scored 26 (req_func_must 40); the
// final verdict, computed after a restore, scored 13 (req_func_must 0) on
// byte-identical RTL and TB — the trim had dropped `req`.
describe("champion snapshot preserves requirement attribution (run 38)", () => {
  it("betterChampion accepts a candidate whose tests carry req, and it survives", () => {
    const cand = {
      rtl: "module m; endmodule", tb: "module tb; endmodule",
      pass: 9, total: 23, fail: 14,
      tests: [{ name: "REQ-FUNC-003.1", st: "PASS", req: "REQ-FUNC-003" },
              { name: "REQ-FUNC-002.1", st: "FAIL", req: "REQ-FUNC-002" }],
    };
    expect(betterChampion(cand, null)).toBe(true);
    expect(cand.tests.every((t) => typeof t.req === "string")).toBe(true);
  });

  it("a restored champion still measures req_func_must (the run-38 collapse)", async () => {
    const { runEvalGate } = await import("../src/eval/gate.js");
    const spec = { requirements: [
      { id: "REQ-FUNC-003", cat: "Functionality", pri: "Must", desc: "a" },
      { id: "REQ-FUNC-002", cat: "Functionality", pri: "Must", desc: "b" },
    ] };
    const withReq = [{ name: "REQ-FUNC-003.1", st: "PASS", req: "REQ-FUNC-003" },
                     { name: "REQ-FUNC-002.1", st: "FAIL", req: "REQ-FUNC-002" }];
    const stripped = withReq.map((t) => ({ name: t.name, st: t.st }));
    const gate = (tests) => runEvalGate({
      spec: spec, lint: { status: "PASS", errors: [] },
      verify: { pass: 1, fail: 1, total: 2, sim: "Verilator (CLI)", tests: tests },
    }, null).results.find((r) => r.id === "req_func_must").measured;
    expect(gate(withReq)).toBeGreaterThan(0);     // 1 of 2 fully green
    expect(gate(stripped)).toBe(0);               // what run 38 shipped
  });
});

// Run 39: verify entered with a TB one error from compiling; the fix loop
// produced a mutilation with 8 blocking errors (the 525L file minus its first
// 25 lines). Both compile-failures score the synthetic -2, so the tie kept the
// LAST candidate, the champion banked it, and the judge shipped it. Distance
// from compiling now breaks the tie.
describe("shouldRestoreBest blocking-distance tiebreak (run 39)", () => {
  const cf = (blocking) => ({ pass: 0, total: 1, fail: 1,
    tests: [{ name: "compilation", st: "FAIL" }], _blocking: blocking });

  it("the run-39 shape: 1-error best beats 8-error final", () => {
    expect(shouldRestoreBest(cf(1), cf(8))).toBe(true);
  });

  it("a final that is CLOSER to compiling is kept", () => {
    expect(shouldRestoreBest(cf(8), cf(1))).toBe(false);
  });

  it("equal distance keeps the final (no churn)", () => {
    expect(shouldRestoreBest(cf(3), cf(3))).toBe(false);
  });

  it("missing _blocking on either side falls back to the old tie behaviour", () => {
    expect(shouldRestoreBest(cf(undefined), cf(8))).toBe(false);
    expect(shouldRestoreBest(cf(1), cf(undefined))).toBe(false);
  });

  it("a compiling final is never displaced by a broken best, whatever the counts", () => {
    const ok = { pass: 3, total: 5, fail: 2, tests: [{ name: "t", st: "PASS" }] };
    expect(shouldRestoreBest(cf(1), ok)).toBe(false);
    expect(shouldRestoreBest(ok, cf(1))).toBe(true);
  });
});
