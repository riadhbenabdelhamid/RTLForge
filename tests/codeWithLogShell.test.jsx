// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CodeWithLogShell } from "../src/react/components/codeWithLogShell.jsx";

describe("CodeWithLogShell (V22-bug-pass-5)", function() {
  const sampleLog = [
    {
      ts: Date.UTC(2026, 0, 1, 12, 0, 0),
      type: "llm",
      iter: 1, model: "claude-sonnet-4", provider: "anthropic",
      systemPrompt: "sys", userMessage: "u", response: "r",
      tokensIn: 100, tokensOut: 50, latencyMs: 800,
    },
  ];

  it("renders children inside the Code tab by default", function() {
    const { container, getByText } = render(
      <CodeWithLogShell data={{ code: "module foo;" }} stageKey="rtl_generate" stageLabel="RTL Gen" codeLabel="RTL">
        <div>SPLIT_CODE_VIEW_CONTENT</div>
      </CodeWithLogShell>
    );
    expect(container.textContent).toMatch(/SPLIT_CODE_VIEW_CONTENT/);
    // Tab labeled "RTL" must be present
    expect(getByText("RTL")).toBeTruthy();
  });

  it("Log tab is hidden when no log events captured", function() {
    const { container } = render(
      <CodeWithLogShell data={{ code: "module foo;" }} stageKey="rtl_generate" stageLabel="RTL Gen" codeLabel="RTL">
        <div>child</div>
      </CodeWithLogShell>
    );
    // No "Log" button anywhere
    const buttons = Array.from(container.querySelectorAll("button"));
    const logBtn = buttons.find(function(b) { return b.textContent === "Log"; });
    expect(logBtn).toBeUndefined();
  });

  it("Log tab appears once events are captured", function() {
    const { container, getByText } = render(
      <CodeWithLogShell data={{ code: "m;", _log: sampleLog }} stageKey="rtl_generate" stageLabel="RTL Gen" codeLabel="RTL">
        <div>SPLIT_CODE_VIEW_CONTENT</div>
      </CodeWithLogShell>
    );
    // Log tab visible
    expect(getByText("Log")).toBeTruthy();
    // Children visible on Code tab (default)
    expect(container.textContent).toMatch(/SPLIT_CODE_VIEW_CONTENT/);
  });

  it("clicking Log tab swaps to log content; children hidden", function() {
    const { container, getByText } = render(
      <CodeWithLogShell data={{ code: "m;", _log: sampleLog }} stageKey="rtl_generate" stageLabel="RTL Gen" codeLabel="RTL">
        <div>SPLIT_CODE_VIEW_CONTENT</div>
      </CodeWithLogShell>
    );
    fireEvent.click(getByText("Log"));
    // Children hidden
    expect(container.textContent).not.toMatch(/SPLIT_CODE_VIEW_CONTENT/);
    // LogTab content visible — recognizable by the "About this log" footer
    expect(container.textContent).toMatch(/About this log/);
    // Event summary shows
    expect(container.textContent).toMatch(/claude-sonnet-4/);
  });

  it("clicking Code tab swaps back; children visible again", function() {
    const { container, getByText } = render(
      <CodeWithLogShell data={{ code: "m;", _log: sampleLog }} stageKey="rtl_generate" stageLabel="RTL Gen" codeLabel="RTL">
        <div>SPLIT_CODE_VIEW_CONTENT</div>
      </CodeWithLogShell>
    );
    fireEvent.click(getByText("Log"));
    expect(container.textContent).not.toMatch(/SPLIT_CODE_VIEW_CONTENT/);
    fireEvent.click(getByText("RTL"));
    expect(container.textContent).toMatch(/SPLIT_CODE_VIEW_CONTENT/);
  });

  it("falls back to default 'Code' tab label when codeLabel prop is omitted", function() {
    const { getByText } = render(
      <CodeWithLogShell data={{ code: "m;", _log: sampleLog }} stageKey="x" stageLabel="X">
        <div>child</div>
      </CodeWithLogShell>
    );
    expect(getByText("Code")).toBeTruthy();
  });
});
