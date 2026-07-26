// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import {
  matchDiagnostic,
  classifyDiagnostics,
  classifyTestResults,
  classifyTestResultsByReq,
  hasCompileFailure,
  reqKeyOf,
} from "../src/pipeline/classifiers.js";

// Bug 1 (e2e convergence): a candidate that does not COMPILE surfaces as a lone
// synthetic {name:"compilation", st:"FAIL"} test. It used to read as
// ACCEPT_EQUIVALENT when the previous candidate also failed to compile, so the
// fix loop "kept" a broken TB and burned its whole iteration budget. It must
// now hard-reject so the loop reverts and re-targets the syntax error.
describe("classifyTestResults — REJECT_COMPILE_FAIL (Bug 1)", () => {
  const compileFail = [{ name: "compilation", st: "FAIL" }];

  it("hasCompileFailure detects the synthetic compilation/syntax FAIL marker", () => {
    expect(hasCompileFailure(compileFail)).toBe(true);
    expect(hasCompileFailure([{ name: "syntax error in tb", st: "FAIL" }])).toBe(true);
    expect(hasCompileFailure([{ name: "REQ-FUNC-001.1", st: "FAIL" }])).toBe(false);
    expect(hasCompileFailure([{ name: "compilation", st: "PASS" }])).toBe(false);
    expect(hasCompileFailure(null)).toBe(false);
  });

  it("two non-compiling candidates are REJECTED, not ACCEPT_EQUIVALENT", () => {
    const r = classifyTestResults(compileFail, compileFail);
    expect(r.patchDecision).toBe("REJECT_COMPILE_FAIL");
    expect(r.decision).toBe("reject");
  });

  it("the same case via classifyTestResultsByReq also rejects", () => {
    expect(classifyTestResultsByReq(compileFail, compileFail).patchDecision)
      .toBe("REJECT_COMPILE_FAIL");
  });

  it("a candidate that now COMPILES again reads as progress (override does NOT fire)", () => {
    // baseline didn't compile; candidate compiles with real (some failing) tests
    const after = [{ name: "REQ-FUNC-001.1", st: "PASS" }, { name: "REQ-FUNC-002.1", st: "FAIL" }];
    const r = classifyTestResults(compileFail, after);
    expect(r.patchDecision).not.toBe("REJECT_COMPILE_FAIL");
    expect(r.decision).toBe("accept"); // resolved the compilation failure
  });

  it("normal (compiling) candidates are unaffected — still ACCEPT_EQUIVALENT when nothing changes", () => {
    const same = [{ name: "REQ-A-001.1", st: "PASS" }];
    expect(classifyTestResults(same, same).patchDecision).toBe("ACCEPT_EQUIVALENT");
  });
});

describe("reqKeyOf", () => {
  it("collapses REQ-X.<sub> subtests to the requirement id", () => {
    expect(reqKeyOf("REQ-FUNC-001.1")).toBe("REQ-FUNC-001");
    expect(reqKeyOf("REQ-FUNC-001.7")).toBe("REQ-FUNC-001");
    expect(reqKeyOf("req-intf-002.3")).toBe("REQ-INTF-002");
  });
  it("groups infrastructure markers under GEN, leaves legacy names alone", () => {
    expect(reqKeyOf("GEN.2")).toBe("GEN");
    expect(reqKeyOf("GEN_reset")).toBe("GEN");
    expect(reqKeyOf("overflow_check")).toBe("overflow_check");   // legacy free-text
  });
});

