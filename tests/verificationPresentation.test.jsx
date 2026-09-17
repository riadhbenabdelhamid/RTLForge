// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JudgeStage, VerifyStage } from "../src/react/components/stages.jsx";
import { stageBadgeStyle } from "../src/react/components/stageBadgeStyle.js";
import { TH } from "../src/constants/theme.js";
import { verificationSummary, verificationSummaryText, outcomePresentation, UNVERIFIED_EXPLANATION, CRITERIA_SCORE_EXPLANATION } from "../src/utils/verificationPresentation.js";
import { cmdStatus } from "../src/term/commands/status.js";
import { cmdExport } from "../src/term/commands/export.js";
import { CHECKPOINT_VERSION } from "../src/projectState/checkpoint.js";

const issues = ["REQ-FUNC-021", "REQ-TIME-008"].map(id => ({ id, quote: "", reason: "Behavioral default is an assumption, not a source-supported requirement" }));
const fixture = () => ({
  1: { modName: "AuthoredUnit" },
  2: { requirements: [], _sourceContract: { status: "UNRESOLVED", issues } },
  8: { status: "UNVERIFIED", cli: true, total: 7, pass: 7, fail: 0, _checkerEvidenceInvalid: true,
    _sourceEvidence: { status: "UNVERIFIED", issues } },
  9: { overall: "UNVERIFIED", score: 100, verified: false, evalOverall: "PASS", unverifiedReason: "Two source assumptions need review.",
    judgeHistory: [{ iter: 1, overall: "UNVERIFIED", score: 100, unmet: 0, total: 2 }] },
  13: { status: "SKIPPED", reason: "unresolved behavioral source provenance; formal properties cannot drive RTL repair", sourceIssues: issues },
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("verification presentation separates measured checks from qualification", () => {
  it("shows unsupported checks in amber without counting them as failures or passes", () => {
    const sd = { 8: { cli: true, status: "MEASURED", total: 2, pass: 1, fail: 0, unsupported: 1,
      _simulationCompatibility: { reason: "X-sensitive checks require four-state simulation.",
        checks: [{ label: "boot", condition: "result === 'x" }] },
      tests: [{ name: "boot", req: "REQ-FUNC-041", st: "UNSUPPORTED", rawStatus: "FAIL", reason: "Requires four-state simulation" },
        { name: "copy", req: "REQ-FUNC-042", st: "PASS" }] },
      9: { overall: "UNVERIFIED", score: 75 } };
    const text = verificationSummaryText(sd);
    expect(text).toContain("1 PASS, 0 supported FAIL, 1 UNSUPPORTED");
    expect(text).toContain("UNSUPPORTED boot: result === 'x");
    const view = render(<VerifyStage data={sd[8]} stageData={sd} />);
    expect(view.getByText(/1 PASS, 0 supported FAIL, 1 UNSUPPORTED/)).toHaveStyle({ color: TH.yellow });
    expect(view.getByText(/Simulator limitation:/)).toBeTruthy();
    fireEvent.click(view.getByText("Functionality"));
    expect(view.getByText("UNSUPPORTED")).toHaveStyle({ color: TH.yellow });
    expect(view.getByText("UNSUPPORTED").closest("[title]")).toHaveAttribute("title", "Requires four-state simulation");
    expect(view.getAllByText("INCOMPLETE").length).toBe(2);
  });
  it("keeps real failures red when other checks are unsupported", () => {
    const data = { cli: true, status: "MEASURED", total: 2, pass: 0, fail: 1, unsupported: 1,
      tests: [{ name: "boot", st: "UNSUPPORTED" }, { name: "copy", st: "FAIL" }] };
    expect(verificationSummary({ 8: data }).rows[1]).toMatchObject({ status: "FAIL", tone: "failure" });
    expect(verificationSummaryText({ 8: data })).toContain("0 PASS, 1 supported FAIL, 1 UNSUPPORTED");
  });

  it("shows the same four facts without changing recorded verdicts or scores", () => {
    const sd = fixture(), before = structuredClone(sd);
    const text = verificationSummaryText(sd);
    expect(text).toContain("Overall: Verification incomplete (UNVERIFIED)");
    expect(text).toContain("Simulation: PASS — 7/7 measured checks");
    expect(text).toContain("Formal: SKIPPED — source qualification blocked");
    expect(text).toContain("Source traceability: 2 unresolved assumption entries");
    expect(text).toContain("Criteria score: 100/100");
    expect(text).toContain(CRITERIA_SCORE_EXPLANATION);
    expect(text).toContain(UNVERIFIED_EXPLANATION);
    expect(sd).toEqual(before);
  });

  it.each(["_compileFailure", "_runtimeExit", "_unknownExit", "_noMarkers", "_missingMarkers"])(
    "does not turn green markers into measured PASS with %s", key => {
      const sd = fixture(); sd[8][key] = true;
      expect(verificationSummary(sd).rows[1].status).toBe("INCONCLUSIVE");
    });

  it("keeps zero tests, inconsistent counts, unknown outcomes, and estimates distinct from measured PASS", () => {
    for (const data of [
      { cli: true, pass: 0, fail: 0, total: 0, status: "PASS" },
      { cli: true, pass: 1, fail: 0, total: 7, status: "PASS" },
      { cli: true, pass: 7, fail: 0, total: 7, status: "UNKNOWN_EXIT" },
      { cli: false, pass: 7, fail: 0, total: 7, status: "PASS" },
      { cli: true, pass: 7, fail: 0, total: 7, status: "UNVERIFIED" },
      { cli: true, pass: 7, fail: 0, total: 7, status: "PASS", _checkerEvidenceInvalid: true },
    ]) expect(verificationSummary({ 8: data }).rows[1].status).not.toBe("PASS");
  });

  it("preserves measured failures, source failures and successful qualified outcomes", () => {
    const sd = fixture();
    sd[8] = { cli: true, pass: 6, fail: 1, total: 7, status: "FAIL", _sourceEvidence: { status: "FAIL", issues: [] } };
    sd[9] = { overall: "FAIL", score: 80 };
    expect(verificationSummary(sd).rows[1]).toMatchObject({ status: "FAIL", tone: "failure" });
    expect(verificationSummaryText(sd)).toContain("Source traceability: FAIL — source checks failed");
    sd[8] = { cli: true, pass: 7, fail: 0, total: 7, status: "PASS" };
    sd[9] = { overall: "PASS", score: 100, verified: true };
    sd[13] = { status: "PASS", depth: 11 };
    expect(verificationSummary(sd).rows[0]).toMatchObject({ status: "PASS", tone: "success" });
    expect(verificationSummary(sd).rows[2].value).toBe("PASS — bounded checks (depth 11)");
    delete sd[9];
    expect(verificationSummary(sd).rows[0].value).toBe("No final verdict recorded");
  });

  it("does not relabel non-assumption source issues as assumptions", () => {
    const sd = fixture(); sd[8]._sourceEvidence.issues = [...issues, { id: "SOURCE.ROW.1", reason: "Ambiguous sampling phase" }];
    expect(verificationSummaryText(sd)).toContain("2 unresolved assumption entries; 1 other unresolved source issue");
  });

  it("shows adopted choices separately from unresolved source issues in GUI and CLI", () => {
    const assumptions = [{ id: "REQ-FUNC-019", ref: "A-03", description: "Choose a value-preserving mapping." }];
    const sd = { 2: { _sourceContract: { status: "READY", issues: [], assumptions } },
      8: { status: "PASS", cli: true, total: 7, pass: 7, fail: 0 },
      9: { overall: "UNVERIFIED", score: 100, contractAssumptions: assumptions },
      13: { status: "PASS", depth: 9, contractAssumptions: assumptions } };
    const text = verificationSummaryText(sd);
    expect(text).toContain("1 auto-selected assumption entry (unconfirmed user intent)");
    expect(text).toContain("REQ-FUNC-019 [A-03]: Choose a value-preserving mapping.");
    expect(text).toContain("against completed specification with recorded assumptions");
    expect(text).not.toContain("source qualification blocked");
    const view = render(<VerifyStage data={sd[8]} stageData={sd} />);
    expect(view.getByText("1 auto-selected assumption entry (unconfirmed user intent)")).toHaveStyle({ color: TH.yellow });
    expect(view.getByText(/REQ-FUNC-019 \[A-03\]/)).toBeTruthy();
  });

  it("renders Judge tooltip, criteria label and the unchanged package-export gate", () => {
    const sd = fixture();
    const exportPackage = vi.fn();
    const view = render(<JudgeStage data={sd[9]} stageData={sd} onExportPackage={exportPackage} />);
    expect(view.getByText("UNVERIFIED")).toHaveAttribute("title", UNVERIFIED_EXPLANATION);
    expect(view.getByText("UNVERIFIED")).toHaveStyle({ color: TH.yellow });
    expect(view.getByText(/Criteria score: 100\/100/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: /Export as Package/ }));
    expect(exportPackage).not.toHaveBeenCalled();
    expect(view.getByText("PASS — 7/7 measured checks")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: /Judge Loop/ }));
    expect(view.getByText("UNVERIFIED")).toHaveAttribute("title", UNVERIFIED_EXPLANATION);
    expect(view.getByText("UNVERIFIED")).toHaveStyle({ color: TH.yellow });
  });

  it("renders unresolved status beside real passing simulation on the Verify page", () => {
    const sd = fixture();
    const view = render(<VerifyStage data={sd[8]} stageData={sd} />);
    expect(view.getByText("Verification incomplete (UNVERIFIED)")).toHaveAttribute("title", UNVERIFIED_EXPLANATION);
    expect(view.getByText("Real CLI")).toBeTruthy();
    expect(view.getByText("SKIPPED — source qualification blocked")).toBeTruthy();
    expect(view.container.textContent).not.toContain("simulation results are LLM-estimated");
  });

  it("uses amber warning badges while preserving hard errors and reflow indicators", () => {
    const outcome = outcomePresentation(fixture()[9]);
    const flags = { stageId: 9, done: true, hasUnresolved: outcome.unresolved };
    expect(stageBadgeStyle(flags)).toMatchObject({ badgeText: "⚠", badgeStyle: { color: TH.yellow } });
    expect(stageBadgeStyle({ ...flags, hasErr: true })).toMatchObject({ badgeText: "!", badgeStyle: { color: TH.red } });
    expect(stageBadgeStyle({ ...flags, inReflowSet: true, processing: true }).badgeText).toBe("↻");
  });
});

