// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// ownerFixContext — V22-bug-pass-9 Layer E
//
// For each loopback-capable owner (lint, lint_test, verify, rtl_review,
// test_review, judge), confirm that when the owner triggers its K-to-X
// reflow it attaches a fixContext to the chain's triage entry with the
// expected shape — so the chain's regen call is INFORMED instead of cold.
//
// We exercise each owner with a stubbed invokeNode that captures the
// subState._fixContext seen by the triage entry's invocation.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";

// CLI / LLM stubs (kept simple — these tests focus on the chain path,
// not the internal fix-loop behavior we already tested in D.3)
let __cliCallCount = 0;
let __llmResponses = [];

vi.mock("../src/llm/index.js", function() {
  return {
    callLLM: vi.fn(async function() {
      if (__llmResponses.length > 0) return __llmResponses.shift();
      return {
        text: JSON.stringify({
          verdict: "NEEDS_FIX", score: 4,
          issues: [{ severity: "critical", description: "x" }],
          code: "module fix; endmodule",
          fixes: [],
          target: "rtl_generate", reason: "default",
        }),
        tokensIn: 10, tokensOut: 5, latencyMs: 1, model: "stub", provider: "stub",
      };
    }),
    extractJSON: function(t) { return JSON.parse(t); },
  };
});

vi.mock("../src/cli/index.js", function() {
  return {
    runCli: vi.fn(async function() {
      __cliCallCount++;
      if (__cliCallCount === 1) {
        return { stdout: "", stderr: "%Error-WIDTH: line 5: x", exitCode: 1 };
      }
      return { stdout: "TEST_PASS t cycles=10 ms=1", stderr: "", exitCode: 0 };
    }),
    parseCLIOutput: function(stderr) {
      if (/%Error/.test(stderr || "")) {
        return { errors: [{ code: "WIDTH", msg: "x", line: 5 }], warnings: [] };
      }
      return { errors: [], warnings: [] };
    },
    parseTestLine: function(l) {
      const m = /TEST_PASS (\w+) cycles=(\d+) ms=(\d+)/.exec(l);
      if (!m) return null;
      return { name: m[1], status: "PASS", cyc: +m[2], ms: +m[3] };
    },
    parseCoverageDat: function() { return { line: 100, branch: 100, toggle: 100 }; },
    CliBackendError: class CliBackendError extends Error {},
  };
});

const lintModule       = await import("../src/pipeline/nodes/lint.js");
const lintTestModule   = await import("../src/pipeline/nodes/lint_test.js");
const verifyModule     = await import("../src/pipeline/nodes/verify.js");
const rtlReviewModule  = await import("../src/pipeline/nodes/rtl_review.js");
const testReviewModule = await import("../src/pipeline/nodes/test_review.js");
const judgeModule      = await import("../src/pipeline/nodes/judge.js");

beforeEach(function() {
  __cliCallCount = 0;
  __llmResponses = [];
});

function baseSt(overrides) {
  return Object.assign({
    rtl_generate: { code: "module orig_rtl; endmodule" },
    test_generate: { code: "module orig_tb; endmodule" },
    spec: { modName: "orig", requirements: [], iface: [], params: [] },
    architect: {},
    elicit: { modName: "orig" },
    _config: {
      maxLintIters: 2, maxVerifyIters: 2,
      maxRtlReviewIters: 2, maxTestReviewIters: 2, maxJudgeIters: 2,
      backendUrl: "http://x",
      lintCmd: "verilator --lint-only {RTL}",
      simCmds: "verilator --binary {RTL} {TB}",
      strictCli: false,
      lintReflowMode: "smart",
      lintTestReflowMode: "smart",
      verifyReflowMode: "smart",
      rtlReviewReflowMode: "smart",
      testReviewReflowMode: "smart",
      judgeReflowMode: "smart",
      _testTriageTarget: "rtl_generate",  // pin judge triage
    },
    _onLog: function() {},
    _signal: null,
    _logger: {
      events: [],
      state: function() {}, llm: function() {}, cli: function() {},
      skill: function() {}, prompt: function() {}, result: function() {},
      context: { depth: 0, parentStageKey: null, parentIter: null },
    },
  }, overrides);
}

function defaultActiveStages() {
  return [
    { id: 4,  key: "rtl_generate",  order: 40 },
    { id: 10, key: "rtl_review",    order: 45 },
    { id: 6,  key: "lint",          order: 60 },
    { id: 5,  key: "formal_props",  order: 65 },
    { id: 7,  key: "test_generate", order: 70 },
    { id: 11, key: "test_review",   order: 75 },
    { id: 12, key: "lint_test",     order: 78 },
    { id: 8,  key: "verify",        order: 80 },
    { id: 9,  key: "judge",         order: 90 },
  ];
}

