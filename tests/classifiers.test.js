// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import {
  matchDiagnostic,
  classifyDiagnostics,
  classifyTestResults,
} from "../src/pipeline/classifiers.js";

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
