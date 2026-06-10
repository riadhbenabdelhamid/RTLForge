// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// traceTabSelectRun — V22 Item 4 (G.3.3)
//
// Pins the trace tab ↔ dropdown sync mechanism:
//   • Reflow runner stamps `runId` + `stageId` onto each chain entry
//     (carried via chainHistory → result._chain → trace tab rendering)
//   • TraceTab accepts an `onSelectRun(stageId, runId)` callback
//   • Each chain entry row renders an "OPEN ↗" button when runId is
//     present and the callback is wired
//   • Clicking the button fires the callback with the entry's IDs
//   • stopPropagation prevents the click from also toggling expand/collapse
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TraceTab } from "../src/react/components/metricsTabs.jsx";

// Build a stage-data fixture that contains a chain entry with runId stamped.
function fixtureWithChainRunId() {
  return {
    data: { judgeHistory: [] },
    stageData: {
      6: {
        status: "PASS",
        _chain: [{
          iter: 1,
          mode: "smart",
          entries: [
            {
              stageKey: "rtl_generate",
              stageId: 4,
              reason: "triage",
              status: "ran",
              durationMs: 1200,
              llmCount: 1,
              events: [],
              // V22 Item 4 (G.3.3) — runId stamped by runner from onSubRun
              runId: 2,
            },
            {
              stageKey: "lint",
              stageId: 6,
              reason: "always",
              status: "ran",
              durationMs: 500,
              llmCount: 1,
              events: [],
              runId: 3,
            },
          ],
        }],
        _llms: [
          { stage: "lint-iter1", startedAtMs: 1000, endedAtMs: 1500, latencyMs: 500,
            tokensIn: 100, tokensOut: 50, model: "stub" },
          { stage: "rtl_generate@lint-iter-1", startedAtMs: 2000, endedAtMs: 3200, latencyMs: 1200,
            tokensIn: 800, tokensOut: 1200, model: "stub",
            _depth: 1, _parentStageKey: "lint", _parentIter: 1 },
          { stage: "lint@lint-iter-1", startedAtMs: 3300, endedAtMs: 3800, latencyMs: 500,
            tokensIn: 100, tokensOut: 50, model: "stub",
            _depth: 1, _parentStageKey: "lint", _parentIter: 1 },
        ],
      },
    },
  };
}

