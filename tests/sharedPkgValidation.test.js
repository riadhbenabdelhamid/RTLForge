// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Generation-time shared-package validation. Measured on lfm2-24b: 3/3
// generated packages were syntactically broken and poisoned every downstream
// compile (their errors cascade into all module files). The package is now
// real-linted ALONE at generation: clean → adopt; broken → one repair; still
// broken → run without a shared package.

import { describe, it, expect } from "vitest";
import { runAllPipelines } from "../src/projectState/runAllPipelines.js";

const ACTIVE = [{ id: 1, key: "elicit" }, { id: 2, key: "spec" }, { id: 4, key: "rtl_generate" }];
const BROKEN_PKG = "timescale 1ns/1ps\npackage p; endpackage";
const FIXED_PKG = "`timescale 1ns/1ps\npackage p; endpackage";
const PKG_ERR = { stdout: "", stderr: "%Error: shared_pkg.sv:1:1: syntax error, unexpected IDENTIFIER\n", exitCode: 1 };
const CLEAN = { stdout: "", stderr: "", exitCode: 0 };

function harness(opts) {
  const state = {
    modules: {
      leaf: { completed: new Set(), stageData: {}, imported: false },
      top: { completed: new Set(), stageData: {}, imported: false },
    },
    instances: { i1: { parentModuleId: "top", moduleId: "leaf", instanceName: "u_leaf" } },
    decomposition: { topModule: "top", sharedTypes: ["ctrl_t"], systemName: "sys" },
    sharedPackage: null,
  };
  const dispatched = [];
  const lintResults = opts.lint.slice();
  const llmCalls = [];
  return {
    state, dispatched, llmCalls,
    run: () => runAllPipelines({
      execMode: "full-auto",
      reducerState: state,
      uiState: { userDesc: "sys", config: opts.config || { backendUrl: "local" }, activeStages: ACTIVE },
      services: {
        getState: () => state,
        allStages: ACTIVE,
        pipeline: {},
        runStage: async (a) => { state.modules[a.targetModId].completed.add(a.stageId); return { ok: true }; },
        callLLM: async (p) => {
          llmCalls.push(p);
          if (/Repair the SHARED PACKAGE/.test(p.userMessage || "")) {
            return { text: JSON.stringify({ code: (opts.repairTo != null ? opts.repairTo : FIXED_PKG), fixes: [] }) };
          }
          return { text: JSON.stringify({ packageName: "p", code: BROKEN_PKG }) };
        },
        extractJSON: JSON.parse,
        promptSharedPackage: () => ({ systemPrompt: "s", userMessage: "generate shared package" }),
        runCli: async () => (lintResults.length > 1 ? lintResults.shift() : lintResults[0]),
      },
      dispatch: (a) => dispatched.push(a),
    }),
  };
}

describe("shared package validated at generation (real lint, repair once, or drop)", () => {
  it("a clean package is adopted as-is", async () => {
    const h = harness({ lint: [CLEAN] });
    await h.run();
    const set = h.dispatched.find((a) => a.type === "SHARED_PACKAGE_SET");
    expect(set.sharedPackage.code).toBe(BROKEN_PKG);   // whatever was generated, lint said clean
    expect(h.llmCalls.filter((p) => /Repair/.test(p.userMessage))).toHaveLength(0);
  });

  it("a broken package is repaired once and adopted when the re-lint is clean", async () => {
    const h = harness({ lint: [PKG_ERR, CLEAN] });
    await h.run();
    const set = h.dispatched.find((a) => a.type === "SHARED_PACKAGE_SET");
    expect(set.sharedPackage.code).toBe(FIXED_PKG);
    expect(set.sharedPackage._fixSource).toContain("generation");
    // the repair prompt carried the real findings
    const fix = h.llmCalls.find((p) => /Repair the SHARED PACKAGE/.test(p.userMessage));
    expect(fix.userMessage).toContain("syntax error");
  });

  it("a package that stays broken after repair is DROPPED — the walk continues without one", async () => {
    const h = harness({ lint: [PKG_ERR] });   // every lint says broken
    const r = await h.run();
    expect(r.ok).toBe(true);                  // non-fatal
    expect(h.dispatched.find((a) => a.type === "SHARED_PACKAGE_SET")).toBeUndefined();
  });

  it("without a backend the package is adopted unvalidated (no measured verdict to gate on)", async () => {
    const h = harness({ lint: [PKG_ERR], config: {} });
    await h.run();
    expect(h.dispatched.find((a) => a.type === "SHARED_PACKAGE_SET")).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Standalone-package lint (run 47, the campaign's first system run).
//
// A shared package linted BY ITSELF has unused parameters — nothing imports
// it until the modules are generated — and Verilator under -Wall then prints
// "%Error: Exiting due to N warning(s)". The old check tested stderr for
// "%Error" and condemned the package, while the finding extraction read the
// CLASSIFIED errors and found none. The two halves disagreed: the repair
// prompt was handed an EMPTY findings list, and the caller then continued
// WITHOUT the shared package the whole system depends on.
// ═══════════════════════════════════════════════════════════════════════════
describe("shared package: warnings alone must not condemn it (run 47)", () => {
  const WARN_ONLY = {
    stdout: "",
    stderr: "%Warning-UNUSEDPARAM: shared_pkg.sv:2:20: Parameter is not used: 'CLKS_PER_BIT'\n"
      + "%Error: Exiting due to 1 warning(s)\n",
    exitCode: 1,
  };

  it("adopts a package whose only lint output is unused-parameter warnings", async () => {
    const h = harness({ lint: [WARN_ONLY] });
    await h.run();
    const set = h.dispatched.find((a) => a.type === "SHARED_PACKAGE_SET");
    expect(set).toBeTruthy();                       // never dropped
    expect(set.sharedPackage.code).toBe(BROKEN_PKG);  // adopted as generated
  });

  it("does not spend a repair call when nothing classified as an error", async () => {
    const h = harness({ lint: [WARN_ONLY] });
    await h.run();
    expect(h.llmCalls.filter((p) => /Repair the SHARED PACKAGE/.test(p.userMessage || "")))
      .toHaveLength(0);
  });

  it("a REAL error still triggers exactly one repair", async () => {
    const h = harness({ lint: [PKG_ERR, CLEAN] });
    await h.run();
    expect(h.llmCalls.filter((p) => /Repair the SHARED PACKAGE/.test(p.userMessage || "")))
      .toHaveLength(1);
  });
});
