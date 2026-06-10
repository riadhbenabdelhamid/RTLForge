// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// runSelectorDropdown — V22 Item 4 (G.3.2)
//
// Pins:
//   • Component returns null when runs.length < 2 (no choice to make)
//   • Each run renders as an option with the right label, glyph, age
//   • labelForRun handles top-level (no context) vs chain re-runs vs deep nesting
//   • Picking a non-latest option calls onSelectRun(runId)
//   • Picking the latest option calls onSelectRun(null) to "follow latest"
//   • The reset button appears only when a non-default selection is active
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { RunSelectorDropdown, labelForRun } from "../src/react/components/runSelectorDropdown.jsx";

// ─── labelForRun pure function ──────────────────────────────────────────
describe("labelForRun (V22 G.3.2)", function() {

  it("renders 'Original run' for top-level run with no context", function() {
    const run = { runId: 1, trigger: "user", context: null };
    expect(labelForRun(run)).toBe("Original run");
  });

  it("renders 'Original run' when context.depth is 0 or null (defensive)", function() {
    expect(labelForRun({ runId: 1, trigger: "user", context: { depth: 0 } })).toBe("Original run");
    expect(labelForRun({ runId: 1, trigger: "user", context: { depth: null } })).toBe("Original run");
  });

  it("renders chain re-run at depth 1 with parent stage + iter", function() {
    const run = {
      runId: 2,
      trigger: "reflow:lint",
      context: { depth: 1, parentStageKey: "lint", parentIter: 2, reason: "triage" },
    };
    expect(labelForRun(run)).toBe("Re-run inside lint iter 2 (depth 1)");
  });

  it("renders chain re-run at depth 2 with depth annotation", function() {
    const run = {
      runId: 3,
      trigger: "reflow:verify",
      context: { depth: 2, parentStageKey: "verify", parentIter: 1, reason: "triage" },
    };
    expect(labelForRun(run)).toBe("Re-run inside verify iter 1 (depth 2)");
  });

  it("renders chain re-run at depth 3", function() {
    const run = {
      runId: 4,
      trigger: "reflow:judge",
      context: { depth: 3, parentStageKey: "judge", parentIter: 1, reason: "triage" },
    };
    expect(labelForRun(run)).toBe("Re-run inside judge iter 1 (depth 3)");
  });

  it("handles missing parentIter gracefully (shows '?')", function() {
    const run = {
      runId: 2,
      trigger: "reflow:lint",
      context: { depth: 1, parentStageKey: "lint" },
    };
    expect(labelForRun(run)).toMatch(/iter \?/);
  });

  it("handles null run defensively", function() {
    expect(labelForRun(null)).toBe("(unknown run)");
    expect(labelForRun(undefined)).toBe("(unknown run)");
  });
});

// ─── Component rendering ────────────────────────────────────────────────
describe("RunSelectorDropdown rendering (V22 G.3.2)", function() {

  it("returns null when runs is empty (nothing to show)", function() {
    const { container } = render(
      <RunSelectorDropdown stageId={6} runs={[]} selectedRunId={null} onSelectRun={function() {}} />
    );
    expect(container.textContent).toBe("");
  });

  it("returns null when only one run exists (no choice to make)", function() {
    const runs = [
      { runId: 1, trigger: "user", ts: Date.now() - 5000, status: "complete",
        result: { foo: "bar" }, context: null },
    ];
    const { container } = render(
      <RunSelectorDropdown stageId={6} runs={runs} selectedRunId={null} onSelectRun={function() {}} />
    );
    expect(container.textContent).toBe("");
  });

  it("renders an option per run when runs.length >= 2", function() {
    const runs = [
      { runId: 1, trigger: "user", ts: Date.now() - 10000, finishedAt: Date.now() - 9000,
        status: "complete", result: { v: 1 }, context: null },
      { runId: 2, trigger: "reflow:lint", ts: Date.now() - 5000, finishedAt: Date.now() - 4000,
        status: "complete", result: { v: 2 },
        context: { depth: 1, parentStageKey: "lint", parentIter: 2, reason: "triage" } },
    ];
    const { container } = render(
      <RunSelectorDropdown stageId={6} runs={runs} selectedRunId={null} onSelectRun={function() {}} />
    );
    const options = container.querySelectorAll("option");
    expect(options.length).toBe(2);
    expect(options[0].textContent).toContain("Original run");
    expect(options[1].textContent).toContain("Re-run inside lint iter 2");
    expect(options[1].textContent).toContain("latest");  // the most recent run is tagged
  });

  it("defaults to latest run when selectedRunId is null", function() {
    const runs = [
      { runId: 1, trigger: "user", ts: Date.now() - 10000,
        status: "complete", result: { v: 1 }, context: null },
      { runId: 2, trigger: "reflow:lint", ts: Date.now() - 5000,
        status: "complete", result: { v: 2 },
        context: { depth: 1, parentStageKey: "lint", parentIter: 1, reason: "triage" } },
    ];
    const { container } = render(
      <RunSelectorDropdown stageId={6} runs={runs} selectedRunId={null} onSelectRun={function() {}} />
    );
    const select = container.querySelector("select");
    expect(select.value).toBe("2");  // latest
  });

  it("reflects explicit selectedRunId in the select value", function() {
    const runs = [
      { runId: 1, trigger: "user", ts: Date.now() - 10000,
        status: "complete", result: { v: 1 }, context: null },
      { runId: 2, trigger: "reflow:lint", ts: Date.now() - 5000,
        status: "complete", result: { v: 2 },
        context: { depth: 1, parentStageKey: "lint", parentIter: 1, reason: "triage" } },
    ];
    const { container } = render(
      <RunSelectorDropdown stageId={6} runs={runs} selectedRunId={1} onSelectRun={function() {}} />
    );
    const select = container.querySelector("select");
    expect(select.value).toBe("1");
  });

  it("renders status badge for the selected run", function() {
    const runs = [
      { runId: 1, trigger: "user", ts: Date.now() - 10000,
        status: "complete", result: { v: 1 }, context: null },
      { runId: 2, trigger: "reflow:lint", ts: Date.now() - 5000,
        status: "error", result: null,
        context: { depth: 1, parentStageKey: "lint", parentIter: 1,
                   reason: "triage", error: "boom" } },
    ];
    const { container } = render(
      <RunSelectorDropdown stageId={6} runs={runs} selectedRunId={2} onSelectRun={function() {}} />
    );
    expect(container.textContent).toMatch(/error/i);
  });

  it("reset-to-latest button appears only when a non-default selection is active", function() {
    const runs = [
      { runId: 1, trigger: "user", ts: Date.now() - 10000, status: "complete",
        result: { v: 1 }, context: null },
      { runId: 2, trigger: "reflow:lint", ts: Date.now() - 5000, status: "complete",
        result: { v: 2 },
        context: { depth: 1, parentStageKey: "lint", parentIter: 1, reason: "triage" } },
    ];
    // selectedRunId=null → no reset button
    const r1 = render(
      <RunSelectorDropdown stageId={6} runs={runs} selectedRunId={null} onSelectRun={function() {}} />
    );
    expect(r1.container.textContent).not.toContain("↻ LATEST");
    // selectedRunId=1 → reset button appears
    const r2 = render(
      <RunSelectorDropdown stageId={6} runs={runs} selectedRunId={1} onSelectRun={function() {}} />
    );
    expect(r2.container.textContent).toContain("↻ LATEST");
  });
});