function makeCapturingInvokeNode(captured) {
  // Returns an invokeNode that records subState._fixContext per stageKey.
  return async function(stageKey, subState) {
    captured.push({ stageKey: stageKey, fixContext: subState._fixContext });
    if (stageKey === "verify") {
      return {
        verify: {
          sim: "mock", total: 1, pass: 1, fail: 0,
          cov: { line: 100, branch: 100, toggle: 100 },
          tests: [{ name: "t", st: "PASS" }], log: "", cli: true,
        },
        _llms: [],
      };
    }
    if (stageKey === "rtl_generate") {
      return { rtl_generate: { code: "module regen; endmodule" }, _llms: [] };
    }
    if (stageKey === "test_generate") {
      return { test_generate: { code: "module regen_tb; endmodule" }, _llms: [] };
    }
    if (stageKey === "rtl_review") {
      return { rtl_review: { verdict: "PASS", score: 9, issues: [] }, _llms: [] };
    }
    if (stageKey === "test_review") {
      return { test_review: { verdict: "PASS", score: 9, issues: [] }, _llms: [] };
    }
    if (stageKey === "lint") {
      return { lint: { status: "PASS", errors: [], warnings: [] }, _llms: [] };
    }
    if (stageKey === "lint_test") {
      return { lint_test: { status: "PASS", errors: [], warnings: [] }, _llms: [] };
    }
    if (stageKey === "judge") {
      return {};  // judge re-runs as gating; just return empty
    }
    return { [stageKey]: {}, _llms: [] };
  };
}

// ─── lint owner ────────────────────────────────────────────────────────
describe("lint owner attaches fixContext (V22-bug-pass-9 E)", function() {
  it("triage entry's invocation sees source='lint' + lintResult + previousCode", async function() {
    const captured = [];
    const st = baseSt({
      _services: {
        invokeNode: makeCapturingInvokeNode(captured),
        allStages: defaultActiveStages(),
      },
    });
    await lintModule.lintNode(st);
    // First capture should be rtl_generate (chain's triage entry)
    expect(captured[0].stageKey).toBe("rtl_generate");
    const ctx = captured[0].fixContext;
    expect(ctx).toBeTruthy();
    expect(ctx.source).toBe("lint");
    expect(ctx.previousCode).toBe("module orig_rtl; endmodule");
    expect(ctx.lintResult).toBeDefined();
    expect(Array.isArray(ctx.lintResult.errors)).toBe(true);
    expect(ctx.lintResult.errors.length).toBeGreaterThan(0);
  });

  it("non-triage entries see _fixContext = null", async function() {
    const captured = [];
    const st = baseSt({
      _services: {
        invokeNode: makeCapturingInvokeNode(captured),
        allStages: defaultActiveStages(),
      },
    });
    await lintModule.lintNode(st);
    // Subsequent entries (rtl_review, lint at chain tail) must NOT see fixContext
    const subsequent = captured.slice(1);
    subsequent.forEach(function(c) {
      expect(c.fixContext).toBe(null);
    });
  });
});

// ─── lint_test owner ──────────────────────────────────────────────────
describe("lint_test owner attaches fixContext", function() {
  it("triage entry test_generate sees source='lint_test' + lintResult", async function() {
    const captured = [];
    const st = baseSt({
      _services: {
        invokeNode: makeCapturingInvokeNode(captured),
        allStages: defaultActiveStages(),
      },
    });
    await lintTestModule.lintTestNode(st);
    expect(captured[0].stageKey).toBe("test_generate");
    const ctx = captured[0].fixContext;
    expect(ctx).toBeTruthy();
    expect(ctx.source).toBe("lint_test");
    expect(ctx.previousCode).toBe("module orig_tb; endmodule");
    expect(ctx.lintResult.errors.length).toBeGreaterThan(0);
  });
});

// ─── verify owner ─────────────────────────────────────────────────────
describe("verify owner attaches fixContext", function() {
  it("triage=rtl_generate: triage entry sees source='verify' + verifyResult + previous RTL", async function() {
    __llmResponses = [
      { text: JSON.stringify({ target: "rtl_generate", reason: "rtl bug" }),
        tokensIn: 10, tokensOut: 5, latencyMs: 1, model: "stub", provider: "stub" },
    ];
    const captured = [];
    const st = baseSt({
      _services: {
        invokeNode: makeCapturingInvokeNode(captured),
        allStages: defaultActiveStages(),
      },
    });
    await verifyModule.verifyNode(st);
    expect(captured[0].stageKey).toBe("rtl_generate");
    const ctx = captured[0].fixContext;
    expect(ctx).toBeTruthy();
    expect(ctx.source).toBe("verify");
    expect(ctx.previousCode).toBe("module orig_rtl; endmodule");
    expect(ctx.verifyResult).toBeTruthy();
    expect(ctx.verifyResult.fail).toBeGreaterThan(0);
  });

  it("triage=test_generate: triage entry sees source='verify' + previousCode = TB", async function() {
    __llmResponses = [
      { text: JSON.stringify({ target: "test_generate", reason: "tb bug" }),
        tokensIn: 10, tokensOut: 5, latencyMs: 1, model: "stub", provider: "stub" },
    ];
    const captured = [];
    const st = baseSt({
      _services: {
        invokeNode: makeCapturingInvokeNode(captured),
        allStages: defaultActiveStages(),
      },
    });
    await verifyModule.verifyNode(st);
    // With triggerStage="test_generate", upstream stages run as
    // "downstream" entries (smart mode treats them as needing re-run
    // because their state isn't "passing"). The test_generate invocation
    // is NOT necessarily captured[0] — find it explicitly by fixContext.
    const triageInvoke = captured.find(function(c) {
      return c.stageKey === "test_generate" && c.fixContext;
    });
    expect(triageInvoke).toBeTruthy();
    const ctx = triageInvoke.fixContext;
    expect(ctx.source).toBe("verify");
    expect(ctx.previousCode).toBe("module orig_tb; endmodule");
    expect(ctx.verifyResult).toBeTruthy();
  });
});