describe("classifyTestResultsByReq — stable across TB regeneration", () => {
  it("a pure rename of a still-failing subtest is NOT mistaken for progress", () => {
    // Test-level would see REQ-FUNC-001.1 'resolved' + REQ-FUNC-001.7 'revealed'
    // (churn → looks like progress). Req-level sees the req still FAILing.
    const before = [{ name: "REQ-FUNC-001.1", st: "FAIL" }];
    const after  = [{ name: "REQ-FUNC-001.7", st: "FAIL" }];   // renumbered, still failing
    const r = classifyTestResultsByReq(before, after);
    expect(r.resolved.length).toBe(0);            // the key: NO false progress
    expect(r.persisting.length).toBe(1);          // the req is correctly seen as still failing
    expect(r.patchDecision).not.toBe("ACCEPT_PROGRESS");

    // Compare: the per-test classifier no longer reads the rename as
    // progress either — the vanished name is now DROPPED (rejected), the
    // new name revealed. Req-level aggregation remains the right tool: it
    // sees continuity (persisting) instead of a drop.
    const naive = classifyTestResults(before, after);
    expect(naive.resolved.length).toBe(0);
    expect(naive.dropped.length).toBe(1);
    expect(naive.patchDecision).toBe("REJECT_REGRESSION");
  });

  it("a real fix (req goes FAIL→all-PASS) reads as progress despite renumbering", () => {
    const before = [{ name: "REQ-FUNC-001.1", st: "PASS" }, { name: "REQ-FUNC-001.2", st: "FAIL" }];
    const after  = [{ name: "REQ-FUNC-001.1", st: "PASS" }, { name: "REQ-FUNC-001.3", st: "PASS" }];
    const r = classifyTestResultsByReq(before, after);
    expect(r.resolved.length).toBe(1);
    expect(r.patchDecision).toBe("ACCEPT_PROGRESS");
  });

  it("a req is FAIL if ANY of its subtests fail", () => {
    const before = [{ name: "REQ-A-001.1", st: "PASS" }, { name: "REQ-A-001.2", st: "FAIL" }];
    const after  = [{ name: "REQ-A-001.1", st: "PASS" }, { name: "REQ-A-001.2", st: "PASS" }];
    expect(classifyTestResultsByReq(before, after).resolved.length).toBe(1);
  });

  it("legacy free-text names behave exactly like per-test classification", () => {
    const before = [{ name: "t_overflow", st: "FAIL" }, { name: "t_reset", st: "PASS" }];
    const after  = [{ name: "t_overflow", st: "PASS" }, { name: "t_reset", st: "PASS" }];
    const byReq = classifyTestResultsByReq(before, after);
    const perTest = classifyTestResults(before, after);
    expect(byReq.resolved.length).toBe(perTest.resolved.length);
    expect(byReq.patchDecision).toBe(perTest.patchDecision);
  });
});

describe("matchDiagnostic", () => {
  it("matches identical code+message", () => {
    const a = { code: "WIDTH", msg: "Operand width mismatch" };
    const b = { code: "WIDTH", msg: "Operand width mismatch" };
    expect(matchDiagnostic(a, b)).toBe(true);
  });

  it("matches when only line numbers differ", () => {
    const a = { code: "UNUSED", msg: "Signal x at line 42 is unused" };
    const b = { code: "UNUSED", msg: "Signal x at line 89 is unused" };
    expect(matchDiagnostic(a, b)).toBe(true);
  });

  it("rejects different codes", () => {
    expect(matchDiagnostic(
      { code: "WIDTH", msg: "Width mismatch" },
      { code: "UNUSED", msg: "Width mismatch" },
    )).toBe(false);
  });

  it("does fuzzy matching above 70% overlap", () => {
    const a = { code: "X", msg: "abcdefghij" };
    const b = { code: "X", msg: "abcdefghxx" }; // 8/10 char overlap
    expect(matchDiagnostic(a, b)).toBe(true);
  });
});

