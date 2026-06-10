// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// perRunCapture — V22 Item 4 (G.3.1)
//
// Pins the data-layer foundation for per-run results:
//
//   1. Top-level stage completion records result + context in stageRuns
//      via the existing RUN_START / RUN_FINISH lifecycle.
//   2. Chain re-runs (via reflowRunner) ALSO publish via onSubRun so
//      each chain entry lands in stageRuns with a context label
//      (depth, parentStageKey, parentIter, reason).
//   3. Errors are recorded with status="error" and null result.
//   4. Skipped chain entries do NOT publish (nothing happened).
//
// Tests use a standalone harness with a mocked dispatch so we can
// inspect every action that fires.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from "vitest";
import { runReflowChain } from "../src/pipeline/reflowRunner.js";

function makeOwnerState(overrides) {
  return Object.assign({
    _config: {},
    _onLog: function() {}, _onLoopback: function() {}, _signal: null,
    _logger: {
      events: [],
      state: function() {}, llm: function() {}, cli: function() {},
      skill: function() {}, prompt: function() {}, result: function() {},
      context: { depth: 0, parentStageKey: null, parentIter: null },
    },
    _services: {
      invokeNode: async function(stageKey) {
        return { [stageKey]: { code: "mock_" + stageKey }, _llms: [] };
      },
      allStages: [
        { id: 4, key: "rtl_generate", order: 40 },
        { id: 6, key: "lint",         order: 60 },
      ],
    },
  }, overrides || {});
}

