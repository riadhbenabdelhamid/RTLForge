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
import { normalizeEvalConfig, listCriteria, getCriterion } from "../src/eval/criteria.js";

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

// ═══════════════════════════════════════════════════════════════════════════
// Weighted score + the lint/formal split (run 36).
//
// Run 36 produced the campaign's first `proven: true` formal verdict while
// its testbench never compiled. Under equal weights that proof was worth
// nothing to the score (formal_proven wasn't a criterion at all), and lint —
// the weakest evidence in the set — held a full third. The user's rule: when
// the formal stage is CHECKED, split lint's 33% into 13% lint + 20% formal.
// The split comes out of lint's slot, never out of requirements or
// simulation: a proof of the control logic is not evidence the datapath does
// what the spec asked (run 36 proved 12 properties on RTL whose own review
// said no test drives a transfer).
// ═══════════════════════════════════════════════════════════════════════════
describe("weighted score: formal_proven splits lint's slot (run 36)", () => {
  const SPEC = { requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "a" }] };
  const base = {
    spec: SPEC,
    lint: { status: "PASS", errors: [], warnings: [] },
    verify: { pass: 1, fail: 0, total: 1, sim: "Verilator (CLI)",
      tests: [{ name: "REQ-FUNC-001.1", st: "PASS", req: "REQ-FUNC-001" }] },
  };
  // Run 36's actual formal shape: 15 generated, 3 skipped (`|=>` bucket), PASS + proven.
  const formal36 = {
    formal_props: { properties: Array.from({ length: 15 }, (_, i) => ({ id: "SVA-" + i })) },
    formal_verify: { status: "PASS", proven: true, formalSkipped: ["SVA-003", "SVA-004", "SVA-006"] },
  };
  const shares = (v) => {
    const live = v.results.filter((r) => r.status !== "SKIP");
    const sum = live.reduce((a, r) => a + r.weight, 0);
    const out = {};
    for (const r of live) out[r.id] = Math.round((r.weight / sum) * 1000) / 10;
    return out;
  };

  // The gate is normally called with a MATERIALIZED config (defaultEvalConfig
  // seeds an entry for every id), so these run both ways: null config and the
  // real normalized one. An earlier cut keyed the auto-enable on "no config
  // entry" and would have been inert in every real run.
  const REAL_CFG = normalizeEvalConfig({}).config;

  for (const [label, cfg] of [["null config", null], ["materialized config", REAL_CFG]]) {
    it("formal stage OFF (" + label + "): the trio keeps 33/33/33, formal_proven SKIPs", () => {
      const v = runEvalGate(base, cfg);
      expect(shares(v)).toEqual({ req_func_must: 33.3, verify_pass_rate: 33.3, lint_rtl_clean: 33.3 });
      const f = resultOf(v, "formal_proven");
      expect(f.status).toBe("SKIP");
      expect(f.detail).toMatch(/did not run/);
      expect(v.failingIds).not.toContain("formal_proven");   // absent ≠ failing
    });

    it("formal stage CHECKED (" + label + "): 33/33/13/20", () => {
      const v = runEvalGate(Object.assign({}, base, formal36), cfg);
      expect(shares(v)).toEqual({
        req_func_must: 33.3, verify_pass_rate: 33.3, formal_proven: 20, lint_rtl_clean: 13.3,
      });
    });
  }

  it("formal stage CHECKED: 33 req / 33 verify / 13 lint / 20 formal", () => {
    const v = runEvalGate(Object.assign({}, base, formal36), null);
    expect(shares(v)).toEqual({
      req_func_must: 33.3, verify_pass_rate: 33.3, formal_proven: 20, lint_rtl_clean: 13.3,
    });
    // lint + formal together still cost exactly what lint alone cost.
    const live = v.results.filter((r) => r.enabled);
    expect(live.reduce((a, r) => a + r.weight, 0)).toBe(3);
  });

  it("a SKIPPED formal stage takes no share and fails nothing", () => {
    const v = runEvalGate(Object.assign({}, base, { formal_verify: { status: "SKIPPED" } }), null);
    expect(resultOf(v, "formal_proven").status).toBe("SKIP");
    expect(resultOf(v, "lint_rtl_clean").weight).toBe(1);
    expect(v.overall).toBe("PASS");
  });

  it("properties generated but no verdict is also not-applicable, not a 0", () => {
    const v = runEvalGate(Object.assign({}, base, { formal_props: formal36.formal_props }), null);
    expect(resultOf(v, "formal_proven").status).toBe("SKIP");
    expect(resultOf(v, "lint_rtl_clean").weight).toBe(1);
  });

  it("an explicit user OFF still wins, even with a real formal verdict present", () => {
    const off = runEvalGate(Object.assign({}, base, formal36),
      normalizeEvalConfig({ formal_proven: { enabled: false } }).config);
    expect(resultOf(off, "formal_proven").status).toBe("SKIP");
    expect(resultOf(off, "lint_rtl_clean").weight).toBe(1);      // no partner → no split
  });

  it("run 36's measurement: 12 of 15 proved unbounded → 80, graded not binary", () => {
    const v = runEvalGate(Object.assign({}, base, formal36), null);
    const r = resultOf(v, "formal_proven");
    expect(r.measured).toBe(80);                    // 3 of 15 skipped = unchecked
    expect(r.status).toBe("FAIL");                  // threshold 100: skipped props aren't proof
    expect(r.detail).toMatch(/12\/15/);
  });

  it("proof credit cannot mask failing requirements or simulation", () => {
    // The run-36 shape: perfect lint, real proof, nothing else works.
    const v = runEvalGate(Object.assign({}, base, formal36, {
      verify: { pass: 0, fail: 1, total: 1, sim: "Verilator (CLI)", tests: [{ name: "compilation", st: "FAIL" }] },
      spec: { requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "a" }] },
    }), null);
    // (0×1 + 0×1 + 0.8×0.6 + 1×0.4) / 3 = 29
    expect(v.score).toBe(29);
    expect(v.overall).toBe("FAIL");
  });

  it("an UNPROVEN formal verdict earns 0 — bounded-only is not a proof", () => {
    const bounded = Object.assign({}, base, {
      formal_props: formal36.formal_props,
      formal_verify: { status: "PASS", proven: false, formalSkipped: [] },
    });
    expect(resultOf(runEvalGate(bounded, null), "formal_proven").measured).toBe(0);
    const failed = Object.assign({}, base, {
      formal_props: formal36.formal_props,
      formal_verify: { status: "FAIL", proven: false, formalSkipped: [] },
    });
    expect(resultOf(runEvalGate(failed, null), "formal_proven").measured).toBe(0);
  });

  it("all-green with formal live still scores exactly 100", () => {
    const v = runEvalGate(Object.assign({}, base, {
      formal_props: formal36.formal_props,
      formal_verify: { status: "PASS", proven: true, formalSkipped: [] },
    }), null);
    expect(v.score).toBe(100);
    expect(v.overall).toBe("PASS");
  });
});

