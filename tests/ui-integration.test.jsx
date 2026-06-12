// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// tests/ui-integration.test.jsx — Automated UI integration tests
//
// Tests component rendering and user interactions with React Testing Library.
// Run with: npm test (requires npm install first)
//
// Coverage:
//   1. Atoms — Btn click, Chip toggle, Tag rendering
//   2. ElicitStage — answer selection via Chip clicks, assumption editing
//   3. SpecStage — requirement editing, port CRUD, propagate button
//   4. SplitCodeView — edit toggle, code editing, fix display
//   5. SettingsPanel — tab switching, config changes
//   6. LintStage — expandable fix loop iterations
//   7. VerifyStage — metric display, coverage rendering
//   8. JudgeStage — verdict display, export button gating
//   9. ResumeDialog — resume/discard callbacks
//  10. useProject integration — launch + stage data updates
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Atoms ────────────────────────────────────────────────────────────────────
import { Btn, Chip, Tag, Spinner, ErrorBox, Label, MetricCard, SubTab, CodeBlock } from "../src/react/components/atoms.jsx";

describe("Atoms", () => {
  it("Btn: fires onClick when enabled", async () => {
    const onClick = vi.fn();
    render(<Btn onClick={onClick}>Click Me</Btn>);
    await userEvent.click(screen.getByText("Click Me"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Btn: does NOT fire onClick when disabled", async () => {
    const onClick = vi.fn();
    render(<Btn onClick={onClick} disabled>Nope</Btn>);
    await userEvent.click(screen.getByText("Nope"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("Btn: danger variant has red styling", () => {
    const { container } = render(<Btn variant="danger">Delete</Btn>);
    const btn = container.querySelector("button");
    expect(btn.style.borderColor).toContain("248, 113, 113");
  });

  it("Chip: toggles active state on click", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Chip label="Option A" active={false} onClick={onClick} />);
    await userEvent.click(screen.getByText("Option A"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Chip: disabled chip prevents click", async () => {
    const onClick = vi.fn();
    render(<Chip label="Locked" disabled onClick={onClick} />);
    await userEvent.click(screen.getByText("Locked"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("Tag: renders children text", () => {
    render(<Tag>STATUS</Tag>);
    expect(screen.getByText("STATUS")).toBeInTheDocument();
  });

  it("Spinner: shows default text", () => {
    render(<Spinner />);
    expect(screen.getByText(/Processing/)).toBeInTheDocument();
  });

  it("Spinner: shows custom text", () => {
    render(<Spinner text="Loading data…" />);
    expect(screen.getByText("Loading data…")).toBeInTheDocument();
  });

  it("ErrorBox: renders error message", () => {
    render(<ErrorBox msg="Something went wrong" />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("MetricCard: renders label and value", () => {
    render(<MetricCard label="TOKENS" value="1.2K" />);
    expect(screen.getByText("TOKENS")).toBeInTheDocument();
    expect(screen.getByText("1.2K")).toBeInTheDocument();
  });

  it("SubTab: clicking a tab fires onChange with correct id", async () => {
    const onChange = vi.fn();
    render(
      <SubTab
        tabs={[{ id: "a", label: "Tab A" }, { id: "b", label: "Tab B" }]}
        active="a"
        onChange={onChange}
      />
    );
    await userEvent.click(screen.getByText("Tab B"));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("CodeBlock: renders code text", () => {
    render(<CodeBlock code="let x = 42;" />);
    expect(screen.getByText("let x = 42;")).toBeInTheDocument();
  });
});

// ── ElicitStage ──────────────────────────────────────────────────────────────
import { ElicitStage } from "../src/react/components/stages.jsx";

describe("ElicitStage", () => {
  function elicitFixture(overrides = {}) {
    return Object.assign({
      domain: "arithmetic",
      questions: [
        { id: "Q-IF-01", cat: "interface", text: "Clock type?", opts: ["Single clock", "Dual clock", "Other (specify)"] },
        { id: "Q-IF-02", cat: "interface", text: "Reset type?", opts: ["Sync", "Async"] },
      ],
      assumptions: [
        { id: "A-01", text: "100MHz clock", confirmed: true, revised: null },
      ],
      answers: {},
      customAnswers: {},
    }, overrides);
  }

  it("renders domain tag", () => {
    render(<ElicitStage data={elicitFixture()} setData={() => {}} isActive={true} />);
    expect(screen.getByText(/Domain:.*arithmetic/)).toBeInTheDocument();
  });

  it("shows answered counter 0/2", () => {
    render(<ElicitStage data={elicitFixture()} setData={() => {}} isActive={true} />);
    expect(screen.getByText("0/2 answered")).toBeInTheDocument();
  });

  it("clicking an option chip fires setData with the answer", async () => {
    const setData = vi.fn();
    render(<ElicitStage data={elicitFixture()} setData={setData} isActive={true} />);
    await userEvent.click(screen.getByText("Single clock"));
    expect(setData).toHaveBeenCalled();
    // The callback should be a function that merges { answers: { "Q-IF-01": "Single clock" } }
    const updater = setData.mock.calls[0][0];
    expect(typeof updater).toBe("function");
    const result = updater(elicitFixture());
    expect(result.answers["Q-IF-01"]).toBe("Single clock");
  });

  it("selecting 'Other (specify)' shows a text input", async () => {
    const data = elicitFixture({ answers: { "Q-IF-01": "Other (specify)" } });
    render(<ElicitStage data={data} setData={() => {}} isActive={true} />);
    expect(screen.getByPlaceholderText("Specify…")).toBeInTheDocument();
  });

  it("assumptions tab shows assumption text", async () => {
    render(<ElicitStage data={elicitFixture()} setData={() => {}} isActive={true} />);
    await userEvent.click(screen.getByText("Assumptions"));
    expect(screen.getByText("100MHz clock")).toBeInTheDocument();
  });

  it("disabled when isActive=false — chips have opacity 0.5", () => {
    const { container } = render(<ElicitStage data={elicitFixture()} setData={() => {}} isActive={false} />);
    const chips = container.querySelectorAll("button[style*='opacity: 0.5']");
    expect(chips.length).toBeGreaterThan(0);
  });
});

// ── SpecStage ────────────────────────────────────────────────────────────────
import { SpecStage } from "../src/react/components/stages.jsx";

describe("SpecStage", () => {
  function specFixture(overrides = {}) {
    return Object.assign({
      requirements: [
        { id: "REQ-FUNC-001", cat: "Functional", pri: "Must", desc: "Add two operands" },
      ],
      iface: [
        { name: "clk", dir: "input", width: "1", desc: "Clock" },
      ],
      params: [
        { name: "WIDTH", type: "parameter", def: 8, range: "[1:64]", desc: "Data width" },
      ],
    }, overrides);
  }

  it("renders requirement ID in default tab", () => {
    render(<SpecStage data={specFixture()} setData={() => {}} isActive={true} />);
    expect(screen.getByText("REQ-FUNC-001")).toBeInTheDocument();
  });

  it("shows Add Requirement button when active", () => {
    render(<SpecStage data={specFixture()} setData={() => {}} isActive={true} />);
    expect(screen.getByText("+ Add Requirement")).toBeInTheDocument();
  });

  it("hides Add Requirement button when not active", () => {
    render(<SpecStage data={specFixture()} setData={() => {}} isActive={false} />);
    expect(screen.queryByText("+ Add Requirement")).not.toBeInTheDocument();
  });

  it("switching to Interface tab shows port names", async () => {
    render(<SpecStage data={specFixture()} setData={() => {}} isActive={true} />);
    await userEvent.click(screen.getByText("Module Interface"));
    expect(screen.getByDisplayValue("clk")).toBeInTheDocument();
  });

  it("editing a port name fires setData", async () => {
    const setData = vi.fn();
    render(<SpecStage data={specFixture()} setData={setData} isActive={true} />);
    await userEvent.click(screen.getByText("Module Interface"));
    const nameInput = screen.getByDisplayValue("clk");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "sys_clk");
    // Each keystroke fires setData
    expect(setData).toHaveBeenCalled();
  });

  it("switching to Parameters tab shows param names", async () => {
    render(<SpecStage data={specFixture()} setData={() => {}} isActive={true} />);
    await userEvent.click(screen.getByText("Parameters"));
    expect(screen.getByDisplayValue("WIDTH")).toBeInTheDocument();
  });

  it("propagate button renders when onPropagate provided", () => {
    render(<SpecStage data={specFixture()} setData={() => {}} isActive={true} onPropagate={() => {}} propagating={false} />);
    expect(screen.getByText(/Propagate/)).toBeInTheDocument();
  });

  it("shows 'Propagating…' text when propagating", () => {
    render(<SpecStage data={specFixture()} setData={() => {}} isActive={true} onPropagate={() => {}} propagating={true} />);
    expect(screen.getByText(/Propagating/)).toBeInTheDocument();
  });
});

// ── SplitCodeView ────────────────────────────────────────────────────────────
import { SplitCodeView } from "../src/react/components/panels.jsx";

describe("SplitCodeView", () => {
  it("renders Code Only button", () => {
    render(<SplitCodeView code="module test; endmodule" fixes={[]} label="RTL" />);
    expect(screen.getByText("Code Only")).toBeInTheDocument();
  });

  it("shows Edit Code button when onChange provided", () => {
    render(<SplitCodeView code="x" fixes={[]} label="RTL" onChange={() => {}} />);
    expect(screen.getByText("✏ Edit Code")).toBeInTheDocument();
  });

  it("hides Edit Code button when onChange not provided", () => {
    render(<SplitCodeView code="x" fixes={[]} label="RTL" />);
    expect(screen.queryByText("✏ Edit Code")).not.toBeInTheDocument();
  });

  it("clicking Edit Code shows textarea and Done Editing button", async () => {
    render(<SplitCodeView code="let x = 1;" fixes={[]} label="RTL" onChange={() => {}} />);
    await userEvent.click(screen.getByText("✏ Edit Code"));
    expect(screen.getByText("✓ Done Editing")).toBeInTheDocument();
    expect(screen.getByDisplayValue("let x = 1;")).toBeInTheDocument();
  });

  it("editing code fires onChange", async () => {
    const onChange = vi.fn();
    render(<SplitCodeView code="old" fixes={[]} label="RTL" onChange={onChange} />);
    await userEvent.click(screen.getByText("✏ Edit Code"));
    const textarea = screen.getByDisplayValue("old");
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "new code");
    expect(onChange).toHaveBeenCalled();
  });

  it("fixSource banner shows when provided", () => {
    render(<SplitCodeView code="x" fixes={[]} label="RTL" fixSource="lint iter 2" />);
    expect(screen.getByText(/Code modified/)).toBeInTheDocument();
    expect(screen.getByText("lint iter 2")).toBeInTheDocument();
  });

  it("fixes panel shows fix count", () => {
    render(<SplitCodeView code="x" fixes={["fix1", "fix2"]} label="RTL" />);
    expect(screen.getByText("Fixes (2)")).toBeInTheDocument();
  });

  it("REGRESSION: does not crash when a fix is wrapped with text:{id,desc} (the user's reported crash)", () => {
    // Pre-fix bug: RTL Review's _fixes were raw {id, desc} objects, and
    // the wrapper code in RTLForge.jsx did `{text: f, source: "RTL Review"}`,
    // pushing the raw object into the `text` slot. panels.jsx then tried to
    // render `{text}` directly and React threw "Objects are not valid as a
    // React child (found: object with keys {id, desc})".
    const fixes = [
      { text: { id: "RR-001", desc: "race condition on reset" }, source: "RTL Review" },
      { text: "real string fix", source: "Lint Fix" },
      { text: { description: "another shape" }, source: "RTL Review" },
    ];
    expect(function() {
      render(<SplitCodeView code="x" fixes={fixes} label="RTL" />);
    }).not.toThrow();
    // Defense-in-depth coercion in panels.jsx should have rendered something
    expect(screen.getByText("Fixes (3)")).toBeInTheDocument();
    // The string fix renders as-is
    expect(screen.getByText("real string fix")).toBeInTheDocument();
  });

  it("REGRESSION: handles raw {id, desc} object pushed directly into fixes array", () => {
    // Belt-and-braces: even if a caller passes an object directly (not
    // wrapped at all), we should not crash.
    const fixes = [
      { id: "RR-001", desc: "race condition" },
      "fix2",
    ];
    expect(function() {
      render(<SplitCodeView code="x" fixes={fixes} label="RTL" />);
    }).not.toThrow();
    expect(screen.getByText("Fixes (2)")).toBeInTheDocument();
  });

  // ── Issue #12: Compare past version ─────────────────────────────────────
  it("Issue #12: shows 'Compare Past Version' button only when pastSnapshots is non-empty", () => {
    const { rerender } = render(<SplitCodeView code="x" fixes={[]} label="RTL" />);
    // No pastSnapshots → no compare button
    expect(screen.queryByText(/Compare Past Version/i)).toBeNull();
    // Empty pastSnapshots → still no button
    rerender(<SplitCodeView code="x" fixes={[]} label="RTL" pastSnapshots={[]} />);
    expect(screen.queryByText(/Compare Past Version/i)).toBeNull();
    // Populated → button appears
    rerender(<SplitCodeView code="x" fixes={[]} label="RTL" pastSnapshots={[
      { stepId: 4, stepLabel: "RTL Gen", iter: 0, code: "v0", lineCount: 1, label: "RTL Gen — original" },
    ]} />);
    expect(screen.getByText(/Compare Past Version/i)).toBeInTheDocument();
  });

  it("Issue #12: clicking Compare opens the side-by-side panel with snapshot dropdown", async () => {
    const past = [
      { stepId: 4, stepLabel: "RTL Gen", iter: 0, code: "module v0; endmodule", lineCount: 1, label: "RTL Gen — original" },
      { stepId: 6, stepLabel: "Lint",    iter: 1, code: "module v1; endmodule", lineCount: 1, label: "Lint — iter 1" },
    ];
    render(<SplitCodeView code="module current; endmodule" fixes={[]} label="RTL" pastSnapshots={past} />);
    await userEvent.click(screen.getByText(/Compare Past Version/i));
    // Compare panel appears with the dropdown labelled by step + iter
    expect(screen.getByText(/Compare with past version/i)).toBeInTheDocument();
    // Both snapshot labels should be in the dropdown options
    expect(screen.getByText(/RTL Gen — original/)).toBeInTheDocument();
    expect(screen.getByText(/Lint — iter 1/)).toBeInTheDocument();
    // The "LATEST" label appears for the right pane
    expect(screen.getByText(/LATEST/)).toBeInTheDocument();
  });

  it("Issue #12: switching the snapshot dropdown updates the displayed past code", async () => {
    const past = [
      { stepId: 4, stepLabel: "RTL Gen", iter: 0, code: "module first; endmodule",  lineCount: 1, label: "RTL Gen — original" },
      { stepId: 6, stepLabel: "Lint",    iter: 1, code: "module second; endmodule", lineCount: 1, label: "Lint — iter 1" },
    ];
    render(<SplitCodeView code="module current; endmodule" fixes={[]} label="RTL" pastSnapshots={past} />);
    await userEvent.click(screen.getByText(/Compare Past Version/i));
    // Default selection is index 0; the pane label now includes a 1-based
    // chronological prefix per Group A2 ("1. RTL Gen — iter 0").
    expect(screen.getByText(/PAST: 1\. RTL Gen — iter 0/)).toBeInTheDocument();
    // Switch to index 1 — the past pane label updates to "2. Lint — iter 1".
    const dropdown = screen.getAllByRole("combobox")[0];
    await userEvent.selectOptions(dropdown, "1");
    expect(screen.getByText(/PAST: 2\. Lint — iter 1/)).toBeInTheDocument();
  });

  // ── Group A2 (v20): numbered chronological dropdown ──────────────────────
  it("Group A2 (v20): compare dropdown options are prefixed with chronological number", async () => {
    const past = [
      { stepId: 4, stepLabel: "RTL Gen", iter: 0, code: "v0", lineCount: 1, label: "RTL Gen — original" },
      { stepId: 6, stepLabel: "Lint",    iter: 1, code: "v1", lineCount: 1, label: "Lint — iter 1" },
      { stepId: 6, stepLabel: "Lint",    iter: 2, code: "v2", lineCount: 1, label: "Lint — iter 2" },
    ];
    render(<SplitCodeView code="latest" fixes={[]} label="RTL" pastSnapshots={past} />);
    await userEvent.click(screen.getByText(/Compare Past Version/i));
    expect(screen.getByText(/^1\. RTL Gen — original/)).toBeInTheDocument();
    expect(screen.getByText(/^2\. Lint — iter 1/)).toBeInTheDocument();
    expect(screen.getByText(/^3\. Lint — iter 2/)).toBeInTheDocument();
  });

  // ── Group A3 (v20): vdiff toggle button ──────────────────────────────────
  it("Group A3 (v20): vdiff toggle switches the compare panel to diff mode", async () => {
    const past = [
      { stepId: 4, stepLabel: "RTL Gen", iter: 0, code: "module before; endmodule", lineCount: 1, label: "RTL Gen — original" },
    ];
    render(<SplitCodeView code="module after; endmodule" fixes={[]} label="RTL" pastSnapshots={past} />);
    await userEvent.click(screen.getByText(/Compare Past Version/i));
    // Default mode is side-by-side: PAST + LATEST labels both visible
    expect(screen.getAllByText(/PAST:/i).length).toBeGreaterThan(0);
    // Click vdiff toggle
    await userEvent.click(screen.getByRole("button", { name: /vdiff/i }));
    // Diff mode shows the +/- legend in the DiffBlock header, not the
    // PAST: / LATEST: labels.
    expect(screen.queryByText(/PAST: 1\. RTL Gen/i)).toBeNull();
    expect(screen.getByText(/unchanged/i)).toBeInTheDocument();
  });

  // ── Group A4 + A5 (v20): numbered fixes with iteration annotation ────────
  it("Group A4/A5 (v20): fix list shows '1.', '2.' numbering and 'iteration N' annotation", () => {
    const fixes = [
      { text: "Fixed reset polarity", source: "Lint Fix", iter: 1 },
      { text: "Added missing default in case", source: "Lint Fix", iter: 2 },
      { text: "Removed dead branch", source: "Verify Fix", iter: 1 },
    ];
    render(<SplitCodeView code="x" fixes={fixes} label="RTL" />);
    // Numbering visible
    expect(screen.getByText("1.")).toBeInTheDocument();
    expect(screen.getByText("2.")).toBeInTheDocument();
    expect(screen.getByText("3.")).toBeInTheDocument();
    // Iteration annotation in source line
    expect(screen.getByText(/Lint Fix iteration 1/)).toBeInTheDocument();
    expect(screen.getByText(/Lint Fix iteration 2/)).toBeInTheDocument();
    expect(screen.getByText(/Verify Fix iteration 1/)).toBeInTheDocument();
  });

  it("Group A5 (v20): fixes without iter info don't get spurious 'iteration null' suffix", () => {
    const fixes = [
      { text: "Manual fix", source: "Manual" },                 // no iter
      { text: "First lint fix", source: "Lint Fix", iter: 1 },  // with iter
    ];
    render(<SplitCodeView code="x" fixes={fixes} label="RTL" />);
    // The first fix should show "Manual" alone, not "Manual iteration null"
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.queryByText(/Manual iteration/)).toBeNull();
    // The second still shows iter
    expect(screen.getByText(/Lint Fix iteration 1/)).toBeInTheDocument();
  });

  // ── Group D2 (v20): onCommitEdit fires with code + ts on Done Editing ────
  it("Group D2 (v20): clicking 'Done Editing' fires onCommitEdit with current code + timestamp", async () => {
    const onCommitEdit = vi.fn();
    const onChange = vi.fn();
    render(<SplitCodeView code="module x;" fixes={[]} label="RTL" onChange={onChange} onCommitEdit={onCommitEdit} />);
    // Toggle into edit mode
    await userEvent.click(screen.getByText(/Edit Code/i));
    // Toggle out → commit fires
    await userEvent.click(screen.getByText(/Done Editing/i));
    expect(onCommitEdit).toHaveBeenCalledTimes(1);
    const arg = onCommitEdit.mock.calls[0][0];
    expect(arg.code).toBe("module x;");
    expect(typeof arg.ts).toBe("string");
    expect(arg.ts.length).toBeGreaterThan(0);
  });

  it("Group D2 (v20): onCommitEdit does NOT fire on entering edit mode (only on commit)", async () => {
    const onCommitEdit = vi.fn();
    render(<SplitCodeView code="x" fixes={[]} label="RTL" onChange={() => {}} onCommitEdit={onCommitEdit} />);
    await userEvent.click(screen.getByText(/Edit Code/i));
    // Editing mode is now on, but no commit yet
    expect(onCommitEdit).not.toHaveBeenCalled();
  });
});

// ── LintStage ────────────────────────────────────────────────────────────────
import { LintStage } from "../src/react/components/stages.jsx";

describe("LintStage", () => {
  function lintFixture(overrides = {}) {
    return Object.assign({
      status: "FAIL",
      tool: "verilator",
      iteration: 2,
      cli: true,
      summary: "2 errors found",
      errors: [
        { line: 10, code: "SYNTAX", msg: "Unexpected token" },
        { line: 20, code: "UNDEF", msg: "Undefined identifier" },
      ],
      warnings: [],
      iterations: [
        { iter: 1, status: "FAIL", errors: 3, warnings: 1,
          errorList: [
            { line: 5, code: "WIDTH", msg: "Width mismatch" },
            { line: 10, code: "SYNTAX", msg: "Bad syntax" },
            { line: 15, code: "UNUSED", msg: "Unused signal" },
          ],
          warningList: [{ line: 20, code: "WARN", msg: "Possible issue" }],
        },
        { iter: 2, status: "FAIL", errors: 2, warnings: 0,
          errorList: [
            { line: 10, code: "SYNTAX", msg: "Unexpected token" },
            { line: 20, code: "UNDEF", msg: "Undefined identifier" },
          ],
          warningList: [],
        },
      ],
      log: "Verilator output",
    }, overrides);
  }

  it("shows FAIL status", () => {
    render(<LintStage data={lintFixture()} warningsAsErrors={false} setWarningsAsErrors={() => {}} />);
    expect(screen.getByText("FAIL")).toBeInTheDocument();
  });

  it("shows error messages", () => {
    render(<LintStage data={lintFixture()} warningsAsErrors={false} setWarningsAsErrors={() => {}} />);
    expect(screen.getByText("Unexpected token")).toBeInTheDocument();
    expect(screen.getByText("Undefined identifier")).toBeInTheDocument();
  });

  it("Fix Loop tab shows iteration count", async () => {
    render(<LintStage data={lintFixture()} warningsAsErrors={false} setWarningsAsErrors={() => {}} />);
    await userEvent.click(screen.getByText(/Fix Loop/));
    expect(screen.getByText("Iter 1")).toBeInTheDocument();
    expect(screen.getByText("Iter 2")).toBeInTheDocument();
  });

  it("clicking an iteration expands its error/warning detail", async () => {
    render(<LintStage data={lintFixture()} warningsAsErrors={false} setWarningsAsErrors={() => {}} />);
    await userEvent.click(screen.getByText(/Fix Loop/));
    // Click on Iter 1 row to expand
    await userEvent.click(screen.getByText("Iter 1"));
    // Should now show the expanded errors for iteration 1
    expect(screen.getByText("Width mismatch")).toBeInTheDocument();
    expect(screen.getByText("Bad syntax")).toBeInTheDocument();
    expect(screen.getByText("Possible issue")).toBeInTheDocument();
  });
});

// ── ReviewStage ──────────────────────────────────────────────────────────────
import { ReviewStage } from "../src/react/components/stages.jsx";

describe("ReviewStage", () => {
  // Two-iteration history: iter 1 = the initial review (kind initial_review,
  // before == after), iter 2 = a fix + re-review. Mirrors what the
  // rtl_review/test_review nodes now emit.
  function reviewFixture() {
    return {
      verdict: "PASS", score: 90, issues: [],
      _fixes: [{ text: "fix A", iter: 1 }],
      _iterations: [
        {
          iter: 1, score: 50, verdict: "NEEDS_FIX", issueCount: 1,
          _structured: {
            rawText: '{"verdict":"NEEDS_FIX","score":50}',
            parsed: { verdict: "NEEDS_FIX", score: 50 },
            parseOk: true,
            beforeCode: "module m; endmodule",
            afterCode: "module m; endmodule",
            kind: "initial_review",
          },
        },
        {
          iter: 2, score: 90, verdict: "PASS", issueCount: 0,
          _structured: {
            rawText: '{"code":"module m2; endmodule"}',
            parsed: { code: "module m2; endmodule", fixes: [{ id: "TR-1", desc: "x" }] },
            parseOk: true,
            beforeCode: "module m; endmodule",
            afterCode: "module m2; endmodule",
            kind: "review_fix",
          },
        },
      ],
    };
  }

  it("iteration 1 (initial review) is expandable, like lint's first iteration", async () => {
    render(<ReviewStage data={reviewFixture()} label="RTL Code Review" />);
    await userEvent.click(screen.getByText(/Iterations/));
    await userEvent.click(screen.getByText("Iter 1"));
    // The expansion renders the initial-review viewer (kind-aware title)
    expect(screen.getByText(/Initial review — raw output and reviewed code/)).toBeInTheDocument();
  });

  it("later iterations expand with the fix-details title", async () => {
    render(<ReviewStage data={reviewFixture()} label="RTL Code Review" />);
    await userEvent.click(screen.getByText(/Iterations/));
    await userEvent.click(screen.getByText("Iter 2"));
    expect(screen.getByText(/Fix details for iteration 2/)).toBeInTheDocument();
  });
});

// ── JudgeStage ───────────────────────────────────────────────────────────────
import { JudgeStage } from "../src/react/components/stages.jsx";

describe("JudgeStage", () => {
  it("shows PASS verdict with score", () => {
    render(<JudgeStage data={{ overall: "PASS", score: 92, trace: [], recs: [], judgeHistory: [] }} onExport={() => {}} onExportPackage={() => {}} />);
    expect(screen.getByText("PASS")).toBeInTheDocument();
    expect(screen.getByText("92")).toBeInTheDocument();
  });

  it("Export as Package is disabled when verdict is FAIL", () => {
    render(<JudgeStage data={{ overall: "FAIL", score: 45, trace: [], recs: [], judgeHistory: [] }} onExport={() => {}} onExportPackage={() => {}} />);
    // The disabled Btn should have opacity
    const exportBtns = screen.getAllByRole("button").filter(b => b.textContent.includes("Export as Package"));
    expect(exportBtns.length).toBe(1);
    expect(exportBtns[0].style.opacity).toBe("0.45");
  });
});

// ── ResumeDialog ─────────────────────────────────────────────────────────────
import { ResumeDialog } from "../src/react/components/panels.jsx";

describe("ResumeDialog", () => {
  const checkpoint = {
    projectId: "p1",
    userDesc: "A sync FIFO",
    designMode: "module",
    timestamp: new Date().toISOString(),
    modules: { fifo: { completed: new Set([1, 2, 3]) } },
  };

  it("returns null when checkpoint is null", () => {
    const { container } = render(<ResumeDialog checkpoint={null} onResume={() => {}} onDiscard={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows dialog when checkpoint provided", () => {
    render(<ResumeDialog checkpoint={checkpoint} onResume={() => {}} onDiscard={() => {}} />);
    expect(screen.getByText("Unfinished Project Detected")).toBeInTheDocument();
  });

  it("Resume button fires onResume with checkpoint", async () => {
    const onResume = vi.fn();
    render(<ResumeDialog checkpoint={checkpoint} onResume={onResume} onDiscard={() => {}} />);
    const resumeBtn = screen.getAllByText(/Resume/).find(el => el.tagName === "BUTTON");
    await userEvent.click(resumeBtn);
    expect(onResume).toHaveBeenCalledWith(checkpoint);
  });

  it("Discard button fires onDiscard with projectId", async () => {
    const onDiscard = vi.fn();
    render(<ResumeDialog checkpoint={checkpoint} onResume={() => {}} onDiscard={onDiscard} />);
    await userEvent.click(screen.getByText(/Discard/));
    expect(onDiscard).toHaveBeenCalledWith("p1");
  });
});

// ── SettingsPanel ────────────────────────────────────────────────────────────
import { SettingsPanel } from "../src/react/components/panels.jsx";

describe("SettingsPanel", () => {
  function settingsProps(overrides = {}) {
    return Object.assign({
      config: {
        provider: "lmstudio", model: "test-model", apiKey: "",
        useGlobalLLM: true, optionalStages: { formal_props: true, lint: true }, promptOverrides: {},
        stageSettings: {}, backendUrl: "http://localhost:3001",
        enableCoverage: false, libraryPath: "", settingsDir: "",
      },
      setConfig: vi.fn(),
      onClose: vi.fn(),
      importedPackages: null,
      onDeletePackage: () => {}, onRedownloadPackage: () => {},
      onClearLibrary: () => {},
      checkpointIndex: null,
      onDeleteCheckpoint: () => {}, onClearCheckpoints: () => {},
      onBackendVerified: () => {},
    }, overrides);
  }

  it("renders Settings heading", () => {
    render(<SettingsPanel {...settingsProps()} />);
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("shows all 6 tab labels", () => {
    render(<SettingsPanel {...settingsProps()} />);
    expect(screen.getByText("Workflow")).toBeInTheDocument();
    expect(screen.getByText("LLM")).toBeInTheDocument();
    expect(screen.getByText("CLI")).toBeInTheDocument();
    expect(screen.getByText(/Library/)).toBeInTheDocument();
    expect(screen.getByText(/Checkpoints/)).toBeInTheDocument();
    expect(screen.getByText("Paths")).toBeInTheDocument();
  });

  it("clicking CLI tab shows coverage checkbox", async () => {
    render(<SettingsPanel {...settingsProps()} />);
    await userEvent.click(screen.getByText("CLI"));
    expect(screen.getByText("Enable Coverage Collection")).toBeInTheDocument();
  });

  it("clicking Paths tab shows library directory input", async () => {
    render(<SettingsPanel {...settingsProps()} />);
    await userEvent.click(screen.getByText("Paths"));
    expect(screen.getByText("Component Library Directory")).toBeInTheDocument();
    expect(screen.getByText("Settings Save Directory")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("/path/to/my/rtl-library")).toBeInTheDocument();
  });

  it("Paths tab shows persistence info", async () => {
    render(<SettingsPanel {...settingsProps()} />);
    await userEvent.click(screen.getByText("Paths"));
    expect(screen.getByText(/automatically saved to browser localStorage/)).toBeInTheDocument();
  });

  it("× close button fires onClose", async () => {
    const props = settingsProps();
    render(<SettingsPanel {...props} />);
    const closeBtn = screen.getAllByRole("button").find(b => b.textContent === "×");
    await userEvent.click(closeBtn);
    expect(props.onClose).toHaveBeenCalled();
  });

  it("Save & Close button fires onClose", async () => {
    const props = settingsProps();
    render(<SettingsPanel {...props} />);
    await userEvent.click(screen.getByText("Save & Close"));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("Workflow tab shows optional stage checkboxes after expanding the disclosure (V22 collapsible)", async () => {
    render(<SettingsPanel {...settingsProps()} />);
    await userEvent.click(screen.getByText("Workflow"));
    // V22: optional-stages section is now collapsible — click to expand
    // before the checkbox labels become visible.
    const disclosure = screen.getByText(/Optional Pipeline Stages/i);
    await userEvent.click(disclosure);
    // V22 Layer F: the Workflow tab now also contains a "Per-Stage
    // Reflow Modes" section that mentions "RTL Review" and "Test Review"
    // — so getByText for those strings would match multiple elements.
    // We disambiguate by also asserting the checkbox-side label
    // "SVA Formal Props" / "Lint RTL + Fix" which only appear in the
    // optional-stages disclosure, and using getAllByText for the
    // collision cases with a non-zero length check.
    expect(screen.getByText("SVA Formal Props")).toBeInTheDocument();
    expect(screen.getByText("Lint RTL + Fix")).toBeInTheDocument();
    expect(screen.getByText("Lint Test + Fix")).toBeInTheDocument();
    expect(screen.getAllByText("RTL Review").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Test Review").length).toBeGreaterThanOrEqual(1);
  });

  it("Workflow tab: optional stages collapsed by default — disclosure header visible", async () => {
    render(<SettingsPanel {...settingsProps()} />);
    await userEvent.click(screen.getByText("Workflow"));
    // Collapsed-by-default header is visible
    expect(screen.getByText(/Optional Pipeline Stages/i)).toBeInTheDocument();
    // But the checkbox labels are NOT yet rendered (lazy)
    expect(screen.queryByText("SVA Formal Props")).toBeNull();
  });

  it("Workflow tab shows the bundle YAML controls (Export All / Import Bundle)", async () => {
    render(<SettingsPanel {...settingsProps()} />);
    await userEvent.click(screen.getByText("Workflow"));
    expect(screen.getByText(/Export All Stages/)).toBeInTheDocument();
    expect(screen.getByText(/Import Bundle/)).toBeInTheDocument();
    // Without a settingsDir set, the hint should mention Settings → Paths
    expect(screen.getByText(/Set a working directory/)).toBeInTheDocument();
  });

  it("Workflow tab surfaces settingsDir hint when set", async () => {
    render(<SettingsPanel {...settingsProps({
      config: Object.assign({}, settingsProps().config, { settingsDir: "/Users/rio/rtl-prompts" }),
    })} />);
    await userEvent.click(screen.getByText("Workflow"));
    expect(screen.getByText(/\/Users\/rio\/rtl-prompts/)).toBeInTheDocument();
  });

  it("YAML import: parses a valid single-stage file and shows the confirmation dialog", async () => {
    const setConfig = vi.fn();
    render(<SettingsPanel {...settingsProps({ setConfig })} />);
    await userEvent.click(screen.getByText("Workflow"));

    // Click on a stage node to open the editor — start with elicit.
    // The clickable label appears as part of the SVG flow graph; we open the
    // editor by clicking on a stage's SVG group via its title.
    // Easiest path: trigger the same selection programmatically by using
    // the visible "elicit" text from the inline IO table, then click "Edit".
    const elicitNode = screen.getAllByText(/elicit/i)[0];
    await userEvent.click(elicitNode);

    // Once the node is selected, click "Edit" (per-stage editor) to surface
    // the per-stage Import YAML button.
    const editBtn = await screen.findByText(/✏\s*Edit/);
    await userEvent.click(editBtn);

    // Find the hidden file input that accepts .yaml — there are two (per-stage
    // + bundle); pick the first.
    const fileInputs = document.querySelectorAll('input[type="file"][accept*="yaml"]');
    expect(fileInputs.length).toBeGreaterThanOrEqual(1);
    const yamlInput = fileInputs[0];

    // Build a single-stage YAML payload as a File and dispatch it.
    const payload = `stage: elicit
sections:
  - title: Custom Identity
    content: |
      You are a custom RTL Forge variant.
  - title: Custom Task
    content: |
      Ask only one question.
`;
    const file = new File([payload], "custom-elicit.yaml", { type: "text/yaml" });
    await userEvent.upload(yamlInput, file);

    // Confirmation dialog should appear, citing the file name.
    expect(await screen.findByText(/Confirm import: custom-elicit.yaml/)).toBeInTheDocument();
    expect(screen.getByText(/2 section\(s\)/)).toBeInTheDocument();

    // Click Apply
    await userEvent.click(screen.getByText("Apply"));

    // setConfig should have been called with promptOverrides.elicit set
    expect(setConfig).toHaveBeenCalled();
    // Inspect the most recent call's updater function output by invoking it
    // against the original config (this is the React updater pattern).
    const updater = setConfig.mock.calls[setConfig.mock.calls.length - 1][0];
    const before = settingsProps().config;
    const after = updater(before);
    expect(after.promptOverrides).toBeDefined();
    expect(after.promptOverrides.elicit).toHaveLength(2);
    expect(after.promptOverrides.elicit[0].title).toBe("Custom Identity");
    expect(after.promptOverrides.elicit[1].title).toBe("Custom Task");
  });

  it("YAML import: rejects malformed file with a notice (does not call setConfig)", async () => {
    const setConfig = vi.fn();
    render(<SettingsPanel {...settingsProps({ setConfig })} />);
    await userEvent.click(screen.getByText("Workflow"));
    const fileInputs = document.querySelectorAll('input[type="file"][accept*="yaml"]');
    const bundleInput = fileInputs[fileInputs.length - 1];   // bundle input is last

    // Malformed: top-level mapping without 'stage' or 'stages'
    const file = new File(["foo: bar\n"], "bad.yaml", { type: "text/yaml" });
    await userEvent.upload(bundleInput, file);

    // Should show a notice, NOT a confirmation dialog
    expect(await screen.findByText(/Import failed/)).toBeInTheDocument();
    expect(screen.queryByText(/Confirm import:/)).not.toBeInTheDocument();
    expect(setConfig).not.toHaveBeenCalled();
  });
});

// ── VerifyStage ──────────────────────────────────────────────────────────────
import { VerifyStage } from "../src/react/components/stages.jsx";

describe("VerifyStage", () => {
  it("renders pass/total metric", () => {
    render(<VerifyStage
      data={{ pass: 5, fail: 1, total: 6, cov: { line: 80, branch: 70, toggle: 60 }, tests: [], log: "", verifyHistory: [], cli: false }}
      warningsAsErrors={false} setWarningsAsErrors={() => {}}
    />);
    expect(screen.getByText("5/6")).toBeInTheDocument();
  });

  it("renders coverage percentages", () => {
    render(<VerifyStage
      data={{ pass: 6, fail: 0, total: 6, cov: { line: 92, branch: 85, toggle: 78 }, tests: [], log: "", verifyHistory: [], cli: true }}
      warningsAsErrors={false} setWarningsAsErrors={() => {}}
    />);
    expect(screen.getByText("92%")).toBeInTheDocument();
    expect(screen.getByText("85%")).toBeInTheDocument();
    expect(screen.getByText("78%")).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// StructuredFixViewer — per-iteration LLM-fix viewer with three view modes:
// Fixes / Side-by-Side / Diff. Pin the headline behaviours.
// ═══════════════════════════════════════════════════════════════════════════
import { StructuredFixViewer } from "../src/react/components/structuredViewer.jsx";

describe("StructuredFixViewer", function() {
  const sampleStructured = {
    rawText: '{"code":"module x;\\nendmodule","fixes":[{"id":"WIDTHEXPAND","desc":"width fix"}]}',
    parsed: {
      code: "module x;\nendmodule",
      fixes: [{ id: "WIDTHEXPAND", desc: "width fix" }],
    },
    parseOk: true,
    beforeCode: "module x;\n  logic q;\nendmodule",
    afterCode:  "module x;\nendmodule",
    kind: "rtl_fix",
  };

  it("shows 'streaming in progress' when streamingInProgress=true", () => {
    render(<StructuredFixViewer streamingInProgress={true} />);
    expect(screen.getByText(/streaming in progress/i)).toBeInTheDocument();
  });

  it("shows 'not available' when structured prop is null", () => {
    render(<StructuredFixViewer structured={null} />);
    expect(screen.getByText(/structured data not available/i)).toBeInTheDocument();
  });

  it("renders Fixes view by default with parsed fix entries", () => {
    render(<StructuredFixViewer structured={sampleStructured} />);
    // Default tab is "Fixes"
    expect(screen.getByText(/Fixes \(1\)/)).toBeInTheDocument();
    // The fix id and desc should appear
    expect(screen.getByText("WIDTHEXPAND")).toBeInTheDocument();
    expect(screen.getByText("width fix")).toBeInTheDocument();
  });

  it("switches to Side-by-Side view showing Before and After labels", async () => {
    render(<StructuredFixViewer structured={sampleStructured} />);
    const btn = screen.getByText("Side by Side");
    await userEvent.click(btn);
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
  });

  it("switches to Diff view and shows added/removed counts", async () => {
    render(<StructuredFixViewer structured={sampleStructured} />);
    const btn = screen.getByText("Diff");
    await userEvent.click(btn);
    // before has 3 lines, after has 2 lines — 1 line removed (the logic q;).
    // The Diff header shows the legend; a removed-count stat is rendered.
    // Use a flexible matcher because the stat text mixes a Unicode minus
    // glyph with the count in adjacent text nodes.
    expect(screen.getAllByText(function(content) {
      return /[−-]\s*1/.test(content);
    }).length).toBeGreaterThan(0);
    expect(screen.getByText(/unchanged/)).toBeInTheDocument();
  });

  it("shows 'JSON parse failed' badge when parseOk is false", () => {
    const broken = Object.assign({}, sampleStructured, { parseOk: false });
    render(<StructuredFixViewer structured={broken} />);
    expect(screen.getByText(/JSON parse failed/)).toBeInTheDocument();
  });

  it("Fixes view shows 'no fixes recorded' when fixes array is empty", () => {
    const noFixes = Object.assign({}, sampleStructured, {
      parsed: Object.assign({}, sampleStructured.parsed, { fixes: [] }),
    });
    render(<StructuredFixViewer structured={noFixes} />);
    expect(screen.getByText(/Fixes \(0\)/)).toBeInTheDocument();
    expect(screen.getByText(/no fixes recorded/i)).toBeInTheDocument();
  });
});
