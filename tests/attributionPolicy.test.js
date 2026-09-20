// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { describe, it, expect, vi } from "vitest";
import { resolveAttributionPolicy, generationBlockingIssues } from "../src/pipeline/attributionPolicy.js";
import { sealDesignContract, assessDesignContract, specQualificationError } from "../src/pipeline/designContract.js";
import { normalizeCitationPassages } from "../src/pipeline/specCitationRepair.js";
import { applySkillsToPrompt } from "../src/pipeline/applySkillsToPrompt.js";
import { buildSourceContract, mergeSourceEvidence } from "../src/pipeline/sourceContract.js";
import { formalVerifyNode } from "../src/pipeline/nodes/formal_verify.js";
import { judgeNode } from "../src/pipeline/nodes/judge.js";
import { createReviewAcceptance } from "../src/pipeline/reviewAcceptance.js";
import { guardStageReplacement } from "../src/pipeline/stageAcceptance.js";
import { runStages } from "../src/pipeline/runStages.js";
import { runStage } from "../src/projectState/runStage.js";
import { blankModule } from "../src/projectState/moduleRegistry.js";
import { defaultEvalConfig } from "../src/eval/criteria.js";
import { verificationSummaryText } from "../src/utils/verificationPresentation.js";
import { loadConfig } from "../src/term/config.js";

const source = "Implement module named WordPath.\nInterface:\n- input word_i (5 bits)\n- output word_o (5 bits)\nword_o equals word_i.\nThere is no clocked storage.";
const rtl = "module WordPath(input [4:0] word_i, output [4:0] word_o); assign word_o=word_i; endmodule";
function state(policy = "relaxed", mode = "full-auto") {
  const st = { _userDesc: source, _config: { attributionPolicy: policy, _executionMode: mode },
    elicit: { assumptions: [], questions: [], answers: {} },
    spec: { modName: "WordPath", iface: [{ name: "word_i", dir: "input", width: "5" },
      { name: "word_o", dir: "output", width: "5" }], params: [],
      requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "Copy word_i to word_o.",
        src: "The output copies the input without delay.", rat: "Derived from the word-copy request." }] },
    rtl_generate: { code: rtl } };
  freeze(st); return st;
}
function freeze(st) {
  st.spec._designContract = sealDesignContract(st._userDesc, st.spec, st.elicit, st.spec._designContract,
    { configuration: st._config, attributionPolicy: resolveAttributionPolicy(st._config) });
  st.spec._sourceContract = buildSourceContract(st._userDesc, st.spec, st.spec.modName, st.elicit);
}

