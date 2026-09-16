// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
vi.mock("../src/cli/index.js", async () => ({ ...await vi.importActual("../src/cli/index.js"), runCli: vi.fn() }));
import { runCli } from "../src/cli/index.js";
import { sealDesignContract, assessDesignContract, checkerInputHash, checkerDescription } from "../src/pipeline/designContract.js";
import { buildSourceContract, mergeSourceEvidence } from "../src/pipeline/sourceContract.js";
import { createReviewAcceptance } from "../src/pipeline/reviewAcceptance.js";
import { applySkillsToPrompt } from "../src/pipeline/applySkillsToPrompt.js";
import { formalVerifyNode } from "../src/pipeline/nodes/formal_verify.js";
import { rtlGenerateNode } from "../src/pipeline/nodes/rtl_generate.js";
import * as formalRunner from "../src/cli/formalRunner.js";
import { judgeNode, checkerEvidenceInvalidOf } from "../src/pipeline/nodes/judge.js";
import { buildSvaChecker } from "../src/pipeline/svaBind.js";
import { defaultEvalConfig } from "../src/eval/criteria.js";
import { extractModuleInterface } from "../src/utils/svInterface.js";
import { djb2 } from "../src/utils/hash.js";
import { verificationSummaryText } from "../src/utils/verificationPresentation.js";
import { projectReducer, createInitialProjectState } from "../src/projectState/reducer.js";
import { blankModule } from "../src/projectState/moduleRegistry.js";
import { MODULE_STAGE_DATA_SET, MODULE_STAGE_DATA_MERGE } from "../src/projectState/actions.js";

