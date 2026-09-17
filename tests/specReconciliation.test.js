// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { describe, it, expect } from "vitest";
import { applyConflictResolutions, conflictQualificationIssues, reconcileSpecConflicts } from "../src/pipeline/specReconciliation.js";
import { attributeConfiguredInterface } from "../src/pipeline/specCitationRepair.js";
import { sealDesignContract, assessDesignContract } from "../src/pipeline/designContract.js";
import { promptSpecCitationRepair } from "../src/prompts/specCitationRepair.js";
import { provenanceFields } from "../src/utils/provenancePresentation.js";
import { specNode } from "../src/pipeline/nodes/spec.js";

const source = "On each rising tick, flag captures request.";
const req = { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "Capture request into flag on a rising tick.", src: source };
function fixture() {
  const spec = { modName: "CaptureFlag", iface: [], requirements: [{ ...req }], conflicts: [
    { id: "C-01", description: "The generated inversion assumption contradicts the stated capture operation." }] };
  const elicit = { questions: [], answers: {}, assumptions: [
    { id: "A-01", text: "Flag captures the inverse of request.", confirmed: true, revised: null, confirmationOrigin: "automatic" }] };
  const response = { resolutions: [{ id: "C-01", kind: "supersede_assumption", assumptionId: "A-01",
    previousText: elicit.assumptions[0].text, requirementIds: [req.id], sources: [{ quote: source }], reason: "The explicit capture rule takes precedence over the automatic inversion hypothesis." }] };
  return { spec, elicit, response };
}