describe("mode-aware attribution without bypassing verification", () => {
  it.each([
    ["auto", "full-auto", "relaxed"], ["auto", "semi-auto", "strict"],
    ["strict", "full-auto", "strict"], ["relaxed", "semi-auto", "relaxed"],
  ])("resolves %s in %s to %s", (requested, mode, effective) => {
    expect(resolveAttributionPolicy({ attributionPolicy: requested }, mode)).toMatchObject({ requested, effective, executionMode: mode });
  });
  it("defaults unknown execution context conservatively and rejects invalid configuration", () => {
    expect(resolveAttributionPolicy().effective).toBe("strict");
    expect(loadConfig({ skipFiles: true }).attributionPolicy).toBe("auto");
    expect(() => loadConfig({ skipFiles: true, flags: { attributionPolicy: "relxaed" } })).toThrow(/attributionPolicy/);
  });
  it("continues provisional generation but keeps rejected quotations unresolved and visible", async () => {
    const st = state();
    const contract = assessDesignContract(source, st.spec, st.elicit, st._config);
    expect(contract.issues).toMatchObject([{ code: "CITATION_UNRESOLVED" }]);
    expect(generationBlockingIssues(contract)).toEqual([]);
    expect(specQualificationError(st.spec)).toBeNull();
    expect(st.spec._sourceContract.status).toBe("UNRESOLVED");
    const p = await applySkillsToPrompt({ userMessage: "Generate RTL." }, st, "rtl_generate");
    expect(p.userMessage).toContain("PROVISIONAL GENERATION ONLY");
    const entry = contract.entries[0];
    expect(entry).toMatchObject({ kind: "unresolved", sources: [], userConfirmed: false,
      rejectedAttribution: { src: st.spec.requirements[0].src } });
    const text = verificationSummaryText({ 2: st.spec, 9: { overall: "UNVERIFIED" } });
    expect(text).toContain("Origin: Unresolved model attribution");
    expect(text).toContain("User confirmation: Unconfirmed");
    expect(text).toContain("Attribution policy: relaxed → relaxed (full-auto)");
  });
  it("pauses strict generation for the same attribution gap", async () => {
    const st = state("strict");
    expect(specQualificationError(st.spec)?.code).toBe("SPEC_ATTRIBUTION_UNRESOLVED");
    await expect(applySkillsToPrompt({ userMessage: "Generate RTL." }, st, "rtl_generate")).rejects.toThrow(/requires revision/);
  });
  it("lets both executors distinguish strict blocks from provisional completion", async () => {
    for (const mode of ["semi-auto", "full-auto"]) {
      const st = state("auto", mode);
      const pipeline = { hasNode: () => true, invokeNode: vi.fn(async (key, s) => {
        if (key === "spec") return { ...s, spec: st.spec };
        await applySkillsToPrompt({ userMessage: "Architect." }, s, key);
        return { ...s, architect: { strategy: "Direct connection" } };
      }) };
      const linear = runStages(pipeline, ["spec", "architect"], { ...st, spec: null });
      if (mode === "full-auto") await expect(linear).resolves.toHaveProperty("architect");
      else await expect(linear).rejects.toMatchObject({ code: "SPEC_ATTRIBUTION_UNRESOLVED" });
      const events = [];
      const project = await runStage({ stageId: 2, stageKey: "spec", targetModId: "unit",
        reducerState: { modules: { unit: blankModule() } }, uiState: { mode, config: { attributionPolicy: "auto" } },
        services: { allStages: [], pipeline: { invokeNode: async (_, s) => {
          expect(s._config._executionMode).toBe(mode);
          return { ...s, spec: st.spec };
        } } }, dispatch: a => events.push(a) });
      expect(project.ok).toBe(mode === "full-auto");
      expect(events.some(a => a.type === "MODULE_STAGE_COMPLETE")).toBe(mode === "full-auto");
    }
  });
  it("requires strict confirmation of open choices, retaining valid interpretations", () => {
    const st = state("strict");
    const req = st.spec.requirements[0];
    req.src = ""; req.provenance = { kind: "assumption", ref: "A-01", reasoning: "Select direct connection.", alternatives: ["Invert the word"] };
    st.elicit.assumptions = [{ id: "A-01", text: req.desc, confirmed: true, confirmationOrigin: "automatic" }];
    freeze(st);
    expect(specQualificationError(st.spec)?.message).toContain("requires user confirmation");
    st.elicit.assumptions[0].confirmationOrigin = "user";
    freeze(st); expect(specQualificationError(st.spec)).toBeNull();
    st.elicit.assumptions = [];
    req.provenance = { kind: "interpretation", reasoning: "Equality means the whole declared word is copied.", sources: [{ quote: "word_o equals word_i." }] };
    freeze(st); expect(specQualificationError(st.spec)).toBeNull();
  });
  it.each(["contradiction", "rejected", "legacy rejected", "unknown", "interface", "duplicate"])("still blocks %s in relaxed mode", kind => {
    const st = state(), req = st.spec.requirements[0];
    if (kind === "contradiction") st.spec.conflicts = [{ description: "Two explicit output requirements contradict each other." }];
    if (kind === "rejected") {
      req.provenance = { ref: "A-01" }; st.elicit.assumptions = [{ id: "A-01", text: req.desc, confirmed: false }];
    }
    if (kind === "legacy rejected") {
      req.rat = "[source: assumption A-01]"; st.elicit.assumptions = [{ id: "A-01", text: req.desc, confirmed: false }];
    }
    if (kind === "unknown") req.provenance = { ref: "A-99" };
    if (kind === "interface") { req.src = ""; req.desc = "The module shall expose word_o as an input with width 5."; }
    if (kind === "duplicate") st.spec.requirements.push({ ...req });
    freeze(st); expect(specQualificationError(st.spec)).not.toBeNull();
  });
  it("requires a revision for policy or behavior changes and cannot bypass integrity errors", async () => {
    const st = state(), previousHash = st.spec._designContract.hash;
    st._config.attributionPolicy = "strict";
    await expect(applySkillsToPrompt({ userMessage: "Generate." }, st, "rtl_generate")).rejects.toThrow(/policy changed/);
    freeze(st); expect(st.spec._designContract.previousHash).toBe(previousHash);
    st._config.attributionPolicy = "relaxed"; freeze(st);
    st.spec.requirements[0].desc = "Invert the word.";
    await expect(applySkillsToPrompt({ userMessage: "Generate." }, st, "rtl_generate")).rejects.toThrow(/changed after contract freeze/);
  });
  it("preserves legacy contracts rather than silently granting relaxed admission", () => {
    const st = state();
    st.spec._designContract = sealDesignContract(source, st.spec, st.elicit);
    expect(st.spec._designContract.version).toBe("completed-spec-v3");
    expect(assessDesignContract(source, st.spec, st.elicit).issues).toEqual(st.spec._designContract.issues);
    expect(specQualificationError(st.spec)).not.toBeNull();
  });
  it("rejects tampering with the frozen effective policy", async () => {
    const st = state("strict");
    st.spec._designContract.attributionPolicy.effective = "relaxed";
    st._config.attributionPolicy = "relaxed";
    await expect(applySkillsToPrompt({ userMessage: "Generate." }, st, "rtl_generate")).rejects.toThrow(/changed after contract freeze/);
  });
  it.each(["strict", "relaxed"])("permits conditional formal checking of qualified interpretations under %s", async policy => {
    const st = state(policy);
    st.elicit.modName = "WordPath";
    st.spec.requirements[0].src = "";
    st.spec.requirements[0].provenance = { kind: "interpretation", reasoning: "Equality preserves the entire declared word.",
      sources: [{ quote: "word_o equals word_i." }] };
    freeze(st);
    const bmc = vi.fn(async () => ({ status: "PASS", log: "bounded check", elapsedMs: 1 }));
    st._config.formalProve = false;
    st._services = { formalRunner: { sbyAvailable: () => true,
      checkFormalSyntax: async () => ({ status: "PASS" }), runBmc: bmc } };
    st.formal_props = { designContractHash: st.spec._designContract.hash,
      properties: [{ id: "P-COPY", req: "REQ-FUNC-001", code: "assert (word_o == word_i);" }] };
    const out = await formalVerifyNode(st);
    expect(bmc).toHaveBeenCalledOnce();
    expect(out.formal_verify.status).toBe("PASS");
    expect(out.formal_verify.contractAssumptions).toHaveLength(1);
    expect(out.formal_verify.proofScope).toBe("completed-specification-properties");
    expect(out.rtl_generate?.code || st.rtl_generate.code).toBe(rtl);
  });
  it("keeps formal and Judge honest and preserves the RTL when attribution is unresolved", async () => {
    const st = state(), bmc = vi.fn();
    st.formal_props = { designContractHash: st.spec._designContract.hash,
      properties: [{ id: "P-COPY", req: "REQ-FUNC-001", code: "assert (word_o == word_i);" }] };
    st._services = { formalRunner: { sbyAvailable: () => true, runBmc: bmc } };
    const formal = await formalVerifyNode(st);
    expect(formal.formal_verify.status).toBe("SKIPPED"); expect(bmc).not.toHaveBeenCalled();
    expect(formal.rtl_generate).toBeUndefined();
    st.verify = mergeSourceEvidence({ status: "PASS", cli: true, total: 1, pass: 1, fail: 0,
      tests: [{ name: "copy", st: "PASS" }] }, st.spec._sourceContract, [], rtl);
    st._config.maxJudgeIters = 1;
    st._config.evalCriteria = Object.fromEntries(Object.entries(defaultEvalConfig()).map(([id,c]) => [id, { ...c, enabled: id === "verify_pass_rate" }]));
    const out = await judgeNode(st);
    expect(out.judge.overall).toBe("UNVERIFIED");
    expect(out.judge.unverifiedReason).toMatch(/source contract/);
    expect(out.rtl_generate?.code || st.rtl_generate.code).toBe(rtl);
    expect(st.verify.pass).toBe(1);
    const text = verificationSummaryText({ 2: st.spec, 8: st.verify, 9: out.judge });
    expect(text).toContain("Simulation: PASS — 1/1 measured checks");
    expect(text).toContain("Verification incomplete");
  });
  it("does not grant unmeasured repairs authority from relaxed admission", async () => {
    const st = state();
    const proposal = rtl.replace("=word_i", "=~word_i");
    expect((await createReviewAcceptance(st, rtl).compare(proposal, rtl)).adopted).toBe(false);
    const out = await guardStageReplacement("rtl_review", async () => ({ rtl_generate: { code: proposal } }))(st);
    expect(out.rtl_generate.code).toBe(rtl);
  });
});

describe("deterministic citation normalization", () => {
  it("repairs stitched legacy citations only when every separate passage is valid", () => {
    const st = state("strict"), req = st.spec.requirements[0];
    req.src = "word_o equals word_i. There is no clocked storage.";
    req.sources = [{ quote: "word_o equals word_i." }, { quote: "There is no clocked storage." }];
    const result = normalizeCitationPassages(source, st.spec);
    expect(result.requirements[0].src).toBe(req.sources[0].quote);
    expect(result.requirements[0].desc).toBe(req.desc);
    expect(result._citationNormalization[0].originalSrc).toBe(req.src);
    expect(result.requirements[0].sources.every(s => source.slice(s.start, s.end) === s.quote)).toBe(true);
    req.sources[1].quote = "The output is inverted.";
    expect(normalizeCitationPassages(source, st.spec)).toBe(st.spec);
  });
});