const good = "module word_unit(input [2:0] d, output [2:0] q); assign q=d; endmodule";
const bad = good.replace("q=d", "q=d & 3'b001");
const tb = `module word_unit_tb;
reg [2:0] d; wire [2:0] q; word_unit dut(d,q);
initial begin d=1; #1; if(q===3'd1) $display("[PASS] word.low"); else $display("[FAIL] word.low");
d=6; #1; if(q===3'd6) $display("[PASS] word.high"); else $display("[FAIL] word.high"); $finish; end
endmodule`;
function state() {
  const st = { _userDesc: "Build a combinational word adapter with three-bit d and q ports.",
    _config: { backendUrl: "local", simCmds: "iverilog -g2012 -s word_unit_tb -o sim {RTL} {TB}\nvvp sim", maxFormalIters: 0, formalProve: false },
    elicit: { modName: "word_unit", assumptions: [{ id: "A-01", text: "Copy the input word without changing its value.", confirmed: true }] },
    spec: { modName: "word_unit", iface: [{ name: "d", dir: "input", width: "3" }, { name: "q", dir: "output", width: "3" }], params: [],
      requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "Copy d to q.", src: "", rat: "[source: assumption A-01]" }] },
    rtl_generate: { code: bad, _standaloneCandidate: { code: bad } } };
  seal(st);
  const header = extractModuleInterface(bad, "word_unit");
  st.rtl_generate._standaloneCheckerCandidate = { code: tb, status: "READY", designContractHash: st.spec._designContract.hash,
    qualification: { status: "PASS", sourceHash: djb2(tb), inputHash: checkerInputHash(st, header) } };
  return st;
}
function seal(st) { st.spec._designContract = sealDesignContract(st._userDesc, st.spec, st.elicit, st.spec._designContract); }
function contract(st) { return buildSourceContract(st._userDesc, st.spec, st.spec.modName, st.elicit); }
beforeEach(() => { runCli.mockReset(); runCli.mockImplementation(async (_, request) => {
  const dir = mkdtempSync(join(tmpdir(), "completed-contract-"));
  try {
    for (const [name, code] of Object.entries(request.files)) writeFileSync(join(dir, name), code);
    try { return { exitCode: 0, stdout: execFileSync("bash", ["-c", request.command], { cwd: dir, timeout: 10000, encoding: "utf8", stdio: "pipe" }), stderr: "" }; }
    catch (e) { return { exitCode: e.status, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") }; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}); });

describe("completed specifications with explicit assumption provenance", () => {
  it("accepts selected elicitation choices as conditional obligations without inventing quotations", () => {
    const st = state(), c = contract(st);
    expect(c.status).toBe("READY");
    expect(c.assumptions).toMatchObject([{ ref: "A-01", kind: "auto_assumption", origin: "elicitation-assumption" }]);
    expect(st.spec.requirements[0].src).toBe("");
    expect(c.suites).toEqual([]);
  });
  it("distinguishes original facts, derivations, answers, revisions and skipped-question choices", () => {
    const st = state();
    st.elicit.questions = [{ id: "TIME-01", text: "Latency?", recommended: "No storage" }];
    st.spec.requirements[0].rat = "[default TIME-01 — question skipped]";
    seal(st); expect(contract(st).assumptions[0].origin).toBe("skipped-question");
    st.elicit.answers = { "TIME-01": "No storage" };
    seal(st); expect(contract(st).provenance[0].kind).toBe("user_answer");
    st.spec.requirements[0].rat = "[source: assumption A-01]";
    st.elicit.assumptions[0].revised = "Copy d to q.";
    seal(st); expect(contract(st).provenance[0].kind).toBe("user_revision");
    st.spec.requirements[0].src = st._userDesc;
    seal(st); expect(contract(st).provenance[0].kind).toBe("source");
    st.spec.requirements[0].rat = "[derived from combinational adapter description]";
    seal(st); expect(contract(st).provenance[0].kind).toBe("derived");
  });
  it("allows documented defaults when elicitation is disabled", () => {
    const st = state(); st.elicit = {}; st.spec.requirements[0].rat = "[domain default] Value-preserving adapter.";
    seal(st); expect(contract(st).assumptions[0].origin).toBe("specification-default");
  });
  it.each(["deselected", "unknown-ref", "fake-quote", "unlabelled", "conflict"])("keeps %s decisions blocked", kind => {
    const st = state();
    if (kind === "deselected") st.elicit.assumptions[0].confirmed = false;
    if (kind === "unknown-ref") st.spec.requirements[0].rat = "[source: assumption A-99]";
    if (kind === "fake-quote") st.spec.requirements[0].src = st.elicit.assumptions[0].text;
    if (kind === "unlabelled") st.spec.requirements[0].rat = "";
    if (kind === "conflict") st.spec.conflicts = [{ reason: "Incompatible explicit output rules" }];
    seal(st); expect(contract(st).status).toBe("UNRESOLVED");
  });
  it("does not silently adopt legacy assumptions", () => {
    const st = state(); delete st.spec._designContract;
    expect(contract(st).status).toBe("UNRESOLVED");
  });
  it.each(["behavior", "source", "selection", "environment", "extension"])("rejects %s changes until Spec creates a new revision", async kind => {
    const st = state(), original = st.spec._designContract.hash;
    if (kind === "behavior") st.spec.requirements[0].desc = "Invert d to q.";
    if (kind === "source") st._userDesc += " Do not invert.";
    if (kind === "selection") st.elicit.assumptions[0].text = "Invert the word.";
    if (kind === "environment") st.spec.requirements[0].environment = true;
    if (kind === "extension") st.spec.requirements[0].latency = 2;
    expect(contract(st).status).toBe("UNRESOLVED");
    await expect(applySkillsToPrompt({ userMessage: "Generate RTL" }, st, "rtl_generate")).rejects.toThrow(/revision/);
    seal(st);
    expect(st.spec._designContract.revision).toBe(2);
    expect(st.spec._designContract.previousHash).toBe(original);
    expect(st.spec._designContract.hash).not.toBe(original);
  });
  it("keeps checker input independent of candidate implementation and results", () => {
    const st = state(), input = checkerDescription(st);
    st.rtl_generate.code = "SECRET_IMPLEMENTATION"; st.verify = { log: "SECRET_RESULT" };
    expect(checkerDescription(st)).toBe(input);
    expect(input).toContain("FROZEN COMPLETED SPECIFICATION");
    expect(input).toContain("auto_assumption");
    expect(input).not.toContain("SECRET");
  });
});

describe("measured repair under a frozen completed contract", () => {
  it("creates and reviews a checker without enabling standalone RTL generation", async () => {
    const st = state(); delete st.rtl_generate;
    const calls = [];
    st.architect = {};
    st._config = { provider: "openai", model: "offline-test", stageSettings: {}, standaloneFallback: false,
      _llmReplay: request => {
        const prompt = request.userMessage;
        calls.push(prompt);
        return { text: JSON.stringify(prompt.includes("Review the independent self-checking testbench")
          ? { status: "PASS", findings: [], summary: "Contract checks are independent." }
          : { code: prompt.includes("Generate one complete self-checking") ? tb : good }) };
      } };
    const out = await rtlGenerateNode(st);
    expect(out.rtl_generate._standaloneCandidate).toBeUndefined();
    expect(out.rtl_generate._standaloneCheckerCandidate.status).toBe("READY");
    expect(out.rtl_generate._standaloneCheckerCandidate.designContractHash).toBe(st.spec._designContract.hash);
    const checkerPrompts = calls.filter(p => p.includes("independent self-checking") || p.includes("Generate one complete self-checking"));
    expect(checkerPrompts).toHaveLength(2);
    expect(checkerPrompts.every(p => p.includes("FROZEN COMPLETED SPECIFICATION"))).toBe(true);
    expect(checkerPrompts.every(p => !p.includes("assign q=d"))).toBe(true);
  });
  it("accepts a real improvement and rejects regression under the same independent checks", async () => {
    const st = state(), guard = createReviewAcceptance(st, bad);
    const improved = await guard.compare(good, bad);
    expect(improved.adopted).toBe(true);
    expect(improved.baseline.pass).toBe(1);
    expect(improved.proposed.pass).toBe(2);
    expect(improved.proposed._checkerEvidenceInvalid).toBe(false);
    expect((await guard.compare(bad, good)).reason).toBe("PASSED_CHECK_REGRESSION");
    expect((await guard.compare(good + "\n// style", good)).adopted).toBe(false);
  });
  it("cannot waive explicit source examples with an assumption or generated checker", async () => {
    const st = state(); st._userDesc += "\n\nd q\n3'b110 3'b101"; seal(st);
    // Deliberately retain a checker matching the default; source replay still wins.
    st.rtl_generate._standaloneCheckerCandidate.qualification.inputHash = checkerInputHash(st, extractModuleInterface(bad, "word_unit"));
    const result = await createReviewAcceptance(st, bad).compare(good, bad);
    expect(result.proposed._sourceEvidence.status).toBe("FAIL");
    expect(result.proposed.status).toBe("FAIL");
  });
  it("rejects changed contracts and old checkers without measuring", async () => {
    const st = state(), guard = createReviewAcceptance(st, bad);
    st.spec.requirements[0].desc = "Invert d.";
    expect((await guard.compare(good, bad)).reason).toBe("CONTRACT_CHANGED");
    seal(st);
    expect((await createReviewAcceptance(st, bad).compare(good, bad)).reason).toBe("CHECKER_UNQUALIFIED");
    expect(runCli).not.toHaveBeenCalled();
  });
  it("does not treat an empty completed contract as an executable checker", async () => {
    const st = state(); delete st.rtl_generate._standaloneCheckerCandidate;
    expect((await createReviewAcceptance(st, bad).compare(good, bad)).reason).toBe("CHECKER_UNQUALIFIED");
  });
});

describe("formal scope and conditional final verdict", () => {
  function formalState() {
    const st = state(); st.rtl_generate.code = good;
    st.formal_props = { designContractHash: st.spec._designContract.hash,
      properties: [{ id: "P-WORD", req: "REQ-FUNC-001", code: "assert (q == d);" }] };
    st._services = { formalRunner: { sbyAvailable: () => true, checkFormalSyntax: async () => ({ status: "PASS" }),
      runBmc: vi.fn(async () => ({ status: "PASS", log: "bounded check", elapsedMs: 1 })) } };
    return st;
  }
  it("runs formal with recorded choices and reports the conditional scope", async () => {
    const st = formalState(), out = await formalVerifyNode(st);
    expect(st._services.formalRunner.runBmc).toHaveBeenCalled();
    expect(out.formal_verify.status).toBe("PASS");
    expect(out.formal_verify.contractAssumptions).toHaveLength(1);
    expect(out.formal_verify.proofScope).toBe("completed-specification-properties");
    expect(out.formal_verify.proven).not.toBe(true);
    expect(out.formal_verify.propertyQualification.status).toBe("NOT_AVAILABLE");
  });
  it("rejects formal properties from an earlier contract", async () => {
    const st = formalState(); st.spec.requirements[0].desc = "Invert d."; seal(st);
    const out = await formalVerifyNode(st);
    expect(out.formal_verify.status).toBe("SKIPPED");
    expect(out.formal_verify.reason).toContain("regenerate formal properties");
    expect(st._services.formalRunner.runBmc).not.toHaveBeenCalled();
  });
  it("checks an assumption-based contract with the real formal tool when available", async ctx => {
    if (!formalRunner.sbyAvailable()) { ctx.skip(); return; }
    const st = formalState(); st._services.formalRunner = formalRunner;
    st._config.formalTimeoutSec = 15;
    const out = await formalVerifyNode(st);
    expect(out.formal_verify.status).toBe("PASS");
    expect(out.formal_verify.assertionIds).toHaveLength(1);
    expect(out.formal_verify.assumptionIds).toEqual([]);
    expect(out.formal_verify.contractAssumptions).toHaveLength(1);
  });
  it("cannot assume the desired DUT output even when labelled an environment requirement", () => {
    const st = formalState(); st.spec.requirements[0].environment = true; seal(st);
    const diag = {};
    expect(buildSvaChecker({ properties: [{ id: "P", req: "REQ-FUNC-001", code: "assume (q == d);" }] }, st.spec, "word_unit", diag, { formal: true })).toBeNull();
    expect(diag.skipped[0].reason).toContain("input-only");
    expect(buildSvaChecker({ properties: [{ id: "P", req: "REQ-FUNC-001", code: "assume (d < 7);" }] }, st.spec, "word_unit", {}, { formal: true })).not.toBeNull();
  });
  it("keeps passing implementation evidence usable while reporting unconfirmed intent", async () => {
    const st = state(); st.rtl_generate.code = good;
    st.test_generate = { code: tb }; st.lint = { status: "PASS", errors: [], warnings: [] };
    st._config.maxJudgeIters = 1;
    st._config.evalCriteria = Object.fromEntries(Object.entries(defaultEvalConfig())
      .map(([id, c]) => [id, { ...c, enabled: id === "verify_pass_rate" }]));
    st.verify = mergeSourceEvidence({ status: "PASS", cli: true, total: 2, pass: 2, fail: 0,
      tests: [{ name: "word.low", st: "PASS" }, { name: "word.high", st: "PASS" }] }, contract(st), [], good);
    expect(checkerEvidenceInvalidOf(st)).toBe(false);
    const out = await judgeNode(st);
    expect(out.judge.contractVerification.status).toBe("PASS");
    expect(out.judge.overall).toBe("UNVERIFIED");
    expect(out.judge.stopReason).toBe("assumptions-unconfirmed");
    const text = verificationSummaryText({ 2: st.spec, 8: st.verify, 9: out.judge });
    expect(text).toContain("Simulation: PASS — 2/2 measured checks");
    expect(text).toContain("1 auto-selected assumption entry (unconfirmed user intent)");
    st.spec.requirements[0].desc = "Invert d."; seal(st);
    expect(checkerEvidenceInvalidOf(st)).toBe(true);
  });
});

describe("saved project contract invalidation", () => {
  it.each([MODULE_STAGE_DATA_SET, MODULE_STAGE_DATA_MERGE])("invalidates evidence and completion through %s", type => {
    const st = state(), initial = createInitialProjectState();
    initial.modules.word_unit = { ...blankModule(), completed: new Set([1,2,4,5,7,8,9,13]),
      stageData: { 1: st.elicit, 2: st.spec, 4: { code: good }, 8: { status: "PASS" },
        9: { overall: "PASS", verified: true }, 13: { status: "PASS", proven: true } } };
    const next = structuredClone(st.spec); next.requirements[0].desc = "Invert d.";
    const result = projectReducer(initial, { type, modId: "word_unit", stageId: 2, data: next }).modules.word_unit;
    expect(result.stageData[4].code).toBe(good);
    expect(result.stageData[8].status).toBe("STALE");
    expect(result.stageData[9].overall).toBe("UNVERIFIED");
    expect(result.stageData[13].proven).toBe(false);
    expect(result.completed.has(8)).toBe(false);
    expect(initial.modules.word_unit.stageData[13].proven).toBe(true);
  });
});
