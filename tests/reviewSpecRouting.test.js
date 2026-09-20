// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/llm/index.js", async () => ({ ...await vi.importActual("../src/llm/index.js"), callLLM: vi.fn(), callLLMJson: vi.fn() }));
import { callLLM, callLLMJson } from "../src/llm/index.js";
import { rtlReviewNode } from "../src/pipeline/nodes/rtl_review.js";
import { testReviewNode } from "../src/pipeline/nodes/test_review.js";
import { formalPropsNode } from "../src/pipeline/nodes/formal_props.js";
import { formalVerifyNode } from "../src/pipeline/nodes/formal_verify.js";
import { pendingSpecConflictOf, reviewSpecConflict } from "../src/pipeline/specConflict.js";
import { sealDesignContract } from "../src/pipeline/designContract.js";
import { guardStageReplacement } from "../src/pipeline/stageAcceptance.js";
import { runStage } from "../src/projectState/runStage.js";
import { blankModule } from "../src/projectState/moduleRegistry.js";
import { ALL_STAGES } from "../src/constants/stages.js";
import { projectReducer, createInitialProjectState } from "../src/projectState/reducer.js";
import { runEvalGate, triageTargetsFor } from "../src/eval/gate.js";
import { outcomePresentation, verificationSummary } from "../src/utils/verificationPresentation.js";

function state() {
  const st = { _userDesc: "Inhibit always forces power off. Otherwise an increased request turns power on.",
    _config: { stageSettings: {}, maxRtlReviewIters: 3, maxTestReviewIters: 3 },
    elicit: { modName: "ThermalControl" }, architect: {},
    spec: { modName: "ThermalControl", iface: [{ name: "inhibit", dir: "input", width: "1" },
      { name: "power", dir: "output", width: "1" }], params: [], requirements: [
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "Inhibit always forces power off.", src: "Inhibit always forces power off." },
      { id: "REQ-FUNC-002", cat: "Functionality", pri: "Should", desc: "Increased request always turns power on.", src: "", rat: "[domain default]" }] },
    rtl_generate: { code: "module ThermalControl(input inhibit, output power); assign power=1'b1; endmodule" },
    test_generate: { code: "module ThermalControl_tb; initial $finish; endmodule" },
    verify: { status: "PASS", cli: true, total: 6, pass: 6, fail: 0, tests: [] } };
  st.spec._designContract = sealDesignContract(st._userDesc, st.spec, st.elicit);
  return st;
}
const conflict = () => ({ verdict: "NEEDS_FIX", score: 55, issues: [{ id: "RR-001", severity: "critical", category: "spec_gap",
  description: "REQ-FUNC-002 conflicts with REQ-FUNC-001 when inhibit is set and the request increases.",
  fix: "Scope the selected general rule around the explicit inhibit exception." }] });
const reply = data => ({ text: JSON.stringify(data), tokensIn: 1, tokensOut: 1 });
beforeEach(() => { callLLM.mockReset(); callLLMJson.mockReset(); });