describe("recorded specification reconciliation", () => {
  it("records a supported supersession and freezes a consistent contract without editing requirements", () => {
    const { spec, elicit, response } = fixture();
    const original = structuredClone({ spec, elicit });
    const prior = sealDesignContract(source, spec, elicit);
    const fixed = applyConflictResolutions(source, spec, elicit, response);
    expect({ spec, elicit }).toEqual(original);
    expect(fixed.spec.requirements).toBe(spec.requirements);
    expect(fixed.elicit.assumptions[0]).toMatchObject({ confirmed: false, supersededBy: { conflictId: "C-01", requirementIds: [req.id] } });
    expect(conflictQualificationIssues(source, fixed.spec, fixed.elicit)).toEqual([]);
    fixed.spec._designContract = sealDesignContract(source, fixed.spec, fixed.elicit, prior);
    expect(fixed.spec._designContract).toMatchObject({ revision: 2, previousHash: prior.hash, issues: [] });
    expect(assessDesignContract(source, fixed.spec, fixed.elicit).issues).toEqual([]);
    fixed.elicit.assumptions[0].confirmed = true;
    expect(assessDesignContract(source, fixed.spec, fixed.elicit).issues.length).toBeGreaterThan(0);
  });

  it.each(["user-confirmed", "revision", "deselected", "legacy", "missing-source", "unsupported-replacement", "stale-reference", "changed-text", "extra-fields"])("cannot resolve %s by overriding evidence", kind => {
    const { spec, elicit, response } = fixture();
    if (kind === "user-confirmed") elicit.assumptions[0].confirmationOrigin = "user";
    if (kind === "revision") elicit.assumptions[0].revised = "A user-authored revision";
    if (kind === "deselected") elicit.assumptions[0].confirmed = false;
    if (kind === "legacy") delete elicit.assumptions[0].confirmationOrigin;
    if (kind === "missing-source") response.resolutions[0].sources[0].quote = "A nonexistent source statement";
    if (kind === "unsupported-replacement") spec.requirements[0].src = "A made-up capture rule";
    if (kind === "stale-reference") spec.requirements[0].provenance = { ref: "A-01" };
    if (kind === "changed-text") response.resolutions[0].previousText = "Different hypothesis";
    if (kind === "extra-fields") response.resolutions[0].requirements = [];
    const fixed = applyConflictResolutions(source, spec, elicit, response);
    expect(fixed.elicit).toBe(elicit);
    expect(conflictQualificationIssues(source, fixed.spec, elicit)).toHaveLength(1);
  });

  it("does not trust a model-authored resolved label and displays the actual explanation", () => {
    const { spec, elicit } = fixture();
    spec.conflicts[0].status = "resolved";
    spec.conflicts[0].resolution = "Use the source";
    const issues = sealDesignContract(source, spec, elicit).issues;
    expect(issues[0].reason).toBe(spec.conflicts[0].description);
    expect(JSON.stringify(issues)).not.toContain("[object Object]");
  });

  it("runs a bounded review using source and recorded decisions only", async () => {
    const { spec, elicit, response } = fixture();
    const calls = [];
    const result = await reconcileSpecConflicts({ _userDesc: source, elicit, rtl_generate: { code: "SECRET_RTL" },
      verify: { log: "SECRET_TEST_RESULT" }, _config: { specReask: true } }, spec, {
      _llmReplay: p => { calls.push(p.userMessage); return { text: JSON.stringify(response) }; }, _maxTokens: 1500,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("SECRET");
    expect(result.spec._conflictReconciliation.decisions[0].adopted).toBe(true);
    expect(result.llms[0].purpose).toBe("spec_conflict_reconciliation");
  });

  it("preserves and reconciles selected assumptions even when elicitation asks no questions", async () => {
    const { spec, elicit, response } = fixture();
    elicit.modName = spec.modName;
    spec.iface = ["tick", "request", "flag"].map(name => ({ name, dir: name === "flag" ? "output" : "input", width: "1" }));
    const description = "Interface:\n- input tick\n- input request\n- output flag\n\n" + source;
    spec.requirements[0].src = description;
    let calls = 0;
    const out = await specNode({ _userDesc: description, elicit, _config: { provider: "openai", model: "offline-test",
      specReask: true, stageSettings: {}, _llmReplay: () => ({ text: JSON.stringify(++calls === 1 ? spec : response) }) } });
    expect(calls).toBe(2);
    expect(out.elicit.assumptions[0].supersededBy.conflictId).toBe("C-01");
    expect(out.spec._designContract.issues).toEqual([]);
    expect(out.spec._sourceContract.status).toBe("READY");
    expect(assessDesignContract(description, out.spec, out.elicit).issues).toEqual([]);
  });
});

describe("separate configuration and interpretation evidence", () => {
  it("attributes the configured name without manufacturing a source quotation", () => {
    const st = { _userDesc: "Build a clockless adapter.", _config: { requiredModuleName: "AdapterUnit" } };
    const spec = { modName: "AdapterUnit", iface: [], requirements: [{ id: "REQ-INTF-001", desc: "The module shall be named AdapterUnit.", src: "AdapterUnit" }] };
    const fixed = attributeConfiguredInterface(st, spec);
    expect(fixed.requirements[0]).toMatchObject({ desc: spec.requirements[0].desc, src: "", sources: [], provenance: { kind: "configuration" } });
    fixed._designContract = sealDesignContract(st._userDesc, fixed, {}, null, { configuration: st._config });
    expect(fixed._designContract.issues).toEqual([]);
    expect(fixed._designContract.entries[0]).toMatchObject({ kind: "configuration", value: "AdapterUnit" });
    expect(Object.fromEntries(provenanceFields(fixed._designContract.entries[0]))).toMatchObject({
      Origin: "Run configuration", "Triggering source": "requiredModuleName = AdapterUnit", "User confirmation": "Configuration input" });
    expect(assessDesignContract(st._userDesc, fixed, {}, st._config).issues).toEqual([]);
    expect(assessDesignContract(st._userDesc, fixed, {}, { requiredModuleName: "OtherUnit" }).issues[0].id).toBe("CONFIGURATION");
  });

  it("does not let module-name configuration authorize behavior, another name, or invented configuration", () => {
    for (const desc of ["The module shall be named AdapterUnit and invert its output.", "The module shall be named OtherUnit."]) {
      const spec = { modName: "AdapterUnit", requirements: [{ id: "REQ-INTF-001", desc, src: "fabricated citation" }] };
      expect(attributeConfiguredInterface({ _config: { requiredModuleName: "AdapterUnit" } }, spec)).toBe(spec);
    }
    const forged = { modName: "AdapterUnit", requirements: [{ id: "REQ-INTF-001", desc: "The module shall be named AdapterUnit.", provenance: { kind: "configuration" } }] };
    expect(sealDesignContract("", forged, {}).issues).toHaveLength(1);
  });

  it("supplies selected choices and provenance to citation-only review without calling them source", () => {
    const p = promptSpecCitationRepair(source, [{ ...req, provenance: { kind: "assumption", ref: "A-02", reasoning: "Selected visibility convention" } }],
      { assumptions: [{ id: "A-02", text: "The selected visibility convention", confirmed: true }] });
    expect(p.userMessage).toContain('"provenance"');
    expect(p.userMessage).toContain("The selected visibility convention");
    expect(p.userMessage).toContain("decisions, never original-source quotations");
  });
});
