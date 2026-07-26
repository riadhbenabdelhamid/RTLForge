// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Empty-contract rule (measured: nemotron run 12). A malformed spec with NO
// requirements reached the judge, and req_func_must reported measured=100
// PASS ("no func requirements at must priority", denominator 0) — a
// requirement-less pipeline passed the requirements gate while the design
// was missing a user-named port. Zero functional Must requirements is a
// spec defect: the gate must FAIL, not pass vacuously. Categories that are
// legitimately absent (e.g. timing on a counter) keep the vacuous pass.

import { describe, it, expect } from "vitest";
import { runEvalGate } from "../src/eval/gate.js";

const PASSING_TESTS = [
  { name: "REQ-FUNC-001.1", st: "PASS", req: "REQ-FUNC-001" },
];

function stateWith(spec) {
  return {
    spec: spec,
    verify: { pass: 1, fail: 0, total: 1, tests: PASSING_TESTS, sim: "Verilator (CLI)" },
    lint: { status: "PASS", errors: [] },
  };
}

function resultOf(verdict, id) {
  return verdict.results.find(function(r) { return r.id === id; });
}

describe("empty-contract rule in the eval gate (run 12)", () => {
  it("req_func_must FAILS when the spec has no requirements at all (the run-12 shape)", () => {
    const verdict = runEvalGate(stateWith({}), null);
    const r = resultOf(verdict, "req_func_must");
    expect(r.status).toBe("FAIL");
    expect(r.measured).toBe(0);
    expect(r.detail).toMatch(/empty contract|no functional Must/i);
    expect(verdict.overall).toBe("FAIL");
  });

  it("req_func_must FAILS when requirements exist but none are functional Must", () => {
    const verdict = runEvalGate(stateWith({
      requirements: [{ id: "REQ-TIME-001", cat: "Timing", pri: "Should", desc: "x" }],
    }), null);
    expect(resultOf(verdict, "req_func_must").status).toBe("FAIL");
  });

  it("still PASSES with a real traced functional Must requirement (control)", () => {
    const verdict = runEvalGate(stateWith({
      requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "x" }],
    }), null);
    expect(resultOf(verdict, "req_func_must").status).toBe("PASS");
  });

  it("legitimately absent categories keep the vacuous pass (timing on a counter)", () => {
    const verdict = runEvalGate(stateWith({
      requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "x" }],
    }), null);
    const timing = verdict.results.find(function(r) { return /timing/.test(r.id); });
    if (timing) expect(timing.measured).toBe(100);
  });
});

describe("graded score (run 29 program: 33 was a 4-value fingerprint)", () => {
  const SPEC = {
    requirements: [
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "a" },
      { id: "REQ-FUNC-002", cat: "Functionality", pri: "Must", desc: "b" },
      { id: "REQ-FUNC-003", cat: "Functionality", pri: "Must", desc: "c" },
    ],
  };
  const T = (id, st) => ({ name: id + ".1", st: st, req: id });
  // Run 28 shape: lint clean, 1/3 func-must green, verify 68%.
  const run28ish = {
    spec: SPEC,
    lint: { status: "PASS", errors: [] },
    verify: {
      pass: 68, fail: 32, total: 100, sim: "Verilator (CLI)",
      tests: [T("REQ-FUNC-001", "PASS"), T("REQ-FUNC-002", "FAIL"), T("REQ-FUNC-003", "FAIL")]
        .concat(Array.from({ length: 67 }, (_, i) => ({ name: "REQ-FUNC-001." + (i + 2), st: "PASS", req: "REQ-FUNC-001" })))
        .concat(Array.from({ length: 30 }, (_, i) => ({ name: "REQ-FUNC-002." + (i + 2), st: "FAIL", req: "REQ-FUNC-002" }))),
    },
  };
  // Run 29 shape: lint clean, TB never compiled (0/1 synthetic).
  const run29ish = {
    spec: SPEC,
    lint: { status: "PASS", errors: [] },
    verify: { pass: 0, fail: 1, total: 1, sim: "Verilator (CLI)", tests: [{ name: "compilation", st: "FAIL" }] },
  };

  it("different qualities now score DIFFERENTLY (both were 33 before)", () => {
    const a = runEvalGate(run28ish, null);
    const b = runEvalGate(run29ish, null);
    expect(a.overall).toBe("FAIL");
    expect(b.overall).toBe("FAIL");
    expect(a.score).toBeGreaterThan(b.score);       // 68%-passing beats never-compiled
    expect(a.score).toBeGreaterThan(33);            // partial credit visible
    expect(a.score).toBeLessThan(100);
  });

  it("failing criteria earn proportional credit; PASS stays exactly 1 credit", () => {
    const v = runEvalGate(run28ish, null);
    const vp = v.results.find((r) => r.id === "verify_pass_rate");
    expect(vp.status).toBe("FAIL");
    expect(vp.measured).toBe(68);                    // the credit source
    const full = runEvalGate({ spec: SPEC, lint: { status: "PASS", errors: [] },
      verify: { pass: 3, fail: 0, total: 3, sim: "Verilator (CLI)",
        tests: [T("REQ-FUNC-001", "PASS"), T("REQ-FUNC-002", "PASS"), T("REQ-FUNC-003", "PASS")] } }, null);
    expect(full.score).toBe(100);                    // all-pass is still exactly 100
    expect(full.overall).toBe("PASS");
  });

  it("overall PASS/FAIL and failingIds are untouched by grading", () => {
    const v = runEvalGate(run28ish, null);
    expect(v.failingIds).toContain("verify_pass_rate");
    expect(v.failed).toBeGreaterThan(0);
  });
});

