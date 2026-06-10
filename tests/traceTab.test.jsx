// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { JudgeStage } from "../src/react/components/stages.jsx";

describe("JudgeStage Trace tab (V22-bug-pass-2 #5)", function() {
  const baseJudge = {
    overall: "PASS", score: 95,
    trace: [], recs: [],
  };

  const sampleStageData = {
    // Elicit: single call
    1: { _llms: [
      { stage: "elicit", startedAtMs: 1000, endedAtMs: 2000, latencyMs: 1000,
        tokensIn: 100, tokensOut: 50, model: "claude-sonnet-4" },
    ]},
    // Spec: single call
    2: { _llms: [
      { stage: "spec", startedAtMs: 2100, endedAtMs: 3500, latencyMs: 1400,
        tokensIn: 200, tokensOut: 300, model: "claude-sonnet-4" },
    ]},
    // RTL Gen: single call
    4: { code: "module foo;", _llms: [
      { stage: "rtl_generate", startedAtMs: 4000, endedAtMs: 6000, latencyMs: 2000,
        tokensIn: 500, tokensOut: 800, model: "claude-sonnet-4" },
    ]},
    // Lint: multiple iterations (loop-back inside)
    6: { status: "PASS", _llms: [
      { stage: "lint-iter1", startedAtMs: 6500, endedAtMs: 7000, latencyMs: 500,
        tokensIn: 100, tokensOut: 100 },
      { stage: "rtl-fix-iter1", startedAtMs: 7100, endedAtMs: 8500, latencyMs: 1400,
        tokensIn: 600, tokensOut: 700 },
      { stage: "lint-iter2", startedAtMs: 8600, endedAtMs: 9000, latencyMs: 400,
        tokensIn: 100, tokensOut: 50 },
    ]},
    // Verify: 4/4 pass
    8: { pass: 4, fail: 0, total: 4, _llms: [
      { stage: "verify", startedAtMs: 10000, endedAtMs: 11000, latencyMs: 1000,
        tokensIn: 50, tokensOut: 30 },
    ]},
    // Judge: 2 iterations with triage decisions
    9: { overall: "PASS", _llms: [
      { stage: "judge-triage-1", startedAtMs: 11500, endedAtMs: 12000, latencyMs: 500,
        tokensIn: 200, tokensOut: 100 },
      { stage: "rtl-regen-judge-1", startedAtMs: 12100, endedAtMs: 14000, latencyMs: 1900,
        tokensIn: 800, tokensOut: 1200 },
      { stage: "judge-triage-2", startedAtMs: 14100, endedAtMs: 14500, latencyMs: 400,
        tokensIn: 200, tokensOut: 100 },
    ]},
  };
  const judgeData = Object.assign({}, baseJudge, {
    judgeHistory: [
      { iter: 1, eval: { overall: "FAIL", score: 60, failed: 2,
        failingIds: ["req_func_must", "verify_pass_rate"] },
        overall: "FAIL", score: 60, unmet: 2, total: 18,
        triageTarget: "rtl_generate" },
      { iter: 2, eval: { overall: "PASS", score: 95, failed: 0, failingIds: [] },
        overall: "PASS", score: 95, unmet: 0, total: 18 },
    ],
  });

  it("Trace tab is shown when stageData is provided", function() {
    const { container } = render(<JudgeStage data={judgeData} stageData={sampleStageData} />);
    // The literal "Trace" button label (distinct from "Traceability")
    const buttons = Array.from(container.querySelectorAll("button"));
    const traceBtn = buttons.find(function(b) {
      return b.textContent && b.textContent.trim() === "Trace";
    });
    expect(traceBtn).toBeTruthy();
  });

  it("Trace tab is NOT shown when stageData is missing", function() {
    const { container } = render(<JudgeStage data={judgeData} />);
    const buttons = Array.from(container.querySelectorAll("button"));
    const traceBtn = buttons.find(function(b) {
      return b.textContent && b.textContent.trim() === "Trace";
    });
    expect(traceBtn).toBeUndefined();
  });

  it("clicking Trace renders header strip + tree + legend", function() {
    const { container } = render(<JudgeStage data={judgeData} stageData={sampleStageData} />);
    const buttons = Array.from(container.querySelectorAll("button"));
    const traceBtn = buttons.find(function(b) {
      return b.textContent && b.textContent.trim() === "Trace";
    });
    fireEvent.click(traceBtn);
    const txt = container.textContent;
    // Header strip
    expect(txt).toMatch(/Execution Trace/);
    // Stage labels appear
    expect(txt).toMatch(/Elicit/);
    expect(txt).toMatch(/Spec/);
    expect(txt).toMatch(/Lint RTL/);
    expect(txt).toMatch(/Verify/);
    expect(txt).toMatch(/Judge/);
    // Legend
    expect(txt).toMatch(/How to read this trace/);
    expect(txt).toMatch(/Date\.now\(\)/);
  });

  it("loop-back iterations show the ↺ marker; forward iterations show →", function() {
    const { container } = render(<JudgeStage data={judgeData} stageData={sampleStageData} />);
    const traceBtn = Array.from(container.querySelectorAll("button"))
      .find(function(b) { return b.textContent && b.textContent.trim() === "Trace"; });
    fireEvent.click(traceBtn);
    const txt = container.textContent;
    // rtl-fix-iter1 is a loop-back; should show ↺
    expect(txt).toMatch(/↺/);
    // Forward marker also present
    expect(txt).toMatch(/→/);
  });

  it("judge iterations annotate the reason inline with triage target", function() {
    const { container } = render(<JudgeStage data={judgeData} stageData={sampleStageData} />);
    const traceBtn = Array.from(container.querySelectorAll("button"))
      .find(function(b) { return b.textContent && b.textContent.trim() === "Trace"; });
    fireEvent.click(traceBtn);
    const txt = container.textContent;
    // Inline "Reason:" row appears for the judge iteration with a failed verdict
    expect(txt).toMatch(/Reason:/);
    // Gate FAIL message with criteria count
    expect(txt).toMatch(/Gate FAIL/);
    // Triage target rendered
    expect(txt).toMatch(/next:/);
    expect(txt).toMatch(/rtl_generate/);
    // Failing criteria spelled out
    expect(txt).toMatch(/req_func_must/);
  });

  it("collapsing a stage hides its iteration rows", function() {
    const { container } = render(<JudgeStage data={judgeData} stageData={sampleStageData} />);
    const traceBtn = Array.from(container.querySelectorAll("button"))
      .find(function(b) { return b.textContent && b.textContent.trim() === "Trace"; });
    fireEvent.click(traceBtn);
    // Lint is open by default — find the header div whose direct content
    // is the down-chevron AND mentions Lint RTL.
    const headers = Array.from(container.querySelectorAll("div"));
    const lintHeader = headers.find(function(d) {
      return d.style && d.style.cursor === "pointer" &&
        d.textContent && d.textContent.includes("Lint RTL") &&
        d.textContent.includes("▾");
    });
    expect(lintHeader).toBeTruthy();
    expect(container.textContent).toMatch(/lint-iter1/);
    fireEvent.click(lintHeader);
    // After collapse, lint-iter1 should no longer be in the DOM
    expect(container.textContent).not.toMatch(/lint-iter1/);
    expect(container.textContent).toMatch(/▸/);
  });

  it("empty state: no stageData with _llms shows 'no execution events captured'", function() {
    const { container } = render(<JudgeStage data={judgeData} stageData={{}} />);
    const traceBtn = Array.from(container.querySelectorAll("button"))
      .find(function(b) { return b.textContent && b.textContent.trim() === "Trace"; });
    fireEvent.click(traceBtn);
    expect(container.textContent).toMatch(/No execution events captured/);
  });

  it("stages with non-PASS status show their status in a colored pill", function() {
    const failingData = {
      6: { status: "FAIL", _llms: [
        { stage: "lint-iter1", startedAtMs: 1000, endedAtMs: 2000, latencyMs: 1000,
          tokensIn: 100, tokensOut: 50 },
      ]},
    };
    const { container } = render(<JudgeStage data={judgeData} stageData={failingData} />);
    const traceBtn = Array.from(container.querySelectorAll("button"))
      .find(function(b) { return b.textContent && b.textContent.trim() === "Trace"; });
    fireEvent.click(traceBtn);
    // FAIL status visible on the lint row
    expect(container.textContent).toMatch(/Lint: FAIL/);
  });
});
