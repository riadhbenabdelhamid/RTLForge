// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Run-21 robustness fixes (fixtures: talk/run21/home*/projects checkpoints).
//
//   • rtl_review compile-honesty gate — the review concluded PASS 82 on code
//     with 9 SYNTAX ERRORS (the relative lint gate only rejects candidates
//     worse than what they replace). A PASS verdict now faces the compiler.
//   • lint_test RTL-errors-only short-circuit — 39 minutes regenerating the
//     TESTBENCH while all 9 errors named sync_fifo.sv.
//   (chain transport retry is pinned by reflowTransportRetry.test.js; the
//   judge compile-filename triage by pipelineNodes.integration.test.js)
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";

let __lintErrorsByCall = [];   // queue of parseCLIOutput results
let __cliCalls = [];

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
    runCli: vi.fn(async function(url, payload) {
      __cliCalls.push(payload);
      return { stdout: "", stderr: "__mock__", exitCode: 0 };
    }),
    parseCLIOutput: function() {
      return __lintErrorsByCall.length > 0 ? __lintErrorsByCall.shift() : { errors: [], warnings: [] };
    },
    parseTestLine: function() { return null; },
    parseCoverageDat: function() { return {}; },
    CliBackendError: class extends Error {},
  };
});

const { callLLM } = await import("../src/llm/index.js");
const { rtlReviewNode } = await import("../src/pipeline/nodes/rtl_review.js");
const { lintTestNode } = await import("../src/pipeline/nodes/lint_test.js");

const llmReply = (json) => ({
  text: JSON.stringify(json), tokensIn: 10, tokensOut: 5, latencyMs: 1,
  model: "m", provider: "p", stopReason: "stop",
});

function baseSt(extra) {
  return Object.assign({
    rtl_generate: { code: "module fifo(input clk);\nendmodule\n" },
    test_generate: { code: "module fifo_tb;\nendmodule\n" },
    spec: { modName: "fifo", requirements: [], iface: [], params: [] },
    architect: {},
    elicit: { modName: "fifo" },
    _config: {
      provider: "openai", model: "m", apiKey: "k", stageSettings: {},
      backendUrl: "http://x", maxRtlReviewIters: 2, maxLintIters: 2,
    },
    _onLog: vi.fn(),
  }, extra);
}

beforeEach(function() {
  callLLM.mockReset();
  __lintErrorsByCall = [];
  __cliCalls = [];
});

describe("rtl_review compile-honesty gate (run 21: PASS 82 on 9 syntax errors)", function() {
  it("downgrades a PASS verdict when the final code does not compile", async function() {
    callLLM.mockResolvedValueOnce(llmReply({
      verdict: "PASS", score: 82, issues: [], strengths: [], summary: "looks great",
    }));
    // The gate's lintErrorCount call sees 9 errors.
    __lintErrorsByCall = [{ errors: new Array(9).fill({ code: "SYNTAX", msg: "syntax error" }), warnings: [] }];
    const st = baseSt();
    const out = await rtlReviewNode(st);
    expect(out.rtl_review.verdict).toBe("NEEDS_FIX");
    expect(out.rtl_review._compileErrors).toBe(9);
    expect(out.rtl_review.summary).toMatch(/compile-honesty gate/);
    const logs = st._onLog.mock.calls.map(function(c) { return c[0]; }).join("\n");
    expect(logs).toMatch(/VERDICT DOWNGRADED/);
  });

  it("leaves an honest PASS on compiling code untouched", async function() {
    callLLM.mockResolvedValueOnce(llmReply({
      verdict: "PASS", score: 90, issues: [], strengths: [], summary: "clean",
    }));
    __lintErrorsByCall = [{ errors: [], warnings: [] }];
    const out = await rtlReviewNode(baseSt());
    expect(out.rtl_review.verdict).toBe("PASS");
    expect(out.rtl_review._compileErrors).toBeUndefined();
  });

  it("abstains without a CLI backend (no false downgrades)", async function() {
    callLLM.mockResolvedValueOnce(llmReply({
      verdict: "PASS", score: 85, issues: [], strengths: [], summary: "s",
    }));
    const st = baseSt();
    st._config.backendUrl = null;
    const out = await rtlReviewNode(st);
    expect(out.rtl_review.verdict).toBe("PASS");
  });
});

describe("lint_test RTL-errors-only short-circuit (run 21: 39 min of TB churn)", function() {
  const rtlErr = function(n) {
    return { errors: new Array(n).fill(0).map(function(_, i) {
      return { code: "SYNTAX", msg: "syntax error " + i, line: 47 + i, file: "fifo.sv" };
    }), warnings: [] };
  };

  it("breaks out at iteration 1 with zero fix LLM calls when every error names the RTL", async function() {
    __lintErrorsByCall = [rtlErr(9)];
    const st = baseSt();
    const out = await lintTestNode(st);
    expect(out.lint_test.status).toBe("FAIL");
    expect(out.lint_test._rtlErrorsOnly).toBe(true);
    expect(out.lint_test.iteration).toBe(1);
    expect(callLLM).not.toHaveBeenCalled();     // no TB fix churn
    const logs = st._onLog.mock.calls.map(function(c) { return c[0]; }).join("\n");
    expect(logs).toMatch(/ERRORS ARE IN THE RTL, NOT THE TB/);
  });

  it("keeps the fix loop when any error names the TB (or lacks attribution)", async function() {
    const mixed = rtlErr(2);
    mixed.errors.push({ code: "SYNTAX", msg: "tb error", line: 3, file: "fifo_tb.sv" });
    // iter-1 lint, then the loop proceeds to fix; give the recheck a clean
    // result so the loop converges quickly.
    __lintErrorsByCall = [mixed, { errors: [], warnings: [] }, { errors: [], warnings: [] }];
    callLLM.mockResolvedValue(llmReply({ code: "module fifo_tb; // v2\nendmodule", fixes: [] }));
    const out = await lintTestNode(baseSt());
    expect(out.lint_test._rtlErrorsOnly).toBeUndefined();
    expect(callLLM).toHaveBeenCalled();          // fix loop engaged
  });
});
