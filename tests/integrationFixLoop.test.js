// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// SoC roadmap S3: integration fix loop with module-routed triage.
// Deterministic routing (structural → top, error files → owner module) runs
// before any LLM opinion; fixes happen only on the real-tooling path.

import { describe, it, expect } from "vitest";
import { runIntegrationPipeline } from "../src/projectState/runIntegrationPipeline.js";
import { runAllPipelines } from "../src/projectState/runAllPipelines.js";
import { extractJSON } from "../src/llm/index.js";

const CHILD = "module cnt #(parameter W=8)(input logic clk, output logic [W-1:0] q);\n  always_ff @(posedge clk) q <= q + 1;\nendmodule";
const TOP = "module top(input logic clk, output logic [7:0] q);\n  cnt #(.W(8)) u_cnt0 (.clk(clk), .q(q));\nendmodule";
const FIXED_TOP = TOP.replace("q <= ", "q  <= ") + "\n// fixed";
const TB = "module system_tb; endmodule";
const FIXED_TB = TB + "\n// fixed";
const PKG = "timescale 1ns/1ps\npackage sys_pkg; endpackage";      // broken: no backtick
const FIXED_PKG = "`timescale 1ns/1ps\npackage sys_pkg; endpackage";

function reducerState() {
  return {
    modules: {
      top: { contentHash: "h1", stageData: { 2: { iface: [], params: [], requirements: [] }, 4: { code: TOP, note: "keep-me" }, 9: { overall: "PASS", score: 90 } } },
      cnt: { contentHash: "h2", stageData: { 4: { code: CHILD }, 9: { overall: "PASS", score: 88 } } },
    },
    instances: { u_cnt0: { instanceName: "u_cnt0", moduleId: "cnt", parentId: "top", paramOverrides: { W: 8 } } },
    decomposition: { topModule: "top", interconnects: [] },
    sharedPackage: null,
  };
}

const CONFIG = {
  backendUrl: "local", provider: "lmstudio",
  lintCmd: "verilator --lint-only -Wall {RTL}",
  simCmds: "verilator --binary {RTL} {TB} -o {RTL}.sim\n./obj_dir/system.sim",
};

// Stub LLM keyed by prompt kind; per-kind responders are overridable.
function llmStub(calls, overrides) {
  const o = overrides || {};
  return async (p) => {
    const u = p.userMessage || "";
    let kind = "judge";
    if (/Repair the TOP module/.test(u)) kind = "topfix";
    else if (/Repair the SHARED PACKAGE/.test(u)) kind = "pkgfix";
    else if (/Repair the SYSTEM TESTBENCH/.test(u)) kind = "tbfix";
    else if (/owns the root cause/.test(u)) kind = "triage";
    else if (/system testbench that exercises/i.test(u)) kind = "tb";
    else if (/cross-module integration lint/i.test(u)) kind = "lint";
    else if (/Estimate what would happen|NO real simulator/i.test(u + (p.systemPrompt || ""))) kind = "estimate";
    calls.push({ kind, p });
    const body = o[kind] ? o[kind](p) : {
      tb: { code: TB },
      topfix: { code: FIXED_TOP, fixes: [{ id: "E1", desc: "rewired" }] },
      pkgfix: { code: FIXED_PKG, fixes: [{ id: "P1", desc: "backticked timescale" }] },
      tbfix: { code: FIXED_TB, fixes: [{ id: "test_b", desc: "fixed check" }] },
      triage: { target: "tb", reason: "expected value wrong" },
      lint: { status: "PASS", issues: [], summary: "llm lint" },
      estimate: { sim: "est", total: 1, pass: 1, fail: 0, tests: [] },
      judge: { overall: "PASS", score: 90, summary: "ok" },
    }[kind];
    return { text: JSON.stringify(body), tokensIn: 1, tokensOut: 1, latencyMs: 1 };
  };
}

const LINT_CLEAN = { stdout: "", stderr: "", exitCode: 0 };
const SIM_PASS = { stdout: "[PASS] test_a @10 cycles\n[SUMMARY] passes=1 fails=0\n", stderr: "", exitCode: 0 };
const SIM_FAIL = { stdout: "[PASS] test_a @10 cycles\n[FAIL] test_b @20 cycles\n[SUMMARY] passes=1 fails=1\n", stderr: "", exitCode: 1 };

