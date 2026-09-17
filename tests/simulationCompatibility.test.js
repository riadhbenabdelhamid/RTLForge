// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/cli/index.js", async () => ({ ...await vi.importActual("../src/cli/index.js"), runCli: vi.fn() }));
import { runCli } from "../src/cli/index.js";
import { unsupportedSimulationChecks, qualifySimulationEvidence } from "../src/pipeline/simulationCompatibility.js";
import { verifyNode } from "../src/pipeline/nodes/verify.js";
import { judgeNode, _judgeReverifyViaCli, mergeReverifyIntoVerify } from "../src/pipeline/nodes/judge.js";
import { runAcceptanceSuite } from "../src/pipeline/reviewAcceptance.js";
import { mergeSourceEvidence } from "../src/pipeline/sourceContract.js";
import { defaultEvalConfig } from "../src/eval/criteria.js";
import { classifyTestResultsByReq } from "../src/pipeline/classifiers.js";
import { selectCommonCheckerCandidate } from "../src/pipeline/candidateGuard.js";
import { verificationSummaryText } from "../src/utils/verificationPresentation.js";

const commands = "verilator --binary --build {RTL} {TB}\n./obj_dir/checker";
const checks = condition => `module test; initial check(${condition}, "REQ-FUNC-031.start"); endmodule`;
const tb = `module SampleUnit_tb;
logic clk; logic [4:0] sample, result;
SampleUnit dut(clk, sample, result);
task automatic check(input bit cond, input string label);
if (cond) $display("[PASS] %s", label); else $display("[FAIL] %s", label);
endtask
initial begin
check(result === 5'bx, "REQ-FUNC-031.start");
check(result == sample, "REQ-FUNC-032.copy");
end
endmodule`;
const rtl = "module SampleUnit(input clk, input [4:0] sample, output reg [4:0] result); always @(posedge clk) result <= sample; endmodule";
function state() {
  return { elicit: { modName: "SampleUnit" }, spec: { requirements: [
    { id: "REQ-FUNC-031", cat: "Functionality", pri: "Must", desc: "Uninitialized output is unknown." },
    { id: "REQ-FUNC-032", cat: "Functionality", pri: "Must", desc: "Copy the sampled input." },
  ] }, rtl_generate: { code: rtl }, test_generate: { code: tb },
  _config: { backendUrl: "http://test", simCmds: commands, strictCli: true, maxVerifyIters: 3, maxJudgeIters: 3,
    standaloneFallback: false, boundaryProbe: false, optionalStages: { formal_verify: false },
    evalCriteria: Object.fromEntries(Object.entries(defaultEvalConfig()).map(([id, c]) => [id,
      { ...c, enabled: ["verify_pass_rate", "req_func_must", "req_must_green"].includes(id) }])),
    _llmReplay: vi.fn(() => { throw new Error("Unexpected model call for unsupported simulation evidence"); }) },
  _services: { allStages: [], invokeNode: vi.fn(() => { throw new Error("Unexpected repair"); }) } };
}
beforeEach(() => runCli.mockReset());

