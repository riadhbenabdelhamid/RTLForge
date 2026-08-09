// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// The system verdict is computed, and a flawless run is exactly 100.
//
// Before this, int_judge printed a rubric into the prompt and stored whatever
// number came back. Two problems, both measured on run 51:
//
//   - Nothing checked the answer. The three inputs are hard measurements and
//     the one number a user reads was an unvalidated opinion on top of them.
//   - The rubric could not reach 100. Its lines are tiers, not additions, so
//     a perfect run topped out at 30+30+25+5 = 90 under a header saying "out
//     of 100"; read as additive it summed to 120.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { scoreIntegration, packageRequired, WEIGHTS } from "../src/pipeline/integrationScore.js";

const IMPORTS_PKG = "module rv_core\n    import rv_pkg::*;\n();\nendmodule\n";
const NO_PKG = "module cnt (input logic clk);\nendmodule\n";

// The exact shape run 51 produced.
const PERFECT = {
  lintData: { status: "PASS", issues: [] },
  verData: { pass: 42, total: 42, fail: 0 },
  perModuleJudges: [
    { modId: "rv_core", score: 100, overall: "PASS" },
    { modId: "rv_pipeline", score: 100, overall: "PASS" },
    { modId: "rv_hazard", score: 100, overall: "PASS" },
    { modId: "rv_decode", score: 100, overall: "PASS" },
    { modId: "rv_regfile", score: 100, overall: "PASS" },
    { modId: "rv_execute", score: 100, overall: "PASS" },
    { modId: "rv_alu", score: 100, overall: "PASS" },
  ],
  sharedPackage: { code: "package rv_pkg;\nendpackage\n" },
  moduleRtls: [IMPORTS_PKG],
};

describe("the weights reach 100", () => {
  it("sums to exactly 100 when every component applies", () => {
    expect(WEIGHTS.lint + WEIGHTS.systemTb + WEIGHTS.modules + WEIGHTS.sharedPackage).toBe(100);
  });

  // The whole point of the rescale: run 51's inputs were flawless and scored 95.
  it("scores run 51's flawless inputs as 100", () => {
    const r = scoreIntegration(PERFECT);
    expect(r.score).toBe(100);
    expect(r.overall).toBe("PASS");
    expect(r.reasons).toEqual([]);
  });

  // A design with no shared definitions is not worse for having none, so it
  // must still be able to reach 100 rather than being capped at 95.
  it("scores a package-free design out of the components that apply", () => {
    const r = scoreIntegration(Object.assign({}, PERFECT, {
      sharedPackage: null,
      moduleRtls: [NO_PKG],
    }));
    expect(r.score).toBe(100);
    expect(r.overall).toBe("PASS");
    expect(r.components.find((c) => c.name === "sharedPackage").applies).toBe(false);
  });

  // But a design whose modules DO import one and lack it is broken — this is
  // the file set run 51's export actually shipped.
  it("penalises modules that import a package the system does not provide", () => {
    const r = scoreIntegration(Object.assign({}, PERFECT, { sharedPackage: null }));
    expect(r.score).toBeLessThan(100);
    expect(r.reasons.join(" ")).toMatch(/import a package/);
  });
});

describe("the verdict follows the measurements", () => {
  it("fails on a lint error however good everything else is", () => {
    const r = scoreIntegration(Object.assign({}, PERFECT, {
      lintData: { status: "FAIL", issues: [{ sev: "error", msg: "boom" }] },
    }));
    expect(r.overall).toBe("FAIL");
    expect(r.reasons.join(" ")).toMatch(/lint error/);
  });

  it("fails when any module did not individually pass", () => {
    const judges = PERFECT.perModuleJudges.slice();
    judges[3] = { modId: "rv_decode", score: 88, overall: "NEEDS_FIX" };
    const r = scoreIntegration(Object.assign({}, PERFECT, { perModuleJudges: judges }));
    expect(r.overall).toBe("FAIL");
  });

  // The verdict is not a threshold on the score alone: this run clears 70 on
  // breadth while failing the thing that makes an integration real.
  it("fails a lint error even when the score still clears 70", () => {
    const r = scoreIntegration(Object.assign({}, PERFECT, {
      lintData: { status: "FAIL", issues: [{ sev: "error", msg: "boom" }] },
    }));
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.overall).toBe("FAIL");
  });

  it("does not treat an absent lint result as a pass", () => {
    const r = scoreIntegration(Object.assign({}, PERFECT, { lintData: null }));
    expect(r.overall).toBe("FAIL");
    expect(r.reasons.join(" ")).toMatch(/did not run/);
  });

  it("does not treat an absent testbench result as a pass", () => {
    const r = scoreIntegration(Object.assign({}, PERFECT, { verData: null }));
    expect(r.score).toBeLessThan(100);
    expect(r.reasons.join(" ")).toMatch(/no system testbench/);
  });
});

describe("the middle tiers", () => {
  it("gives lint a partial score for warnings and no errors", () => {
    const r = scoreIntegration(Object.assign({}, PERFECT, {
      lintData: { status: "PASS", issues: [{ sev: "warning", msg: "w" }] },
    }));
    expect(r.overall).toBe("PASS");            // warnings are not errors
    expect(r.score).toBeGreaterThan(70);
    expect(r.score).toBeLessThan(100);
  });

  it("gives the testbench a partial score at 80% and nothing below", () => {
    const at80 = scoreIntegration(Object.assign({}, PERFECT, {
      verData: { pass: 80, total: 100, fail: 20 },
    }));
    const below = scoreIntegration(Object.assign({}, PERFECT, {
      verData: { pass: 79, total: 100, fail: 21 },
    }));
    expect(at80.score).toBeGreaterThan(below.score);
    expect(below.reasons.join(" ")).toMatch(/pass rate 79%/);
  });

  it("takes only the best matching tier, never both", () => {
    // 100% also satisfies ">= 80%", and all-PASS also satisfies "all >= 70";
    // counting both is what made the old rubric sum past 100.
    const r = scoreIntegration(PERFECT);
    const tb = r.components.find((c) => c.name === "systemTb");
    const mods = r.components.find((c) => c.name === "modules");
    expect(tb.earned).toBe(WEIGHTS.systemTb);
    expect(mods.earned).toBe(WEIGHTS.modules);
  });
});

describe("packageRequired", () => {
  it("sees an import in any module", () => {
    expect(packageRequired([NO_PKG, IMPORTS_PKG])).toBe(true);
    expect(packageRequired([NO_PKG])).toBe(false);
    expect(packageRequired([])).toBe(false);
  });

  it("is not fooled by an import named only in a comment", () => {
    expect(packageRequired(["// each module opens with import rv_pkg::*;\n" + NO_PKG]))
      .toBe(false);
    expect(packageRequired(["/* import rv_pkg::*; */\n" + NO_PKG])).toBe(false);
  });
});
