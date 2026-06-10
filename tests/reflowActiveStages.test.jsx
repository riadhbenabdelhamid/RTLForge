// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// reflowActiveStages — V22 Layer F.2
//
// Pins the multi-stage reflow signal contract:
//
//   When a K-to-X chain runs, the runner calls st._onReflowStages(ids)
//   with the SET of stage IDs currently active in the chain — so the UI
//   can fast-blink them all simultaneously. After the chain finishes,
//   the runner calls _onReflowStages([]) to clear.
//
//   The set includes:
//     • every non-skipped chain entry's stageId
//     • the owner stage's id (it's still "active" — waiting for chain)
//   And excludes:
//     • skipped entries (smart-mode skip)
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { runReflowChain } from "../src/pipeline/reflowRunner.js";

function makeOwnerState(overrides) {
  return Object.assign({
    _config: {},
    _onLog:     function() {},
    _onLoopback:function() {},
    _signal: null,
    _logger: {
      events: [],
      state: function() {}, llm: function() {}, cli: function() {},
      skill: function() {}, prompt: function() {}, result: function() {},
      context: { depth: 0, parentStageKey: null, parentIter: null },
    },
    _services: {
      invokeNode: async function(stageKey, subState) {
        return { [stageKey]: {}, _llms: [] };
      },
      allStages: [
        { id: 4, key: "rtl_generate", order: 40 },
        { id: 10, key: "rtl_review",   order: 45 },
        { id: 6, key: "lint",          order: 60 },
      ],
    },
  }, overrides || {});
}

describe("reflowRunner publishes active-stages signal (V22 Layer F.2)", function() {

  it("calls _onReflowStages on chain enter with all non-skipped entry IDs + owner ID", async function() {
    const calls = [];
    const st = makeOwnerState({
      _onReflowStages: function(ids) { calls.push(ids.slice().sort(function(a,b){return a-b;})); },
    });
    const chain = [
      { stageId: 4,  stageKey: "rtl_generate", order: 40, reason: "triage" },
      { stageId: 10, stageKey: "rtl_review",   order: 45, reason: "downstream" },
      { stageId: 6,  stageKey: "lint",         order: 60, reason: "always" },
    ];
    await runReflowChain({
      chain, st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    // First call should be the active set on enter
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Set contains all three chain stage IDs (4, 10, 6); owner is lint (6),
    // already in the chain, so the set is just [4, 6, 10] sorted.
    expect(calls[0]).toEqual([4, 6, 10]);
  });

  it("calls _onReflowStages([]) on chain exit to clear", async function() {
    const calls = [];
    const st = makeOwnerState({
      _onReflowStages: function(ids) { calls.push(ids.slice()); },
    });
    const chain = [
      { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
      { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
    ];
    await runReflowChain({
      chain, st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    // Last call should be the clear ([])
    expect(calls[calls.length - 1]).toEqual([]);
  });

  it("excludes skipped entries from the active set (smart mode)", async function() {
    const calls = [];
    const st = makeOwnerState({
      _onReflowStages: function(ids) { calls.push(ids.slice().sort(function(a,b){return a-b;})); },
    });
    const chain = [
      { stageId: 4,  stageKey: "rtl_generate", order: 40, reason: "triage" },
      { stageId: 10, stageKey: "rtl_review",   order: 45, reason: "skipped" },
      { stageId: 6,  stageKey: "lint",         order: 60, reason: "always" },
    ];
    await runReflowChain({
      chain, st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    // rtl_review (id=10) is skipped — should NOT be in the active set
    expect(calls[0]).toEqual([4, 6]);
  });

  it("includes owner stage ID when chain doesn't explicitly contain it", async function() {
    // Example: a chain where owner is NOT in chain entries (planner edge case).
    // The runner should still add the owner to the active set so the
    // owner's own badge fast-blinks while waiting.
    const calls = [];
    const st = makeOwnerState({
      _onReflowStages: function(ids) { calls.push(ids.slice().sort(function(a,b){return a-b;})); },
      _services: {
        invokeNode: async function(stageKey) { return { [stageKey]: {}, _llms: [] }; },
        allStages: [
          { id: 4, key: "rtl_generate", order: 40 },
          { id: 6, key: "lint",         order: 60 },
        ],
      },
    });
    const chain = [
      { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
      // owner (lint, id=6) deliberately absent from the chain entries
    ];
    await runReflowChain({
      chain, st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    expect(calls[0]).toEqual([4, 6]);  // owner added
  });

  it("propagates _onReflowStages onto subState so nested chains can publish too", async function() {
    let observedOnSubState = null;
    const st = makeOwnerState({
      _onReflowStages: function() {},
      _services: {
        invokeNode: async function(stageKey, subState) {
          if (stageKey === "rtl_generate") {
            observedOnSubState = typeof subState._onReflowStages;
          }
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: [{ id: 4, key: "rtl_generate", order: 40 }, { id: 6, key: "lint", order: 60 }],
      },
    });
    await runReflowChain({
      chain: [
        { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
        { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
      ],
      st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    expect(observedOnSubState).toBe("function");
  });

  it("no-op gracefully when _onReflowStages isn't provided (backward compat)", async function() {
    const st = makeOwnerState({
      // _onReflowStages deliberately omitted
    });
    // Should not throw
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
  });

  it("missing invokeNode → fallback path does NOT call _onReflowStages", async function() {
    const calls = [];
    const st = makeOwnerState({
      _onReflowStages: function(ids) { calls.push(ids.slice()); },
      _services: { invokeNode: null },
    });
    const result = await runReflowChain({
      chain: [{ stageId: 6, stageKey: "lint", order: 60, reason: "triage" }],
      st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    expect(result.fallbackToLegacy).toBe(true);
    // The runner returned early; no enter/exit calls were made
    expect(calls.length).toBe(0);
  });
});
