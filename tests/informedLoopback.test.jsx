// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// informedLoopback — V22-bug-pass-9 Layer E
//
// Pins that K-to-X reflow chains carry failure context across the chain
// boundary so generation nodes (rtl_generate / test_generate) build
// FIX prompts instead of cold regen.
//
// The chain we're testing:
//   1. Owner stage detects failure → builds fixContext
//   2. Owner calls planStageReflow / planReflow with fixContext
//   3. Planner attaches fixContext to the chain's TRIAGE entry
//   4. Runner forwards entry.fixContext onto subState._fixContext
//   5. Generation node sees _fixContext, calls promptXxxFix instead of cold
//
// For each test we spy on the prompt functions to confirm the fix
// variant was used and that it received the expected arguments.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";

// Spy on every prompt builder we care about. The mock returns a benign
// prompt shape; we just want to know WHICH function was called.
const promptSpies = {
  promptRTL:                vi.fn(function() { return { messages: [{ role: "user", content: "cold-rtl" }] }; }),
  promptRTLFix:             vi.fn(function() { return { messages: [{ role: "user", content: "rtl-fix-from-lint" }] }; }),
  promptRTLFromVerifyFail:  vi.fn(function() { return { messages: [{ role: "user", content: "rtl-fix-from-verify" }] }; }),
  promptRTLReviewFix:       vi.fn(function() { return { messages: [{ role: "user", content: "rtl-fix-from-review" }] }; }),
  promptTB:                 vi.fn(function() { return { messages: [{ role: "user", content: "cold-tb" }] }; }),
  promptTBLintFix:          vi.fn(function() { return { messages: [{ role: "user", content: "tb-fix-from-lint" }] }; }),
  promptTBFromVerifyFail:   vi.fn(function() { return { messages: [{ role: "user", content: "tb-fix-from-verify" }] }; }),
  promptTestReviewFix:      vi.fn(function() { return { messages: [{ role: "user", content: "tb-fix-from-review" }] }; }),
};

// Mock the prompts index used by rtl_generate / test_generate / etc.
vi.mock("../src/prompts/index.js", function() {
  return {
    promptRTL: function() { return promptSpies.promptRTL.apply(null, arguments); },
    promptTB:  function() { return promptSpies.promptTB.apply(null, arguments); },
  };
});
vi.mock("../src/prompts/lint.js", function() {
  return {
    promptLint:        function() { return { messages: [] }; },
    promptRTLFix:      function() { return promptSpies.promptRTLFix.apply(null, arguments); },
    promptTBLint:      function() { return { messages: [] }; },
    promptTBLintFix:   function() { return promptSpies.promptTBLintFix.apply(null, arguments); },
  };
});
vi.mock("../src/prompts/verify.js", function() {
  return {
    promptVerify:                function() { return { messages: [] }; },
    promptVerifyTriage:          function() { return { messages: [] }; },
    promptRTLFromVerifyFail:     function() { return promptSpies.promptRTLFromVerifyFail.apply(null, arguments); },
    promptTBFromVerifyFail:      function() { return promptSpies.promptTBFromVerifyFail.apply(null, arguments); },
  };
});
vi.mock("../src/prompts/rtlReview.js", function() {
  return {
    promptRTLReview:    function() { return { messages: [] }; },
    promptRTLReviewFix: function() { return promptSpies.promptRTLReviewFix.apply(null, arguments); },
  };
});
vi.mock("../src/prompts/testReview.js", function() {
  return {
    promptTestReview:    function() { return { messages: [] }; },
    promptTestReviewFix: function() { return promptSpies.promptTestReviewFix.apply(null, arguments); },
  };
});

// Mock callLLM to return a valid JSON envelope
vi.mock("../src/llm/index.js", function() {
  return {
    callLLM: vi.fn(async function(p) {
      return {
        text: JSON.stringify({ code: "module fixed; endmodule" }),
        tokensIn: 10, tokensOut: 5, latencyMs: 1, model: "stub", provider: "stub",
      };
    }),
    extractJSON: function(t) { return JSON.parse(t); },
    addRetryHint: function() {},
  };
});

// Mock applySkillsToPrompt to pass through
vi.mock("../src/pipeline/applySkillsToPrompt.js", function() {
  return {
    applySkillsToPrompt: async function(p) { return p; },
  };
});

// Mock getStageConfig
vi.mock("../src/constants/index.js", async function() {
  const actual = await vi.importActual("../src/constants/index.js");
  return Object.assign({}, actual, {
    getStageConfig: function() { return { _maxTokens: 1000 }; },
  });
});

const { rtlGenerateNode } = await import("../src/pipeline/nodes/rtl_generate.js");
const { testGenerateNode } = await import("../src/pipeline/nodes/test_generate.js");