describe("backend compatibility attribution", () => {
  it.each(["result === 5'bx", "(result === shadow) && (result === 5'bx)", "1'bX === flag",
    "result !== 'x", "((4'shx)) === result", "$isunknown(result)", "!$isunknown(result)"])(
    "recognizes X-sensitive checks: %s", condition => {
      expect(unsupportedSimulationChecks(checks(condition), commands)).toMatchObject([
        { label: "REQ-FUNC-031.start", condition }]);
    });
  it.each(["result === shadow", "result === 5'b10101", "result === 1'bz", "result == sample",
    "$isunknown(0)", "1'b0", "decode(1'bx) === result", "result === decode(1'bx)",
    'message == "result === 1\'bx"'])("does not invent unsupported checks: %s", condition => {
      expect(unsupportedSimulationChecks(checks(condition), commands)).toEqual([]);
    });
  it.each(["iverilog -g2012 -o sim {RTL} {TB}\nvvp sim", "vcs -sverilog {RTL} {TB}",
    "simulator {RTL} {TB}", "# verilator --binary\niverilog -o sim {RTL} {TB}"])(
    "only applies to a selected Verilator compiler: %s", cmds => {
      expect(unsupportedSimulationChecks(checks("result === 'x"), cmds)).toEqual([]);
    });
  it("does not guess dynamic or ambiguous label ownership", () => {
    expect(unsupportedSimulationChecks(`check(q === 'x, $sformatf("startup.%0d", i));`, commands)).toEqual([]);
    expect(unsupportedSimulationChecks(`check(q === 'x, "same"); check(q === d, "same");`, commands)).toEqual([]);
    expect(unsupportedSimulationChecks(`// check(q === 'x, "comment");\ncheck(q === d, "X state");`, commands)).toEqual([]);
  });
  it("preserves raw evidence, exact label boundaries, ordinary failures, and unsupported passes", () => {
    const raw = { cli: true, status: "MEASURED", pass: 1, fail: 2, total: 3, tests: [
      { name: "REQ-FUNC-031.start @0 cycles @ t=0", st: "PASS" },
      { name: "REQ-FUNC-031.start_extra", st: "FAIL" }, { name: "REQ-FUNC-032.copy", st: "FAIL" }],
      log: "[PASS] REQ-FUNC-031.start @0 cycles @ t=0\n[FAIL] REQ-FUNC-031.start_extra\n[FAIL] REQ-FUNC-032.copy" };
    const before = structuredClone(raw);
    const result = qualifySimulationEvidence(raw, tb, commands);
    expect(result).toMatchObject({ total: 3, pass: 0, fail: 2, unsupported: 1 });
    expect(result.tests[0]).toMatchObject({ st: "UNSUPPORTED", rawStatus: "PASS" });
    expect(result.rawLog).toBe(raw.log);
    expect(result.log).toContain("[UNSUPPORTED] REQ-FUNC-031.start");
    expect(result.log).toContain("[FAIL] REQ-FUNC-032.copy");
    expect(raw).toEqual(before);
    expect(qualifySimulationEvidence(result, tb, commands)).toBe(result);
  });
  it.each(["COMPILE_FAILURE", "RUNTIME_EXIT", "UNKNOWN_EXIT", "MISSING_MARKERS", "UNVERIFIED"])(
    "never conceals %s as an unsupported assertion", status => {
      const raw = { status, cli: true, tests: [{ name: "REQ-FUNC-031.start", st: "FAIL" }] };
      expect(qualifySimulationEvidence(raw, tb, commands)).toBe(raw);
    });
  it("does not conceal an independent runtime assertion after labelled failures", () => {
    const raw = { status: "MEASURED", cli: true, tests: [{ name: "REQ-FUNC-031.start", st: "FAIL" }],
      log: "[FAIL] REQ-FUNC-031.start\n%Error: checker.sv:18: Assertion failed in protocol_checker" };
    expect(qualifySimulationEvidence(raw, tb, commands)).toBe(raw);
  });
  it("does not count FAIL to UNSUPPORTED as a resolved requirement", () => {
    const result = classifyTestResultsByReq([{ name: "REQ-FUNC-031.start", st: "FAIL" }], [
      { name: "REQ-FUNC-031.start", st: "UNSUPPORTED" }, { name: "REQ-FUNC-031.copy", st: "PASS" }]);
    expect(result.resolved).toEqual([]);
    expect(result.taskStatus).toBe("INCOMPLETE");
  });
});

