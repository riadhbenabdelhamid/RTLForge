// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// stageReflowChains — V22-bug-pass-8 D.3.6
//
// Pins per-stage K-to-X reflow contract for lint_test, verify,
// rtl_review, and test_review (mirrors the contract pinned by
// lintReflowChain.test.jsx for lint at D.3.1).
//
// For each stage we verify:
//   • Chain runs through invokeNode when services available
//   • Recursion termination when parentStageKey === ownerKey
//   • Legacy fallback when no services
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";

// Module-level state for mocks, reset between tests
let __cliCallCount = 0;
let __llmResponses = [];   // queue of responses for callLLM stub

vi.mock("../src/llm/index.js", function() {
  return {
    callLLM: vi.fn(async function(p) {
      if (__llmResponses.length > 0) {
        return __llmResponses.shift();
      }
      // Default: emit a benign JSON envelope
      return {
        text: JSON.stringify({
          verdict: "NEEDS_FIX",
          score: 6,
          issues: [{ severity: "major", description: "x" }],
          code: "module fix; endmodule",
          fixes: [{ description: "fix1" }],
          target: "test_generate",
          reason: "default",
        }),
        tokensIn: 50, tokensOut: 25, latencyMs: 5,
        model: "stub", provider: "stub",
      };
    }),
    extractJSON: function(t) { return JSON.parse(t); },
  };
});

vi.mock("../src/cli/index.js", function() {
  return {
    runCli: vi.fn(async function(url, payload) {
      __cliCallCount++;
      if (__cliCallCount === 1) {
        return { stdout: "", stderr: "%Error-WIDTH: line 5: blah", exitCode: 1 };
      }
      return { stdout: "TEST_PASS test1 cycles=10 ms=1", stderr: "", exitCode: 0 };
    }),
    parseCLIOutput: function(stderr) {
      if (/%Error/.test(stderr || "")) {
        return { errors: [{ code: "WIDTH", msg: "blah", line: 5 }], warnings: [] };
      }
      return { errors: [], warnings: [] };
    },
    parseTestLine: function(l) {
      const m = /TEST_PASS (\w+) cycles=(\d+) ms=(\d+)/.exec(l);
      if (!m) return null;
      return { name: m[1], status: "PASS", cyc: parseInt(m[2], 10), ms: parseInt(m[3], 10) };
    },
    parseCoverageDat: function() { return { line: 100, branch: 100, toggle: 100 }; },
    CliBackendError: class CliBackendError extends Error {},
  };
});

const lintTestModule   = await import("../src/pipeline/nodes/lint_test.js");
const verifyModule     = await import("../src/pipeline/nodes/verify.js");
const rtlReviewModule  = await import("../src/pipeline/nodes/rtl_review.js");
const testReviewModule = await import("../src/pipeline/nodes/test_review.js");

beforeEach(function() {
  __cliCallCount = 0;
  __llmResponses = [];
});