beforeEach(function() {
  // Clear all spies between tests
  Object.values(promptSpies).forEach(function(s) { s.mockClear(); });
});

// ─── rtl_generate FIX-prompt branching ─────────────────────────────────
describe("rtl_generate informed loopback (V22-bug-pass-9 E)", function() {
  it("no _fixContext → cold promptRTL", async function() {
    const st = {
      architect: {}, spec: {}, elicit: {},
      _config: {},
      _onLog: function() {},
    };
    await rtlGenerateNode(st);
    expect(promptSpies.promptRTL).toHaveBeenCalledTimes(1);
    expect(promptSpies.promptRTLFix).not.toHaveBeenCalled();
  });

  it("source='lint' + lintResult → promptRTLFix with code + lintResult", async function() {
    const lintResult = { errors: [{ code: "WIDTH", msg: "x" }], warnings: [] };
    const st = {
      architect: {}, spec: {}, elicit: { modName: "m" },
      _config: {}, _onLog: function() {},
      _fixContext: {
        source: "lint", ownerIter: 1,
        previousCode: "module prev; endmodule",
        previousFixes: [],
        lintResult: lintResult,
      },
    };
    await rtlGenerateNode(st);
    expect(promptSpies.promptRTLFix).toHaveBeenCalledTimes(1);
    expect(promptSpies.promptRTL).not.toHaveBeenCalled();
    const args = promptSpies.promptRTLFix.mock.calls[0];
    expect(args[0]).toBe("module prev; endmodule");  // code
    expect(args[1]).toBe(lintResult);                 // lintResult
  });

  it("source='verify' + verifyResult → promptRTLFromVerifyFail", async function() {
    const verifyResult = { sim: "verilator", total: 5, pass: 3, fail: 2, tests: [] };
    const st = {
      architect: {}, spec: { modName: "x" }, elicit: { modName: "m" },
      _config: {}, _onLog: function() {},
      _fixContext: {
        source: "verify", ownerIter: 1,
        previousCode: "module v; endmodule",
        previousFixes: [],
        verifyResult: verifyResult,
      },
    };
    await rtlGenerateNode(st);
    expect(promptSpies.promptRTLFromVerifyFail).toHaveBeenCalledTimes(1);
    expect(promptSpies.promptRTL).not.toHaveBeenCalled();
  });

  it("source='rtl_review' + reviewResult → promptRTLReviewFix", async function() {
    const reviewResult = { verdict: "NEEDS_FIX", issues: [{ severity: "critical" }] };
    const st = {
      architect: {}, spec: {}, elicit: {},
      _config: {}, _onLog: function() {},
      _fixContext: {
        source: "rtl_review", ownerIter: 1,
        previousCode: "module r; endmodule",
        reviewResult: reviewResult,
      },
    };
    await rtlGenerateNode(st);
    expect(promptSpies.promptRTLReviewFix).toHaveBeenCalledTimes(1);
    expect(promptSpies.promptRTL).not.toHaveBeenCalled();
  });

  it("source='judge' with verifyResult → promptRTLFromVerifyFail (judge-via-verify path)", async function() {
    const verifyResult = { sim: "verilator", total: 5, pass: 3, fail: 2 };
    const st = {
      architect: {}, spec: {}, elicit: {},
      _config: {}, _onLog: function() {},
      _fixContext: {
        source: "judge", ownerIter: 2,
        previousCode: "module j; endmodule",
        verifyResult: verifyResult,
        judgeVerdict: { failingIds: ["REQ-1"] },
      },
    };
    await rtlGenerateNode(st);
    expect(promptSpies.promptRTLFromVerifyFail).toHaveBeenCalledTimes(1);
  });

  it("source='judge' WITHOUT verifyResult → promptRTLFix with synthesized lint from failingIds", async function() {
    const st = {
      architect: {}, spec: {}, elicit: {},
      _config: {}, _onLog: function() {},
      _fixContext: {
        source: "judge", ownerIter: 2,
        previousCode: "module j; endmodule",
        verifyResult: null,
        judgeVerdict: { failingIds: ["REQ-FUNC-001", "REQ-TIM-003"] },
      },
    };
    await rtlGenerateNode(st);
    expect(promptSpies.promptRTLFix).toHaveBeenCalledTimes(1);
    // Synthesized lint result has one error per failing ID
    const args = promptSpies.promptRTLFix.mock.calls[0];
    const synthLint = args[1];
    expect(synthLint.errors).toHaveLength(2);
    expect(synthLint.errors[0].code).toBe("REQ-FUNC-001");
  });

  it("unknown source → falls back to cold promptRTL (defensive)", async function() {
    const st = {
      architect: {}, spec: {}, elicit: {},
      _config: {}, _onLog: function() {},
      _fixContext: { source: "unknown", ownerIter: 1 },
    };
    await rtlGenerateNode(st);
    expect(promptSpies.promptRTL).toHaveBeenCalledTimes(1);
    expect(promptSpies.promptRTLFix).not.toHaveBeenCalled();
  });

  it("LLM event stage label includes @fix:<source> for traceability", async function() {
    const st = {
      architect: {}, spec: {}, elicit: {},
      _config: {}, _onLog: function() {},
      _fixContext: {
        source: "lint", ownerIter: 1,
        previousCode: "m", previousFixes: [],
        lintResult: { errors: [], warnings: [] },
      },
    };
    const result = await rtlGenerateNode(st);
    expect(result._llm.stage).toBe("rtl_generate@fix:lint");
  });
});