// runCli stub: routes lint vs sim payloads through the given queues (each an
// array consumed left-to-right; the last entry repeats).
function cliStub(cliCalls, lintQueue, simQueue) {
  return async (backendUrl, payload) => {
    cliCalls.push(payload);
    const q = payload.command && /lint-only/.test(payload.command) ? lintQueue : simQueue;
    return q.length > 1 ? q.shift() : q[0];
  };
}

async function run(opts) {
  const calls = [], cliCalls = [], dispatched = [];
  const r = await runIntegrationPipeline({
    reducerState: reducerState(),
    uiState: { config: Object.assign({}, CONFIG, opts.config) },
    services: Object.assign(
      { callLLM: llmStub(calls, opts.llm), extractJSON, runCli: cliStub(cliCalls, opts.lint, opts.sim) },
      opts.logger ? { logger: opts.logger } : {},
    ),
    dispatch: (a) => dispatched.push(a),
  });
  return { r, calls, cliCalls, dispatched };
}

// ═══════════════════════════════════════════════════════════════════════════
// The integration score and verdict are COMPUTED, not taken from the model.
//
// Before this, int_judge printed a rubric into the prompt and stored whatever
// number came back, so "PASS" alongside lint errors, or 100 with modules
// failing, would have been the run's headline result.
// ═══════════════════════════════════════════════════════════════════════════
describe("int_judge score is measured, not asked for", () => {
  it("overrides a model verdict that contradicts the measurements", async () => {
    const { r } = await run({
      lint: [LINT_CLEAN], sim: [SIM_PASS],
      llm: { judge: () => ({ overall: "FAIL", score: 12, integrationIssues: ["nonsense"] }) },
    });
    expect(r.ok).toBe(true);
    // clean lint, every check passing, both modules PASS → nothing to deduct
    expect(r.judgeData.overall).toBe("PASS");
    expect(r.judgeData.score).toBe(100);
    // the model's reading is kept beside it rather than discarded
    expect(r.judgeData._modelOverall).toBe("FAIL");
    expect(r.judgeData._modelScore).toBe(12);
    expect(r.judgeData._scoreDisagreement).toBe(true);
    // and the narrative the model IS responsible for survives untouched
    expect(r.judgeData.integrationIssues).toEqual(["nonsense"]);
  });

  it("fails the verdict on a measured lint error however the model scores it", async () => {
    // the top's lint error is never repaired, so int_lint stays failing
    const TOP_ERR = { stdout: "", stderr: "%Error: top.sv:2:3: syntax error\n", exitCode: 1 };
    const { r } = await run({
      lint: [TOP_ERR], sim: [SIM_PASS],
      llm: {
        topfix: () => ({ code: TOP, fixes: [{ id: "E1", desc: "no-op" }] }),
        judge: () => ({ overall: "PASS", score: 100 }),
      },
    });
    if (r.ok) {
      expect(r.judgeData.overall).toBe("FAIL");
      expect(r.judgeData._modelOverall).toBe("PASS");
    } else {
      expect(r.stage).toBe("int_lint");   // halted before judging, also correct
    }
  });

  // The crash this test exists for: the CLI passes services.logger as an
  // OBJECT with .info, while every harness here omits it entirely. Calling it
  // as a function passed the whole suite and died on the first real run.
  it("logs the disagreement through a logger object without calling it", async () => {
    const lines = [];
    const { r } = await run({
      lint: [LINT_CLEAN], sim: [SIM_PASS],
      logger: { info: (m) => lines.push(m) },
      llm: { judge: () => ({ overall: "FAIL", score: 12 }) },
    });
    expect(r.ok).toBe(true);
    expect(lines.join("\n")).toMatch(/int_judge.*model said FAIL \(12\/100\).*measured PASS \(100\/100\)/);
  });

  // Both surfaces read this one object. The CLI prints score/overall into its
  // verdict block and the disagreement into its run log; the GUI's int_judge
  // panel renders d.score, d.overall, and the banner from d._scoreDisagreement
  // with d._modelOverall / d._modelScore / d._scoreReasons. Renaming any of
  // them leaves the GUI silently showing nothing, which is precisely how a fix
  // ends up live on one surface and inert on the other.
  it("publishes the exact fields both the CLI and the GUI read", async () => {
    const { r } = await run({
      lint: [LINT_CLEAN], sim: [SIM_PASS],
      llm: { judge: () => ({ overall: "FAIL", score: 12 }) },
    });
    const d = r.judgeData;
    expect(Object.keys(d)).toEqual(expect.arrayContaining([
      "score", "overall", "_scoreComponents", "_scoreReasons",
      "_modelScore", "_modelOverall", "_scoreDisagreement",
    ]));
    expect(typeof d.score).toBe("number");
    expect(["PASS", "FAIL"]).toContain(d.overall);
    expect(Array.isArray(d._scoreReasons)).toBe(true);
    expect(Array.isArray(d._scoreComponents)).toBe(true);
  });

  it("says nothing when the model and the measurements agree", async () => {
    const lines = [];
    const { r } = await run({
      lint: [LINT_CLEAN], sim: [SIM_PASS],
      logger: { info: (m) => lines.push(m) },
      llm: { judge: () => ({ overall: "PASS", score: 100 }) },
    });
    expect(r.judgeData._scoreDisagreement).toBe(false);
    expect(lines.filter((l) => /int_judge/.test(l))).toEqual([]);
  });
});

