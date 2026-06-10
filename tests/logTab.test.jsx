// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { LogTab } from "../src/react/components/logTab.jsx";

describe("LogTab (V22-bug-pass-5 #4)", function() {
  // Sample log events covering every type
  const sampleEvents = [
    {
      ts: Date.UTC(2026, 0, 1, 12, 0, 0),
      type: "llm",
      iter: 1, model: "claude-sonnet-4", provider: "anthropic",
      systemPrompt: "You are a helpful assistant.",
      userMessage:  "Generate a synchronous FIFO module with parameterizable depth and width.",
      response:     '{"code": "module sync_fifo (clk, rst_n, ...);"}',
      tokensIn: 1200, tokensOut: 850, latencyMs: 3200,
      startedAtMs: Date.UTC(2026, 0, 1, 12, 0, 0),
      endedAtMs:   Date.UTC(2026, 0, 1, 12, 0, 3),
      promptTruncated: false, responseTruncated: false,
    },
    {
      ts: Date.UTC(2026, 0, 1, 12, 0, 5),
      type: "cli",
      command: "verilator --binary --coverage foo.sv tb.sv",
      stdout: "Simulation complete.\nLine coverage: 92%",
      stderr: "",
      exitCode: 0, latencyMs: 4100,
    },
    {
      ts: Date.UTC(2026, 0, 1, 12, 0, 8),
      type: "state",
      iter: 2,
      message: "iter 2 — lint loop-back triggered by 3 errors",
    },
    {
      ts: Date.UTC(2026, 0, 1, 12, 0, 12),
      type: "result",
      status: "PASS",
      summary: "all checks passed after 2 iterations",
    },
  ];

  it("renders all event rows by default", function() {
    const { container } = render(
      <LogTab data={{ _log: sampleEvents }} stageKey="rtl_generate" stageLabel="RTL Generate" />
    );
    const txt = container.textContent;
    expect(txt).toMatch(/4 of 4 events/);
    expect(txt).toMatch(/claude-sonnet-4/);
    expect(txt).toMatch(/verilator/);
    expect(txt).toMatch(/loop-back triggered/);
    expect(txt).toMatch(/PASS/);
  });

  it("filter toolbar toggles LLM events off", function() {
    const { container } = render(
      <LogTab data={{ _log: sampleEvents }} stageKey="rtl_generate" stageLabel="RTL Generate" />
    );
    // Click LLM filter button to disable
    const buttons = Array.from(container.querySelectorAll("button"));
    const llmBtn = buttons.find(function(b) { return /^LLM/.test(b.textContent); });
    expect(llmBtn).toBeTruthy();
    fireEvent.click(llmBtn);
    // Now only 3 of 4 events visible
    expect(container.textContent).toMatch(/3 of 4 events/);
    // LLM-specific content gone
    expect(container.textContent).not.toMatch(/claude-sonnet-4/);
  });

  it("empty log shows 'No log events captured'", function() {
    const { container } = render(
      <LogTab data={{ _log: [] }} stageKey="elicit" stageLabel="Elicit" />
    );
    expect(container.textContent).toMatch(/No log events captured/);
  });

  it("missing _log array shows 'No log events captured'", function() {
    const { container } = render(
      <LogTab data={{}} stageKey="elicit" stageLabel="Elicit" />
    );
    expect(container.textContent).toMatch(/No log events captured/);
  });

  it("download button shows .log and .json picker", function() {
    const { container, getByText } = render(
      <LogTab data={{ _log: sampleEvents }} stageKey="rtl_generate" stageLabel="RTL Generate" />
    );
    const dlBtn = getByText("Download ↓");
    fireEvent.click(dlBtn);
    expect(container.textContent).toMatch(/Plain log/);
    expect(container.textContent).toMatch(/Structured/);
  });

  it("LLM event with long response: expand row reveals systemPrompt/userMessage/response", function() {
    const longResponse = "z".repeat(500);
    const longEvent = [{
      ts: 1000, type: "llm", iter: 1, model: "claude-sonnet-4",
      systemPrompt: "x".repeat(300), userMessage: "y".repeat(300),
      response: longResponse,
      tokensIn: 100, tokensOut: 50, latencyMs: 800,
      promptTruncated: true, responseTruncated: true,
    }];
    const { container } = render(
      <LogTab data={{ _log: longEvent }} stageKey="x" stageLabel="X" />
    );
    // Click the row to expand
    const rows = container.querySelectorAll('div[style*="cursor: pointer"]');
    const llmRow = Array.from(rows).find(function(r) {
      return /claude-sonnet-4/.test(r.textContent);
    });
    expect(llmRow).toBeTruthy();
    fireEvent.click(llmRow);
    // Now System Prompt / User Message / Response labels are visible
    // (rendered uppercase via CSS, but textContent retains original case)
    expect(container.textContent).toMatch(/System Prompt/);
    expect(container.textContent).toMatch(/User Message/);
    expect(container.textContent).toMatch(/Response/);
    // "show full" button is visible because content is truncated
    expect(container.textContent).toMatch(/show full/);
  });

  it("filter button is disabled when no events of that type exist", function() {
    const onlyLLM = [{
      ts: 1000, type: "llm", iter: 1, model: "x",
      tokensIn: 100, tokensOut: 50, latencyMs: 100,
    }];
    const { container } = render(
      <LogTab data={{ _log: onlyLLM }} stageKey="x" stageLabel="X" />
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    const cliBtn = buttons.find(function(b) { return /^CLI/.test(b.textContent); });
    expect(cliBtn).toBeTruthy();
    expect(cliBtn.disabled).toBe(true);
  });
});