// ─── test_generate FIX-prompt branching ────────────────────────────────
describe("test_generate informed loopback (V22-bug-pass-9 E)", function() {
  it("no _fixContext → cold promptTB", async function() {
    const st = {
      spec: {}, elicit: {}, rtl_generate: { code: "module r; endmodule" },
      _config: {}, _onLog: function() {},
    };
    await testGenerateNode(st);
    expect(promptSpies.promptTB).toHaveBeenCalledTimes(1);
    expect(promptSpies.promptTBLintFix).not.toHaveBeenCalled();
  });

  it("source='lint_test' + lintResult → promptTBLintFix", async function() {
    const lintResult = { errors: [{ code: "X" }], warnings: [] };
    const st = {
      spec: {}, elicit: {}, rtl_generate: { code: "module r; endmodule" },
      _config: {}, _onLog: function() {},
      _fixContext: {
        source: "lint_test", ownerIter: 1,
        previousCode: "module prev_tb; endmodule",
        previousFixes: [],
        lintResult: lintResult,
      },
    };
    await testGenerateNode(st);
    expect(promptSpies.promptTBLintFix).toHaveBeenCalledTimes(1);
    expect(promptSpies.promptTB).not.toHaveBeenCalled();
  });

  it("source='verify' + verifyResult → promptTBFromVerifyFail", async function() {
    const verifyResult = { sim: "verilator", fail: 1, total: 1, tests: [] };
    const st = {
      spec: {}, elicit: {}, rtl_generate: { code: "m" },
      _config: {}, _onLog: function() {},
      _fixContext: {
        source: "verify", ownerIter: 1,
        previousCode: "module tb_v; endmodule",
        previousFixes: [],
        verifyResult: verifyResult,
      },
    };
    await testGenerateNode(st);
    expect(promptSpies.promptTBFromVerifyFail).toHaveBeenCalledTimes(1);
  });

  it("source='test_review' + reviewResult → promptTestReviewFix", async function() {
    const reviewResult = { verdict: "NEEDS_FIX", issues: [{ severity: "major" }] };
    const st = {
      spec: {}, elicit: {}, rtl_generate: { code: "m" },
      _config: {}, _onLog: function() {},
      _fixContext: {
        source: "test_review", ownerIter: 1,
        previousCode: "module tb_r; endmodule",
        reviewResult: reviewResult,
      },
    };
    await testGenerateNode(st);
    expect(promptSpies.promptTestReviewFix).toHaveBeenCalledTimes(1);
  });

  it("source='judge' with verifyResult → promptTBFromVerifyFail", async function() {
    const verifyResult = { sim: "verilator", fail: 1, total: 1 };
    const st = {
      spec: {}, elicit: {}, rtl_generate: { code: "m" },
      _config: {}, _onLog: function() {},
      _fixContext: {
        source: "judge", ownerIter: 2,
        previousCode: "module tb_j; endmodule",
        previousFixes: [],
        verifyResult: verifyResult,
      },
    };
    await testGenerateNode(st);
    expect(promptSpies.promptTBFromVerifyFail).toHaveBeenCalledTimes(1);
  });

  it("source='judge' WITHOUT verifyResult → cold regen (no TB-only judge fix prompt)", async function() {
    const st = {
      spec: {}, elicit: {}, rtl_generate: { code: "m" },
      _config: {}, _onLog: function() {},
      _fixContext: {
        source: "judge", ownerIter: 2,
        previousCode: "m_tb",
        verifyResult: null,
        judgeVerdict: { failingIds: ["REQ-1"] },
      },
    };
    await testGenerateNode(st);
    expect(promptSpies.promptTB).toHaveBeenCalledTimes(1);
  });
});