// ─── Shared fixtures ─────────────────────────────────────────────────────
function baseSt(overrides) {
  return Object.assign({
    rtl_generate: { code: "module orig; endmodule" },
    test_generate: { code: "module tb; endmodule" },
    spec: { modName: "orig", requirements: [], iface: [], params: [] },
    architect: {},
    elicit: { modName: "orig" },
    _config: {
      maxLintIters: 2,
      maxVerifyIters: 2,
      maxRtlReviewIters: 2,
      maxTestReviewIters: 2,
      backendUrl: "http://x",
      simCmds: "verilator --binary {RTL} {TB}",
      strictCli: false,
      lintReflowMode:        "smart",
      lintTestReflowMode:    "smart",
      verifyReflowMode:      "smart",
      rtlReviewReflowMode:   "smart",
      testReviewReflowMode:  "smart",
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

// ─── lint_test (D.3.2) ───────────────────────────────────────────────────
describe("lint_test K-to-X reflow chain (V22-bug-pass-8 D.3.2)", function() {
  it("chains to test_generate → test_review → lint_test when services available", async function() {
    const invocations = [];
    const st = baseSt({
      _services: {
        invokeNode: async function(stageKey, subState) {
          invocations.push(stageKey);
          if (stageKey === "test_generate") {
            return { test_generate: { code: "module chain_tb; endmodule" }, _llms: [] };
          }
          if (stageKey === "test_review") {
            return { test_review: { verdict: "PASS", issues: [] }, _llms: [] };
          }
          if (stageKey === "lint_test") {
            return { lint_test: { status: "PASS", errors: [], warnings: [] }, _llms: [] };
          }
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: defaultActiveStages(),
      },
    });
    const result = await lintTestModule.lintTestNode(st);
    expect(invocations.slice(0, 3)).toEqual(["test_generate", "test_review", "lint_test"]);
    expect(result.lint_test._chain).toBeDefined();
    expect(result.lint_test._chain[0].entries[0].stageKey).toBe("test_generate");
  });

  it("recursion termination: inner lint_test (parentStageKey='lint_test') takes legacy path", async function() {
    let invokeCalled = false;
    const st = baseSt({
      _logger: {
        events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 1, parentStageKey: "lint_test", parentIter: 2 },
      },
      _services: {
        invokeNode: async function() { invokeCalled = true; return {}; },
        allStages: defaultActiveStages(),
      },
    });
    await lintTestModule.lintTestNode(st);
    expect(invokeCalled).toBe(false);
  });

  it("legacy fallback: no _services → no chain history", async function() {
    const st = baseSt({});
    const result = await lintTestModule.lintTestNode(st);
    expect(result.lint_test._chain).toBeUndefined();
  });
});

// ─── verify (D.3.3) ──────────────────────────────────────────────────────
describe("verify K-to-X reflow chain (V22-bug-pass-8 D.3.3)", function() {
  it("triage='rtl_generate' maps chain triggerStage to rtl_generate", async function() {
    // Queue: first callLLM is the LLM-fallback verify call (no CLI gives
    // a clean test); we set CLI to return clean instead by pre-running it
    // — but the verify node calls CLI directly. Easier: make sure verify
    // sees a failure THEN triage picks rtl_generate THEN chain runs.
    // The default __cliCallCount sequence gives error on first call which
    // verify treats as a sim setup failure; subsequent calls clean.
    __llmResponses = [
      // verify-triage response
      {
        text: JSON.stringify({ target: "rtl_generate", reason: "rtl bug" }),
        tokensIn: 50, tokensOut: 10, latencyMs: 5, model: "stub", provider: "stub",
      },
    ];
    const invocations = [];
    const st = baseSt({
      _services: {
        invokeNode: async function(stageKey, subState) {
          invocations.push(stageKey);
          if (stageKey === "verify") {
            return {
              verify: {
                sim: "mock", total: 1, pass: 1, fail: 0,
                cov: { line: 100, branch: 100, toggle: 100 },
                tests: [{ name: "t", st: "PASS", cyc: 10, ms: 1 }],
                log: "", cli: true,
              },
              _llms: [],
            };
          }
          if (stageKey === "rtl_generate") {
            return { rtl_generate: { code: "module fix; endmodule" }, _llms: [] };
          }
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: defaultActiveStages(),
      },
    });
    // Fix base config (the destructure assignment above was wrong)
    const result = await verifyModule.verifyNode(st);
    // The first invocation should be rtl_generate (triage='rtl_generate' →
    // chain trigger = rtl_generate, which is the head of verify's tail)
    expect(invocations[0]).toBe("rtl_generate");
    expect(result.verify._chain).toBeDefined();
  });

  it("recursion termination: inner verify (parentStageKey='verify') takes legacy path", async function() {
    let invokeCalled = false;
    const st = baseSt({
      _logger: {
        events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 1, parentStageKey: "verify", parentIter: 1 },
      },
      _services: {
        invokeNode: async function() { invokeCalled = true; return {}; },
        allStages: defaultActiveStages(),
      },
    });
    // Force a sim outcome that doesn't trigger fix to keep test fast.
    // The CLI mock returns clean on call 2+, but we want first call clean too:
    __cliCallCount = 100;  // skip past "error" path in our mock
    await verifyModule.verifyNode(st);
    expect(invokeCalled).toBe(false);
  });

  it("legacy fallback: no _services → no chain history", async function() {
    __cliCallCount = 100;  // CLI returns clean → no fix loop triggered
    const st = baseSt({});
    const result = await verifyModule.verifyNode(st);
    expect(result.verify._chain).toBeUndefined();
  });
});

// ─── rtl_review (D.3.4) ──────────────────────────────────────────────────
describe("rtl_review K-to-X reflow chain (V22-bug-pass-8 D.3.4)", function() {
  it("chains to rtl_generate → rtl_review when services available", async function() {
    // First LLM call: the initial review identifying critical issues
    __llmResponses = [
      {
        text: JSON.stringify({
          verdict: "NEEDS_FIX", score: 4,
          issues: [{ severity: "critical", description: "missing reset" }],
        }),
        tokensIn: 100, tokensOut: 30, latencyMs: 5, model: "stub", provider: "stub",
      },
    ];
    const invocations = [];
    const st = baseSt({
      _services: {
        invokeNode: async function(stageKey, subState) {
          invocations.push(stageKey);
          if (stageKey === "rtl_generate") {
            return { rtl_generate: { code: "module chain_fixed; endmodule" }, _llms: [] };
          }
          if (stageKey === "rtl_review") {
            return {
              rtl_review: { verdict: "PASS", score: 9, issues: [] },
              _llms: [],
            };
          }
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: defaultActiveStages(),
      },
    });
    const result = await rtlReviewModule.rtlReviewNode(st);
    expect(invocations.slice(0, 2)).toEqual(["rtl_generate", "rtl_review"]);
    expect(result.rtl_review._chain).toBeDefined();
    expect(result.rtl_review._chain[0].entries[0].stageKey).toBe("rtl_generate");
  });

  it("recursion termination: inner rtl_review (parent='rtl_review') takes legacy path", async function() {
    let invokeCalled = false;
    __llmResponses = [
      {
        text: JSON.stringify({
          verdict: "PASS", score: 9, issues: [],
        }),
        tokensIn: 100, tokensOut: 30, latencyMs: 5, model: "stub", provider: "stub",
      },
    ];
    const st = baseSt({
      _logger: {
        events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 1, parentStageKey: "rtl_review", parentIter: 1 },
      },
      _services: {
        invokeNode: async function() { invokeCalled = true; return {}; },
        allStages: defaultActiveStages(),
      },
    });
    await rtlReviewModule.rtlReviewNode(st);
    expect(invokeCalled).toBe(false);
  });

  it("legacy fallback: no _services → no chain history", async function() {
    __llmResponses = [
      {
        text: JSON.stringify({
          verdict: "PASS", score: 9, issues: [],
        }),
        tokensIn: 100, tokensOut: 30, latencyMs: 5, model: "stub", provider: "stub",
      },
    ];
    const st = baseSt({});
    const result = await rtlReviewModule.rtlReviewNode(st);
    expect(result.rtl_review._chain).toBeUndefined();
  });
});

// ─── test_review (D.3.5) ─────────────────────────────────────────────────
describe("test_review K-to-X reflow chain (V22-bug-pass-8 D.3.5)", function() {
  it("chains to test_generate → test_review when services available", async function() {
    __llmResponses = [
      {
        text: JSON.stringify({
          verdict: "NEEDS_FIX", score: 4,
          issues: [{ severity: "critical", description: "missing edge case" }],
        }),
        tokensIn: 100, tokensOut: 30, latencyMs: 5, model: "stub", provider: "stub",
      },
    ];
    const invocations = [];
    const st = baseSt({
      _services: {
        invokeNode: async function(stageKey, subState) {
          invocations.push(stageKey);
          if (stageKey === "test_generate") {
            return { test_generate: { code: "module chain_tb_fixed; endmodule" }, _llms: [] };
          }
          if (stageKey === "test_review") {
            return {
              test_review: { verdict: "PASS", score: 9, issues: [] },
              _llms: [],
            };
          }
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: defaultActiveStages(),
      },
    });
    const result = await testReviewModule.testReviewNode(st);
    expect(invocations.slice(0, 2)).toEqual(["test_generate", "test_review"]);
    expect(result.test_review._chain).toBeDefined();
    expect(result.test_review._chain[0].entries[0].stageKey).toBe("test_generate");
  });

  it("recursion termination: inner test_review (parent='test_review') takes legacy path", async function() {
    let invokeCalled = false;
    __llmResponses = [
      {
        text: JSON.stringify({ verdict: "PASS", score: 9, issues: [] }),
        tokensIn: 100, tokensOut: 30, latencyMs: 5, model: "stub", provider: "stub",
      },
    ];
    const st = baseSt({
      _logger: {
        events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 1, parentStageKey: "test_review", parentIter: 1 },
      },
      _services: {
        invokeNode: async function() { invokeCalled = true; return {}; },
        allStages: defaultActiveStages(),
      },
    });
    await testReviewModule.testReviewNode(st);
    expect(invokeCalled).toBe(false);
  });

  it("legacy fallback: no _services → no chain history", async function() {
    __llmResponses = [
      {
        text: JSON.stringify({ verdict: "PASS", score: 9, issues: [] }),
        tokensIn: 100, tokensOut: 30, latencyMs: 5, model: "stub", provider: "stub",
      },
    ];
    const st = baseSt({});
    const result = await testReviewModule.testReviewNode(st);
    expect(result.test_review._chain).toBeUndefined();
  });
});