// ─── Selection writes ───────────────────────────────────────────────────
describe("RunSelectorDropdown selection callbacks (V22 G.3.2)", function() {

  it("picking a non-latest run calls onSelectRun(runId)", function() {
    const onSelectRun = vi.fn();
    const runs = [
      { runId: 1, trigger: "user", ts: Date.now() - 10000, status: "complete",
        result: { v: 1 }, context: null },
      { runId: 2, trigger: "reflow:lint", ts: Date.now() - 5000, status: "complete",
        result: { v: 2 },
        context: { depth: 1, parentStageKey: "lint", parentIter: 1, reason: "triage" } },
    ];
    const { container } = render(
      <RunSelectorDropdown stageId={6} runs={runs} selectedRunId={null} onSelectRun={onSelectRun} />
    );
    const select = container.querySelector("select");
    fireEvent.change(select, { target: { value: "1" } });
    expect(onSelectRun).toHaveBeenCalledWith(1);
  });

  it("picking the latest run calls onSelectRun(null) to follow latest", function() {
    const onSelectRun = vi.fn();
    const runs = [
      { runId: 1, trigger: "user", ts: Date.now() - 10000, status: "complete",
        result: { v: 1 }, context: null },
      { runId: 2, trigger: "reflow:lint", ts: Date.now() - 5000, status: "complete",
        result: { v: 2 },
        context: { depth: 1, parentStageKey: "lint", parentIter: 1, reason: "triage" } },
    ];
    const { container } = render(
      <RunSelectorDropdown stageId={6} runs={runs} selectedRunId={1} onSelectRun={onSelectRun} />
    );
    const select = container.querySelector("select");
    fireEvent.change(select, { target: { value: "2" } });
    expect(onSelectRun).toHaveBeenCalledWith(null);
  });

  it("clicking ↻ LATEST calls onSelectRun(null)", function() {
    const onSelectRun = vi.fn();
    const runs = [
      { runId: 1, trigger: "user", ts: Date.now() - 10000, status: "complete",
        result: { v: 1 }, context: null },
      { runId: 2, trigger: "reflow:lint", ts: Date.now() - 5000, status: "complete",
        result: { v: 2 },
        context: { depth: 1, parentStageKey: "lint", parentIter: 1, reason: "triage" } },
    ];
    const { container } = render(
      <RunSelectorDropdown stageId={6} runs={runs} selectedRunId={1} onSelectRun={onSelectRun} />
    );
    // Find the reset button by its text
    let resetBtn = null;
    container.querySelectorAll("button").forEach(function(b) {
      if (b.textContent.includes("↻ LATEST")) resetBtn = b;
    });
    expect(resetBtn).not.toBe(null);
    fireEvent.click(resetBtn);
    expect(onSelectRun).toHaveBeenCalledWith(null);
  });
});
