// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Run-22 robustness fixes (fixture: talk/run22/home/projects).
//
//   • test_review compile-honesty gate — test_review PASSed a TB whose task
//     body was syntax-mangled; lint_test then burned its budget on it and
//     the run ended 0/1. TB mirror of rtl_review's run-21 gate.
//   • budget-halt spares measure entries — four consecutive runs (19–22)
//     exhausted the run budget mid-chain AFTER the LLM regeneration entries
//     but BEFORE the token-free CLI re-measure, leaving repairs unmeasured.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runReflowChain } from "../src/pipeline/reflowRunner.js";

let __lintErrorsByCall = [];

vi.mock("../src/llm/index.js", function() {
  return {
    callLLM: vi.fn(),
    callLLMJson: vi.fn(),
    extractJSON: function(t) { return JSON.parse(t); },
    addRetryHint: function(s) { return s; },
  };
});
vi.mock("../src/cli/index.js", function() {
  return {
    extractInfoEvidence: function() { return {}; },
    runCli: vi.fn(async function() { return { stdout: "", stderr: "__mock__", exitCode: 0 }; }),
    parseCLIOutput: function() {
      return __lintErrorsByCall.length > 0 ? __lintErrorsByCall.shift() : { errors: [], warnings: [] };
    },
    parseTestLine: function() { return null; },
    parseCoverageDat: function() { return {}; },
    CliBackendError: class extends Error {},
  };
});

const { callLLM } = await import("../src/llm/index.js");
const { testReviewNode } = await import("../src/pipeline/nodes/test_review.js");

const llmReply = (json) => ({
  text: JSON.stringify(json), tokensIn: 10, tokensOut: 5, latencyMs: 1,
  model: "m", provider: "p", stopReason: "stop",
});

function reviewSt(extra) {
  return Object.assign({
    rtl_generate: { code: "module fifo(input clk);\nendmodule\n" },
    test_generate: { code: "module fifo_tb;\nendmodule\n" },
    spec: { modName: "fifo", requirements: [], iface: [], params: [] },
    elicit: { modName: "fifo" },
    _config: {
      provider: "openai", model: "m", apiKey: "k", stageSettings: {},
      backendUrl: "http://x", maxTestReviewIters: 2,
    },
    _onLog: vi.fn(),
  }, extra);
}

beforeEach(function() {
  callLLM.mockReset();
  __lintErrorsByCall = [];
});

describe("test_review compile-honesty gate (run 22: PASS on a syntax-broken TB)", function() {
  it("downgrades a PASS verdict when the final TB does not compile", async function() {
    callLLM.mockResolvedValueOnce(llmReply({
      verdict: "PASS", score: 80, issues: [], strengths: [],
      coverage_assessment: {}, infrastructure: {}, summary: "fine",
    }));
    __lintErrorsByCall = [{
      errors: [
        { code: "SYNTAX", msg: "syntax error, unexpected <=", line: 185, file: "fifo_tb.sv" },
        { code: "SYNTAX", msg: "syntax error, unexpected endtask", line: 196, file: "fifo_tb.sv" },
      ], warnings: [],
    }];
    const st = reviewSt();
    const out = await testReviewNode(st);
    expect(out.test_review.verdict).toBe("NEEDS_FIX");
    expect(out.test_review._compileErrors).toBe(2);
    const logs = st._onLog.mock.calls.map(function(c) { return c[0]; }).join("\n");
    expect(logs).toMatch(/TEST REVIEW VERDICT DOWNGRADED/);
  });

  it("ignores RTL-attributed errors (those are not the TB's fault) and honest PASSes stand", async function() {
    callLLM.mockResolvedValueOnce(llmReply({
      verdict: "PASS", score: 85, issues: [], strengths: [],
      coverage_assessment: {}, infrastructure: {}, summary: "fine",
    }));
    __lintErrorsByCall = [{
      errors: [{ code: "SYNTAX", msg: "rtl-side", line: 4, file: "fifo.sv" }], warnings: [],
    }];
    const out = await testReviewNode(reviewSt());
    expect(out.test_review.verdict).toBe("PASS");
  });

  it("abstains without a CLI backend", async function() {
    callLLM.mockResolvedValueOnce(llmReply({
      verdict: "PASS", score: 85, issues: [], strengths: [],
      coverage_assessment: {}, infrastructure: {}, summary: "fine",
    }));
    const st = reviewSt();
    st._config.backendUrl = null;
    const out = await testReviewNode(st);
    expect(out.test_review.verdict).toBe("PASS");
  });
});

describe("budget-halt spares measure entries (runs 19–22: repairs ended unmeasured)", function() {
  function chainSt(invokeNode, over, backendUrl) {
    return {
      _config: { backendUrl: backendUrl === undefined ? "http://x" : backendUrl },
      _onLog: function() {},
      _signal: null,
      _budget: { enabled: true, overWith: function() { return over; } },
      _logger: {
        events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 0, parentStageKey: null, parentIter: null },
      },
      _services: { invokeNode: invokeNode, allStages: [] },
    };
  }
  const CHAIN = [
    { stageId: 7,  stageKey: "test_generate", order: 70, reason: "triage" },
    { stageId: 12, stageKey: "lint_test",     order: 78, reason: "downstream" },
    { stageId: 8,  stageKey: "verify",        order: 80, reason: "always" },
  ];

  it("skips LLM entries but still runs CLI measure entries when the budget is gone", async function() {
    const invoked = [];
    const invokeNode = vi.fn(async function(key) {
      invoked.push(key);
      return { [key]: { status: "FAIL" }, _llms: [] };
    });
    const walk = await runReflowChain({
      chain: CHAIN, st: chainSt(invokeNode, { message: "budget over" }),
      currentState: {}, allLlms: [], appendLog: function() {},
      ownerKey: "verify", ownerIter: 1, parentDepth: 0, strictOnError: false,
    });
    expect(invoked).toEqual(["lint_test", "verify"]);       // test_generate skipped
    expect(walk.chainHistory[0].status).toBe("budget-halted");
    expect(walk.chainHistory[1].status).toBe("ran");
    expect(walk.chainHistory[2].status).toBe("ran");
  });

  it("without a CLI backend nothing runs on an exhausted budget (LLM estimation would spend)", async function() {
    const invokeNode = vi.fn(async function(key) { return { [key]: {}, _llms: [] }; });
    const walk = await runReflowChain({
      chain: CHAIN, st: chainSt(invokeNode, { message: "budget over" }, null),
      currentState: {}, allLlms: [], appendLog: function() {},
      ownerKey: "verify", ownerIter: 1, parentDepth: 0, strictOnError: false,
    });
    expect(invokeNode).not.toHaveBeenCalled();
    expect(walk.chainHistory.every(function(e) { return e.status === "budget-halted"; })).toBe(true);
  });

  it("a healthy budget runs everything as before", async function() {
    const invoked = [];
    const invokeNode = vi.fn(async function(key) { invoked.push(key); return { [key]: {}, _llms: [] }; });
    await runReflowChain({
      chain: CHAIN, st: chainSt(invokeNode, null),
      currentState: {}, allLlms: [], appendLog: function() {},
      ownerKey: "verify", ownerIter: 1, parentDepth: 0, strictOnError: false,
    });
    expect(invoked).toEqual(["test_generate", "lint_test", "verify"]);
  });
});