describe("classifyDiagnostics", () => {
  it("ACCEPT_PROGRESS when baseline issues resolved without regressions", () => {
    const baseline  = [{ code: "WIDTH", sev: "warning", msg: "x" }, { code: "UNUSED", sev: "warning", msg: "y" }];
    const candidate = [{ code: "WIDTH", sev: "warning", msg: "x" }];
    const r = classifyDiagnostics(baseline, candidate);
    expect(r.resolved.length).toBe(1);
    expect(r.persisting.length).toBe(1);
    expect(r.introduced.length).toBe(0);
    expect(r.patchDecision).toBe("ACCEPT_PROGRESS");
  });

  it("ACCEPT_EQUIVALENT when nothing changes", () => {
    const issues = [{ code: "WIDTH", sev: "warning", msg: "x" }];
    const r = classifyDiagnostics(issues, issues);
    expect(r.patchDecision).toBe("ACCEPT_EQUIVALENT");
  });

  it("REJECT_REGRESSION when fix introduces new syntax errors", () => {
    const baseline  = [{ code: "WIDTH", sev: "warning", msg: "x" }];
    const candidate = [
      { code: "WIDTH", sev: "warning", msg: "x" },
      { code: "SYNTAX", sev: "error", msg: "missing semicolon" },
    ];
    const r = classifyDiagnostics(baseline, candidate);
    expect(r.patchDecision).toBe("REJECT_REGRESSION");
    expect(r.introduced.length).toBe(1);
  });

  it("REJECT_INVALID_PATCH when opts.patchInvalid is set", () => {
    const r = classifyDiagnostics([], [], { patchInvalid: true });
    expect(r.patchDecision).toBe("REJECT_INVALID_PATCH");
  });

  it("classifies revealed (same code family) vs introduced (new code family)", () => {
    const baseline  = [{ code: "WIDTH", sev: "warning", msg: "first" }];
    const candidate = [
      { code: "WIDTH", sev: "warning", msg: "second" }, // revealed (same code family)
      { code: "UNUSED", sev: "warning", msg: "third" }, // introduced (new code family)
    ];
    const r = classifyDiagnostics(baseline, candidate);
    expect(r.resolved.length).toBe(1);
    // Note: depending on match order, "second" may be revealed since matchDiagnostic
    // is fuzzy and "first"/"second" are different enough
    expect(r.introduced.length + r.revealed.length).toBeGreaterThan(0);
  });

  it("TASK_STATUS COMPLETE when no candidate issues remain", () => {
    const r = classifyDiagnostics([{ code: "WIDTH", msg: "x" }], []);
    expect(r.taskStatus).toBe("COMPLETE");
    expect(r.resolved.length).toBe(1);
  });

  it("provides legacy decision field", () => {
    // ACCEPT case: candidate has zero issues — clean fix
    const r1 = classifyDiagnostics([{ code: "X", msg: "y" }], []);
    expect(r1.decision).toBe("accept");

    // REJECT case: baseline persists fully AND a new error is introduced
    // → REJECT_REGRESSION (resolved=0, introduced has error, sev=error)
    const r2 = classifyDiagnostics(
      [{ code: "X", msg: "y" }],
      [{ code: "X", msg: "y" }, { code: "Y", sev: "error", msg: "new" }],
    );
    expect(r2.decision).toBe("reject");
  });
});

describe("classifyTestResults", () => {
  it("ACCEPT_PROGRESS when failing test now passes", () => {
    const baseline  = [{ name: "test_reset", st: "FAIL" }];
    const candidate = [{ name: "test_reset", st: "PASS" }];
    const r = classifyTestResults(baseline, candidate);
    expect(r.resolved.length).toBe(1);
    expect(r.patchDecision).toBe("ACCEPT_PROGRESS");
  });

  it("REJECT_REGRESSION when previously passing test now fails", () => {
    const baseline  = [{ name: "test_reset", st: "PASS" }, { name: "test_basic", st: "PASS" }];
    const candidate = [{ name: "test_reset", st: "PASS" }, { name: "test_basic", st: "FAIL" }];
    const r = classifyTestResults(baseline, candidate);
    expect(r.introduced.length).toBe(1);
    expect(r.patchDecision).toBe("REJECT_REGRESSION");
  });

  it("revealed: new test that doesn't exist in baseline and fails", () => {
    const baseline  = [{ name: "test_a", st: "PASS" }];
    const candidate = [{ name: "test_a", st: "PASS" }, { name: "test_b", st: "FAIL" }];
    const r = classifyTestResults(baseline, candidate);
    expect(r.revealed.length).toBe(1);
  });

  it("TASK_STATUS COMPLETE when all candidate tests pass", () => {
    const r = classifyTestResults(
      [{ name: "t1", st: "FAIL" }],
      [{ name: "t1", st: "PASS" }, { name: "t2", st: "PASS" }],
    );
    expect(r.taskStatus).toBe("COMPLETE");
  });

  it("TASK_STATUS INCOMPLETE when some tests still fail", () => {
    const r = classifyTestResults(
      [],
      [{ name: "t1", st: "PASS" }, { name: "t2", st: "FAIL" }],
    );
    expect(r.taskStatus).toBe("INCOMPLETE");
  });
});