describe("reflowRunner publishes chain entries via onSubRun (V22 Item 4 G.3.1)", function() {

  it("calls onSubRun once per non-skipped chain entry with full run record", async function() {
    const captured = [];
    const st = makeOwnerState({
      _services: {
        invokeNode: async function(stageKey) {
          return { [stageKey]: { code: "regen_" + stageKey }, _llms: [] };
        },
        allStages: [
          { id: 4, key: "rtl_generate", order: 40 },
          { id: 6, key: "lint",         order: 60 },
        ],
        onSubRun: function(rec) { captured.push(rec); },
      },
    });
    const chain = [
      { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
      { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
    ];
    await runReflowChain({
      chain, st, ownerKey: "lint", ownerIter: 2, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    expect(captured.length).toBe(2);
    expect(captured[0].stageKey).toBe("rtl_generate");
    expect(captured[0].stageId).toBe(4);
    expect(captured[0].status).toBe("complete");
    expect(captured[0].result).toEqual({ code: "regen_rtl_generate" });
    expect(captured[0].trigger).toBe("reflow:lint");
    expect(captured[0].context.depth).toBe(1);
    expect(captured[0].context.parentStageKey).toBe("lint");
    expect(captured[0].context.parentIter).toBe(2);
    expect(captured[0].context.reason).toBe("triage");
  });

  it("does NOT publish for skipped entries (smart mode)", async function() {
    const captured = [];
    const st = makeOwnerState({
      _services: {
        invokeNode: async function(stageKey) {
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: [
          { id: 4, key: "rtl_generate", order: 40 },
          { id: 6, key: "lint",         order: 60 },
        ],
        onSubRun: function(rec) { captured.push(rec); },
      },
    });
    const chain = [
      { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "skipped" },
      { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
    ];
    await runReflowChain({
      chain, st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    // Only lint was published; rtl_generate was skipped
    expect(captured.length).toBe(1);
    expect(captured[0].stageKey).toBe("lint");
  });

  it("publishes errors with status='error' and null/partial result", async function() {
    const captured = [];
    const st = makeOwnerState({
      _services: {
        invokeNode: async function(stageKey) {
          if (stageKey === "rtl_generate") throw new Error("regen failed");
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: [
          { id: 4, key: "rtl_generate", order: 40 },
          { id: 6, key: "lint",         order: 60 },
        ],
        onSubRun: function(rec) { captured.push(rec); },
      },
    });
    const chain = [
      { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
      { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
    ];
    await runReflowChain({
      chain, st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    expect(captured[0].stageKey).toBe("rtl_generate");
    expect(captured[0].status).toBe("error");
    expect(captured[0].context.error).toMatch(/regen failed/);
  });

  it("propagates context.depth for nested chains (deeper levels carry depth+1+1...)", async function() {
    const captured = [];
    const st = makeOwnerState({
      _services: {
        invokeNode: async function(stageKey) {
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: [
          { id: 4, key: "rtl_generate", order: 40 },
          { id: 6, key: "lint",         order: 60 },
        ],
        onSubRun: function(rec) { captured.push(rec); },
      },
    });
    // Simulate a chain that ITSELF is running at depth 1 (inside a
    // parent owner chain) — parentDepth=1 means our entries land at
    // depth 2.
    await runReflowChain({
      chain: [
        { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
      ],
      st, ownerKey: "lint", ownerIter: 1, parentDepth: 1,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    expect(captured[0].context.depth).toBe(2);
  });

  it("backward-compat: no onSubRun in services → runner doesn't throw, no records published", async function() {
    const st = makeOwnerState({
      _services: {
        invokeNode: async function(stageKey) { return { [stageKey]: {}, _llms: [] }; },
        allStages: [{ id: 4, key: "rtl_generate", order: 40 }],
        // No onSubRun — older callers (tests, smoke driver) don't supply one
      },
    });
    // Should not throw
    await expect(
      runReflowChain({
        chain: [{ stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" }],
        st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
        currentState: {}, allLlms: [], appendLog: function() {},
      })
    ).resolves.toBeTruthy();
  });

  it("onSubRun throwing doesn't break the chain walk", async function() {
    const captured = [];
    const st = makeOwnerState({
      _services: {
        invokeNode: async function(stageKey) { return { [stageKey]: {}, _llms: [] }; },
        allStages: [
          { id: 4, key: "rtl_generate", order: 40 },
          { id: 6, key: "lint",         order: 60 },
        ],
        onSubRun: function(rec) {
          captured.push(rec);
          if (rec.stageKey === "rtl_generate") {
            throw new Error("consumer crashed");
          }
        },
      },
    });
    // Should not throw — onSubRun errors are swallowed
    await expect(
      runReflowChain({
        chain: [
          { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
          { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
        ],
        st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
        currentState: {}, allLlms: [], appendLog: function() {},
      })
    ).resolves.toBeTruthy();
    // Both publishes attempted (second one succeeded)
    expect(captured.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Reducer side: RUN_FINISH now carries result + context
// ─────────────────────────────────────────────────────────────────────────

describe("RUN_FINISH carries result + context (V22 Item 4 G.3.1)", function() {

  it("RUN_FINISH with result populates run.result on the corresponding run", async function() {
    const { projectReducer: reduce } = await import("../src/projectState/reducer.js");
    const {
      MODULE_REGISTER, MODULE_STAGE_RUN_START, MODULE_STAGE_RUN_FINISH,
    } = await import("../src/projectState/actions.js");

    let state = { modules: {}, moduleOrder: [], integrationState: { stageData: {}, completed: new Set(), errors: {} } };
    state = reduce(state, { type: MODULE_REGISTER, modId: "mA", spec: { name: "mA", inputs: [], outputs: [] } });
    state = reduce(state, {
      type: MODULE_STAGE_RUN_START, modId: "mA", stageId: 6, stageKey: "lint",
      run: { runId: 1, trigger: "manual", ts: 1000 },
    });
    state = reduce(state, {
      type: MODULE_STAGE_RUN_FINISH, modId: "mA", stageId: 6, runId: 1,
      status: "complete",
      result: { code: "module x; endmodule", status: "PASS" },
      context: { depth: 0, parentStageKey: null, parentIter: null, reason: null },
      ts: 2000,
    });
    const runs = state.modules.mA.stageRuns[6];
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("complete");
    expect(runs[0].result).toEqual({ code: "module x; endmodule", status: "PASS" });
    expect(runs[0].context.depth).toBe(0);
    expect(runs[0].finishedAt).toBe(2000);
  });

  it("RUN_FINISH without result (legacy callers) doesn't overwrite an existing result", async function() {
    const { projectReducer: reduce } = await import("../src/projectState/reducer.js");
    const {
      MODULE_REGISTER, MODULE_STAGE_RUN_START, MODULE_STAGE_RUN_FINISH,
    } = await import("../src/projectState/actions.js");

    let state = { modules: {}, moduleOrder: [], integrationState: { stageData: {}, completed: new Set(), errors: {} } };
    state = reduce(state, { type: MODULE_REGISTER, modId: "mA", spec: { name: "mA", inputs: [], outputs: [] } });
    state = reduce(state, {
      type: MODULE_STAGE_RUN_START, modId: "mA", stageId: 6, stageKey: "lint",
      run: { runId: 1, trigger: "manual", ts: 1000, result: { code: "preset" } },
    });
    // Legacy RUN_FINISH (no result/context fields)
    state = reduce(state, {
      type: MODULE_STAGE_RUN_FINISH, modId: "mA", stageId: 6, runId: 1, status: "complete",
    });
    const run = state.modules.mA.stageRuns[6][0];
    // The original 'preset' result attached via RUN_START is preserved
    expect(run.result).toEqual({ code: "preset" });
    expect(run.status).toBe("complete");
  });

  it("multiple runs accumulate in stageRuns[id] preserving each result", async function() {
    const { projectReducer: reduce } = await import("../src/projectState/reducer.js");
    const {
      MODULE_REGISTER, MODULE_STAGE_RUN_START, MODULE_STAGE_RUN_FINISH,
    } = await import("../src/projectState/actions.js");

    let state = { modules: {}, moduleOrder: [], integrationState: { stageData: {}, completed: new Set(), errors: {} } };
    state = reduce(state, { type: MODULE_REGISTER, modId: "mA", spec: { name: "mA", inputs: [], outputs: [] } });

    // Run 1 — original
    state = reduce(state, {
      type: MODULE_STAGE_RUN_START, modId: "mA", stageId: 4, stageKey: "rtl_generate",
      run: { runId: 1, trigger: "manual", ts: 1000 },
    });
    state = reduce(state, {
      type: MODULE_STAGE_RUN_FINISH, modId: "mA", stageId: 4, runId: 1,
      status: "complete",
      result: { code: "module v1; endmodule" },
      context: { depth: 0 },
      ts: 2000,
    });

    // Run 2 — reflow rerun inside lint chain (depth 1)
    state = reduce(state, {
      type: MODULE_STAGE_RUN_START, modId: "mA", stageId: 4, stageKey: "rtl_generate",
      run: { runId: 2, trigger: "reflow:lint", ts: 3000 },
    });
    state = reduce(state, {
      type: MODULE_STAGE_RUN_FINISH, modId: "mA", stageId: 4, runId: 2,
      status: "complete",
      result: { code: "module v2; endmodule" },
      context: { depth: 1, parentStageKey: "lint", parentIter: 1 },
      ts: 4000,
    });

    // Run 3 — deeper reflow inside verify→lint chain (depth 2)
    state = reduce(state, {
      type: MODULE_STAGE_RUN_START, modId: "mA", stageId: 4, stageKey: "rtl_generate",
      run: { runId: 3, trigger: "reflow:verify", ts: 5000 },
    });
    state = reduce(state, {
      type: MODULE_STAGE_RUN_FINISH, modId: "mA", stageId: 4, runId: 3,
      status: "complete",
      result: { code: "module v3; endmodule" },
      context: { depth: 2, parentStageKey: "verify", parentIter: 1 },
      ts: 6000,
    });

    const runs = state.modules.mA.stageRuns[4];
    expect(runs.length).toBe(3);
    expect(runs[0].result.code).toBe("module v1; endmodule");
    expect(runs[1].result.code).toBe("module v2; endmodule");
    expect(runs[2].result.code).toBe("module v3; endmodule");
    expect(runs[0].context.depth).toBe(0);
    expect(runs[1].context.depth).toBe(1);
    expect(runs[2].context.depth).toBe(2);
    expect(runs[1].trigger).toBe("reflow:lint");
    expect(runs[2].trigger).toBe("reflow:verify");
  });
});
