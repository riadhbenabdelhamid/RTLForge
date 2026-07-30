// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Append-only telemetry at the REDUCER (run 39). The top-level Test Review's
// entire 59-minute record — _llms AND _iterations — was erased by an
// inner-chain re-entry that reached the store through a path the static hunt
// never found. 84d8579 fixed the StateGraph layer only; this pins the store
// layer, where every write funnels through.

import { describe, it, expect } from "vitest";
import { projectReducer, createInitialProjectState } from "../src/projectState/reducer.js";
import { carryLlms, carryIterations, withCarriedTelemetry } from "../src/pipeline/telemetryCarry.js";
import { MODULE_STAGE_DATA_SET, MODULE_STAGE_DATA_MERGE } from "../src/projectState/actions.js";

const call = (stage, t, ms) => ({
  stage, model: "laguna-s-2.1", provider: "ollama", tokensIn: 10, tokensOut: 20,
  latencyMs: ms, ttft: 5, startedAtMs: t, endedAtMs: t + ms, stopReason: "stop",
  systemPrompt: "S".repeat(2000), text: "T".repeat(2000),
});
const iterEntry = (iter, score, kind, code) => ({
  iter, score, verdict: "NEEDS_FIX", issueCount: 3,
  _structured: { kind, beforeCode: code, afterCode: code, fixOutcome: "adopted" },
});

function stateWithSlot(slotData) {
  let st = createInitialProjectState();
  st = projectReducer(st, { type: MODULE_STAGE_DATA_SET, modId: "m1", stageId: 11, data: slotData });
  return st;
}

describe("reducer-level telemetry carry (run 39)", () => {
  const topLevel = {
    verdict: "NEEDS_FIX", score: 58,
    _llms: [call("test_review", 1000, 300000), call("test_generate@fix", 2000, 200000)],
    _iterations: [iterEntry(1, 60, "initial_review", "x".repeat(500))],
  };
  const innerRun = {
    verdict: "NEEDS_FIX", score: 44,
    _llms: [call("test_review", 9000, 100)],
    _iterations: [iterEntry(1, 44, "initial_review", "y".repeat(400))],
  };

  it("DATA_SET keeps the prior ledgers ahead of the incoming ones (the run-39 erasure)", () => {
    let st = stateWithSlot(topLevel);
    st = projectReducer(st, { type: MODULE_STAGE_DATA_SET, modId: "m1", stageId: 11, data: innerRun });
    const slot = st.modules.m1.stageData[11];
    expect(slot.score).toBe(44);                              // verdict fields replaced
    expect(slot._llms).toHaveLength(3);                       // 2 prior + 1 new
    expect(slot._llms[0]._prior).toBe(true);
    expect(slot._llms[0].latencyMs).toBe(300000);             // the evidence run 39 lost
    expect(slot._llms[0].systemPrompt).toBeUndefined();       // slimmed
    expect(slot._iterations).toHaveLength(2);
    expect(slot._iterations[0]._prior).toBe(true);
    expect(slot._iterations[0]._structured.beforeCode).toBeUndefined();   // code dropped
    expect(slot._iterations[0]._structured.beforeCodeLen).toBe(500);      // size survives
  });

  it("DATA_MERGE gets the same treatment", () => {
    let st = stateWithSlot(topLevel);
    st = projectReducer(st, { type: MODULE_STAGE_DATA_MERGE, modId: "m1", stageId: 11, data: innerRun });
    const slot = st.modules.m1.stageData[11];
    expect(slot._llms).toHaveLength(3);
    expect(slot._llms.filter((c) => c._prior)).toHaveLength(2);
  });

  it("composes with the StateGraph-layer carry: already-carried entries do not duplicate", () => {
    let st = stateWithSlot(topLevel);
    // Simulate a payload whose _llms ALREADY contain the carried priors
    // (invokeNode did its job) — the reducer must not double them.
    const already = { score: 44, _llms: carryLlms(topLevel._llms, innerRun._llms) };
    st = projectReducer(st, { type: MODULE_STAGE_DATA_SET, modId: "m1", stageId: 11, data: already });
    const slot = st.modules.m1.stageData[11];
    expect(slot._llms).toHaveLength(3);                       // not 5
  });

  it("a slot without prior ledgers, or a payload without them, is untouched", () => {
    let st = stateWithSlot({ score: 1 });                     // no _llms
    st = projectReducer(st, { type: MODULE_STAGE_DATA_SET, modId: "m1", stageId: 11, data: innerRun });
    expect(st.modules.m1.stageData[11]._llms).toHaveLength(1);
    expect(withCarriedTelemetry(null, innerRun)).toBe(innerRun);
    expect(withCarriedTelemetry(topLevel, { score: 9 }).score).toBe(9);
  });

  it("carryIterations dedups identical entries and caps the tail", () => {
    const prior = Array.from({ length: 20 }, (_, i) => iterEntry(i, i, "review_fix", "z"));
    const next = [prior[19], iterEntry(99, 1, "initial_review", "w")];
    const out = carryIterations(prior, next);
    expect(out.filter((x) => x._prior).length).toBeLessThanOrEqual(12);   // capped
    expect(out.filter((x) => x.iter === 19)).toHaveLength(1);             // deduped
  });
});