describe("unsupported simulation evidence through the pipeline", () => {
  it("preserves RTL and reports incomplete verification without triage or model calls", async () => {
    runCli.mockResolvedValue({ stdout: "[FAIL] REQ-FUNC-031.start @0 cycles @ t=0\n[PASS] REQ-FUNC-032.copy", stderr: "", exitCode: 1 });
    const st = state(), delta = await verifyNode(st);
    expect(delta.verify).toMatchObject({ cli: true, status: "MEASURED", total: 2, pass: 1, fail: 0, unsupported: 1 });
    expect(delta.verify.verifyHistory.at(-1).status).toBe("UNVERIFIED");
    expect(delta.verify.champion.unsupported).toBe(1);
    expect(delta.verify._ledger.requirements.find(r => r.id === "REQ-FUNC-031")).toMatchObject({ status: "untested", green: false });
    const final = await judgeNode({ ...st, ...delta });
    expect(final.judge).toMatchObject({ overall: "UNVERIFIED", verified: false, stopReason: "simulation-evidence-incomplete" });
    expect(final.rtl_generate.code).toBe(rtl);
    expect(final.test_generate.code).toBe(tb);
    expect(st._services.invokeNode).not.toHaveBeenCalled();
    expect(st._config._llmReplay).not.toHaveBeenCalled();
    expect(runCli).toHaveBeenCalledTimes(1);
    const text = verificationSummaryText({ 8: final.verify, 9: final.judge });
    expect(text).toContain("1 PASS, 0 supported FAIL, 1 UNSUPPORTED");
    expect(text).toContain("four-state simulation");
  });
  it("keeps independently measured failures actionable alongside unsupported checks", async () => {
    runCli.mockResolvedValue({ stdout: "[FAIL] REQ-FUNC-031.start\n[FAIL] REQ-FUNC-032.copy", stderr: "", exitCode: 1 });
    const st = state(); st._config.maxVerifyIters = 1; st._config.maxJudgeIters = 1;
    const delta = await verifyNode(st);
    expect(delta.verify).toMatchObject({ pass: 0, fail: 1, unsupported: 1 });
    expect(delta.verify.tests[1].st).toBe("FAIL");
    const final = await judgeNode({ ...st, ...delta });
    expect(final.judge.overall).toBe("FAIL");
    expect(final.judge.stopReason).not.toBe("simulation-evidence-incomplete");
  });
  it("keeps an unsupported check out of repair-acceptance passes and source-merge failures", async () => {
    runCli.mockResolvedValue({ stdout: "[PASS] REQ-FUNC-031.start\n[PASS] REQ-FUNC-032.copy", stderr: "", exitCode: 0 });
    const st = state(), measured = await runAcceptanceSuite(st, rtl, tb);
    expect(measured).toMatchObject({ pass: 1, fail: 0, total: 2, unsupported: 1 });
    const merged = mergeSourceEvidence(measured, { status: "READY", suites: [], issues: [] }, [], rtl);
    expect(merged).toMatchObject({ pass: 1, fail: 0, total: 2, unsupported: 1 });
  });
  it("accepts repairs only for supported improvements on the frozen checker", async () => {
    const st = state(), checker = { version: "test-v1", seed: "fixed", hash: "unchanged-checker" };
    const measure = async (xStatus, functionalStatus) => {
      runCli.mockResolvedValue({ stdout: `[${xStatus}] REQ-FUNC-031.start\n[${functionalStatus}] REQ-FUNC-032.copy`, stderr: "", exitCode: 0 });
      return { verify: { ...await runAcceptanceSuite(st, rtl, tb), checker } };
    };
    const baseline = await measure("FAIL", "FAIL");
    const unsupportedOnly = await measure("PASS", "FAIL");
    const supportedRepair = await measure("PASS", "PASS");
    expect(selectCommonCheckerCandidate(unsupportedOnly, baseline)).toMatchObject({ decision: "FALLBACK", reason: "TIE" });
    expect(selectCommonCheckerCandidate(supportedRepair, baseline)).toMatchObject({ decision: "ACCEPT_IMPROVEMENT", retainedPassedChecks: true });
    expect(supportedRepair.verify.unsupported).toBe(1);
  });
  it("qualifies Judge's direct CLI re-verification as well", async () => {
    runCli.mockResolvedValue({ stdout: "[FAIL] REQ-FUNC-031.start\n[PASS] REQ-FUNC-032.copy", stderr: "", exitCode: 1 });
    const st = state();
    const result = await _judgeReverifyViaCli(st, st, 1, () => {});
    expect(result).toMatchObject({ status: "MEASURED", pass: 1, fail: 0, unsupported: 1 });
  });
  it("clears compatibility evidence when a fresh four-state measurement replaces it", () => {
    const old = qualifySimulationEvidence({ status: "MEASURED", cli: true, pass: 0, fail: 1, total: 1,
      tests: [{ name: "REQ-FUNC-031.start", st: "FAIL" }] }, tb, commands);
    const fresh = { status: "MEASURED", cli: true, pass: 1, fail: 0, total: 1,
      tests: [{ name: "REQ-FUNC-031.start", st: "PASS" }] };
    const merged = mergeReverifyIntoVerify(old, fresh);
    expect(merged.unsupported || 0).toBe(0);
    expect(merged._simulationCompatibility).toBeUndefined();
  });
});