describe("int_lint fix loop (S3)", () => {
  const TOP_ERR = { stdout: "", stderr: "%Error: top.sv:2:3: syntax error, unexpected ';'\n", exitCode: 1 };

  it("a top-file lint error is fixed inline, re-lints clean, and the fixed top is persisted MERGED", async () => {
    const { r, calls, dispatched } = await run({ lint: [TOP_ERR, LINT_CLEAN], sim: [SIM_PASS] });
    expect(r.ok).toBe(true);
    expect(r.lintData.status).toBe("PASS");
    expect(r.lintData.fixIterations).toBe(1);
    expect(calls.filter((c) => c.kind === "topfix")).toHaveLength(1);
    // the fix prompt carried the real finding
    expect(calls.find((c) => c.kind === "topfix").p.userMessage).toContain("syntax error");
    // persistence: merged over the prior stage-4 slot (clobber lesson)
    const persist = dispatched.find((a) => a.type === "MODULE_STAGE_DATA_SET");
    expect(persist).toMatchObject({ modId: "top", stageId: 4 });
    expect(persist.data.code).toBe(FIXED_TOP);
    expect(persist.data.note).toBe("keep-me");
    expect(persist.data._fixSource).toContain("int_lint");
  });

  it("errors attributed to ONE child's file return a reflowTarget instead of forking a fix", async () => {
    const childErr = { stdout: "", stderr: "%Error-WIDTHEXPAND: cnt.sv:2:5: width mismatch\n", exitCode: 1 };
    const { r, calls } = await run({ lint: [childErr], sim: [SIM_PASS] });
    expect(r).toMatchObject({ ok: false, stage: "int_lint", reflowTarget: "cnt" });
    expect(r.reason).toContain("cnt");
    // evidence rides along for the module's informed re-run
    expect(r.reflowEvidence).toEqual([{ type: "WIDTHEXPAND", msg: "width mismatch" }]);
    expect(calls.filter((c) => c.kind === "topfix")).toHaveLength(0);
  });

  it("structural wiring errors route to top even when Verilator is silent", async () => {
    // Break the planned instance name so checkSystemWiring reports MISSING_INSTANCE.
    const state = reducerState();
    state.instances.u_cnt0.instanceName = "u_ghost";
    const calls = [], dispatched = [];
    const r = await runIntegrationPipeline({
      reducerState: state,
      uiState: { config: CONFIG },
      services: {
        callLLM: llmStub(calls, { topfix: () => ({ code: TOP.replace("u_cnt0", "u_ghost"), fixes: [] }) }),
        extractJSON,
        runCli: cliStub([], [LINT_CLEAN], [SIM_PASS]),
      },
      dispatch: (a) => dispatched.push(a),
    });
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "topfix")).toHaveLength(1);
    expect(r.lintData.fixIterations).toBe(1);
  });

  it("an identical fixed top stalls the loop — errors stand, no infinite spin", async () => {
    const { r, calls } = await run({
      lint: [TOP_ERR], sim: [SIM_PASS],
      llm: { topfix: () => ({ code: TOP, fixes: [] }) },   // model returns the same code
    });
    expect(r).toMatchObject({ ok: false, stage: "int_lint" });
    expect(calls.filter((c) => c.kind === "topfix")).toHaveLength(1);
  });

  it("maxIntegrationIters caps the loop", async () => {
    let n = 0;
    const { r, calls } = await run({
      lint: [TOP_ERR], sim: [SIM_PASS],
      config: { maxIntegrationIters: 1 },
      llm: { topfix: () => ({ code: TOP + "\n// v" + (++n), fixes: [] }) },
    });
    expect(r.ok).toBe(false);
    expect(calls.filter((c) => c.kind === "topfix")).toHaveLength(1);
  });

  it("never fixes against LLM-estimated lint (no backend → halt, zero fix calls)", async () => {
    const calls = [];
    const r = await runIntegrationPipeline({
      reducerState: reducerState(),
      uiState: { config: {} },
      services: {
        callLLM: llmStub(calls, { lint: () => ({ status: "FAIL", issues: [{ type: "NAMING", msg: "bad", sev: "error" }], summary: "fail" }) }),
        extractJSON,
      },
      dispatch: () => {},
    });
    expect(r).toMatchObject({ ok: false, stage: "int_lint" });
    expect(r.reflowTarget).toBeUndefined();
    expect(calls.filter((c) => c.kind === "topfix")).toHaveLength(0);
  });
});