describe("per-requirement graded credit (run 29 program, level 2)", () => {
  const SPEC3 = {
    requirements: [
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "a" },
      { id: "REQ-FUNC-002", cat: "Functionality", pri: "Must", desc: "b" },
      { id: "REQ-FUNC-003", cat: "Functionality", pri: "Must", desc: "c" },
    ],
  };
  const state = {
    spec: SPEC3,
    lint: { status: "PASS", errors: [] },
    verify: {
      pass: 3, fail: 2, total: 5, sim: "Verilator (CLI)",
      tests: [
        { name: "REQ-FUNC-001.1", st: "PASS", req: "REQ-FUNC-001" },              // fully green (1.0)
        { name: "REQ-FUNC-002.1", st: "PASS", req: "REQ-FUNC-002" },              // 2/3 pass (0.667)
        { name: "REQ-FUNC-002.2", st: "PASS", req: "REQ-FUNC-002" },
        { name: "REQ-FUNC-002.3", st: "FAIL", req: "REQ-FUNC-002" },
        { name: "REQ-FUNC-003.1", st: "FAIL", req: "REQ-FUNC-003" },              // 0/1 (0)
      ],
    },
  };

  it("a near-complete requirement earns proportional credit, not zero", () => {
    const r = runEvalGate(state, null).results.find((x) => x.id === "req_func_must");
    // credits: 1 + 2/3 + 0 = 1.667 of 3 → 56%
    expect(r.measured).toBe(56);
    expect(r.status).toBe("FAIL");                       // threshold 100 unchanged
    expect(r.detail).toMatch(/1\/3 .*fully green/);
    expect(r.detail).toMatch(/1 partially passing, graded/);
  });

  it("measured 100 still means EVERY requirement fully green (threshold semantics keep)", () => {
    const allGreen = JSON.parse(JSON.stringify(state));
    allGreen.verify.tests.forEach((t) => { t.st = "PASS"; });
    allGreen.verify.pass = 5; allGreen.verify.fail = 0;
    const r = runEvalGate(allGreen, null).results.find((x) => x.id === "req_func_must");
    expect(r.measured).toBe(100);
    expect(r.status).toBe("PASS");
  });

  it("requirements with no test link still earn zero (empty-contract rigor keeps)", () => {
    const untraced = { spec: SPEC3, lint: { status: "PASS", errors: [] },
      verify: { pass: 1, fail: 0, total: 1, sim: "Verilator (CLI)",
        tests: [{ name: "compilation", st: "FAIL" }] } };
    const r = runEvalGate(untraced, null).results.find((x) => x.id === "req_func_must");
    expect(r.measured).toBe(0);
  });
});
