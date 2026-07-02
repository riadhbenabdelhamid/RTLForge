// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// SoC roadmap S1+S4: real integration lint + sim (measured verdicts) with the
// LLM path as the no-backend fallback, and interface-view prompts.

import { describe, it, expect } from "vitest";
import { runIntegrationPipeline } from "../src/projectState/runIntegrationPipeline.js";
import { extractJSON } from "../src/llm/index.js";

const CHILD = "module cnt #(parameter W=8)(input logic clk, output logic [W-1:0] q);\n  always_ff @(posedge clk) q <= q + 1;\nendmodule";
const TOP = "module top(input logic clk, output logic [7:0] q);\n  cnt #(.W(8)) u_cnt0 (.clk(clk), .q(q));\nendmodule";

function reducerState() {
  return {
    modules: {
      top: { contentHash: "h1", stageData: { 2: { iface: [], params: [], requirements: [] }, 4: { code: TOP }, 9: { overall: "PASS", score: 90 } } },
      cnt: { contentHash: "h2", stageData: { 4: { code: CHILD }, 9: { overall: "PASS", score: 88 } } },
    },
    instances: { u_cnt0: { instanceName: "u_cnt0", moduleId: "cnt", parentId: "top", paramOverrides: { W: 8 } } },
    decomposition: { topModule: "top", interconnects: [] },
    sharedPackage: null,
  };
}

function llmStub(calls) {
  return async (p) => {
    calls.push(p);
    if (/system-level testbench|SYSTEM TESTBENCH|testbench/i.test(p.userMessage || "")) {
      return { text: JSON.stringify({ code: "module system_tb; endmodule" }), tokensIn: 1, tokensOut: 1, latencyMs: 1 };
    }
    if (/integration lint|cross-module/i.test(p.userMessage || "")) {
      return { text: JSON.stringify({ status: "PASS", issues: [], summary: "llm lint" }), tokensIn: 1, tokensOut: 1, latencyMs: 1 };
    }
    if (/Estimate what would happen|NO real simulator/i.test((p.userMessage || "") + (p.systemPrompt || ""))) {
      return { text: JSON.stringify({ sim: "est", total: 1, pass: 1, fail: 0, tests: [] }), tokensIn: 1, tokensOut: 1, latencyMs: 1 };
    }
    return { text: JSON.stringify({ overall: "PASS", score: 90, summary: "ok" }), tokensIn: 1, tokensOut: 1, latencyMs: 1 };
  };
}

describe("real integration lint + sim (S1)", () => {
  it("with a backend, lint and sim are MEASURED via runCli — no LLM lint/estimate calls", async () => {
    const llmCalls = [];
    const cliCalls = [];
    const runCliStub = async (backendUrl, payload) => {
      cliCalls.push(payload);
      if (payload.command && /lint-only/.test(payload.command)) {
        return { stdout: "", stderr: "%Warning-UNUSEDSIGNAL: top.sv:2:3: Signal is not used: 'x'\n", exitCode: 0 };
      }
      return { stdout: "[PASS] test_a @10 cycles\n[FAIL] test_b @20 cycles\n[SUMMARY] passes=1 fails=1\n", stderr: "", exitCode: 1 };
    };
    const dispatched = [];
    const r = await runIntegrationPipeline({
      reducerState: reducerState(),
      // maxIntegrationIters 0: this test measures the S1 verdicts themselves;
      // the S3 fix loop has its own suite (integrationFixLoop.test.js).
      uiState: { config: { backendUrl: "local", provider: "lmstudio", maxIntegrationIters: 0, lintCmd: "verilator --lint-only -Wall {RTL}", simCmds: "verilator --binary {RTL} {TB} -o {RTL}.sim\n./obj_dir/system.sim" } },
      services: { callLLM: llmStub(llmCalls), extractJSON, runCli: runCliStub },
      dispatch: (a) => dispatched.push(a),
    });
    expect(r.ok).toBe(true);
    expect(r.lintData.cli).toBe(true);
    expect(r.lintData.status).toBe("PASS");                       // warnings only
    expect(r.lintData.issues).toHaveLength(1);
    expect(r.verData).toMatchObject({ cli: true, pass: 1, fail: 1, total: 2 });
    // lint files: package absent, child + top present, top LAST
    expect(Object.keys(cliCalls[0].files)).toEqual(["cnt.sv", "top.sv"]);
    // sim command expanded: file list + system_tb + fixed -o name
    expect(cliCalls[1].commands[0]).toContain("cnt.sv top.sv system_tb.sv");
    expect(cliCalls[1].commands[0]).toContain("-o system.sim");
    // LLM used ONLY for TB + judge (no lint prompt, no verify estimate)
    expect(llmCalls).toHaveLength(2);
  });

  it("without a backend, the LLM fallback path is unchanged (4 calls incl. estimate)", async () => {
    const llmCalls = [];
    const r = await runIntegrationPipeline({
      reducerState: reducerState(),
      uiState: { config: {} },
      services: { callLLM: llmStub(llmCalls), extractJSON },
      dispatch: () => {},
    });
    expect(r.ok).toBe(true);
    expect(r.lintData.cli).toBeUndefined();
    expect(llmCalls).toHaveLength(4);                              // lint, tb, estimate, judge
  });

  it("interface views (S4): the LLM lint prompt carries headers, not child bodies", async () => {
    const llmCalls = [];
    await runIntegrationPipeline({
      reducerState: reducerState(),
      uiState: { config: {} },
      services: { callLLM: llmStub(llmCalls), extractJSON },
      dispatch: () => {},
    });
    const lintPrompt = llmCalls.find((p) => /CHILD MODULE INTERFACES/.test(p.userMessage || ""));
    expect(lintPrompt).toBeTruthy();
    expect(lintPrompt.userMessage).toContain("module cnt #(parameter W=8)");   // header present
    expect(lintPrompt.userMessage).not.toContain("q <= q + 1");                // body withheld
  });
});