describe("classifyTestResults — dropped tests (oracle-weakening loophole)", () => {
  it("a DELETED failing test is dropped, never resolved — and rejected", () => {
    // The loophole: "fix the TB by removing the failing check" used to earn
    // resolved +3 and ACCEPT_PROGRESS.
    const baseline  = [{ name: "test_full_flag", st: "FAIL" }, { name: "test_reset", st: "PASS" }];
    const candidate = [{ name: "test_reset", st: "PASS" }];
    const r = classifyTestResults(baseline, candidate);
    expect(r.resolved.length).toBe(0);
    expect(r.dropped.map((t) => t.name)).toEqual(["test_full_flag"]);
    expect(r.patchDecision).toBe("REJECT_REGRESSION");
    expect(r.taskStatus).toBe("COMPLETE");   // all-pass, but the DECISION still rejects
  });

  it("a silently vanished PASSING test is dropped (lost coverage), not free", () => {
    const baseline  = [{ name: "a", st: "PASS" }, { name: "b", st: "PASS" }];
    const candidate = [{ name: "a", st: "PASS" }];
    const r = classifyTestResults(baseline, candidate);
    expect(r.dropped.length).toBe(1);
    expect(r.score).toBe(-3);
    expect(r.patchDecision).toBe("REJECT_REGRESSION");
  });

  it("real progress can outweigh a small drop via score, but not a big one", () => {
    const baseline = [
      { name: "f1", st: "FAIL" }, { name: "f2", st: "FAIL" },
      { name: "gone", st: "PASS" },
    ];
    const netWin = classifyTestResults(baseline, [
      { name: "f1", st: "PASS" }, { name: "f2", st: "PASS" },
    ]);
    expect(netWin.score).toBe(3);              // +6 resolved, -3 dropped
    expect(netWin.patchDecision).toBe("ACCEPT_PROGRESS");
    const netLoss = classifyTestResults(
      [{ name: "f1", st: "FAIL" }, { name: "g1", st: "PASS" }, { name: "g2", st: "PASS" }],
      [{ name: "f1", st: "PASS" }],
    );
    expect(netLoss.score).toBe(-3);            // +3 resolved, -6 dropped
    expect(netLoss.patchDecision).toBe("REJECT_REGRESSION");
  });

  it("pure progress with no drops keeps the exact pre-existing decision path", () => {
    const r = classifyTestResults(
      [{ name: "t", st: "FAIL" }],
      [{ name: "t", st: "PASS" }],
    );
    expect(r.dropped.length).toBe(0);
    expect(r.patchDecision).toBe("ACCEPT_PROGRESS");
  });

  it("REQ-keyed aggregation still absorbs subtest renumbering (no false drop)", () => {
    // Rename REQ-FN-001.1 → REQ-FN-001.2 across a regen: per-req keys match.
    const r = classifyTestResultsByReq(
      [{ name: "REQ-FN-001.1", st: "FAIL" }],
      [{ name: "REQ-FN-001.2", st: "PASS" }],
    );
    expect(r.dropped.length).toBe(0);
    expect(r.patchDecision).toBe("ACCEPT_PROGRESS");
  });

  it("compile-fail override still wins over the dropped-based reject", () => {
    const r = classifyTestResults(
      [{ name: "t1", st: "FAIL" }, { name: "t2", st: "PASS" }],
      [{ name: "compilation", st: "FAIL" }],
    );
    expect(r.dropped.length).toBe(2);
    expect(r.patchDecision).toBe("REJECT_COMPILE_FAIL");
  });
});

describe("classifyDiagnostics — introduced-SYNTAX override (run 29)", () => {
  const W = (n) => ({ code: "WIDTH", sev: "warning", msg: "operand width mismatch " + n });
  const S = (n) => ({ code: "SYNTAX", sev: "error", msg: "syntax error, unexpected '[' " + n });

  it("run 29 shape: 25 resolved warnings never pay for 14 introduced SYNTAX errors", () => {
    const baseline = Array.from({ length: 25 }, (_, i) => W(i));
    const candidate = Array.from({ length: 14 }, (_, i) => S(i));
    const r = classifyDiagnostics(baseline, candidate);
    expect(r.resolved.length).toBe(25);
    expect(r.introduced.length).toBe(14);
    expect(r.score).toBeGreaterThan(0);              // the trap: score says progress
    expect(r.patchDecision).toBe("REJECT_REGRESSION");
  });

  it("a repair in progress (baseline already had SYNTAX) keeps the normal tiers", () => {
    const r = classifyDiagnostics([S(1), S(2), S(3)], [S(9)]);
    expect(r.patchDecision).toBe("ACCEPT_PROGRESS"); // 2 resolved, 1 revealed-class
  });

  it("pure warning cleanup with no syntax damage still accepts", () => {
    const r = classifyDiagnostics([W(1), W(2)], []);
    expect(r.patchDecision).toBe("ACCEPT_PROGRESS");
  });
});