describe("shared-package fix path (S3 gap found live: broken pkg poisoned integration with no fix route)", () => {
  const pkgState = () => Object.assign(reducerState(), { sharedPackage: { name: "sys_pkg", code: PKG } });
  const PKG_ERR = { stdout: "", stderr: "%Error: sys_pkg.sv:1:1: syntax error, unexpected IDENTIFIER\n", exitCode: 1 };

  async function runPkg(opts) {
    const calls = [], cliCalls = [], dispatched = [];
    const r = await runIntegrationPipeline({
      reducerState: pkgState(),
      uiState: { config: Object.assign({}, CONFIG, opts.config) },
      services: { callLLM: llmStub(calls, opts.llm), extractJSON, runCli: cliStub(cliCalls, opts.lint, opts.sim) },
      dispatch: (a) => dispatched.push(a),
    });
    return { r, calls, cliCalls, dispatched };
  }

  it("lint errors in the shared package are fixed inline and the fixed package is persisted MERGED", async () => {
    const { r, calls, cliCalls, dispatched } = await runPkg({ lint: [PKG_ERR, LINT_CLEAN], sim: [SIM_PASS] });
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "pkgfix")).toHaveLength(1);
    expect(calls.find((c) => c.kind === "pkgfix").p.userMessage).toContain("syntax error");
    // the re-lint compiled the FIXED package
    const relint = cliCalls.filter((c) => c.command)[1];
    expect(relint.files["sys_pkg.sv"]).toBe(FIXED_PKG);
    const persist = dispatched.find((a) => a.type === "SHARED_PACKAGE_SET");
    expect(persist.sharedPackage).toMatchObject({ name: "sys_pkg", code: FIXED_PKG });
    expect(persist.sharedPackage._fixSource).toContain("int_lint");
  });

  it("package errors take precedence over child attribution (cascade masking)", async () => {
    const both = { stdout: "", stderr: "%Error: sys_pkg.sv:1:1: syntax error\n%Error: cnt.sv:2:5: cascade error\n", exitCode: 1 };
    const { r, calls } = await runPkg({ lint: [both, LINT_CLEAN], sim: [SIM_PASS] });
    expect(r.ok).toBe(true);
    expect(r.reflowTarget).toBeUndefined();               // no premature child reflow
    expect(calls.filter((c) => c.kind === "pkgfix")).toHaveLength(1);
    // only the package findings went to the fix prompt
    expect(calls.find((c) => c.kind === "pkgfix").p.userMessage).not.toContain("cascade error");
  });

  it("a sim-time compile failure in the shared package routes to the package fix, then re-sims", async () => {
    const compileErr = { stdout: "", stderr: "%Error: sys_pkg.sv:1:1: syntax error\n", exitCode: 1 };
    const { r, calls, dispatched } = await runPkg({ lint: [LINT_CLEAN], sim: [compileErr, SIM_PASS] });
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "triage")).toHaveLength(0);   // deterministic
    expect(calls.filter((c) => c.kind === "pkgfix")).toHaveLength(1);
    const persist = dispatched.find((a) => a.type === "SHARED_PACKAGE_SET");
    expect(persist.sharedPackage._fixSource).toContain("int_test");
  });

  it("an identical fixed package stalls the loop — errors stand", async () => {
    const { r, calls } = await runPkg({
      lint: [PKG_ERR], sim: [SIM_PASS],
      llm: { pkgfix: () => ({ code: PKG, fixes: [] }) },
    });
    expect(r).toMatchObject({ ok: false, stage: "int_lint" });
    expect(calls.filter((c) => c.kind === "pkgfix")).toHaveLength(1);
  });
});