// ─── rtl_review owner ─────────────────────────────────────────────────
describe("rtl_review owner attaches fixContext", function() {
  it("triage entry rtl_generate sees source='rtl_review' + reviewResult + previousCode", async function() {
    __llmResponses = [
      // initial review identifying critical issues
      { text: JSON.stringify({
          verdict: "NEEDS_FIX", score: 4,
          issues: [{ severity: "critical", description: "no reset" }],
        }),
        tokensIn: 10, tokensOut: 5, latencyMs: 1, model: "stub", provider: "stub" },
    ];
    const captured = [];
    const st = baseSt({
      _services: {
        invokeNode: makeCapturingInvokeNode(captured),
        allStages: defaultActiveStages(),
      },
    });
    await rtlReviewModule.rtlReviewNode(st);
    expect(captured[0].stageKey).toBe("rtl_generate");
    const ctx = captured[0].fixContext;
    expect(ctx).toBeTruthy();
    expect(ctx.source).toBe("rtl_review");
    expect(ctx.previousCode).toBe("module orig_rtl; endmodule");
    expect(ctx.reviewResult).toBeTruthy();
    expect(ctx.reviewResult.verdict).toBe("NEEDS_FIX");
  });
});

// ─── test_review owner ────────────────────────────────────────────────
describe("test_review owner attaches fixContext", function() {
  it("triage entry test_generate sees source='test_review' + reviewResult + previousCode = TB", async function() {
    __llmResponses = [
      { text: JSON.stringify({
          verdict: "NEEDS_FIX", score: 4,
          issues: [{ severity: "critical", description: "missing edge case" }],
        }),
        tokensIn: 10, tokensOut: 5, latencyMs: 1, model: "stub", provider: "stub" },
    ];
    const captured = [];
    const st = baseSt({
      _services: {
        invokeNode: makeCapturingInvokeNode(captured),
        allStages: defaultActiveStages(),
      },
    });
    await testReviewModule.testReviewNode(st);
    expect(captured[0].stageKey).toBe("test_generate");
    const ctx = captured[0].fixContext;
    expect(ctx).toBeTruthy();
    expect(ctx.source).toBe("test_review");
    expect(ctx.previousCode).toBe("module orig_tb; endmodule");
    expect(ctx.reviewResult).toBeTruthy();
  });
});

// ─── judge owner ──────────────────────────────────────────────────────
describe("judge owner attaches fixContext", function() {
  it("triage=rtl_generate: triage entry sees source='judge' + verifyResult + judgeVerdict + previousCode", async function() {
    // Pre-seed verify as failing so judge has work to do
    const captured = [];
    const st = baseSt({
      verify: {
        sim: "mock", total: 1, pass: 0, fail: 1,
        cov: { line: 0, branch: 0, toggle: 0 },
        tests: [{ name: "t", st: "FAIL" }], log: "", cli: true,
      },
      _services: {
        invokeNode: makeCapturingInvokeNode(captured),
        allStages: defaultActiveStages(),
      },
    });
    await judgeModule.judgeNode(st);
    // The chain's first invocation is rtl_generate (triage target).
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].stageKey).toBe("rtl_generate");
    const ctx = captured[0].fixContext;
    expect(ctx).toBeTruthy();
    expect(ctx.source).toBe("judge");
    expect(ctx.previousCode).toBe("module orig_rtl; endmodule");
    expect(ctx.verifyResult).toBeTruthy();
    expect(ctx.verifyResult.fail).toBe(1);
    expect(ctx.judgeVerdict).toBeTruthy();
  });

  it("triage=test_generate: previousCode = TB", async function() {
    const captured = [];
    const st = baseSt({
      verify: {
        sim: "mock", total: 1, pass: 0, fail: 1,
        cov: { line: 0, branch: 0, toggle: 0 },
        tests: [{ name: "t", st: "FAIL" }], log: "", cli: true,
      },
      _config: Object.assign({}, baseSt()._config, {
        _testTriageTarget: "test_generate",
      }),
      _services: {
        invokeNode: makeCapturingInvokeNode(captured),
        allStages: defaultActiveStages(),
      },
    });
    await judgeModule.judgeNode(st);
    expect(captured[0].stageKey).toBe("test_generate");
    const ctx = captured[0].fixContext;
    expect(ctx).toBeTruthy();
    expect(ctx.source).toBe("judge");
    expect(ctx.previousCode).toBe("module orig_tb; endmodule");
  });
});
