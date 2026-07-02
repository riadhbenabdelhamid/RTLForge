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
    else if (/Repair the SYSTEM TESTBENCH/.test(u)) kind = "tbfix";
    else if (/owns the root cause/.test(u)) kind = "triage";
    else if (/system testbench that exercises/i.test(u)) kind = "tb";
    else if (/cross-module integration lint/i.test(u)) kind = "lint";
    else if (/Estimate what would happen|NO real simulator/i.test(u + (p.systemPrompt || ""))) kind = "estimate";
    calls.push({ kind, p });
    const body = o[kind] ? o[kind](p) : {
      tb: { code: TB },
      topfix: { code: FIXED_TOP, fixes: [{ id: "E1", desc: "rewired" }] },
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
    services: { callLLM: llmStub(calls, opts.llm), extractJSON, runCli: cliStub(cliCalls, opts.lint, opts.sim) },
    dispatch: (a) => dispatched.push(a),
  });
  return { r, calls, cliCalls, dispatched };
}

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
        leaf: { completed: new Set([2, 3, 4, 5]), stageData: {}, imported: false },
        top: { completed: new Set([2, 3, 4, 5]), stageData: {}, imported: false },
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
      runStage: async (a) => { stageCalls.push({ modId: a.targetModId, stageId: a.stageId }); return { ok: true }; },
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
      { ok: false, stage: "int_lint", reflowTarget: "leaf", reason: "attributed to leaf" },
      { ok: true },
    ]);
    const r = await h.runIt();
    expect(r.ok).toBe(true);
    expect(h.intCalls()).toBe(2);
    // normal walk: leaf 2..5, top 2..5 = 8; reflow: leaf 4,5 only
    expect(h.stageCalls).toHaveLength(10);
    expect(h.stageCalls.slice(8)).toEqual([{ modId: "leaf", stageId: 4 }, { modId: "leaf", stageId: 5 }]);
    expect(r.modulesCompleted).toBe(2);        // reflow re-run doesn't inflate progress
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