describe("int_test fix loop (S3)", () => {
  it("a semantic sim failure triaged 'tb' gets a TB fix and the re-sim PASSES", async () => {
    const { r, calls, cliCalls } = await run({ lint: [LINT_CLEAN], sim: [SIM_FAIL, SIM_PASS] });
    expect(r.ok).toBe(true);
    expect(r.verData).toMatchObject({ fail: 0, pass: 1, fixIterations: 1 });
    expect(calls.filter((c) => c.kind === "triage")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "tbfix")).toHaveLength(1);
    // the second sim run carried the FIXED testbench
    const simRuns = cliCalls.filter((c) => c.commands);
    expect(simRuns).toHaveLength(2);
    expect(simRuns[1].files["system_tb.sv"]).toBe(FIXED_TB);
    expect(r.tbData.code).toBe(FIXED_TB);
  });

  it("triage naming a child module returns a reflowTarget from int_test", async () => {
    const { r, calls } = await run({
      lint: [LINT_CLEAN], sim: [SIM_FAIL],
      llm: { triage: () => ({ target: "cnt", reason: "counter internals wrong" }) },
    });
    expect(r).toMatchObject({ ok: false, stage: "int_test", reflowTarget: "cnt" });
    expect(calls.filter((c) => c.kind === "tbfix" || c.kind === "topfix")).toHaveLength(0);
    expect(r.verData.fail).toBe(1);   // the measured failure is preserved for the caller
    // evidence: failing tests + the triage verdict
    expect(r.reflowEvidence).toEqual([
      { type: "TEST_FAIL", msg: expect.stringContaining("test_b") },
      { type: "TRIAGE", msg: "counter internals wrong" },
    ]);
  });

  it("garbage triage output degrades to the 'tb' path", async () => {
    const { r, calls } = await run({
      lint: [LINT_CLEAN], sim: [SIM_FAIL, SIM_PASS],
      llm: { triage: () => ({ target: "the testbench, probably", reason: "?" }) },
    });
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "tbfix")).toHaveLength(1);
  });

  it("a TB compile failure routes deterministically by file — no triage call", async () => {
    const compileErr = { stdout: "", stderr: "%Error: system_tb.sv:3:1: syntax error\n", exitCode: 1 };
    const { r, calls } = await run({ lint: [LINT_CLEAN], sim: [compileErr, SIM_PASS] });
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "triage")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "tbfix")).toHaveLength(1);
  });

  it("a child compile failure at sim time returns that module as reflowTarget", async () => {
    const compileErr = { stdout: "", stderr: "%Error: cnt.sv:2:5: syntax error\n", exitCode: 1 };
    const { r, calls } = await run({ lint: [LINT_CLEAN], sim: [compileErr] });
    expect(r).toMatchObject({ ok: false, stage: "int_test", reflowTarget: "cnt" });
    expect(calls.filter((c) => c.kind === "triage")).toHaveLength(0);
  });

  it("triage → 'top' fixes the top and persists it once the sim is clean", async () => {
    const { r, calls, dispatched } = await run({
      lint: [LINT_CLEAN], sim: [SIM_FAIL, SIM_PASS],
      llm: { triage: () => ({ target: "top", reason: "wiring swaps the operands" }) },
    });
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "topfix")).toHaveLength(1);
    const persist = dispatched.find((a) => a.type === "MODULE_STAGE_DATA_SET");
    expect(persist).toBeTruthy();
    expect(persist.data.code).toBe(FIXED_TOP);
    expect(persist.data._fixSource).toContain("int_test");
  });

  it("a marker-less clean sim is treated as a TB defect", async () => {
    const noMarkers = { stdout: "sim done\n", stderr: "", exitCode: 0 };
    const { r, calls } = await run({ lint: [LINT_CLEAN], sim: [noMarkers, SIM_PASS] });
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "triage")).toHaveLength(0);
    const tbfix = calls.find((c) => c.kind === "tbfix");
    expect(tbfix.p.userMessage).toContain("markers");
  });
});

