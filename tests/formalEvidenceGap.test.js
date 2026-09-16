// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { describe, expect, it, vi } from "vitest";
import { judgeNode } from "../src/pipeline/nodes/judge.js";
import { defaultEvalConfig } from "../src/eval/criteria.js";
import { verificationSummaryText } from "../src/utils/verificationPresentation.js";

function state(formal) {
  const invokeNode = vi.fn(() => { throw new Error("Unexpected repair for missing evidence"); });
  return { _config: { maxJudgeIters: 3, formalProve: true, optionalStages: { formal_verify: true },
    _llmReplay: () => { throw new Error("Unexpected LLM call"); },
    evalCriteria: Object.fromEntries(Object.entries(defaultEvalConfig()).map(([id, c]) => [id, { ...c, enabled: ["verify_pass_rate", "formal_proven"].includes(id) }])) },
    _services: { invokeNode, allStages: [] },
    elicit: { modName: "DirectWord" }, spec: { requirements: [] },
    rtl_generate: { code: "module DirectWord(input d, output q); assign q=d; endmodule" }, test_generate: { code: "frozen testbench" },
    formal_props: { properties: [{ id: "P-WORD", code: "assert (q==d);" }] }, formal_verify: formal,
    verify: { status: "MEASURED", cli: true, pass: 1, fail: 0, total: 1, tests: [{ name: "copy", st: "PASS" }] } };
}
describe("unavailable formal evidence never authorizes behavioral repair", () => {
  it.each([undefined, { status: "SKIPPED", reason: "Property compilation failed" }, { status: "TOOL_ERROR", reason: "Solver missing" },
    { status: "TIMEOUT" }, { status: "PASS", proven: false, proveStatus: "UNKNOWN" },
    { status: "PASS", proven: true, assertionIds: [] }])("retains RTL and reports incomplete verification for %j", async formal => {
    const st = state(formal), out = await judgeNode(st);
    expect(st._services.invokeNode).not.toHaveBeenCalled();
    expect(out.rtl_generate.code).toBe(st.rtl_generate.code);
    expect(out.judge.overall).toBe("UNVERIFIED");
    expect(out.judge.stopReason).toBe("formal-evidence-incomplete");
    expect(out.judge.verified).toBe(false);
    const text = verificationSummaryText({ 8: out.verify, 9: out.judge, 13: formal });
    expect(text).toContain("Verification incomplete");
    expect(text).toContain("Simulation: PASS — 1/1 measured checks");
  });
  it("keeps real formal counterexamples as failures", async () => {
    const st = state({ status: "FAIL", proven: false }); st._config.maxJudgeIters = 1;
    expect((await judgeNode(st)).judge.overall).toBe("FAIL");
  });
  it("does not hide independently measured simulation failures behind a harness error", async () => {
    const st = state({ status: "SKIPPED" }); st._config.maxJudgeIters = 1;
    st.verify = { ...st.verify, pass: 0, fail: 1, tests: [{ name: "copy", st: "FAIL" }] };
    expect((await judgeNode(st)).judge.overall).toBe("FAIL");
  });
  it("does not require formal when it is disabled", async () => {
    const st = state(undefined); st._config.optionalStages.formal_verify = false;
    expect((await judgeNode(st)).judge.overall).toBe("PASS");
  });
  it("does not treat an optional skipped cover as an unproved assertion", async () => {
    const st = state({ status: "PASS", proven: true, assertionIds: ["P-WORD"], formalSkipped: ["C-NEXT"] });
    st.formal_props.properties.push({ id: "C-NEXT", type: "cover", code: "cover property (q ##1 d);" });
    expect((await judgeNode(st)).judge.overall).toBe("PASS");
  });
});