describe("saved-project CLI presentation", () => {
  it("shows UNVERIFIED/SKIPPED in status and preserves real simulation in exported reports", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rtlforge-display-"));
    const previous = process.env.RTLFORGE_HOME;
    const stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation(chunk => { stdout.push(String(chunk)); return true; });
    try {
      process.env.RTLFORGE_HOME = temp;
      fs.mkdirSync(path.join(temp, "projects"));
      const checkpoint = path.join(temp, "projects", encodeURIComponent("rtlforge:checkpoint:authored-display") + ".json");
      fs.writeFileSync(checkpoint, JSON.stringify({ version: CHECKPOINT_VERSION, projectId: "authored-display", timestamp: 0,
        activeModId: "design", config: { optionalStages: { formal_verify: true } },
        modules: { design: { completed: [8, 9, 13], stageData: fixture() } } }));
      const before = fs.readFileSync(checkpoint, "utf8");
      expect(await cmdStatus({ _: ["authored-display"] })).toBe(0);
      const text = stdout.join("");
      expect(text).toMatch(/Verify\s+UNVERIFIED/);
      expect(text).toMatch(/Judge\s+UNVERIFIED/);
      expect(text).toMatch(/Formal BMC\s+SKIPPED/);
      expect(text).toContain(UNVERIFIED_EXPLANATION);
      expect(text).toContain("Simulation: PASS — 7/7 measured checks");
      const out = path.join(temp, "export");
      expect(await cmdExport({ _: ["authored-display"], out })).toBe(0);
      const report = fs.readFileSync(path.join(out, "AuthoredUnit.report.txt"), "utf8");
      expect(report).toContain("Overall: Verification incomplete (UNVERIFIED)");
      expect(report).toContain(UNVERIFIED_EXPLANATION);
      expect(report).toContain("Simulation: PASS — 7/7 measured checks");
      expect(report).not.toContain("simulation results were LLM-estimated");
      expect(fs.readFileSync(checkpoint, "utf8")).toBe(before);
    } finally {
      if (previous === undefined) delete process.env.RTLFORGE_HOME;
      else process.env.RTLFORGE_HOME = previous;
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
