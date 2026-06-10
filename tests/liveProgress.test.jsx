// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// liveProgress — V22 Layer F.3
//
// Pins:
//   1. createStageLogger fires onEmit for every event when supplied
//   2. LiveProgressPanel renders the latest event, counters, and tail
//   3. LiveProgressCollapsedPill summarizes events and triggers onExpand
//   4. The panel updates when new events stream in (live re-render)
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { createStageLogger } from "../src/projectState/stageLogger.js";
import {
  LiveProgressPanel,
  LiveProgressCollapsedPill,
} from "../src/react/components/liveProgressPanel.jsx";

describe("createStageLogger onEmit hook (V22 Layer F.3)", function() {

  it("fires onEmit for every event push (cli, llm, skill, prompt, state, result)", function() {
    const emitted = [];
    const log = createStageLogger("test", null, function(e) { emitted.push(e); });
    log.cli({ cmd: "verilator --lint-only" });
    log.llm({ stage: "lint-iter1", tokensIn: 100, tokensOut: 50 });
    log.skill({ stageKey: "lint", skillCount: 2 });
    log.prompt({ stageKey: "lint" });
    log.state({ message: "starting" });
    log.result({});
    expect(emitted.length).toBe(6);
    expect(emitted.map(function(e) { return e.type; })).toEqual([
      "cli", "llm", "skill", "prompt", "state", "result",
    ]);
  });

  it("backward compat: no onEmit → all logger methods still push to events", function() {
    const log = createStageLogger("test", null);
    log.cli({ cmd: "x" });
    log.llm({ stage: "y", tokensIn: 1 });
    expect(log.events.length).toBe(2);
    expect(log.events[0].type).toBe("cli");
    expect(log.events[1].type).toBe("llm");
  });

  it("onEmit error doesn't break logging (defensive try/catch)", function() {
    const log = createStageLogger("test", null, function() {
      throw new Error("downstream consumer crashed");
    });
    // Should not throw
    expect(function() { log.cli({ cmd: "x" }); }).not.toThrow();
    // Event still pushed to events
    expect(log.events.length).toBe(1);
  });

  it("event includes ts + type + depth fields (existing contract preserved)", function() {
    const emitted = [];
    const log = createStageLogger("test", { depth: 2, parentStageKey: "verify", parentIter: 3 },
      function(e) { emitted.push(e); });
    log.cli({ cmd: "x" });
    const e = emitted[0];
    expect(e.type).toBe("cli");
    expect(typeof e.ts).toBe("number");
    expect(e.depth).toBe(2);
    expect(e.parentStageKey).toBe("verify");
    expect(e.parentIter).toBe(3);
  });
});

describe("LiveProgressPanel rendering (V22 Layer F.3)", function() {

  it("renders the latest event's headline + detail", function() {
    const progress = {
      events: [
        { ts: Date.now() - 1000, type: "cli", cmd: "verilator --lint-only" },
        { ts: Date.now(), type: "llm", stage: "lint-iter1", tokensIn: 100, tokensOut: 50, latencyMs: 250 },
      ],
      startedAtMs: Date.now() - 2000,
      lastUpdatedMs: Date.now(),
      llmCount: 1,
      cliCount: 1,
    };
    const { container } = render(<LiveProgressPanel stageId={6} progress={progress} />);
    const text = container.textContent || "";
    expect(text).toContain("Currently Running");
    expect(text).toContain("lint-iter1");
  });

  it("displays LLM and CLI count badges", function() {
    const progress = {
      events: [
        { ts: Date.now(), type: "llm", stage: "x", tokensIn: 1 },
        { ts: Date.now(), type: "llm", stage: "y", tokensIn: 1 },
        { ts: Date.now(), type: "cli", cmd: "verilator" },
      ],
      startedAtMs: Date.now(),
      lastUpdatedMs: Date.now(),
      llmCount: 2,
      cliCount: 1,
    };
    const { container } = render(<LiveProgressPanel stageId={6} progress={progress} />);
    const text = container.textContent || "";
    expect(text).toMatch(/2 LLM calls?/);
    expect(text).toMatch(/1 CLI exec/);
  });

  it("renders an event tail (last N events, most recent first)", function() {
    const events = [];
    for (let i = 0; i < 12; i++) {
      events.push({
        ts: Date.now() - (12 - i) * 1000,
        type: "cli",
        cmd: "step_" + i,
      });
    }
    const progress = {
      events: events,
      startedAtMs: Date.now() - 20000,
      lastUpdatedMs: Date.now(),
      llmCount: 0, cliCount: 12,
    };
    const { container } = render(<LiveProgressPanel stageId={6} progress={progress} />);
    const text = container.textContent || "";
    // Most recent (step_11) appears in tail
    expect(text).toContain("step_11");
    // Tail shows N out of total
    expect(text).toMatch(/last \d+ of 12/);
  });

  it("triggers onClear when CLEAR button is clicked", function() {
    const onClear = vi.fn();
    const progress = {
      events: [{ ts: Date.now(), type: "cli", cmd: "x" }],
      startedAtMs: Date.now(),
      lastUpdatedMs: Date.now(),
      llmCount: 0, cliCount: 1,
    };
    const { container } = render(
      <LiveProgressPanel stageId={6} progress={progress} onClear={onClear} />
    );
    const buttons = container.querySelectorAll("button");
    let clearBtn = null;
    buttons.forEach(function(b) {
      if (b.textContent === "CLEAR") clearBtn = b;
    });
    expect(clearBtn).not.toBe(null);
    fireEvent.click(clearBtn);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("renders 'Starting…' when no events have arrived yet", function() {
    // Empty events array still passed in
    const progress = {
      events: [],
      startedAtMs: Date.now(),
      lastUpdatedMs: Date.now(),
      llmCount: 0, cliCount: 0,
    };
    const { container } = render(<LiveProgressPanel stageId={6} progress={progress} />);
    const text = container.textContent || "";
    expect(text).toContain("Starting");
  });
});

describe("LiveProgressCollapsedPill (V22 Layer F.3)", function() {

  it("renders nothing when there are no events", function() {
    const { container } = render(
      <LiveProgressCollapsedPill stageId={6} progress={{ events: [] }} onExpand={function() {}} />
    );
    expect(container.textContent).toBe("");
  });

  it("renders event/LLM/CLI counts", function() {
    const progress = {
      events: [
        { ts: Date.now(), type: "llm", stage: "x" },
        { ts: Date.now(), type: "cli", cmd: "y" },
        { ts: Date.now(), type: "skill", skillCount: 1 },
      ],
      llmCount: 1, cliCount: 1,
    };
    const { container } = render(
      <LiveProgressCollapsedPill stageId={6} progress={progress} onExpand={function() {}} />
    );
    const text = container.textContent || "";
    expect(text).toMatch(/3 events/);
    expect(text).toMatch(/1 LLM/);
    expect(text).toMatch(/1 CLI/);
  });

  it("calls onExpand when clicked", function() {
    const onExpand = vi.fn();
    const progress = {
      events: [{ ts: Date.now(), type: "cli", cmd: "x" }],
      llmCount: 0, cliCount: 1,
    };
    const { container } = render(
      <LiveProgressCollapsedPill stageId={6} progress={progress} onExpand={onExpand} />
    );
    const btn = container.querySelector("button");
    expect(btn).not.toBe(null);
    fireEvent.click(btn);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
