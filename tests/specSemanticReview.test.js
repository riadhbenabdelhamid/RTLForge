// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/llm/index.js", async () => ({ ...await vi.importActual("../src/llm/index.js"), callLLM: vi.fn(), callLLMJson: vi.fn() }));
import { callLLM, callLLMJson } from "../src/llm/index.js";
import { reviewSpecSemantics, semanticProposal } from "../src/pipeline/specSemanticReview.js";
import { sealDesignContract, assessDesignContract, specificationSnapshot } from "../src/pipeline/designContract.js";
import { resolveAttributionPolicy, generationBlockingIssues } from "../src/pipeline/attributionPolicy.js";
import { specNode } from "../src/pipeline/nodes/spec.js";
import { makeSpecConflict } from "../src/pipeline/specConflict.js";
import { promptSpec } from "../src/prompts/spec.js";
import { judgeNode } from "../src/pipeline/nodes/judge.js";
import { guardStageReplacement } from "../src/pipeline/stageAcceptance.js";
import { buildSourceContract, mergeSourceEvidence } from "../src/pipeline/sourceContract.js";

const Q = "Decode the three-bit selector by its unsigned binary value; table order is for display only.";
const req = (id, desc, kind = "interpretation") => ({ id, cat: "Functionality", pri: "Must", desc,
  src: kind === "source" ? Q : "", sources: [], environment: false,
  provenance: { kind, reasoning: "Interpret the displayed selector labels.", sources: kind === "source" ? [] : [{ quote: Q }] } });
function state() {
  return { _userDesc: "Implement module named AddressView with selector (3 bits), mask (8 bits), and result (1 bit).\n"
      + Q + "\nLabels shown: 110, 001, 100.\nOutput result equals the selected mask bit.",
    _config: { specSemanticReview: true, attributionPolicy: "relaxed", _executionMode: "full-auto", stageSettings: {} },
    _onLog: vi.fn(), elicit: { modName: "AddressView", questions: [], assumptions: [], answers: {} },
    spec: { modName: "AddressView", iface: [{ name: "selector", dir: "input", width: "3" },
      { name: "mask", dir: "input", width: "8" }, { name: "result", dir: "output", width: "1" }], params: [], conflicts: [],
    requirements: [req("REQ-FUNC-001", "The selector is an unsigned binary index.", "source"),
      req("REQ-FUNC-002", "Selector 110 selects mask[0], the first displayed label."),
      req("REQ-FUNC-003", "When selector is 110, result equals mask[0].", "derived")] },
    rtl_generate: { code: "module AddressView(input [2:0] selector,input [7:0] mask,output result); assign result=mask[selector]; endmodule" },
    test_generate: { code: "TESTBENCH_MUST_NOT_REACH_SPEC_REVIEW" },
    verify: { status: "PASS", cli: true, total: 7, pass: 7, fail: 0, log: "MEASUREMENTS_MUST_NOT_REACH_SPEC_REVIEW" } };
}
const quote = [{ quote: Q }];
function correction(st) {
  return { findings: [{ id: "F1", kind: "label_mapping", requirementIds: ["REQ-FUNC-002", "REQ-FUNC-003"],
    reason: "Display order was used as an address.", sources: quote,
    witness: { situation: "selector=110", required: "mask[6]", inferred: "mask[0]" } }],
  repairs: [{ id: "REQ-FUNC-002", previousDescription: st.spec.requirements[1].desc,
    description: "Selector 110 selects mask[6], regardless of the displayed label position.", dependsOn: [],
    reasoning: "Binary 110 is the unsigned integer six.", sources: quote },
  { id: "REQ-FUNC-003", previousDescription: st.spec.requirements[2].desc,
    description: "When selector is 110, result equals mask[6].", dependsOn: ["REQ-FUNC-002"],
    reasoning: "Apply the corrected selector-to-address mapping.", sources: quote }], decisions: [] };
}
const confirmation = () => ({ decision: "accept", reason: "The labelled source selects bit six and all explicit obligations remain.",
  checkedRequirementIds: ["REQ-FUNC-002", "REQ-FUNC-003"], explicitRequirementsPreserved: true, confirmedFindingIds: ["F1"] });