// A formal stage that errored out produced no verdict (run 37: yosys could not
// run because the RTL had 8 SYNTAX errors). Absence of evidence must not be
// priced as a design defect — it would charge 20% for toolchain breakage and
// shrink lint's slot to 13% on the strength of nothing.
describe("formal_proven requires an actual verdict (run 37)", () => {
  const base = {
    spec: { requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "a" }] },
    lint: { status: "PASS", errors: [], warnings: [] },
    verify: { pass: 1, fail: 0, total: 1, sim: "Verilator (CLI)",
      tests: [{ name: "REQ-FUNC-001.1", st: "PASS", req: "REQ-FUNC-001" }] },
    formal_props: { properties: [{ id: "SVA-001" }, { id: "SVA-002" }] },
  };
  const r = (status) => runEvalGate(Object.assign({}, base, {
    formal_verify: { status: status, proven: false, formalSkipped: [] },
  }), null);

  it("TOOL_ERROR is not applicable — no share taken, lint keeps its full slot", () => {
    const v = r("TOOL_ERROR");
    expect(v.results.find((x) => x.id === "formal_proven").status).toBe("SKIP");
    expect(v.results.find((x) => x.id === "lint_rtl_clean").weight).toBe(1);
    expect(v.results.find((x) => x.id === "formal_proven").detail).toMatch(/TOOL_ERROR/);
    expect(v.failingIds).not.toContain("formal_proven");
  });

  it("a formal FAIL still scores 0 and takes its 20% — a counterexample is evidence", () => {
    const v = r("FAIL");
    const f = v.results.find((x) => x.id === "formal_proven");
    expect(f.status).toBe("FAIL");
    expect(f.measured).toBe(0);
    expect(v.results.find((x) => x.id === "lint_rtl_clean").weight).toBe(0.4);
  });
});

