// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// lintReflowChain — V22-bug-pass-8 D.3.1
//
// Pins the per-stage K-to-X reflow contract for lint:
//   • When services.invokeNode is available AND lint isn't already
//     nested inside its own chain, lint's fix-loop walks
//     rtl_generate → rtl_review → lint via runReflowChain.
//   • When services.invokeNode is missing, lint uses the legacy inline
//     callLLM(promptRTLFix) path (unchanged from V22-bug-pass-7).
//   • Inner lint runs (depth=1, parentStageKey="lint") bypass chaining
//     to prevent infinite recursion.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";

// Track CLI call sequence per-test to keep behavior deterministic
let __cliCallCount = 0;

// Stub callLLM and runCli BEFORE importing lintNode so the mocks
// intercept the inline path
vi.mock("../src/llm/index.js", function() {
  return {
    callLLM: vi.fn(async function(p) {
      return {
        text: JSON.stringify({
          code: "module fixed_via_inline; endmodule",
          fixes: [{ description: "fix1" }],
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
        // Iter 1 primary: errors
        return { stdout: "", stderr: "%Error-WIDTH: line 5: blah", exitCode: 1 };
      }
      // All subsequent: clean (recheck or iter 2 primary)
      return { stdout: "", stderr: "", exitCode: 0 };
    }),
    parseCLIOutput: function(stderr) {
      if (/%Error/.test(stderr || "")) {
        return {
          errors: [{ code: "WIDTH", msg: "blah", line: 5 }],
          warnings: [],
        };
      }
      return { errors: [], warnings: [] };
    },
    CliBackendError: class CliBackendError extends Error {},
  };
});

const lintModule = await import("../src/pipeline/nodes/lint.js");
const lintNode = lintModule.lintNode;

beforeEach(function() {
  __cliCallCount = 0;
});

describe("lint K-to-X reflow chain (V22-bug-pass-8 D.3.1)", function() {
  function baseSt(overrides) {
    return Object.assign({
      rtl_generate: { code: "module orig; endmodule" },
      elicit: { modName: "orig" },
      _config: {
        maxLintIters: 2,
        backendUrl: "http://x",
        lintCmd: "verilator --lint-only -Wall {RTL}",
        strictCli: false,
        lintReflowMode: "smart",
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

  it("chains to rtl_generate → rtl_review → lint when services.invokeNode is provided", async function() {
    const invocations = [];
    const st = baseSt({
      _services: {
        invokeNode: async function(stageKey, subState) {
          invocations.push(stageKey);
          // Stub: regenerate rtl, no-op review, return passing lint
          if (stageKey === "rtl_generate") {
            return { rtl_generate: { code: "module chain_fixed; endmodule" }, _llms: [] };
          }
          if (stageKey === "rtl_review") {
            return { rtl_review: { issues: [] }, _llms: [] };
          }
          if (stageKey === "lint") {
            // Inner lint at depth=1 — let it return a clean result so
            // outer lint's regression check passes
            return { lint: { status: "PASS", errors: [], warnings: [] }, _llms: [] };
          }
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: [
          { id: 4,  key: "rtl_generate", order: 40 },
          { id: 10, key: "rtl_review",   order: 45 },
          { id: 6,  key: "lint",         order: 60 },
        ],
      },
    });

    const result = await lintNode(st);

    // First three invocations are the chain entries:
    // rtl_generate → rtl_review → lint
    expect(invocations.slice(0, 3)).toEqual(["rtl_generate", "rtl_review", "lint"]);

    // The lint result carries _chain metadata
    expect(result.lint._chain).toBeDefined();
    expect(Array.isArray(result.lint._chain)).toBe(true);
    expect(result.lint._chain.length).toBeGreaterThan(0);
    const firstChainPass = result.lint._chain[0];
    expect(firstChainPass.entries.length).toBe(3);
    expect(firstChainPass.entries[0].stageKey).toBe("rtl_generate");
    expect(firstChainPass.entries[0].reason).toBe("triage");
    expect(firstChainPass.entries[2].stageKey).toBe("lint");
    expect(firstChainPass.entries[2].reason).toBe("always");
  });

  it("inner lint nested in its own chain takes the LEGACY path (recursion termination)", async function() {
    let chainAttemptedAtDepth1 = false;
    const st = baseSt({
      _logger: {
        events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        // Pretend we're already inside a lint-owned chain at depth=1
        context: { depth: 1, parentStageKey: "lint", parentIter: 2 },
      },
      _services: {
        invokeNode: async function(stageKey, subState) {
          // If chaining happened, this would be called for chain entries
          chainAttemptedAtDepth1 = true;
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: [
          { id: 4,  key: "rtl_generate", order: 40 },
          { id: 6,  key: "lint",         order: 60 },
        ],
      },
    });

    await lintNode(st);

    // Inner lint should NOT have triggered a chain — it took the legacy
    // inline path. Since the mock CLI returns clean on iter-2's recheck,
    // and the inline path calls callLLM (mocked above), we know it
    // didn't invoke the chain because invokeNode was never called.
    expect(chainAttemptedAtDepth1).toBe(false);
  });

  it("legacy path used when services.invokeNode is missing", async function() {
    const st = baseSt({
      // No _services field at all
    });
    const result = await lintNode(st);
    // No chain history on the result
    expect(result.lint._chain).toBeUndefined();
  });

  it("nested case: lint at depth=1 inside a JUDGE chain still chains (parentStageKey != 'lint')", async function() {
    let chainTriggered = false;
    const st = baseSt({
      _logger: {
        events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        // Inside a judge-owned chain, NOT lint's own
        context: { depth: 1, parentStageKey: "judge", parentIter: 2 },
      },
      _services: {
        invokeNode: async function(stageKey, subState) {
          chainTriggered = true;
          if (stageKey === "rtl_generate") {
            return { rtl_generate: { code: "module from_chain; endmodule" }, _llms: [] };
          }
          if (stageKey === "lint") {
            return { lint: { status: "PASS", errors: [], warnings: [] }, _llms: [] };
          }
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: [
          { id: 4, key: "rtl_generate", order: 40 },
          { id: 6, key: "lint",         order: 60 },
        ],
      },
    });
    await lintNode(st);
    // Chain DID trigger because we're inside a judge chain, not a lint chain
    expect(chainTriggered).toBe(true);
  });
});
