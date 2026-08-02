// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { EvalsTab } from "../src/react/components/evalsTab.jsx";
import { defaultEvalConfig } from "../src/eval/index.js";

describe("EvalsTab smoke", function() {
  it("renders all 6 categories with default config", function() {
    const { container } = render(
      <EvalsTab config={{ evalCriteria: defaultEvalConfig() }} setConfig={function() {}} />
    );
    const text = container.textContent || "";
    expect(text).toMatch(/Requirements/i);
    expect(text).toMatch(/Verify/i);
    expect(text).toMatch(/Coverage/i);
    expect(text).toMatch(/Lint/i);
    expect(text).toMatch(/Functional \(Must\)/);
    expect(text).toMatch(/Test pass rate/);
  });

  it("renders with empty config (defaults applied implicitly)", function() {
    const { container } = render(
      <EvalsTab config={{}} setConfig={function() {}} />
    );
    expect(container.textContent).toMatch(/Functional \(Must\)/);
  });

  it("toggles enabled checkbox calls setConfig", function() {
    let captured = null;
    const setConfig = function(fn) { captured = fn({ evalCriteria: defaultEvalConfig() }); };
    const { container } = render(
      <EvalsTab config={{ evalCriteria: defaultEvalConfig() }} setConfig={setConfig} />
    );
    // Find the first checkbox and click it
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBeGreaterThan(0);
    // Toggle the first one (should be req_func_func — currently enabled by default)
    checkboxes[0].click();
    expect(captured).toBeTruthy();
    expect(captured.evalCriteria).toBeTruthy();
  });

  it("renders Reset button", function() {
    const { container } = render(
      <EvalsTab config={{ evalCriteria: defaultEvalConfig() }} setConfig={function() {}} />
    );
    expect(container.textContent).toMatch(/Reset to defaults/);
  });
});

describe("EvalsTab requirement-category grouping (Bug A4)", function() {
  it("renders an 'All priorities' parent checkbox per requirement category", function() {
    const { container } = render(
      <EvalsTab config={{ evalCriteria: defaultEvalConfig() }} setConfig={function() {}} />
    );
    const text = container.textContent || "";
    // One parent per req cat: Functional, Verification, Timing, Interface
    expect(text).toMatch(/Functional/);
    expect(text).toMatch(/Verification/);
    expect(text).toMatch(/Timing/);
    expect(text).toMatch(/Interface/);
    expect(text.match(/All priorities/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("clicking the 'All priorities' parent toggles both must+should children", function() {
    let captured = null;
    const setConfig = function(fn) {
      captured = fn({ evalCriteria: defaultEvalConfig() });
    };
    const { container } = render(
      <EvalsTab config={{ evalCriteria: defaultEvalConfig() }} setConfig={setConfig} />
    );
    // Find the parent checkbox for Functional (aria-label matches our spec)
    const parents = container.querySelectorAll('input[type="checkbox"][aria-label]');
    const funcParent = Array.from(parents).find(function(c) {
      return c.getAttribute("aria-label").includes("Functional");
    });
    expect(funcParent).toBeTruthy();
    funcParent.click();
    expect(captured).toBeTruthy();
    // After click, both req_func_must and req_func_should should be ENABLED
    // (default state has req_func_must enabled, req_func_should disabled).
    // Parent was indeterminate → click turns all ON.
    expect(captured.evalCriteria.req_func_must.enabled).toBe(true);
    expect(captured.evalCriteria.req_func_should.enabled).toBe(true);
  });

  it("'All' parent goes to indeterminate state when children are mixed", function() {
    // Default state: req_func_must enabled, req_func_should disabled = mixed
    const { container } = render(
      <EvalsTab config={{ evalCriteria: defaultEvalConfig() }} setConfig={function() {}} />
    );
    const parents = container.querySelectorAll('input[type="checkbox"][aria-label]');
    const funcParent = Array.from(parents).find(function(c) {
      return c.getAttribute("aria-label").includes("Functional");
    });
    expect(funcParent).toBeTruthy();
    expect(funcParent.indeterminate).toBe(true);
  });

  it("clicking a fully-on 'All' parent disables both children", function() {
    let captured = null;
    const setConfig = function(fn) {
      captured = fn({
        evalCriteria: {
          req_func_must:   { enabled: true,  threshold: 100 },
          req_func_should: { enabled: true,  threshold: 100 },
          // Other entries omitted — normalizeEvalConfig will fill them
        },
      });
    };
    const fullOnCfg = Object.assign({}, defaultEvalConfig(), {
      req_func_must:   { enabled: true,  threshold: 100 },
      req_func_should: { enabled: true,  threshold: 100 },
    });
    const { container } = render(
      <EvalsTab config={{ evalCriteria: fullOnCfg }} setConfig={setConfig} />
    );
    const parents = container.querySelectorAll('input[type="checkbox"][aria-label]');
    const funcParent = Array.from(parents).find(function(c) {
      return c.getAttribute("aria-label").includes("Functional");
    });
    expect(funcParent.checked).toBe(true);
    funcParent.click();
    expect(captured.evalCriteria.req_func_must.enabled).toBe(false);
    expect(captured.evalCriteria.req_func_should.enabled).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JudgeStage Eval tab (run-43 keynote-demo rehearsal finding): the weighted
// criteria breakdown — the number the whole run is graded by — was visible
// only in the CLI's `evals` table; the GUI judge panel had no tab for it.
// Rendered with the REAL run-43 demo seed so the demo path stays pinned.
// ═══════════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import { JudgeStage } from "../src/react/components/stages.jsx";

describe("JudgeStage Eval tab (run 43 demo)", () => {
  const seedPath = "talk/demo/gui/seed-data.json";
  const hasSeed = fs.existsSync(seedPath);

  it("renders the weighted criteria table from data.eval", () => {
    const J = hasSeed
      ? (() => {
          const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
          const p = JSON.parse(seed["rtlforge:checkpoint:8052b43c"]);
          return p.modules[Object.keys(p.modules)[0]].stageData["9"];
        })()
      : { overall: "FAIL", score: 77, trace: [], recs: [], judgeHistory: [{}],
          eval: { score: 77, overall: "FAIL", results: [
            { id: "req_func_must", enabled: true, status: "FAIL", measured: 97, threshold: 100, weight: 1, detail: "3/4 green" },
            { id: "formal_proven", enabled: true, status: "FAIL", measured: 0, threshold: 100, weight: 0.6, detail: "CEX" },
            { id: "lint_rtl_clean", enabled: true, status: "PASS", measured: 100, threshold: 100, weight: 0.4, detail: "" },
            { id: "coverage_line", enabled: false, status: "SKIP", measured: 0, threshold: 80, weight: 1, detail: "" },
          ] } };
    const { container, getByText } = render(<JudgeStage data={J} stageData={J} maxIters={2} />);
    fireEvent.click(getByText("Eval"));
    const text = container.textContent;
    expect(text).toContain("req_func_must");
    expect(text).toContain("formal_proven");
    expect(text).toContain("Weighted graded score");
    expect(text).toContain("77");
    // disabled criteria are not listed
    expect(text).not.toContain("coverage_branch");
  });

  it("no Eval tab when the judge slot has no eval verdict", () => {
    const { queryByText } = render(<JudgeStage
      data={{ overall: "FAIL", score: 0, trace: [], recs: [], judgeHistory: [] }}
      stageData={null} maxIters={2} />);
    expect(queryByText("Eval")).toBeNull();
  });
});
