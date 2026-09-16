// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/llm/index.js", async () => {
  const actual = await vi.importActual("../src/llm/extractJSON.js");
  return { callLLM: vi.fn(), callLLMJson: vi.fn(), extractJSON: actual.extractJSON,
    addRetryHint: p => p };
});
vi.mock("../src/cli/index.js", async () => {
  const actual = await vi.importActual("../src/cli/index.js");
  return { ...actual, runCli: vi.fn() };
});
vi.mock("../src/pipeline/applySkillsToPrompt.js", () => ({ applySkillsToPrompt: async p => p }));

import { callLLM, callLLMJson } from "../src/llm/index.js";
import { runCli } from "../src/cli/index.js";
import { verifyNode } from "../src/pipeline/nodes/verify.js";
import { judgeNode } from "../src/pipeline/nodes/judge.js";
import { specNode } from "../src/pipeline/nodes/spec.js";
import { runEvalGate, triageTargetsFor } from "../src/eval/gate.js";
import { listCriteria } from "../src/eval/criteria.js";
import { makeSpecConflict } from "../src/pipeline/specConflict.js";
import { buildSourceContract, mergeSourceEvidence } from "../src/pipeline/sourceContract.js";

const diagnosis = { target: "spec", reason: "REQ-FUNC-001 and REQ-FUNC-002 contradict each other." };
const stages = ["spec", "architect", "rtl_generate", "test_generate", "verify", "judge"]
  .map((key, i) => ({ key, id: i + 1, order: i * 10 }));
function state() {
  return {
    _userDesc: "Implement a module whose output is always true.",
    elicit: { modName: "unit" },
    spec: { modName: "unit", params: [], iface: [{ name: "result", dir: "output", width: "1" }], requirements: [
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "The output must be true.", src: "output is always true." },
      { id: "REQ-FUNC-002", cat: "Functionality", pri: "Must", desc: "The output must be false." },
    ] },
    rtl_generate: { code: "module unit; endmodule" },
    test_generate: { code: "module unit_tb; endmodule" },
    lint: { status: "PASS", errors: [], warnings: [] },
    verify: { cli: true, sim: "Verilator", total: 2, pass: 1, fail: 1,
      tests: [{ name: "T1", st: "PASS", req: "REQ-FUNC-001" },
        { name: "T2", st: "FAIL", req: "REQ-FUNC-002" }], cov: {}, log: "" },
    _config: { provider: "openai", model: "test", apiKey: "test", stageSettings: {},
      backendUrl: "http://test", simCmds: "sim {RTL} {TB}", strictCli: false,
      cliRetryCount: 0, backendTimeoutSec: 1, triageInvestigation: false,
      maxVerifyIters: 3, maxJudgeIters: 3, judgeReflowMode: "strict" },
  };
}
function pendingState() {
  const st = state();
  st.verify._specConflict = makeSpecConflict(st, diagnosis);
  st.verify.status = "NEEDS_SPEC_REVIEW";
  return st;
}
function reply(data) {
  return { text: JSON.stringify(data), tokensIn: 10, tokensOut: 10, model: "test", provider: "test" };
}
function reviewed(data) { return { data, llms: [reply(data)] }; }
function installChain(st, calls) {
  st._services = { allStages: stages, invokeNode: vi.fn(async (key, sub) => {
    calls.push(key);
    if (key === "spec") return specNode(sub);
    if (key === "verify") return { verify: mergeSourceEvidence({ status: "PASS", cli: true, total: 1, pass: 1, fail: 0,
      tests: [{ name: "T1", st: "PASS", req: "REQ-FUNC-001" }], cov: {}, log: "" },
      buildSourceContract(sub._userDesc, sub.spec, sub.elicit.modName, sub.elicit), [], sub.rtl_generate.code) };
    return {};
  }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  callLLM.mockReset();
  callLLMJson.mockReset();
  runCli.mockReset();
  runCli.mockResolvedValue({ stdout: "[PASS] T1\n[FAIL] T2\n", stderr: "", exitCode: 1 });
});

describe("verification specification-conflict escalation", () => {
  it.each([false, true])("stops before any local artifact repair (chain=%s)", async chain => {
    const st = state();
    if (chain) installChain(st, []);
    callLLM.mockResolvedValueOnce(reply(diagnosis));
    const result = await verifyNode(st);
    expect(result.verify.status).toBe("NEEDS_SPEC_REVIEW");
    expect(result.verify._specConflict.reason).toBe(diagnosis.reason);
    expect(result.verify._specConflict.requirementIds).toEqual(["REQ-FUNC-001", "REQ-FUNC-002"]);
    expect(result.rtl_generate.code).toBe(st.rtl_generate.code);
    expect(result.test_generate.code).toBe(st.test_generate.code);
    expect(callLLM).toHaveBeenCalledTimes(1);
    if (chain) expect(st._services.invokeNode).not.toHaveBeenCalled();
  });

  it("preserves the request across checkpoint reload and a verify rerun", async () => {
    const st = JSON.parse(JSON.stringify(pendingState()));
    const result = await verifyNode(st);
    expect(result.verify._specConflict).toEqual(st.verify._specConflict);
    expect(callLLM).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
  });

  it("propagates a conflict from a nested verification without another repair", async () => {
    const st = state();
    const pending = pendingState().verify;
    const calls = [];
    st._services = { allStages: stages, invokeNode: vi.fn(async key => {
      calls.push(key);
      return key === "verify" ? { verify: pending } : {};
    }) };
    callLLM.mockResolvedValueOnce(reply({ target: "rtl_generate", reason: "An implementation defect" }));
    const result = await verifyNode(st);
    expect(result.verify._specConflict).toEqual(pending._specConflict);
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)).toBe("verify");
  });
});

