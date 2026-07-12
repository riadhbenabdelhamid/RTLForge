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
