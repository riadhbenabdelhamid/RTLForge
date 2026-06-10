// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// stageRunsHistory — V22 Item 4 (G.3)
//
// Pins that the per-stage run array correctly captures:
//   • The original top-level run with its result snapshot + null context
//   • Each chain re-run as a separate entry with result + nesting context
//   • Run records carry status, ts, depth, parentStageKey, parentIter
//
// This is the foundation Item 4 builds on. The dropdown UI in G.3.2 and
// the trace-panel sync in G.3.3 both READ from this data, so getting
// the capture contract right matters most.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";

let __cliCallCount = 0;
let __llmResponses = [];

vi.mock("../src/llm/index.js", function() {
  return {
    callLLM: vi.fn(async function() {
      if (__llmResponses.length > 0) return __llmResponses.shift();
      return {
        text: JSON.stringify({
          code: "module x; endmodule",
          fixes: [],
          verdict: "PASS", score: 9, issues: [],
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
    parseTestLine: function() { return null; },
    parseCoverageDat: function() { return { line: 100, branch: 100, toggle: 100 }; },
    CliBackendError: class extends Error {},
  };
});

beforeEach(function() {
  __cliCallCount = 0;
  __llmResponses = [];
});

// ─── Reducer-level pin: RUN_FINISH stores result + context ─────────────
describe("reducer MODULE_STAGE_RUN_FINISH captures result + context (G.3)", function() {

  it("FINISH writes result + context onto the matching run", async function() {
    const { projectReducer: reducer } = await import("../src/projectState/reducer.js");
    const {
      MODULE_UPSERT,
      MODULE_STAGE_RUN_START,
      MODULE_STAGE_RUN_FINISH,
    } = await import("../src/projectState/actions.js");
    const { blankModule } = await import("../src/projectState/moduleRegistry.js");

    let state = reducer({ modules: {}, modOrder: [] },
      { type: MODULE_UPSERT, modId: "mod1", patch: blankModule() });
    state = reducer(state, {
      type: MODULE_STAGE_RUN_START,
      modId: "mod1", stageId: 6, stageKey: "lint",
      run: { runId: 1, trigger: "user", ts: 1000, text: "", metrics: {}, status: "running" },
    });
    state = reducer(state, {
      type: MODULE_STAGE_RUN_FINISH,
      modId: "mod1", stageId: 6, runId: 1,
      status: "complete",
      result: { status: "PASS", errors: [], warnings: [] },
      context: null,
      ts: 2000,
    });
    const run = state.modules.mod1.stageRuns[6][0];
    expect(run.status).toBe("complete");
    expect(run.result).toBeTruthy();
    expect(run.result.status).toBe("PASS");
    expect(run.context).toBe(null);
    expect(run.finishedAt).toBe(2000);
  });

  it("FINISH preserves nesting context for chain re-runs", async function() {
    const { projectReducer: reducer } = await import("../src/projectState/reducer.js");
    const {
      MODULE_UPSERT,
      MODULE_STAGE_RUN_START,
      MODULE_STAGE_RUN_FINISH,
    } = await import("../src/projectState/actions.js");
    const { blankModule } = await import("../src/projectState/moduleRegistry.js");

    let state = reducer({ modules: {}, modOrder: [] },
      { type: MODULE_UPSERT, modId: "mod1", patch: blankModule() });
    // Simulate a chain re-run: rtl_generate triggered inside lint's chain
    state = reducer(state, {
      type: MODULE_STAGE_RUN_START,
      modId: "mod1", stageId: 4, stageKey: "rtl_generate",
      run: { runId: 1, trigger: "reflow:lint", ts: 3000, status: "running" },
    });
    state = reducer(state, {
      type: MODULE_STAGE_RUN_FINISH,
      modId: "mod1", stageId: 4, runId: 1,
      status: "complete",
      result: { code: "module fixed; endmodule" },
      context: {
        depth: 1,
        parentStageKey: "lint",
        parentIter: 2,
        reason: "triage",
      },
      ts: 4000,
    });
    const run = state.modules.mod1.stageRuns[4][0];
    expect(run.context).toBeTruthy();
    expect(run.context.depth).toBe(1);
    expect(run.context.parentStageKey).toBe("lint");
    expect(run.context.parentIter).toBe(2);
    expect(run.context.reason).toBe("triage");
  });
});

// ─── Reflow runner publishes runs via onSubRun ──────────────────────────
describe("reflowRunner publishes per-entry runs via onSubRun (G.3)", function() {

  it("calls onSubRun for each non-skipped chain entry with result + context", async function() {
    const { runReflowChain } = await import("../src/pipeline/reflowRunner.js");
    const published = [];
    const st = {
      _config: {}, _onLog: function() {}, _onLoopback: function() {}, _signal: null,
      _logger: {
        events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 0, parentStageKey: null, parentIter: null },
      },
      _services: {
        invokeNode: async function(stageKey) {
          if (stageKey === "rtl_generate") {
            return { rtl_generate: { code: "module regen; endmodule" }, _llms: [] };
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
        onSubRun: function(rec) { published.push(rec); },
      },
    };
    const chain = [
      { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
      { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
    ];
    await runReflowChain({
      chain, st, ownerKey: "lint", ownerIter: 2, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    // Both entries published
    expect(published.length).toBe(2);
    // First publish: rtl_generate as triage
    expect(published[0].stageKey).toBe("rtl_generate");
    expect(published[0].stageId).toBe(4);
    expect(published[0].trigger).toBe("reflow:lint");
    expect(published[0].status).toBe("complete");
    expect(published[0].result).toBeTruthy();
    expect(published[0].result.code).toBe("module regen; endmodule");
    expect(published[0].context.depth).toBe(1);
    expect(published[0].context.parentStageKey).toBe("lint");
    expect(published[0].context.parentIter).toBe(2);
    expect(published[0].context.reason).toBe("triage");
    // Second publish: lint as always (chain tail)
    expect(published[1].stageKey).toBe("lint");
    expect(published[1].stageId).toBe(6);
    expect(published[1].context.reason).toBe("always");
  });

  it("does NOT call onSubRun for skipped chain entries", async function() {
    const { runReflowChain } = await import("../src/pipeline/reflowRunner.js");
    const published = [];
    const st = {
      _config: {}, _onLog: function() {}, _onLoopback: function() {}, _signal: null,
      _logger: { events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 0, parentStageKey: null, parentIter: null },
      },
      _services: {
        invokeNode: async function(stageKey) {
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: [
          { id: 4, key: "rtl_generate", order: 40 },
          { id: 10, key: "rtl_review",   order: 45 },
          { id: 6, key: "lint",         order: 60 },
        ],
        onSubRun: function(rec) { published.push(rec); },
      },
    };
    const chain = [
      { stageId: 4,  stageKey: "rtl_generate", order: 40, reason: "triage" },
      { stageId: 10, stageKey: "rtl_review",   order: 45, reason: "skipped" },
      { stageId: 6,  stageKey: "lint",         order: 60, reason: "always" },
    ];
    await runReflowChain({
      chain, st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    // Only 2 publishes (rtl_generate + lint); rtl_review was skipped
    expect(published.length).toBe(2);
    expect(published.map(function(p) { return p.stageKey; })).toEqual(["rtl_generate", "lint"]);
  });

  it("publishes status='error' when invokeNode throws", async function() {
    const { runReflowChain } = await import("../src/pipeline/reflowRunner.js");
    const published = [];
    const st = {
      _config: {}, _onLog: function() {}, _onLoopback: function() {}, _signal: null,
      _logger: { events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 0, parentStageKey: null, parentIter: null },
      },
      _services: {
        invokeNode: async function(stageKey) {
          if (stageKey === "rtl_generate") throw new Error("boom");
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: [
          { id: 4, key: "rtl_generate", order: 40 },
          { id: 6, key: "lint",         order: 60 },
        ],
        onSubRun: function(rec) { published.push(rec); },
      },
    };
    await runReflowChain({
      chain: [
        { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
        { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
      ],
      st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    // rtl_generate published with status="error"; lint still ran
    expect(published[0].stageKey).toBe("rtl_generate");
    expect(published[0].status).toBe("error");
    expect(published[0].context.error).toMatch(/boom/);
  });

  it("propagates nested depth correctly (depth 0 → depth 1 → depth 2)", async function() {
    const { runReflowChain } = await import("../src/pipeline/reflowRunner.js");
    const published = [];
    const st = {
      _config: {}, _onLog: function() {}, _onLoopback: function() {}, _signal: null,
      _logger: { events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 0, parentStageKey: null, parentIter: null },
      },
      _services: {
        invokeNode: async function(stageKey) { return { [stageKey]: {}, _llms: [] }; },
        allStages: [{ id: 4, key: "rtl_generate", order: 40 }],
        onSubRun: function(rec) { published.push(rec); },
      },
    };
    // Outer caller is at depth 0 (judge), so the chain it owns runs entries at depth 1
    await runReflowChain({
      chain: [{ stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" }],
      st, ownerKey: "judge", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    expect(published[0].context.depth).toBe(1);
    // Now simulate one nesting level deeper: judge → verify → rtl_generate
    published.length = 0;
    await runReflowChain({
      chain: [{ stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" }],
      st, ownerKey: "verify", ownerIter: 1, parentDepth: 1,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    expect(published[0].context.depth).toBe(2);
  });

  it("no onSubRun configured → publishes silently skipped (no throw)", async function() {
    const { runReflowChain } = await import("../src/pipeline/reflowRunner.js");
    const st = {
      _config: {}, _onLog: function() {}, _onLoopback: function() {}, _signal: null,
      _logger: { events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 0, parentStageKey: null, parentIter: null },
      },
      _services: {
        invokeNode: async function(stageKey) { return { [stageKey]: {}, _llms: [] }; },
        allStages: [{ id: 6, key: "lint", order: 60 }],
        // no onSubRun
      },
    };
    await expect(
      runReflowChain({
        chain: [{ stageId: 6, stageKey: "lint", order: 60, reason: "triage" }],
        st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
        currentState: {}, allLlms: [], appendLog: function() {},
      })
    ).resolves.toBeTruthy();
  });

  it("onSubRun throw doesn't break the chain walk", async function() {
    const { runReflowChain } = await import("../src/pipeline/reflowRunner.js");
    let secondEntryHit = false;
    const st = {
      _config: {}, _onLog: function() {}, _onLoopback: function() {}, _signal: null,
      _logger: { events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 0, parentStageKey: null, parentIter: null },
      },
      _services: {
        invokeNode: async function(stageKey) {
          if (stageKey === "lint") secondEntryHit = true;
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: [
          { id: 4, key: "rtl_generate", order: 40 },
          { id: 6, key: "lint",         order: 60 },
        ],
        onSubRun: function() { throw new Error("publish blew up"); },
      },
    };
    await runReflowChain({
      chain: [
        { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
        { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
      ],
      st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    // Second entry MUST still execute even if the first's publish threw
    expect(secondEntryHit).toBe(true);
  });
});