describe("review findings that require a specification revision", () => {
  it.each([false, true])("routes an RTL-review conflict to Spec without attempting an RTL repair (chain=%s)", async chain => {
    const st = state();
    if (chain) st._services = { allStages: ALL_STAGES, invokeNode: vi.fn() };
    callLLM.mockResolvedValueOnce(reply(conflict()));
    const out = await guardStageReplacement("rtl_review", rtlReviewNode)(st);
    expect(callLLM).toHaveBeenCalledOnce();
    expect(out.rtl_review).toMatchObject({ status: "NEEDS_SPEC_REVIEW", _repairUnresolved: true });
    expect(out.rtl_generate.code).toBe(st.rtl_generate.code);
    expect(out.verify).toMatchObject({ status: "NEEDS_SPEC_REVIEW", pass: 6, total: 6,
      _specConflict: { source: "rtl_review", requirementIds: ["REQ-FUNC-001", "REQ-FUNC-002"] } });
    if (chain) expect(st._services.invokeNode).not.toHaveBeenCalled();
    expect(triageTargetsFor(runEvalGate({ ...st, ...out }))).toEqual(["spec"]);
    expect(outcomePresentation(out.rtl_review).tone).toBe("warning");
    expect(verificationSummary({ 8: out.verify, 9: { overall: "PASS" } }).rows[0].status).toBe("UNVERIFIED");
    expect(verificationSummary({ 8: out.verify }).rows[1].value).toBe("PASS — 6/6 measured checks (specification under review)");
  });
  it("also escalates a conflict found by Test Review without rewriting either artifact", async () => {
    const st = state();
    callLLM.mockResolvedValueOnce(reply(conflict()));
    const out = await testReviewNode(st);
    expect(pendingSpecConflictOf(out)?.source).toBe("test_review");
    expect(out.test_generate.code).toBe(st.test_generate.code);
    expect(out.rtl_generate).toBeUndefined();
    expect(callLLM).toHaveBeenCalledOnce();
  });
  it.each(["FAIL", "TOOL_ERROR"])("does not turn %s measurements into passing evidence during review", async status => {
    const st = state(); st.verify = { ...st.verify, status, pass: 5, fail: 1 };
    callLLM.mockResolvedValueOnce(reply(conflict()));
    const out = await rtlReviewNode(st);
    expect(verificationSummary({ 8: out.verify }).rows[1].status).toBe(status === "FAIL" ? "FAIL" : "INCONCLUSIVE");
  });
  it("keeps ordinary missing-implementation findings on the RTL repair path", () => {
    const st = state(), review = conflict();
    review.issues[0].description = "REQ-FUNC-001 is missing from the RTL implementation.";
    expect(reviewSpecConflict(st, review)).toBeNull();
    review.issues[0].description = "An unreferenced interpretation might be inconsistent.";
    expect(reviewSpecConflict(st, review)).toBeNull();
    review.issues[0].description = "The RTL output conflicts with REQ-FUNC-001.";
    review.issues[0].fix = "Implement the missing inhibit branch.";
    expect(reviewSpecConflict(st, review)).toBeNull();
    review.issues[0] = { ...conflict().issues[0], target: "rtl" };
    expect(reviewSpecConflict(st, review)).toBeNull();
  });
  it("honors a source-specific diagnosis even when the model incorrectly emits verdict PASS", async () => {
    const st = state(), review = conflict(); review.verdict = "PASS";
    review.issues[0].category = "correctness"; review.issues[0].target = "spec";
    callLLM.mockResolvedValueOnce(reply(review));
    const out = await rtlReviewNode(st);
    expect(out.rtl_review.verdict).toBe("NEEDS_FIX");
    expect(pendingSpecConflictOf(out)).toBeTruthy();
  });
  it("preserves pending conflicts across review reruns and prevents formal activity", async () => {
    const st = state(); st.verify._specConflict = reviewSpecConflict(st, conflict());
    const runner = { sbyAvailable: vi.fn(), runBmc: vi.fn() }; st._services = { formalRunner: runner };
    expect(pendingSpecConflictOf(await rtlReviewNode(st))).toEqual(st.verify._specConflict);
    expect(pendingSpecConflictOf(await testReviewNode(st))).toEqual(st.verify._specConflict);
    expect((await formalPropsNode(st)).formal_props.status).toBe("SKIPPED");
    expect((await formalVerifyNode(st)).formal_verify.status).toBe("SKIPPED");
    expect(callLLM).not.toHaveBeenCalled(); expect(callLLMJson).not.toHaveBeenCalled();
    expect(runner.sbyAvailable).not.toHaveBeenCalled(); expect(runner.runBmc).not.toHaveBeenCalled();
  });
  it("persists a review-created conflict through the shared GUI/CLI stage executor", async () => {
    const st = state();
    let project = { ...createInitialProjectState(), activeModId: "unit", modules: { unit: { ...blankModule(),
      stageData: { 1: st.elicit, 2: st.spec, 3: st.architect, 4: st.rtl_generate } } } };
    callLLM.mockResolvedValueOnce(reply(conflict()));
    const out = await runStage({ stageId: 10, stageKey: "rtl_review", targetModId: "unit", reducerState: project,
      uiState: { mode: "full-auto", userDesc: st._userDesc, config: st._config, activeStages: ALL_STAGES },
      services: { allStages: ALL_STAGES, pipeline: { invokeNode: (_, s) => rtlReviewNode(s) } },
      dispatch: action => { project = projectReducer(project, action); } });
    expect(out.ok).toBe(true);
    const saved = JSON.parse(JSON.stringify(project.modules.unit.stageData));
    expect(saved[8]._specConflict.source).toBe("rtl_review");
    expect(saved[8].status).toBe("NEEDS_SPEC_REVIEW");
    expect(saved[4].code).toBe(st.rtl_generate.code);
  });
});
