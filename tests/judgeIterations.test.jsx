// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { JudgeStage } from "../src/react/components/stages.jsx";

describe("JudgeStage iteration drill-down (Bug 2)", function() {
  function fixture(overrides) {
    return Object.assign({
      data: {
        overall: "FAIL",
        score: 67,
        trace: [],
        recs: [],
        eval: {
          overall: "FAIL", score: 67, totalEnabled: 3, passed: 2, failed: 1,
          failingIds: ["verify_pass_rate"],
          results: [
            { id: "req_func_must", category: "requirements", label: "Functional (Must)",
              enabled: true, threshold: 100, measured: 100, denominator: 1,
              detail: "1/1 func/must traced+ok", status: "PASS", margin: 0 },
            { id: "verify_pass_rate", category: "verify", label: "Test pass rate",
              enabled: true, threshold: 100, measured: 0, denominator: 1,
              detail: "0/1 tests passing", status: "FAIL", margin: -100 },
            { id: "lint_rtl_clean", category: "lint", label: "RTL lint clean",
              enabled: true, threshold: 100, measured: 100, denominator: 0,
              detail: "0 errors", status: "PASS", margin: 0 },
          ],
          categories: {
            requirements: { pass: 1, fail: 0, skipped: 0 },
            verify: { pass: 0, fail: 1, skipped: 0 },
            coverage: { pass: 0, fail: 0, skipped: 5 },
            formal: { pass: 0, fail: 0, skipped: 2 },
            lint: { pass: 1, fail: 0, skipped: 1 },
            review: { pass: 0, fail: 0, skipped: 2 },
          },
        },
        judgeHistory: [{
          iter: 1,
          overall: "FAIL", score: 67, unmet: 1, total: 3, triageTarget: "test_generate",
          eval: {
            overall: "FAIL", score: 67, totalEnabled: 3, passed: 2, failed: 1,
            failingIds: ["verify_pass_rate"],
            results: [
              { id: "req_func_must", category: "requirements", label: "Functional (Must)",
                enabled: true, threshold: 100, measured: 100, denominator: 1,
                status: "PASS", margin: 0, detail: "ok" },
              { id: "verify_pass_rate", category: "verify", label: "Test pass rate",
                enabled: true, threshold: 100, measured: 0, denominator: 1,
                status: "FAIL", margin: -100, detail: "0/1 passing" },
            ],
            categories: { verify: { pass: 0, fail: 1, skipped: 0 } },
          },
          _structured: {
            tbRegen: {
              beforeCode: "module old_tb;\n  initial $finish;\nendmodule",
              afterCode:  "module new_tb;\n  initial begin\n    $display(\"hi\");\n    $finish;\n  end\nendmodule",
              parseOk: true, kind: "judge_tb_regen", rawText: "...",
            },
          },
        }],
      },
      onExport: function() {},
      onExportPackage: function() {},
      maxIters: 3,
    }, overrides || {});
  }

  it("renders iteration summary row when not expanded", function() {
    const props = fixture();
    const { container } = render(<JudgeStage {...props} />);
    // Switch to iterations sub-tab
    const tabs = container.querySelectorAll("button");
    const iterTab = Array.from(tabs).find(function(b) { return b.textContent.match(/Judge Loop/); });
    if (iterTab) fireEvent.click(iterTab);
    // The collapsed row should show iter+verdict+score+triage
    expect(container.textContent).toMatch(/Iter 1/);
    expect(container.textContent).toMatch(/test_generate/);
    expect(container.textContent).toMatch(/67/);
    expect(container.textContent).toMatch(/▶/);   // collapsed marker
  });

  it("expands iteration row on click and reveals criterion breakdown + diff", function() {
    const props = fixture();
    const { container } = render(<JudgeStage {...props} />);
    const tabs = container.querySelectorAll("button");
    const iterTab = Array.from(tabs).find(function(b) { return b.textContent.match(/Judge Loop/); });
    if (iterTab) fireEvent.click(iterTab);

    const allBtns = container.querySelectorAll("button");
    const iterRow = Array.from(allBtns).find(function(b) {
      return b.textContent.match(/Iter 1/) && b.textContent.match(/▶/);
    });
    expect(iterRow).toBeTruthy();
    fireEvent.click(iterRow);

    const txt = container.textContent;
    // Per-criterion breakdown shows
    expect(txt).toMatch(/Per-criterion verdict/);
    expect(txt).toMatch(/Functional \(Must\)/);
    expect(txt).toMatch(/Test pass rate/);
    // Regen diff shows
    expect(txt).toMatch(/Testbench regen/);
    // The DiffBlock renders before/after content
    expect(txt).toMatch(/old_tb/);
    expect(txt).toMatch(/new_tb/);
  });

  it("shows '(no regen)' when iteration has no _structured", function() {
    const props = fixture({
      data: Object.assign({}, fixture().data, {
        judgeHistory: [Object.assign({}, fixture().data.judgeHistory[0], { _structured: null })],
      }),
    });
    const { container } = render(<JudgeStage {...props} />);
    const tabs = container.querySelectorAll("button");
    const iterTab = Array.from(tabs).find(function(b) { return b.textContent.match(/Judge Loop/); });
    if (iterTab) fireEvent.click(iterTab);
    // Expand the row
    const allBtns = container.querySelectorAll("button");
    const iterRow = Array.from(allBtns).find(function(b) {
      return b.textContent.match(/Iter 1/) && b.textContent.match(/▶/);
    });
    fireEvent.click(iterRow);
    expect(container.textContent).toMatch(/No regen captures/);
  });

  it("shows '(no change)' when before === after", function() {
    const data = fixture().data;
    data.judgeHistory[0]._structured = {
      tbRegen: {
        beforeCode: "module identical;\nendmodule",
        afterCode:  "module identical;\nendmodule",
        parseOk: true, kind: "judge_tb_regen", rawText: "...",
      },
    };
    const { container } = render(<JudgeStage data={data} onExport={function() {}} onExportPackage={function() {}} maxIters={3} />);
    const tabs = container.querySelectorAll("button");
    const iterTab = Array.from(tabs).find(function(b) { return b.textContent.match(/Judge Loop/); });
    if (iterTab) fireEvent.click(iterTab);
    const allBtns = container.querySelectorAll("button");
    const iterRow = Array.from(allBtns).find(function(b) {
      return b.textContent.match(/Iter 1/) && b.textContent.match(/▶/);
    });
    fireEvent.click(iterRow);
    expect(container.textContent).toMatch(/no change/);
    expect(container.textContent).toMatch(/identical output/);
  });
});