// Run 40: a failing formal criterion post-f676b63 is a REAL counterexample,
// and a counterexample indicts the design — triage must offer rtl_generate
// before formal_props.
describe("formal triage prefers the design over the properties (run 40)", () => {
  it("a formal-failing verdict routes rtl_generate first", async () => {
    const { triageTargetsFor } = await import("../src/eval/gate.js");
    const verdict = {
      failingIds: ["formal_proven"],
      results: [{ id: "formal_proven", category: "formal", status: "FAIL" }],
    };
    const targets = triageTargetsFor(verdict);
    expect(targets[0]).toBe("rtl_generate");
    expect(targets).toContain("formal_props");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// mutation_score semantics (run 45/46). The criterion existed but could not
// be trusted if enabled: absent data scored 0 — charging a run for not having
// measured — and "no valid mutants" scored 100, rewarding a run that measured
// nothing. Both are now notApplicable, the same treatment formal gives a
// toolchain failure, so verify keeps its full share until real evidence
// exists.
// ═══════════════════════════════════════════════════════════════════════════
describe("mutation_score measurer", () => {
  const defaultCriteria = () => listCriteria();
  const measurerOf = (id) => getCriterion(id).measure;
  const measure = (state) => measurerOf("mutation_score")(state);

  it("absent mutation data is notApplicable, never a zero", () => {
    const m = measure({ verify: { pass: 10, total: 10 } });
    expect(m.notApplicable).toBe(true);
    expect(m.detail).toMatch(/no mutation run/);
  });

  it("a run where nothing compiled is notApplicable, never a perfect score", () => {
    expect(measure({ mutation: { score: 0, compiled: 0, total: 6 } }).notApplicable).toBe(true);
    expect(measure({ verify: { mutation: { total: 4, invalid: 4, killed: 0 } } }).notApplicable).toBe(true);
  });

  it("reads the tool's shape and reports the kill rate", () => {
    // run 45's real testbench
    const m = measure({ mutation: { score: 93, compiled: 14, killed: 13, survived: [{ line: 111, kind: "bitwise" }] } });
    expect(m.notApplicable).toBeFalsy();
    expect(m.measured).toBe(93);
    expect(m.denominator).toBe(14);
    expect(m.detail).toMatch(/13\/14 mutants killed/);
    expect(m.detail).toMatch(/may be equivalent/);
  });

  it("reads the pipeline's own slot shape too", () => {
    const m = measure({ verify: { mutation: { total: 10, invalid: 2, killed: 6, score: 75 } } });
    expect(m.measured).toBe(75);
    expect(m.denominator).toBe(8);
  });

  it("separates the two run-45 testbenches the pass rate could not", () => {
    // both suites reported 60/60; only the kill rate tells them apart
    expect(measure({ mutation: { score: 93, compiled: 14, killed: 13 } }).measured).toBe(93);
    expect(measure({ mutation: { score: 7, compiled: 14, killed: 1 } }).measured).toBe(7);
  });

  it("takes its share out of verify's slot rather than adding on top", () => {
    const all = defaultCriteria();
    const mut = all.find((c) => c.id === "mutation_score");
    const ver = all.find((c) => c.id === "verify_pass_rate");
    expect(mut.weight).toBe(0.6);
    expect(ver.splitBy).toBe("mutation_score");
    expect(ver.weightWhenSplit).toBe(0.4);
    // 0.4 + 0.6 = the 1.0 pass rate held alone
    expect(ver.weightWhenSplit + mut.weight).toBe(1);
  });

  it("stays opt-in — the default config leaves it off", () => {
    const mut = defaultCriteria().find((c) => c.id === "mutation_score");
    expect(mut.defaultEnabled).toBe(false);
  });
});