describe("TraceTab → onSelectRun navigation (V22 G.3.3)", function() {

  it("renders OPEN button on chain entries with runId + callback wired", function() {
    const fix = fixtureWithChainRunId();
    const onSelectRun = vi.fn();
    const { container } = render(
      <TraceTab data={fix.data} stageData={fix.stageData} onSelectRun={onSelectRun} />
    );
    // OPEN buttons should appear (one per chain entry)
    const buttons = Array.from(container.querySelectorAll("button"));
    const openButtons = buttons.filter(function(b) {
      return /OPEN\s*↗/.test(b.textContent);
    });
    expect(openButtons.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT render OPEN button when onSelectRun is not wired (back-compat)", function() {
    const fix = fixtureWithChainRunId();
    const { container } = render(
      <TraceTab data={fix.data} stageData={fix.stageData} />
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    const openButtons = buttons.filter(function(b) {
      return /OPEN\s*↗/.test(b.textContent);
    });
    expect(openButtons.length).toBe(0);
  });

  it("does NOT render OPEN button when entry lacks runId (legacy chain history)", function() {
    const fix = {
      data: { judgeHistory: [] },
      stageData: {
        6: {
          status: "PASS",
          _chain: [{
            iter: 1, mode: "smart",
            entries: [
              // legacy: stageId present but runId missing
              { stageKey: "rtl_generate", stageId: 4, reason: "triage",
                status: "ran", durationMs: 100, llmCount: 1, events: [] },
            ],
          }],
          _llms: [
            { stage: "lint-iter1", startedAtMs: 1, endedAtMs: 2,
              latencyMs: 1, tokensIn: 1, tokensOut: 1, model: "stub" },
          ],
        },
      },
    };
    const onSelectRun = vi.fn();
    const { container } = render(
      <TraceTab data={fix.data} stageData={fix.stageData} onSelectRun={onSelectRun} />
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    const openButtons = buttons.filter(function(b) {
      return /OPEN\s*↗/.test(b.textContent);
    });
    expect(openButtons.length).toBe(0);
  });

  it("clicking OPEN button fires onSelectRun with stageId + runId", function() {
    const fix = fixtureWithChainRunId();
    const onSelectRun = vi.fn();
    const { container } = render(
      <TraceTab data={fix.data} stageData={fix.stageData} onSelectRun={onSelectRun} />
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    const firstOpen = buttons.find(function(b) {
      return /OPEN\s*↗/.test(b.textContent);
    });
    expect(firstOpen).toBeTruthy();
    fireEvent.click(firstOpen);
    expect(onSelectRun).toHaveBeenCalledTimes(1);
    // First chain entry was rtl_generate (stageId=4, runId=2)
    expect(onSelectRun).toHaveBeenCalledWith(4, 2);
  });

  it("click on OPEN button does NOT toggle expand/collapse (stopPropagation)", function() {
    const fix = fixtureWithChainRunId();
    const onSelectRun = vi.fn();
    const { container } = render(
      <TraceTab data={fix.data} stageData={fix.stageData} onSelectRun={onSelectRun} />
    );
    // Find the OPEN button. Click it. Verify the entry's expand state
    // is unchanged. We assert by checking that the row is still in
    // its initial open state — measured by presence of the nested
    // LLM call rendered underneath (the arrow nested-iter row uses
    // text "→").
    const beforeArrows = container.textContent.match(/→/g);
    const beforeCount = beforeArrows ? beforeArrows.length : 0;
    const buttons = Array.from(container.querySelectorAll("button"));
    const firstOpen = buttons.find(function(b) {
      return /OPEN\s*↗/.test(b.textContent);
    });
    fireEvent.click(firstOpen);
    const afterArrows = container.textContent.match(/→/g);
    const afterCount = afterArrows ? afterArrows.length : 0;
    // Expand state unchanged (same number of nested arrows visible)
    expect(afterCount).toBe(beforeCount);
  });

  it("each chain entry's OPEN button passes its own stageId + runId", function() {
    const fix = fixtureWithChainRunId();
    const onSelectRun = vi.fn();
    const { container } = render(
      <TraceTab data={fix.data} stageData={fix.stageData} onSelectRun={onSelectRun} />
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    const opens = buttons.filter(function(b) { return /OPEN\s*↗/.test(b.textContent); });
    expect(opens.length).toBe(2);
    fireEvent.click(opens[0]);
    fireEvent.click(opens[1]);
    expect(onSelectRun).toHaveBeenCalledTimes(2);
    // First: rtl_generate (stageId=4, runId=2)
    expect(onSelectRun.mock.calls[0]).toEqual([4, 2]);
    // Second: lint (stageId=6, runId=3)
    expect(onSelectRun.mock.calls[1]).toEqual([6, 3]);
  });
});

// ─── Runner contract: chain entries carry runId + stageId ───────────────
describe("reflowRunner stamps runId + stageId on chainHistory entries (V22 G.3.3)", function() {

  it("chainHistory entry has runId returned by onSubRun", async function() {
    const { runReflowChain } = await import("../src/pipeline/reflowRunner.js");
    let publishedCount = 0;
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
          return { [stageKey]: {}, _llms: [] };
        },
        allStages: [
          { id: 4, key: "rtl_generate", order: 40 },
          { id: 6, key: "lint", order: 60 },
        ],
        onSubRun: function(rec) {
          publishedCount++;
          // Mimic runStage's wrapper: return the assigned runId.
          // We use publishedCount as a stand-in for sequential IDs.
          return 100 + publishedCount;
        },
      },
    };
    const result = await runReflowChain({
      chain: [
        { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
        { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
      ],
      st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    expect(result.chainHistory.length).toBe(2);
    expect(result.chainHistory[0].runId).toBe(101);  // first onSubRun returned 101
    expect(result.chainHistory[0].stageId).toBe(4);
    expect(result.chainHistory[1].runId).toBe(102);
    expect(result.chainHistory[1].stageId).toBe(6);
  });

  it("chainHistory entry has runId=null when onSubRun is unwired (back-compat)", async function() {
    const { runReflowChain } = await import("../src/pipeline/reflowRunner.js");
    const st = {
      _config: {}, _onLog: function() {}, _onLoopback: function() {}, _signal: null,
      _logger: {
        events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 0, parentStageKey: null, parentIter: null },
      },
      _services: {
        invokeNode: async function(stageKey) { return { [stageKey]: {}, _llms: [] }; },
        allStages: [{ id: 6, key: "lint", order: 60 }],
        // No onSubRun
      },
    };
    const result = await runReflowChain({
      chain: [{ stageId: 6, stageKey: "lint", order: 60, reason: "triage" }],
      st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    expect(result.chainHistory[0].runId).toBeNull();
    expect(result.chainHistory[0].stageId).toBe(6);  // stageId still stamped
  });

  it("chainHistory entry has runId=null when onSubRun returns non-number", async function() {
    const { runReflowChain } = await import("../src/pipeline/reflowRunner.js");
    const st = {
      _config: {}, _onLog: function() {}, _onLoopback: function() {}, _signal: null,
      _logger: {
        events: [],
        state: function() {}, llm: function() {}, cli: function() {},
        skill: function() {}, prompt: function() {}, result: function() {},
        context: { depth: 0, parentStageKey: null, parentIter: null },
      },
      _services: {
        invokeNode: async function(stageKey) { return { [stageKey]: {}, _llms: [] }; },
        allStages: [{ id: 6, key: "lint", order: 60 }],
        onSubRun: function() { /* returns undefined */ },
      },
    };
    const result = await runReflowChain({
      chain: [{ stageId: 6, stageKey: "lint", order: 60, reason: "triage" }],
      st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
    expect(result.chainHistory[0].runId).toBeNull();
  });
});