const findingConfirmation = proposal => ({ reason: "Checked against the original source and recorded choices.",
  checkedRequirementIds: proposal.repairs.map(r => r.id), explicitRequirementsPreserved: true,
  findings: proposal.findings.map(f => ({ id: f.id, status: "resolved", reason: "The complete proposed correction restores the stated behavior." })),
  sourceCorrections: proposal.repairs.filter(r => r.sourceCorrection).map(r => ({ id: r.id, kind: r.sourceCorrection,
    reason: "The labelled source establishes the corrected mapping or scope.", sources: r.sources })) });
const reply = data => ({ data, llms: [{ text: JSON.stringify(data), tokensIn: 10, tokensOut: 10 }] });
function seal(st) {
  st.spec._designContract = sealDesignContract(st._userDesc, st.spec, st.elicit, st.spec._designContract,
    { configuration: st._config, attributionPolicy: resolveAttributionPolicy(st._config) });
}
beforeEach(() => { callLLMJson.mockReset(); callLLM.mockReset(); });

describe("source-only semantic correction before contract freezing", () => {
  it("runs the semantic transaction inside the production Spec node before sealing", async () => {
    const st = state();
    st.spec.domain = "combinational";
    st.spec.iface[2].reset = "N/A";
    const proposed = structuredClone(st.spec);
    callLLMJson.mockResolvedValueOnce(reply(proposed))
      .mockResolvedValueOnce(reply(correction(st))).mockResolvedValueOnce(reply(confirmation()));
    const out = await specNode({ ...st, spec: null });
    expect(callLLMJson).toHaveBeenCalledTimes(3);
    expect(out.spec._semanticReview.status).toBe("REPAIRED");
    expect(out.spec._designContract.snapshot.requirements[1].desc).toContain("mask[6]");
    expect(assessDesignContract(st._userDesc, out.spec, out.elicit, st._config).issues).toEqual([]);
  });
  it("corrects label/index confusion and dependent derivations as one checked transaction", async () => {
    const st = state(), original = { spec: structuredClone(st.spec) };
    callLLMJson.mockResolvedValueOnce(reply(correction(st))).mockResolvedValueOnce(reply(confirmation()));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec._semanticReview.status).toBe("REPAIRED");
    expect(out.spec.requirements[0]).toEqual(original.spec.requirements[0]);
    expect(out.spec.requirements.slice(1).every(r => r.desc.includes("mask[6]"))).toBe(true);
    expect(out.spec.requirements.map(r => r.id)).toEqual(original.spec.requirements.map(r => r.id));
    expect(out.spec.iface).toEqual(original.spec.iface);
    expect(st.spec).toEqual(original.spec);
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    for (const [prompt, options] of callLLMJson.mock.calls) {
      expect(prompt.userMessage).toContain(st._userDesc.replaceAll("\n", "\\n"));
      expect(prompt.userMessage).not.toContain(st.rtl_generate.code);
      expect(prompt.userMessage).not.toContain(st.test_generate.code);
      expect(prompt.userMessage).not.toContain(st.verify.log);
      expect(options.parseRetries).toBe(0);
    }
  });
  it("scopes an automatic rule around an explicit override and revises its decision without claiming user authorship", async () => {
    const st = state();
    st._userDesc = "Inhibit always forces power off. Outside inhibit, increased demand turns power on and reduced demand turns it off.";
    const evidence = [{ quote: st._userDesc }];
    st.elicit.assumptions = [{ id: "A-07", text: "Increased demand always turns power on.", confirmed: true, confirmationOrigin: "automatic" }];
    st.spec.requirements = [req("REQ-FUNC-001", "Inhibit always forces power off.", "source"),
      { ...req("REQ-FUNC-002", "Increased demand always turns power on.", "assumption"),
        provenance: { kind: "assumption", ref: "A-07", reasoning: "Selected default." }, rat: "[source: assumption A-07]" }];
    st.spec.requirements[0].src = "Inhibit always forces power off.";
    const response = { findings: [{ id: "F1", kind: "default_scope", requirementIds: ["REQ-FUNC-001", "REQ-FUNC-002"],
      reason: "Unconditional demand rule overrides inhibit.", sources: evidence,
      witness: { situation: "inhibit=1 and demand rises", required: "power=0", inferred: "power=1" } }],
    repairs: [{ id: "REQ-FUNC-002", previousDescription: st.spec.requirements[1].desc,
      description: "Outside inhibit, increased demand turns power on.", dependsOn: [], reasoning: "Explicit inhibit takes precedence.", sources: evidence }],
    decisions: [{ kind: "assumption", id: "A-07", previousText: st.elicit.assumptions[0].text,
      replacementText: "Outside inhibit, increased demand turns power on.", reason: "Preserve the explicit override.", sources: evidence }] };
    callLLMJson.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply({ ...confirmation(), checkedRequirementIds: ["REQ-FUNC-002"] }));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec._semanticReview.status).toBe("REPAIRED");
    expect(out.spec.requirements[0]).toEqual(st.spec.requirements[0]);
    expect(out.elicit.assumptions[0]).toMatchObject({ confirmationOrigin: "automatic", text: st.elicit.assumptions[0].text,
      revised: response.decisions[0].replacementText });
    expect(out.elicit.assumptions[0]._semanticRevisions[0].previousText).toBe(st.elicit.assumptions[0].text);
    const prompt = promptSpec(out.elicit, [], st._userDesc);
    expect(prompt.userMessage).not.toContain('"sourceKind": "explicit_user_revision"');
    expect(prompt.userMessage).toContain("generated_assumption");
  });
  it.each(["interface", "priority", "environment", "explicit fact", "source with assumption ref", "explicit revision", "unrelated decision", "unrelated derivation", "bad source", "new id", "stale description", "user decision", "answered question"])("rejects %s changes before confirmation", kind => {
    const st = state(), response = correction(st);
    if (kind === "interface") response.iface = [];
    if (kind === "priority") response.repairs[0].pri = "May";
    if (kind === "environment") response.repairs[0].environment = true;
    if (kind === "explicit fact") { response.repairs[0].id = "REQ-FUNC-001"; response.repairs[0].previousDescription = st.spec.requirements[0].desc; }
    if (kind === "source with assumption ref") {
      st.spec.requirements[1].provenance = { kind: "source", ref: "A-01" };
      st.elicit.assumptions = [{ id: "A-01", text: "Select a displayed position", confirmed: true, confirmationOrigin: "automatic" }];
    }
    if (kind === "explicit revision") {
      st.spec.requirements[1].provenance.kind = "user_revision";
      st.spec.requirements[1].rat = "[default chosen by user]";
    }
    if (kind === "unrelated decision") {
      st.elicit.assumptions = [{ id: "A-09", text: "Retain the reset convention.", confirmed: true, confirmationOrigin: "automatic" }];
      response.decisions = [{ kind: "assumption", id: "A-09", previousText: st.elicit.assumptions[0].text,
        replacementText: "Change the reset convention.", reason: "Unrelated change", sources: quote }];
    }
    if (kind === "unrelated derivation") response.repairs[1].dependsOn = [];
    if (kind === "bad source") response.findings[0].sources = [{ quote: "Unstated convenient behavior" }];
    if (kind === "new id") response.repairs[0].id = "REQ-FUNC-999";
    if (kind === "stale description") response.repairs[0].previousDescription = "Not the current requirement";
    if (kind === "user decision") {
      st.elicit.assumptions = [{ id: "A-01", text: "Select the first displayed position.", confirmed: true, confirmationOrigin: "user" }];
      st.spec.requirements[1].provenance.ref = "A-01";
    }
    if (kind === "answered question") {
      st.elicit.questions = [{ id: "Q-01", recommended: "Select the binary index" }];
      st.elicit.answers = { "Q-01": "Use the displayed position" };
      st.spec.requirements[1].provenance.ref = "Q-01";
    }
    expect(semanticProposal(st._userDesc, st.spec, st.elicit, response).valid).toBe(false);
  });
  it("retains a source-specified custom encoding when no defect is found", async () => {
    const st = state(); st._userDesc = "Use this custom encoding: selector 110 selects mask[0]. Display order defines the wiring.";
    callLLMJson.mockResolvedValueOnce(reply({ findings: [], repairs: [], decisions: [] }));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec.requirements).toEqual(st.spec.requirements);
    expect(out.spec._semanticReview.status).toBe("REVIEWED");
    expect(callLLMJson).toHaveBeenCalledOnce();
    expect(callLLMJson.mock.calls[0][0].userMessage).toContain("Honor explicitly\nspecified custom encodings");
  });
  it("rejects a false-positive first review and retains the complete original specification", async () => {
    const st = state();
    callLLMJson.mockResolvedValueOnce(reply(correction(st))).mockResolvedValueOnce(reply({ ...confirmation(), decision: "reject", confirmedFindingIds: [] }));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec._semanticReview.status).toBe("REJECTED");
    expect(specificationSnapshot(out.spec)).toEqual(specificationSnapshot(st.spec));
  });
  it.each(["missing coverage", "unpreserved explicit requirements"])("records an unresolved conflict without accepting %s", async kind => {
    const st = state();
    const incomplete = kind === "missing coverage" ? { checkedRequirementIds: ["REQ-FUNC-002"] }
      : { explicitRequirementsPreserved: false };
    callLLMJson.mockResolvedValueOnce(reply(correction(st)))
      .mockResolvedValueOnce(reply({ ...confirmation(), ...incomplete }));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec._semanticReview.status).toBe("UNRESOLVED");
    expect(out.spec.requirements).toEqual(st.spec.requirements);
    expect(out.spec.conflicts).toHaveLength(1);
    expect(sealDesignContract(st._userDesc, out.spec, st.elicit).issues.length).toBeGreaterThan(0);
  });
  it.each([false, true])("preserves original requirements when a review call is unavailable (second=%s)", async second => {
    const st = state();
    if (second) callLLMJson.mockResolvedValueOnce(reply(correction(st)));
    callLLMJson.mockRejectedValueOnce(new Error("review unavailable"));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec._semanticReview.status).toBe("UNAVAILABLE");
    expect(specificationSnapshot(out.spec)).toEqual(specificationSnapshot(st.spec));
    expect(callLLMJson).toHaveBeenCalledTimes(second ? 2 : 1);
  });
  it("honors cancellation instead of converting it to an unavailable review", async () => {
    const st = state();
    callLLMJson.mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
    await expect(reviewSpecSemantics(st, st.spec, {})).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("frozen specification semantic revisions", () => {
  it("keeps a guarded judge reflow on the revised contract and collects fresh downstream evidence", async () => {
    const st = state(); seal(st);
    const previous = st.spec._designContract;
    st.verify._specConflict = makeSpecConflict(st, { source: "rtl_review", reason: "REQ-FUNC-002 uses the wrong selector index." });
    st._config = { ...st._config, maxJudgeIters: 2, judgeReflowMode: "strict",
      optionalStages: { formal_props: true, formal_verify: true } };
    const stages = ["spec", "architect", "rtl_generate", "formal_props", "formal_verify", "test_generate", "verify", "judge"]
      .map((key, i) => ({ key, id: i + 1, order: i * 10 }));
    const calls = [];
    st._services = { allStages: stages, invokeNode: async (key, sub) => {
      calls.push(key);
      if (key === "spec") return specNode(sub);
      expect(sub.spec._designContract.previousHash).toBe(previous.hash);
      expect(sub.verify._specConflict).toBeFalsy();
      if (key === "rtl_generate") return guardStageReplacement(key, async s => ({ rtl_generate: s.rtl_generate }))(sub);
      if (key === "verify") return { verify: mergeSourceEvidence({ status: "PASS", cli: true, total: 1, pass: 1, fail: 0,
        tests: [{ name: "Binary label mapping", st: "PASS", req: "REQ-FUNC-002" }], cov: {}, log: "Fresh measurement" },
      buildSourceContract(sub._userDesc, sub.spec, sub.elicit.modName, sub.elicit), [], sub.rtl_generate.code) };
      if (key === "formal_props") return { formal_props: { status: "SKIPPED", reason: "Unavailable in this test" } };
      if (key === "formal_verify") return { formal_verify: { status: "SKIPPED", reason: "Unavailable in this test" } };
      return {};
    } };
    callLLMJson.mockResolvedValueOnce(reply(correction(st))).mockResolvedValueOnce(reply(confirmation()));
    const out = await guardStageReplacement("judge", judgeNode)(st);
    expect(calls, out.judge.stopReason).toEqual(stages.map(s => s.key));
    expect(out.spec._designContract.previousHash).toBe(previous.hash);
    expect(out.spec.requirements[1].desc).toContain("mask[6]");
    expect(out.spec._specRevision.preservedCandidate.code).toBe(st.rtl_generate.code);
    expect(out.verify.log).toContain("Fresh measurement");
    expect(out.verify.total).toBe(1);
    expect(out.rtl_generate.code).toBe(st.rtl_generate.code);
    expect(callLLM).not.toHaveBeenCalled();
    expect(callLLMJson).toHaveBeenCalledTimes(2);
  });
  it("records a revision, preserves incumbent RTL for inspection, and invalidates prior verification", async () => {
    const st = state(); seal(st);
    const previous = st.spec._designContract;
    st.verify._specConflict = makeSpecConflict(st, { source: "rtl_review", reason: "REQ-FUNC-002 uses the wrong selector index." });
    callLLMJson.mockResolvedValueOnce(reply(correction(st))).mockResolvedValueOnce(reply(confirmation()));
    const out = await specNode(st);
    expect(out.spec._designContract.previousHash).toBe(previous.hash);
    expect(out.spec._designContract.revision).toBe(previous.revision + 1);
    expect(assessDesignContract(st._userDesc, out.spec, out.elicit, st._config).issues).toEqual([]);
    expect(out.spec._specRevision.preservedCandidate.code).toBe(st.rtl_generate.code);
    expect(out.verify).toMatchObject({ status: "UNVERIFIED", cli: false, total: 0, _specConflict: null });
    expect(out.verify._specConflictReview.decision).toBe("revise");
    expect(out.rtl_generate).toBeUndefined();
    expect(callLLMJson).toHaveBeenCalledTimes(2);
  });
  it("cannot alter a frozen spec when a correction is not confirmed", async () => {
    const st = state(); seal(st);
    st.verify._specConflict = makeSpecConflict(st, { reason: "REQ-FUNC-002 mapping conflict" });
    callLLMJson.mockResolvedValueOnce(reply(correction(st)))
      .mockResolvedValueOnce(reply({ ...confirmation(), decision: "needs_clarification" }));
    const out = await specNode(st);
    expect(out.spec._designContract).toEqual(st.spec._designContract);
    expect(specificationSnapshot(out.spec)).toEqual(specificationSnapshot(st.spec));
    expect(out.verify._specConflict.review.decision).toBe("needs_clarification");
    expect(out.rtl_generate).toBeUndefined();
  });
});

describe("source authority and individual semantic finding outcomes", () => {
  it("retains a valid finding as unresolved when its proposed edit is stale", async () => {
    const st = state(), response = correction(st);
    response.repairs[0].previousDescription = "A different version of the requirement.";
    callLLMJson.mockResolvedValueOnce(reply(response));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec.requirements).toEqual(st.spec.requirements);
    expect(out.spec._semanticReview.status).toBe("UNAVAILABLE");
    expect(out.spec._semanticReview.findingOutcomes).toEqual([
      expect.objectContaining({ id: "F1", status: "unresolved" })]);
    expect(out.spec.conflicts).toEqual([]);
    expect(callLLMJson).toHaveBeenCalledTimes(1);
  });
  it.each(["inference", "extraction"])("accepts an omitted empty dependency list on an %s root", async mode => {
    const st = state(), response = correction(st);
    delete response.repairs[0].dependsOn;
    if (mode === "extraction") {
      st.spec.requirements[1].provenance.kind = "source";
      response.repairs[0].sourceCorrection = "mapping";
    }
    callLLMJson.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply(findingConfirmation(response)));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec._semanticReview.status).toBe("REPAIRED");
    expect(out.spec.requirements[2].desc).toBe(response.repairs[1].description);
  });
  it.each(["missing dependent", "null root", "invalid root"])("rejects %s dependency data", kind => {
    const st = state(), response = correction(st);
    if (kind === "missing dependent") delete response.repairs[1].dependsOn;
    if (kind === "null root") response.repairs[0].dependsOn = null;
    if (kind === "invalid root") response.repairs[0].dependsOn = "REQ-FUNC-002";
    expect(semanticProposal(st._userDesc, st.spec, st.elicit, response).valid).toBe(false);
  });
  it.each(["derived", "source", "legacy source"])("corrects mislabeled source mappings and their %s verification dependency together", async kind => {
    const st = state();
    st.spec.requirements[1].provenance.kind = "source"; st.spec.requirements[1].src = Q;
    st.spec.requirements[2].provenance.kind = "source"; st.spec.requirements[2].src = Q;
    const response = correction(st);
    response.repairs.forEach(r => { r.sourceCorrection = "mapping"; });
    st.spec.requirements.push({ ...req("REQ-VERIF-001", "Check that selector 110 selects mask[0].", kind),
      cat: "Verification", pri: "Should" });
    if (kind === "legacy source") {
      delete st.spec.requirements[3].provenance;
      st.spec.requirements[3].src = Q;
    }
    response.findings[0].requirementIds.push("REQ-VERIF-001");
    response.repairs.push({ id: "REQ-VERIF-001", previousDescription: st.spec.requirements[3].desc,
      description: "Check that selector 110 selects mask[6].", dependsOn: ["REQ-FUNC-003"],
      reasoning: "The verification plan must follow the corrected binary mapping.", sources: quote,
      ...(kind !== "derived" ? { sourceCorrection: "mapping" } : {}) });
    callLLMJson.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply(findingConfirmation(response)));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec._semanticReview.status).toBe("REPAIRED");
    expect(out.spec.requirements.slice(1).every(r => r.desc.includes("mask[6]"))).toBe(true);
    expect(out.spec.requirements[0]).toEqual(st.spec.requirements[0]);
    expect(out.spec.requirements[3]).toMatchObject({ cat: "Verification", pri: "Should", environment: false });
    expect(out.spec.requirements[1]._revisedFrom).toMatchObject({ src: Q, provenance: { kind: "source" }, sourceCorrection: "mapping" });
    expect(out.spec.requirements[1].provenance.kind).toBe("interpretation");
    expect(sealDesignContract(st._userDesc, out.spec, out.elicit).issues).toEqual([]);
  });
  it("reviews an extraction-only spec and restores a component rule's source scope", async () => {
    const st = state();
    st._userDesc = "Inside FilterUnit, result equals gate. OuterUnit inverts FilterUnit's result.";
    st.spec.requirements = [{ ...req("REQ-FUNC-001", "OuterUnit result equals gate.", "source"),
      src: "Inside FilterUnit, result equals gate." }];
    const response = { findings: [{ id: "S1", kind: "source_scope", requirementIds: ["REQ-FUNC-001"],
      reason: "The component's rule was assigned to its parent.", sources: [{ quote: st._userDesc }],
      witness: { situation: "gate=1", required: "FilterUnit=1, OuterUnit=0", inferred: "OuterUnit=1" } }],
    repairs: [{ id: "REQ-FUNC-001", previousDescription: st.spec.requirements[0].desc,
      description: "Inside FilterUnit, result equals gate.", sourceCorrection: "scope", dependsOn: [],
      reasoning: "Keep the quoted rule in its explicitly named component.", sources: [{ quote: st._userDesc }] }], decisions: [] };
    callLLMJson.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply(findingConfirmation(response)));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec._semanticReview.status).toBe("REPAIRED");
    expect(out.spec.requirements[0].desc).toBe("Inside FilterUnit, result equals gate.");
    expect(st._userDesc).toBe("Inside FilterUnit, result equals gate. OuterUnit inverts FilterUnit's result.");
    expect(callLLMJson).toHaveBeenCalledTimes(2);
  });
  it.each(["literal source", "second user decision", "cyclic dependencies", "detached verification"])("rejects %s edits at the deterministic boundary", kind => {
    const st = state(), response = correction(st);
    if (kind === "literal source") {
      st.spec.requirements[1].desc = Q;
      response.repairs[0].previousDescription = Q;
    }
    if (kind === "second user decision") {
      st.elicit.assumptions = [{ id: "A-01", confirmed: true, confirmationOrigin: "automatic" },
        { id: "A-02", confirmed: true, confirmationOrigin: "user" }];
      st.spec.requirements[1].rat = "[source: assumption A-01], [source: assumption A-02]";
    }
    if (kind === "cyclic dependencies") response.repairs[0].dependsOn = ["REQ-FUNC-003"];
    if (kind === "detached verification") st.spec.requirements[1].cat = "Verification";
    expect(semanticProposal(st._userDesc, st.spec, st.elicit, response).valid).toBe(false);
  });
  it.each(["import flag", "imported contract"])("never rewrites an imported specification (%s)", async kind => {
    const st = state();
    if (kind === "import flag") st._specImport = { text: "user specification" };
    else st.spec._designContract = { imported: true };
    const out = await reviewSpecSemantics(st, st.spec, {}, { force: true });
    expect(out.spec).toBe(st.spec);
    expect(callLLMJson).not.toHaveBeenCalled();
  });
  it.each(["missing source check", "invented source check"])("retains original extraction with %s", async kind => {
    const st = state(); st.spec.requirements[1].provenance.kind = "source";
    const response = correction(st); response.repairs[0].sourceCorrection = "mapping";
    const check = findingConfirmation(response);
    if (kind === "missing source check") check.sourceCorrections = [];
    else check.sourceCorrections[0].sources = [{ quote: "A convenient statement that was never supplied." }];
    callLLMJson.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply(check));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec.requirements).toEqual(st.spec.requirements);
    expect(out.spec._semanticReview.status).not.toBe("REPAIRED");
  });
  function mixed(st) {
    const response = correction(st);
    response.findings.push({ id: "F2", kind: "contradiction", requirementIds: ["REQ-FUNC-001"],
      reason: "Alleged conflict with an unselected encoding.", sources: quote,
      witness: { situation: "Use an alternative encoding", required: "Unknown", inferred: "Binary addressing" } });
    const check = findingConfirmation(response);
    check.findings[1] = { id: "F2", status: "rejected", reason: "An unselected alternative does not override the source." };
    return { response, check };
  }
  it("adopts a complete correction while rejecting a separate false diagnosis", async () => {
    const st = state(), { response, check } = mixed(st);
    callLLMJson.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply(check));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec._semanticReview.status).toBe("REPAIRED");
    expect(out.spec._semanticReview.findingOutcomes.map(f => [f.id, f.status])).toEqual([["F1", "resolved"], ["F2", "rejected"]]);
    expect(out.spec.conflicts).toEqual([]);
    expect(out.spec.requirements[1].desc).toContain("mask[6]");
  });
  it("clarifies a selected timing assumption without reopening an unselected operating mode", async () => {
    const st = state();
    st._userDesc = "On rising clock edges, accept transfers and discard invalid packets without a completion pulse.";
    const evidence = [{ quote: st._userDesc }];
    st.elicit.questions = [{ id: "TIME-04", question: "What is the transfer cadence?",
      recommended: "Accept one transfer every three rising edges." }];
    st.spec.requirements = [{ ...req("REQ-TIME-001", "Accept one transfer every three rising edges.", "assumption"),
      cat: "Timing", provenance: { kind: "assumption", ref: "TIME-04", reasoning: "Selected skipped-question default." } },
    { ...req("REQ-FUNC-001", "Discard invalid packets without a completion pulse.", "source"), src: st._userDesc }];
    const response = { findings: [{ id: "T1", kind: "attribution", requirementIds: ["REQ-TIME-001"],
      reason: "Identify the selected cadence as a provisional timing convention.", sources: evidence,
      witness: { situation: "Transfer cadence", required: "Rising edges; exact cadence unspecified",
        inferred: "Recorded default selects one transfer every three rising edges" } },
    { id: "T2", kind: "contradiction", requirementIds: ["REQ-FUNC-001"], sources: evidence,
      reason: "Alleged conflict with a completion pulse for every packet.",
      witness: { situation: "Invalid packet", required: "Discard without completion", inferred: "Discard without completion" } }],
    repairs: [{ id: "REQ-TIME-001", previousDescription: st.spec.requirements[0].desc,
      description: "Under the selected provisional timing convention, accept one transfer every three rising edges.",
      dependsOn: [], reasoning: "Preserve the skipped-question default and disclose its automatic origin.", sources: evidence }], decisions: [] };
    const check = findingConfirmation(response);
    check.findings[1] = { id: "T2", status: "rejected", reason: "The discard behavior directly matches the source." };
    callLLMJson.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply(check));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec._semanticReview.status).toBe("REPAIRED");
    expect(out.spec._semanticReview.findingOutcomes.map(f => f.status)).toEqual(["resolved", "rejected"]);
    expect(out.elicit).toEqual(st.elicit);
    expect(out.spec.requirements[1]).toEqual(st.spec.requirements[1]);
    expect(out.spec.requirements[0].provenance.ref).toBe("TIME-04");
    expect(out.spec.conflicts).toEqual([]);
  });
  it("preserves the atomic candidate when a genuine source conflict remains unresolved", async () => {
    const st = state(), { response, check } = mixed(st);
    check.findings[1].status = "unresolved";
    callLLMJson.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply(check));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec._semanticReview.status).toBe("UNRESOLVED");
    expect(out.spec.requirements).toEqual(st.spec.requirements);
    expect(out.spec._semanticReview.findingOutcomes.every(f => f.status === "unresolved")).toBe(true);
  });
  it.each(["strict", "relaxed"])("keeps unresolved attribution separate from a checked behavioral repair under %s policy", async policy => {
    const st = state(), { response, check } = mixed(st);
    st._config.attributionPolicy = policy;
    st.spec.requirements[0].src = "This alleged quotation was never supplied.";
    response.findings[1].kind = "attribution";
    check.findings[1] = { id: "F2", status: "unresolved", reason: "The original attribution remains unqualified." };
    callLLMJson.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply(check));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec._semanticReview.status).toBe("REPAIRED");
    expect(out.spec._semanticReview.findingOutcomes.map(f => f.status)).toEqual(["resolved", "unresolved"]);
    expect(out.spec.requirements[0]).toEqual(st.spec.requirements[0]);
    expect(out.spec.conflicts).toEqual([]);
    const contract = sealDesignContract(st._userDesc, out.spec, out.elicit, null,
      { configuration: st._config, attributionPolicy: resolveAttributionPolicy(st._config) });
    expect(contract.issues).toContainEqual(expect.objectContaining({ id: "REQ-FUNC-001", code: "CITATION_UNRESOLVED" }));
    expect(generationBlockingIssues(contract).length > 0).toBe(policy === "strict");
  });
  it("cannot apply an edit supported only by a rejected finding", async () => {
    const st = state(), { response, check } = mixed(st);
    response.findings[0].requirementIds = ["REQ-FUNC-002"];
    response.findings[1].requirementIds = ["REQ-FUNC-003"];
    callLLMJson.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply(check));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec.requirements).toEqual(st.spec.requirements);
    expect(out.spec._semanticReview.findingOutcomes[1].status).toBe("rejected");
  });
  it.each(["missing", "duplicate", "unknown", "invalid status"])("retains the spec for a %s finding outcome", async kind => {
    const st = state(), { response, check } = mixed(st);
    if (kind === "missing") check.findings.pop();
    if (kind === "duplicate") check.findings[1].id = "F1";
    if (kind === "unknown") check.findings[1].id = "F99";
    if (kind === "invalid status") check.findings[1].status = "approved";
    callLLMJson.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply(check));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec._semanticReview.status).toBe("UNAVAILABLE");
    expect(specificationSnapshot(out.spec)).toEqual(specificationSnapshot(st.spec));
    expect(out.spec._semanticReview.findingOutcomes.map(f => [f.id, f.status]))
      .toEqual([["F1", "unresolved"], ["F2", "unresolved"]]);
    expect(out.spec.conflicts).toEqual([]);
  });
  it("does not manufacture a contradiction from an ambiguous legacy mixed response", async () => {
    const st = state(), { response } = mixed(st);
    callLLMJson.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply({ ...confirmation(),
      reason: "One finding is supported and corrected; the other is rejected." }));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec._semanticReview.status).toBe("UNAVAILABLE");
    expect(out.spec.conflicts).toEqual([]);
    expect(out.spec.requirements).toEqual(st.spec.requirements);
  });
  it("keeps an attribution-only concern separate from a blocking behavioral conflict", async () => {
    const st = state(), response = correction(st);
    response.findings[0].kind = "attribution";
    response.findings[0].reason = "Clarify that the selected timing convention is an assumption.";
    response.repairs = [];
    const check = findingConfirmation(response); check.findings[0].status = "unresolved";
    callLLMJson.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply(check));
    const out = await reviewSpecSemantics(st, st.spec, {});
    expect(out.spec.conflicts).toEqual([]);
    expect(out.spec.requirements).toEqual(st.spec.requirements);
    expect(out.spec._semanticReview.findingOutcomes[0].status).toBe("unresolved");
  });
});
