// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
// The judge gate and the reflow planner honor measurement provenance: a lint /
// verify result stamped for code the state no longer holds is graded as a
// STALE failure (never a pass, never silently skipped), triage routes it to
// the measure stage rather than a regeneration, and smart-mode planning never
// skips a stale stage as "already passing".
import { describe, it, expect } from "vitest";
import { runEvalGate, triageTargetsFor, staleMeasureStageFor } from "../src/eval/gate.js";
import { defaultEvalConfig } from "../src/eval/criteria.js";
import { isStagePassing } from "../src/pipeline/reflowPlanner.js";
import { stampMeasurement } from "../src/utils/measurement.js";

const RTL_A = "module m; logic a; endmodule";
const RTL_B = "module m; logic b; endmodule";
const TB_A  = "module tb; endmodule";

function baseState(lint) {
  return {
    spec: { requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "x" }] },
    rtl_generate: { code: RTL_A },
    test_generate: { code: TB_A },
    verify: stampMeasurement("verify", { total: 1, pass: 1, fail: 0, cli: true,
      tests: [{ name: "t", st: "PASS", req: "REQ-FUNC-001" }] }, { rtl: RTL_A, tb: TB_A }),
    lint: lint,
  };
}
function row(verdict, id) { return verdict.results.find(function(r) { return r.id === id; }); }

describe("eval gate: stale measurements", function() {
  it("a lint PASS stamped for a different RTL fails as STALE, a fresh one passes, an unstamped one is graded as before", function() {
    const cfg = defaultEvalConfig();
    const stale = runEvalGate(baseState(stampMeasurement("lint", { status: "PASS", errors: [], warnings: [] }, { rtl: RTL_B })), cfg);
    expect(row(stale, "lint_rtl_clean").status).toBe("FAIL");
    expect(row(stale, "lint_rtl_clean").stale).toBe(true);
    expect(row(stale, "lint_rtl_clean").detail).toMatch(/stale/);
    expect(stale.overall).toBe("FAIL");
    const fresh = runEvalGate(baseState(stampMeasurement("lint", { status: "PASS", errors: [], warnings: [] }, { rtl: RTL_A })), cfg);
    expect(row(fresh, "lint_rtl_clean").status).toBe("PASS");
    expect(row(fresh, "lint_rtl_clean").stale).toBe(false);
    expect(fresh.overall).toBe("PASS");
    const legacy = runEvalGate(baseState({ status: "PASS", errors: [], warnings: [] }), cfg);
    expect(row(legacy, "lint_rtl_clean").status).toBe("PASS");
  });

  it("a stale verify result fails the pass-rate criterion as STALE even when its numbers are green", function() {
    const st = baseState(stampMeasurement("lint", { status: "PASS", errors: [], warnings: [] }, { rtl: RTL_A }));
    st.test_generate = { code: "module tb2; endmodule" };   // TB rewritten after the sim ran
    const v = runEvalGate(st, defaultEvalConfig());
    expect(row(v, "verify_pass_rate").status).toBe("FAIL");
    expect(row(v, "verify_pass_rate").stale).toBe(true);
  });
});

describe("triage of stale failures", function() {
  it("routes an all-stale verdict to the measure stage only (re-lint, not regenerate)", function() {
    const v = runEvalGate(baseState(stampMeasurement("lint", { status: "PASS", errors: [], warnings: [] }, { rtl: RTL_B })), defaultEvalConfig());
    expect(triageTargetsFor(v)).toEqual(["lint"]);
  });
  it("puts the measure stage first when stale and genuine failures mix", function() {
    const st = baseState(stampMeasurement("lint", { status: "PASS", errors: [], warnings: [] }, { rtl: RTL_B }));
    st.verify = stampMeasurement("verify", { total: 2, pass: 1, fail: 1, cli: true,
      tests: [{ name: "t", st: "FAIL", req: "REQ-FUNC-001" }] }, { rtl: RTL_A, tb: TB_A });
    const targets = triageTargetsFor(runEvalGate(st, defaultEvalConfig()));
    expect(targets[0]).toBe("lint");
    expect(targets.length).toBeGreaterThan(1);
  });
  it("maps criteria to their measure stages", function() {
    expect(staleMeasureStageFor("lint_rtl_clean")).toBe("lint");
    expect(staleMeasureStageFor("lint_tb_clean")).toBe("lint_test");
    expect(staleMeasureStageFor("verify_pass_rate")).toBe("verify");
    expect(staleMeasureStageFor("coverage_line")).toBe("verify");
    expect(staleMeasureStageFor("req_func_must")).toBeNull();
  });
});

describe("reflow planner: stale stages are not 'passing'", function() {
  it("a stale lint PASS does not count as passing; a fresh or unstamped one does", function() {
    const state = { rtl_generate: { code: RTL_A }, test_generate: { code: TB_A } };
    expect(isStagePassing("lint", stampMeasurement("lint", { status: "PASS" }, { rtl: RTL_B }), state)).toBe(false);
    expect(isStagePassing("lint", stampMeasurement("lint", { status: "PASS" }, { rtl: RTL_A }), state)).toBe(true);
    expect(isStagePassing("lint", { status: "PASS" }, state)).toBe(true);
    expect(isStagePassing("verify", stampMeasurement("verify", { fail: 0, total: 3 }, { rtl: RTL_A, tb: "old tb" }), state)).toBe(false);
  });
});