describe("orchestrator reflow consumption (S3)", () => {
  const ACTIVE = [
    { id: 1, key: "elicit" }, { id: 2, key: "spec" }, { id: 3, key: "architect" },
    { id: 4, key: "rtl_generate" }, { id: 5, key: "lint" },
  ];

  function harness(intResults) {
    const state = {
      modules: {
        leaf: { completed: new Set([2, 3, 4, 5]), stageData: { 4: { code: "module leaf_v1; endmodule" } }, imported: false },
        top: { completed: new Set([2, 3, 4, 5]), stageData: { 4: { code: "module top_v1; endmodule" } }, imported: false },
      },
      instances: { i1: { parentModuleId: "top", moduleId: "leaf", instanceName: "u_leaf" } },
      decomposition: { topModule: "top" },
      sharedPackage: null,
    };
    const stageCalls = [];
    let intCalls = 0;
    const services = {
      getState: () => state,
      allStages: ACTIVE,
      pipeline: {},
      runStage: async (a) => { stageCalls.push({ modId: a.targetModId, stageId: a.stageId, trigger: a.trigger, fixContext: a.fixContext || null }); return { ok: true }; },
      runIntegrationPipeline: async () => {
        intCalls++;
        return intResults.length > 1 ? intResults.shift() : intResults[0];
      },
    };
    const runIt = () => runAllPipelines({
      execMode: "full-auto",
      reducerState: state,
      uiState: { userDesc: "sys", config: {}, activeStages: ACTIVE },
      services,
      dispatch: () => {},
    });
    return { runIt, stageCalls, intCalls: () => intCalls };
  }

  it("a reflowTarget re-runs that module from rtl_generate onward and re-integrates", async () => {
    const h = harness([
      { ok: false, stage: "int_lint", reflowTarget: "leaf", reason: "attributed to leaf",
        reflowEvidence: [{ type: "WIDTHEXPAND", msg: "width mismatch" }] },
      { ok: true },
    ]);
    const r = await h.runIt();
    expect(r.ok).toBe(true);
    expect(h.intCalls()).toBe(2);
    // normal walk: leaf 2..5, top 2..5 = 8; reflow: leaf 4,5 only
    expect(h.stageCalls).toHaveLength(10);
    const reflowRuns = h.stageCalls.slice(8);
    expect(reflowRuns.map((c) => ({ modId: c.modId, stageId: c.stageId })))
      .toEqual([{ modId: "leaf", stageId: 4 }, { modId: "leaf", stageId: 5 }]);
    // the system evidence + current code ride into rtl_generate ONLY —
    // downstream stages run normally on the repaired code
    expect(reflowRuns[0].fixContext).toEqual({
      source: "integration",
      findings: [{ type: "WIDTHEXPAND", msg: "width mismatch" }],
      previousCode: "module leaf_v1; endmodule",
    });
    expect(reflowRuns[1].fixContext).toBe(null);
    // reflow re-runs are marked (so CLI skip-completed never suppresses them);
    // the normal walk stays "auto" and never carries a fixContext
    expect(reflowRuns.every((c) => c.trigger === "reflow")).toBe(true);
    expect(h.stageCalls.slice(0, 8).every((c) => c.fixContext === null && c.trigger === "auto")).toBe(true);
    expect(r.modulesCompleted).toBe(2);        // reflow re-run doesn't inflate progress
  });

  it("a reflowTarget without evidence falls back to the reason as the finding", async () => {
    const h = harness([
      { ok: false, stage: "int_test", reflowTarget: "leaf", reason: "sim failure attributed to leaf" },
      { ok: true },
    ]);
    await h.runIt();
    const rtlReflow = h.stageCalls.find((c) => c.fixContext);
    expect(rtlReflow.fixContext.findings).toEqual([{ type: "INTEGRATION", msg: "sim failure attributed to leaf" }]);
  });

  it("reflow rounds are capped by maxIntegrationIters", async () => {
    const h = harness([{ ok: false, stage: "int_lint", reflowTarget: "leaf", reason: "still failing" }]);
    const r = await h.runIt();
    expect(r.ok).toBe(true);                    // integration failure stays non-fatal
    expect(h.intCalls()).toBe(3);               // initial + 2 reflow rounds (default cap)
  });

  it("an unknown reflowTarget stops the loop immediately", async () => {
    const h = harness([{ ok: false, stage: "int_lint", reflowTarget: "ghost", reason: "?" }]);
    await h.runIt();
    expect(h.intCalls()).toBe(1);
    expect(h.stageCalls).toHaveLength(8);       // no reflow re-runs
  });
});
