// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Pins the nested-reflow LLM live-telemetry fix: as each chain entry completes,
// runReflowChain surfaces that entry's DIRECT llm calls on the owner's
// in-flight panel via st._emitLiveProgress — so a stage grinding in a nested
// re-run no longer shows "0 LLM calls". Calls already stamped `_depth` (deeper
// reflow, surfaced at that level) are NOT re-emitted (exactly-once).

import { describe, it, expect } from "vitest";
import { runReflowChain } from "../src/pipeline/reflowRunner.js";
import { createStageLogger } from "../src/projectState/stageLogger.js";

function makeSt(emit, invokeNode) {
  return {
    _config: {},
    _logger: createStageLogger("verify", { depth: 0 }),
    _emitLiveProgress: emit,
    _services: { invokeNode, allStages: [] },
  };
}

const baseOpts = (st, chain) => ({
  chain, st, currentState: {}, allLlms: [], appendLog: function() {},
  ownerKey: "verify", ownerIter: 1, parentDepth: 0, strictOnError: false,
});

describe("runReflowChain — live LLM telemetry", () => {
  it("emits each entry's direct llm calls to the owner live panel", async () => {
    const live = [];
    const invokeNode = async (stageKey) => ({
      [stageKey]: { code: "x" },
      _llms: [
        { model: "gpt-oss-120b", tokensIn: 500, tokensOut: 80, endedAtMs: 1234 },
        { model: "gpt-oss-120b", tokensIn: 30, tokensOut: 10 },
      ],
    });
    const st = makeSt(function(e) { live.push(e); }, invokeNode);
    await runReflowChain(baseOpts(st, [
      { stageKey: "rtl_generate", stageId: 4, reason: "triage" },
    ]));

    const llmEvents = live.filter((e) => e.type === "llm");
    expect(llmEvents).toHaveLength(2);
    expect(llmEvents[0].depth).toBe(1);                 // nested (parentDepth+1)
    expect(llmEvents[0].parentStageKey).toBe("verify");
    expect(llmEvents[0].model).toBe("gpt-oss-120b");
    expect(llmEvents[0].tokensIn).toBe(500);
    expect(llmEvents[0].ts).toBe(1234);                 // endedAtMs when present
  });

  it("does NOT re-emit calls already stamped _depth (exactly-once)", async () => {
    const live = [];
    // Simulate an entry (e.g. verify-as-judge-entry) whose result mixes its own
    // direct call with a deeper-reflow call already surfaced one level down.
    const invokeNode = async (stageKey) => ({
      [stageKey]: { code: "x" },
      _llms: [
        { model: "m", tokensIn: 10 },                     // direct  → emit
        { model: "m", tokensIn: 20, _depth: 2 },          // deeper  → skip
      ],
    });
    const st = makeSt(function(e) { live.push(e); }, invokeNode);
    await runReflowChain(baseOpts(st, [
      { stageKey: "verify", stageId: 8, reason: "triage" },
    ]));
    const llmEvents = live.filter((e) => e.type === "llm");
    expect(llmEvents).toHaveLength(1);
    expect(llmEvents[0].tokensIn).toBe(10);
  });

  it("propagates _emitLiveProgress onto the sub-state for deeper recursion", async () => {
    const live = [];
    let seenSubState = null;
    const emit = function(e) { live.push(e); };
    const invokeNode = async (stageKey, subState) => {
      seenSubState = subState;
      return { [stageKey]: { code: "x" }, _llms: [] };
    };
    const st = makeSt(emit, invokeNode);
    await runReflowChain(baseOpts(st, [
      { stageKey: "rtl_generate", stageId: 4, reason: "triage" },
    ]));
    expect(seenSubState).not.toBe(null);
    expect(seenSubState._emitLiveProgress).toBe(emit);   // same channel, top panel
  });

  it("is a no-op (no throw) when no live channel is wired (headless)", async () => {
    const invokeNode = async (stageKey) => ({ [stageKey]: { code: "x" }, _llms: [{ model: "m" }] });
    const st = makeSt(null, invokeNode);                 // _emitLiveProgress = null
    const res = await runReflowChain(baseOpts(st, [
      { stageKey: "rtl_generate", stageId: 4, reason: "triage" },
    ]));
    expect(res.currentState.rtl_generate).toEqual({ code: "x" });
  });
});
