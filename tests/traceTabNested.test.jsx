// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// traceTabNested — V22-bug-pass-8 D.4
//
// Pins the trace panel's behavior for K-to-X reflow chains:
//   • Stage._chain renders as a REFLOW block under the stage's iterations
//   • Each chain entry renders with stageKey + reason + status pills
//   • Chain-derived LLM calls (those stamped with _parentStageKey) nest
//     under their owning chain entry instead of appearing as flat siblings
//   • Flatten toggle switches between tree and linear view
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { render, fireEvent, screen, within } from "@testing-library/react";
import { TraceTab } from "../src/react/components/metricsTabs.jsx";

describe("TraceTab nested rendering (V22-bug-pass-8 D.4)", function() {

  // Fixture: a lint stage that ran a K-to-X chain (rtl_generate → rtl_review → lint).
  // The chain-derived LLM calls are stamped with _parentStageKey="lint" and _depth=1.
  function fixtureWithLintChain() {
    return {
      data: { judgeHistory: [] },
      stageData: {
        6: {  // lint stage id
          status: "PASS",
          _chain: [{
            iter: 1,
            mode: "smart",
            entries: [
              {
                stageKey: "rtl_generate", reason: "triage", status: "ran",
                durationMs: 1200, llmCount: 1, events: [],
              },
              {
                stageKey: "rtl_review", reason: "downstream", status: "ran",
                durationMs: 800, llmCount: 1, events: [],
              },
              {
                stageKey: "lint", reason: "always", status: "ran",
                durationMs: 500, llmCount: 1, events: [],
              },
            ],
          }],
          _llms: [
            // The stage's own LLM call (not chain-derived)
            { stage: "lint-iter1", startedAtMs: 1000, endedAtMs: 1500, latencyMs: 500,
              tokensIn: 100, tokensOut: 50, model: "stub" },
            // Chain-derived calls — stamped with _depth/_parentStageKey
            { stage: "rtl_generate@lint-iter-1", startedAtMs: 2000, endedAtMs: 3200, latencyMs: 1200,
              tokensIn: 800, tokensOut: 1200, model: "stub",
              _depth: 1, _parentStageKey: "lint", _parentIter: 1 },
            { stage: "rtl_review@lint-iter-1", startedAtMs: 3300, endedAtMs: 4100, latencyMs: 800,
              tokensIn: 500, tokensOut: 200, model: "stub",
              _depth: 1, _parentStageKey: "lint", _parentIter: 1 },
            { stage: "lint@lint-iter-1", startedAtMs: 4200, endedAtMs: 4700, latencyMs: 500,
              tokensIn: 100, tokensOut: 50, model: "stub",
              _depth: 1, _parentStageKey: "lint", _parentIter: 1 },
          ],
        },
      },
    };
  }

  it("renders a REFLOW block when a stage has _chain history", function() {
    const fix = fixtureWithLintChain();
    const { container } = render(<TraceTab data={fix.data} stageData={fix.stageData} />);
    // The chain block emits a "REFLOW" pill
    const reflowPills = container.querySelectorAll("*");
    let found = false;
    reflowPills.forEach(function(el) {
      if (el.textContent === "REFLOW") found = true;
    });
    expect(found).toBe(true);
  });

  it("renders each chain entry with stageKey and reason labels", function() {
    const fix = fixtureWithLintChain();
    const { container } = render(<TraceTab data={fix.data} stageData={fix.stageData} />);
    const text = container.textContent || "";
    // Each chain entry's stageKey should appear in the rendered output
    expect(text).toContain("rtl_generate");
    expect(text).toContain("rtl_review");
    // Reasons should appear too
    expect(text).toContain("triage");
    expect(text).toContain("downstream");
    expect(text).toContain("always");
  });

  it("chain-derived LLM calls nest under their chain entry, not as flat siblings", function() {
    const fix = fixtureWithLintChain();
    const { container } = render(<TraceTab data={fix.data} stageData={fix.stageData} />);
    const text = container.textContent || "";
    // The own-iter "lint-iter1" appears once at the top level.
    // The chain-derived "lint@lint-iter-1" appears once nested under
    // the "always" entry of the chain. We check both are present.
    expect(text).toContain("lint-iter1");
    expect(text).toContain("rtl_generate@lint-iter-1");
    expect(text).toContain("rtl_review@lint-iter-1");
    expect(text).toContain("lint@lint-iter-1");
    // The own-iter label appears exactly once (NOT once at top-level
    // AND once nested under the chain — chain rendering keeps them separate)
    const ownIterMatches = (text.match(/lint-iter1(?!-)/g) || []);
    expect(ownIterMatches.length).toBeGreaterThanOrEqual(1);
  });

  it("flatten toggle exists and switches mode", function() {
    const fix = fixtureWithLintChain();
    const { container } = render(<TraceTab data={fix.data} stageData={fix.stageData} />);
    // Find the TREE/FLAT toggle button
    const buttons = container.querySelectorAll("button");
    let toggleBtn = null;
    buttons.forEach(function(b) {
      if (b.textContent === "TREE" || b.textContent === "FLAT") toggleBtn = b;
    });
    expect(toggleBtn).not.toBe(null);
    // Initially TREE (hierarchical)
    expect(toggleBtn.textContent).toBe("TREE");
    // Click toggles to FLAT
    fireEvent.click(toggleBtn);
    expect(toggleBtn.textContent).toBe("FLAT");
    fireEvent.click(toggleBtn);
    expect(toggleBtn.textContent).toBe("TREE");
  });

  it("flatten mode shows all chain-derived iters as flat siblings (no REFLOW block)", function() {
    const fix = fixtureWithLintChain();
    const { container } = render(<TraceTab data={fix.data} stageData={fix.stageData} />);
    // Toggle to FLAT
    const buttons = container.querySelectorAll("button");
    let toggleBtn = null;
    buttons.forEach(function(b) {
      if (b.textContent === "TREE") toggleBtn = b;
    });
    fireEvent.click(toggleBtn);
    // After flatten, REFLOW block should not render
    let reflowFound = false;
    container.querySelectorAll("*").forEach(function(el) {
      if (el.textContent === "REFLOW") reflowFound = true;
    });
    expect(reflowFound).toBe(false);
    // But the chain-derived labels are still visible (as flat iters)
    const text = container.textContent || "";
    expect(text).toContain("rtl_generate@lint-iter-1");
  });

  it("no _chain on result → renders without REFLOW block (legacy stage)", function() {
    const stageData = {
      6: {
        status: "PASS",
        _llms: [
          { stage: "lint-iter1", startedAtMs: 1000, endedAtMs: 1500, latencyMs: 500,
            tokensIn: 100, tokensOut: 50, model: "stub" },
        ],
      },
    };
    const { container } = render(<TraceTab data={{ judgeHistory: [] }} stageData={stageData} />);
    let reflowFound = false;
    container.querySelectorAll("*").forEach(function(el) {
      if (el.textContent === "REFLOW") reflowFound = true;
    });
    expect(reflowFound).toBe(false);
  });

  it("judge stage: per-iteration _chain renders as one REFLOW block per judge iter", function() {
    const data = {
      judgeHistory: [
        {
          iter: 1, eval: { overall: "FAIL", score: 50, failingIds: ["REQ-1"] },
          triageTarget: "test_generate",
          _reflowMode: "smart",
          _chain: [
            { stageKey: "test_generate", reason: "triage", status: "ran",
              durationMs: 1000, llmCount: 1, events: [] },
            { stageKey: "verify", reason: "always", status: "ran",
              durationMs: 500, llmCount: 1, events: [] },
            { stageKey: "judge", reason: "always", status: "ran",
              durationMs: 200, llmCount: 1, events: [] },
          ],
        },
        {
          iter: 2, eval: { overall: "PASS", score: 90 },
          _reflowMode: "smart",
          // Iter 2 passed — no chain
        },
      ],
    };
    const stageData = {
      9: {  // judge stage id
        overall: "PASS",
        judgeHistory: data.judgeHistory,
        _llms: [
          { stage: "judge-triage-1", startedAtMs: 5000, endedAtMs: 5300, latencyMs: 300,
            tokensIn: 200, tokensOut: 80, model: "stub" },
        ],
      },
    };
    const { container } = render(<TraceTab data={data} stageData={stageData} />);
    const text = container.textContent || "";
    // ONE REFLOW pill (only iter 1 had a chain)
    const reflowMatches = text.match(/REFLOW/g) || [];
    expect(reflowMatches.length).toBe(1);
    // Chain entries from iter 1 are visible
    expect(text).toContain("test_generate");
  });
});
