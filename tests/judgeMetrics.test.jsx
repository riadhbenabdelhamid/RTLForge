// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { JudgeStage } from "../src/react/components/stages.jsx";

describe("JudgeStage Duration + Tokens tabs (V22 #8/#9)", function() {
  // Minimal judge data — overall PASS, trivial trace + recs
  const baseJudge = {
    overall: "PASS",
    score: 90,
    trace: [{ req: "REQ-FUNC-001", ok: true, note: "covered" }],
    recs: ["Looks good."],
  };

  // stageData fixture covering a few stages with full timing + token telemetry
  // (stage ids per src/constants/stages.js: 1=elicit, 4=rtl_generate, 6=lint)
  const sampleStageData = {
    1: { _llms: [
      { stage: "elicit", startedAtMs: 1000, endedAtMs: 2500, latencyMs: 1500,
        tokensIn: 100, tokensOut: 50, model: "claude-sonnet-4", provider: "anthropic" },
    ]},
    4: { _llms: [
      { stage: "rtl_generate", startedAtMs: 3000, endedAtMs: 6500, latencyMs: 3500,
        tokensIn: 800, tokensOut: 1200, model: "claude-sonnet-4", provider: "anthropic" },
    ]},
    6: { _llms: [
      { stage: "lint-iter1", startedAtMs: 7000, endedAtMs: 7800, latencyMs: 800,
        tokensIn: 200, tokensOut: 100, model: "claude-sonnet-4", provider: "anthropic" },
      { stage: "rtl-fix-iter1", startedAtMs: 8000, endedAtMs: 9200, latencyMs: 1200,
        tokensIn: 600, tokensOut: 900, model: "claude-sonnet-4", provider: "anthropic" },
    ]},
  };

  it("does NOT show Duration / Tokens tabs when stageData is not provided", function() {
    const { container } = render(<JudgeStage data={baseJudge} />);
    expect(container.textContent).not.toMatch(/Duration/);
    expect(container.textContent).not.toMatch(/^Tokens$|>\s*Tokens\s*</);
  });

  it("shows Duration and Tokens tabs when stageData is provided", function() {
    const { container } = render(
      <JudgeStage data={baseJudge} stageData={sampleStageData} />
    );
    expect(container.textContent).toMatch(/Duration/);
    expect(container.textContent).toMatch(/Tokens/);
  });

  it("clicking Duration tab renders pie chart + per-call table + methodology footer", function() {
    const { container, getByText } = render(
      <JudgeStage data={baseJudge} stageData={sampleStageData} />
    );
    fireEvent.click(getByText("Duration"));
    const txt = container.textContent;
    // Headline shows total elapsed (window 1000→9200 = 8200ms = 8.2s)
    expect(txt).toMatch(/8\.2s|total elapsed/);
    // Per-stage labels appear
    expect(txt).toMatch(/Elicit/);
    expect(txt).toMatch(/RTL/);
    expect(txt).toMatch(/Lint RTL/);
    // Methodology footer
    expect(txt).toMatch(/How timing is measured/);
    expect(txt).toMatch(/Date\.now\(\)/);
    expect(txt).toMatch(/performance\.now\(\)/);
    // SVG pie present
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("Duration tab — per-call table shows 4 rows + 1 footer total", function() {
    const { container, getByText } = render(
      <JudgeStage data={baseJudge} stageData={sampleStageData} />
    );
    fireEvent.click(getByText("Duration"));
    const tbodies = container.querySelectorAll("tbody");
    expect(tbodies.length).toBeGreaterThanOrEqual(1);
    // 4 calls total (elicit + rtl_generate + 2 lint sub-calls)
    const rows = container.querySelectorAll("tbody tr");
    expect(rows.length).toBe(4);
    // Footer has the total
    const tfoots = container.querySelectorAll("tfoot");
    expect(tfoots.length).toBeGreaterThanOrEqual(1);
    expect(tfoots[0].textContent).toMatch(/TOTAL ELAPSED/);
  });

  it("clicking Tokens tab renders two pie charts (input + output)", function() {
    const { container, getByText } = render(
      <JudgeStage data={baseJudge} stageData={sampleStageData} />
    );
    fireEvent.click(getByText("Tokens"));
    const txt = container.textContent;
    // Headline shows both input and output sums
    // tokensIn  total = 100 + 800 + 200 + 600 = 1700
    // tokensOut total =  50 + 1200 + 100 + 900 = 2250
    expect(txt).toMatch(/1,700/);
    expect(txt).toMatch(/2,250/);
    // Pie panel titles
    expect(txt).toMatch(/Input tokens per stage/);
    expect(txt).toMatch(/Output tokens per stage/);
    // Two pie charts (each panel has one) — total SVGs ≥ 2
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThanOrEqual(2);
    // Methodology footer
    expect(txt).toMatch(/How tokens are counted/);
    expect(txt).toMatch(/Provider telemetry/);
  });

  it("Tokens tab: missing telemetry renders '—' and surfaces an explicit warning (no fabrication)", function() {
    const missingData = {
      1: { _llms: [
        // No tokensIn / tokensOut at all — provider didn't return usage
        { stage: "elicit", latencyMs: 500, userMessage: "x".repeat(400),
          text: "y".repeat(200), model: "lm-studio-local", provider: "lmstudio" },
      ]},
    };
    const { container, getByText } = render(
      <JudgeStage data={baseJudge} stageData={missingData} />
    );
    fireEvent.click(getByText("Tokens"));
    const txt = container.textContent;
    // Explicit "missing telemetry" notice in the headline
    expect(txt).toMatch(/missing telemetry/);
    // Footer must NOT mention char/4 estimation — that's no longer policy
    expect(txt).not.toMatch(/Char\/4 estimate/);
    expect(txt).toMatch(/Telemetry incomplete/);
    expect(txt).toMatch(/never estimated/);
    // The table value renders as "—" not a fabricated number
    expect(txt).toMatch(/—/);
    // And explicitly does NOT contain the old char/4-derived value "100*"
    expect(txt).not.toMatch(/100\*/);
  });

  it("empty state: stageData with no _llms entries shows 'no LLM calls captured'", function() {
    const { container, getByText } = render(
      <JudgeStage data={baseJudge} stageData={{}} />
    );
    fireEvent.click(getByText("Duration"));
    expect(container.textContent).toMatch(/No LLM calls captured/);
    fireEvent.click(getByText("Tokens"));
    expect(container.textContent).toMatch(/No LLM calls captured/);
  });

  it("Duration tab — falls back to cumulative tag when no wall-clock data", function() {
    const monotonicOnlyData = {
      1: { _llms: [
        { stage: "elicit", latencyMs: 1000, tokensIn: 10, tokensOut: 5 },
      ]},
      4: { _llms: [
        { stage: "rtl_generate", latencyMs: 2500, tokensIn: 50, tokensOut: 100 },
      ]},
    };
    const { container, getByText } = render(
      <JudgeStage data={baseJudge} stageData={monotonicOnlyData} />
    );
    fireEvent.click(getByText("Duration"));
    // The "cumulative (no wall-clock)" tag should appear
    expect(container.textContent).toMatch(/cumulative.*no wall-clock|no wall-clock/);
    // Total = 3500ms = 3.5s
    expect(container.textContent).toMatch(/3\.5s/);
  });

  it("per-call rows show iter annotation when stage has -iter<N> suffix", function() {
    const { container, getByText } = render(
      <JudgeStage data={baseJudge} stageData={sampleStageData} />
    );
    fireEvent.click(getByText("Duration"));
    expect(container.textContent).toMatch(/iter 1/);
  });
});