// ─── Planner: fixContext attached to triage entry only ─────────────────
describe("planner: fixContext attaches to triage entry only (V22-bug-pass-9 E)", function() {
  it("planStageReflow with fixContext: triage entry carries it, others don't", async function() {
    const { planStageReflow } = await import("../src/pipeline/reflowPlanner.js");
    const { getReflowTail } = await import("../src/constants/stages.js");
    const stages = [
      { id: 4,  key: "rtl_generate", order: 40 },
      { id: 10, key: "rtl_review",   order: 45 },
      { id: 6,  key: "lint",         order: 60 },
    ];
    const tail = getReflowTail("lint", stages);
    const ctx = { source: "lint", ownerIter: 1, previousCode: "m", lintResult: { errors: [], warnings: [] } };
    const chain = planStageReflow({
      ownerKey: "lint", tail: tail, state: {}, mode: "strict",
      fixContext: ctx,
    });
    expect(chain[0].stageKey).toBe("rtl_generate");
    expect(chain[0].reason).toBe("triage");
    expect(chain[0].fixContext).toBe(ctx);  // SAME ref
    // Other entries don't carry fixContext
    expect(chain[1].fixContext).toBeUndefined();
    expect(chain[2].fixContext).toBeUndefined();
  });

  it("planReflow (judge entry point) attaches fixContext to triage entry", async function() {
    const { planReflow } = await import("../src/pipeline/reflowPlanner.js");
    const stages = [
      { id: 4, key: "rtl_generate", order: 40 },
      { id: 6, key: "lint",         order: 60 },
      { id: 8, key: "verify",       order: 80 },
      { id: 9, key: "judge",        order: 90 },
    ];
    const ctx = {
      source: "judge", ownerIter: 1, previousCode: "m",
      verifyResult: { sim: "x" }, judgeVerdict: { failingIds: ["R1"] },
    };
    const chain = planReflow({
      triageTarget: "rtl_generate", activeStages: stages, state: {},
      mode: "strict", fixContext: ctx,
    });
    expect(chain[0].fixContext).toBe(ctx);
    // gating "always" entries (verify, judge) don't carry it
    expect(chain.find(function(c) { return c.stageKey === "verify"; }).fixContext).toBeUndefined();
    expect(chain.find(function(c) { return c.stageKey === "judge"; }).fixContext).toBeUndefined();
  });

  it("planner with NO fixContext: chain has no fixContext fields", async function() {
    const { planReflow } = await import("../src/pipeline/reflowPlanner.js");
    const stages = [
      { id: 4, key: "rtl_generate", order: 40 },
      { id: 9, key: "judge",        order: 90 },
    ];
    const chain = planReflow({
      triageTarget: "rtl_generate", activeStages: stages, state: {}, mode: "strict",
    });
    chain.forEach(function(c) {
      expect(c.fixContext).toBeUndefined();
    });
  });
});

// ─── Runner: forwards entry.fixContext onto subState._fixContext ───────
describe("runner: forwards fixContext onto subState (V22-bug-pass-9 E)", function() {
  it("triage entry's invokeNode call sees subState._fixContext", async function() {
    const { runReflowChain } = await import("../src/pipeline/reflowRunner.js");
    let observedFixContext = null;
    const st = {
      _config: {},
      _onLog: function() {}, _onLoopback: function() {}, _signal: null,
      _logger: {
        events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 0, parentStageKey: null, parentIter: null },
      },
      _services: {
        invokeNode: async function(stageKey, subState) {
          if (stageKey === "rtl_generate") {
            observedFixContext = subState._fixContext;
          }
          return { [stageKey]: {}, _llms: [] };
        },
      },
    };
    const ctx = { source: "lint", ownerIter: 1, lintResult: { errors: [], warnings: [] } };
    const chain = [
      { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage", fixContext: ctx },
      { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
    ];
    await runReflowChain({
      chain, st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    expect(observedFixContext).toBe(ctx);
  });

  it("non-triage entry's invokeNode call sees null _fixContext", async function() {
    const { runReflowChain } = await import("../src/pipeline/reflowRunner.js");
    let observedAtLint = "unset";
    const st = {
      _config: {},
      _onLog: function() {}, _onLoopback: function() {}, _signal: null,
      _logger: {
        events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 0, parentStageKey: null, parentIter: null },
      },
      _services: {
        invokeNode: async function(stageKey, subState) {
          if (stageKey === "lint") {
            observedAtLint = subState._fixContext;
          }
          return { [stageKey]: {}, _llms: [] };
        },
      },
    };
    const ctx = { source: "lint", ownerIter: 1 };
    const chain = [
      { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage", fixContext: ctx },
      { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
    ];
    await runReflowChain({
      chain, st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    expect(observedAtLint).toBe(null);
  });
});