describe("judge escalation and acceptance", () => {
  it("makes spec eligible even with only verification failing or all criteria disabled", () => {
    const st = pendingState();
    const disabled = Object.fromEntries(listCriteria().map(c => [c.id, { enabled: false }]));
    for (const cfg of [{}, disabled]) {
      const verdict = runEvalGate(st, cfg);
      expect(verdict.overall).toBe("FAIL");
      expect(triageTargetsFor(verdict)).toEqual(["spec"]);
    }
  });

  it("cannot report PASS for an unresolved conflict when no repair iterations remain", async () => {
    const st = pendingState();
    st.verify.pass = 2; st.verify.fail = 0;
    st.verify.tests.forEach(t => { t.st = "PASS"; });
    st._config.maxJudgeIters = 1;
    const result = await judgeNode(st);
    expect(result.judge.overall).toBe("UNVERIFIED");
    expect(result.judge.verified).toBe(false);
    expect(result.judge.specConflict).toEqual(st.verify._specConflict);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("reviews the diagnosis and reruns downstream stages after a supported revision", async () => {
    const st = pendingState();
    const fixed = { ...st.spec, requirements: [st.spec.requirements[0]] };
    callLLMJson.mockResolvedValueOnce(reviewed({ decision: "revise", reason: "REQ-FUNC-002 was introduced by extraction." }))
      .mockResolvedValueOnce(reviewed(fixed));
    const calls = [];
    installChain(st, calls);
    const result = await judgeNode(st);
    expect(calls.slice(0, 6)).toEqual(stages.map(s => s.key));
    expect(callLLM).not.toHaveBeenCalled();
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    expect(callLLMJson.mock.calls[0][0].userMessage).toContain(st._userDesc);
    expect(callLLMJson.mock.calls[0][0].userMessage).toContain(diagnosis.reason);
    expect(callLLMJson.mock.calls[1][0].userMessage).toContain("SPECIFICATION CONFLICT REVIEW");
    expect(result.spec.requirements).toEqual(fixed.requirements);
    expect(result.verify._specConflict).toBeFalsy();
    expect(result.judge.overall).toBe("PASS");
  });

  it.each([false, true])("halts for clarification without rewriting downstream artifacts (chain=%s)", async chain => {
    const st = pendingState();
    const calls = [];
    if (chain) installChain(st, calls);
    callLLMJson.mockResolvedValueOnce(reviewed({ decision: "needs_clarification", reason: "Should REQ-FUNC-001 or REQ-FUNC-002 apply?" }));
    const result = await judgeNode(st);
    expect(result.judge.overall).toBe("UNVERIFIED");
    expect(result.judge.stopReason).toBe("spec-clarification-required");
    expect(result.spec).toEqual(st.spec);
    expect(result.rtl_generate.code).toBe(st.rtl_generate.code);
    expect(result.test_generate.code).toBe(st.test_generate.code);
    expect(callLLM).not.toHaveBeenCalled();
    if (chain) expect(calls).toEqual(["spec"]);
  });

  it("also reviews and re-verifies on the legacy path", async () => {
    const st = pendingState();
    const fixed = { ...st.spec, requirements: [st.spec.requirements[0]] };
    callLLMJson.mockResolvedValueOnce(reviewed({ decision: "revise", reason: "REQ-FUNC-002 contradicts the stated constant true output." }))
      .mockResolvedValueOnce(reviewed(fixed));
    callLLM.mockResolvedValueOnce(reply({ code: "module unit(output result); assign result = 1'b1; endmodule" }))
      .mockResolvedValueOnce(reply({ code: "module unit_tb; initial $finish; endmodule" }));
    runCli.mockResolvedValue({ stdout: "[PASS] T1 [REQ-FUNC-001]\n", stderr: "", exitCode: 0 });
    const result = await judgeNode(st);
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(runCli).toHaveBeenCalled();
    expect(result.spec.requirements).toEqual(fixed.requirements);
    expect(result.verify._specConflict).toBeNull();
    expect(result.verify._specConflictReview.decision).toBe("revise");
    expect(result.judge.overall).toBe("PASS");
  });

  it("stops downstream generation if spec review throws in non-strict mode", async () => {
    const st = pendingState();
    st._config.strictJudgeCli = false;
    callLLMJson.mockRejectedValue(new Error("No usable review response"));
    const calls = [];
    installChain(st, calls);
    const result = await judgeNode(st);
    expect(calls).toEqual(["spec"]);
    expect(result.verify._specConflict).toEqual(st.verify._specConflict);
    expect(result.judge.overall).toBe("UNVERIFIED");
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("cannot restore old passing evidence if reflow stops after specification review", async () => {
    const st = pendingState();
    st.verify.pass = 2; st.verify.fail = 0;
    st.verify.tests.forEach(t => { t.st = "PASS"; });
    const fixed = { ...st.spec, requirements: [st.spec.requirements[0]] };
    callLLMJson.mockResolvedValueOnce(reviewed({ decision: "revise", reason: "REQ-FUNC-002 was added during extraction." }))
      .mockResolvedValueOnce(reviewed(fixed));
    st._config.strictJudgeCli = true;
    st._services = { allStages: stages, invokeNode: async (key, sub) => {
      if (key === "spec") return specNode(sub);
      throw new Error("Generation unavailable");
    } };
    const result = await judgeNode(st);
    expect(result.spec.requirements).toEqual(fixed.requirements);
    expect(result.verify.cli).toBe(false);
    expect(result.verify.total).toBe(0);
    expect(result.judge.overall).toBe("UNVERIFIED");
  });
});

describe("specification review boundaries", () => {
  it("rejects an unsupported diagnosis without applying a model-supplied replacement", async () => {
    const st = pendingState();
    callLLMJson.mockResolvedValueOnce(reviewed({ decision: "reject", reason: "The requirements apply in different modes.",
      spec: { requirements: [] } }));
    const result = await specNode(st);
    expect(result.spec).toBe(st.spec);
    expect(result.verify._specConflict).toBeNull();
    expect(result.verify.cli).toBe(false);
    expect(result.verify.status).toBe("UNVERIFIED");
    expect(result.verify._specConflictReview.decision).toBe("reject");
  });

  it("does not silently revise an imported specification", async () => {
    const st = pendingState();
    st._specImport = { text: JSON.stringify(st.spec), format: "json" };
    const result = await specNode(st);
    expect(result.spec).toBe(st.spec);
    expect(result.verify._specConflict.review.decision).toBe("needs_clarification");
    expect(callLLMJson).not.toHaveBeenCalled();
  });

  it("keeps the request pending for an invalid review response", async () => {
    const st = pendingState();
    callLLMJson.mockResolvedValueOnce(reviewed({ decision: "revise" }));
    const result = await specNode(st);
    expect(result.spec).toBe(st.spec);
    expect(result.verify._specConflict).toBeTruthy();
    expect(callLLMJson).toHaveBeenCalledTimes(1);
  });
});
