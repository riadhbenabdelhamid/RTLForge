// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { describe, expect, it } from "vitest";
import { sealDesignContract, assessDesignContract } from "../src/pipeline/designContract.js";
import { inspectCitation, interfaceCitation } from "../src/pipeline/sourceAttribution.js";
import { applyCitationRepairs } from "../src/pipeline/specCitationRepair.js";
import { provenanceFields } from "../src/utils/provenancePresentation.js";
import { buildSourceContract } from "../src/pipeline/sourceContract.js";
import { promptSpecFromDescription, promptSpec } from "../src/prompts/spec.js";
import { specNode } from "../src/pipeline/nodes/spec.js";

const source = "Implement a 4-bit unsigned saturating event counter.";
function specification() {
  return { modName: "EventTally", iface: [], params: [], requirements: [{
    id: "REQ-FUNC-001", desc: "An increment at 15 leaves the count at 15.", cat: "Functionality", pri: "Must", src: "", rat: "Interpreted upper boundary",
    provenance: { kind: "interpretation", reasoning: "An unsigned four-bit count has maximum 15; saturation holds that value.",
      sources: [{ quote: "4-bit unsigned" }, { quote: "saturating event counter" }], userConfirmation: "Confirmed" },
  }] };
}
function frozen(spec = specification(), el = {}) {
  spec._designContract = sealDesignContract(source, spec, el);
  return assessDesignContract(source, spec, el);
}

describe("interpretations are conditional provenance, not invented source facts", () => {
  it("completes the actual Spec stage with an unconfirmed interpretation", async () => {
    const generated = specification();
    generated.iface = [{ name: "clk", dir: "input", width: "1", desc: "Sampling clock" },
      { name: "event_i", dir: "input", width: "1", desc: "Increment request" },
      { name: "count", dir: "output", width: "4", desc: "Unsigned event count" }];
    const out = await specNode({ _userDesc: source, _config: { specReask: false,
      _llmReplay: () => ({ text: JSON.stringify(generated) }) } });
    expect(out.spec._sourceContract.status).toBe("READY");
    expect(out.spec._designContract.issues).toEqual([]);
    expect(out.spec._designContract.entries[0].kind).toBe("interpretation");
  });
  it("accepts an inferred boundary, records exact triggers and ignores model-claimed confirmation", () => {
    const spec = specification(), c = frozen(spec);
    expect(c.issues).toEqual([]);
    expect(c.assumptions).toHaveLength(1);
    expect(c.entries[0].kind).toBe("interpretation");
    for (const passage of c.entries[0].sources) expect(source.slice(passage.start, passage.end)).toBe(passage.quote);
    expect(Object.fromEntries(provenanceFields(c.entries[0]))).toMatchObject({ Origin: "LLM interpretation", "User confirmation": "Unconfirmed" });
    expect(buildSourceContract(source, spec, "EventTally", {}).status).toBe("READY");
  });
  it.each(["missing-reason", "fabricated-trigger", "bad-offset", "pretend-quotation", "contradiction", "unknown-reference", "rejected"])("blocks %s without changing behavior", mode => {
    const spec = specification(), r = spec.requirements[0], el = {};
    if (mode === "missing-reason") r.provenance.reasoning = "";
    if (mode === "fabricated-trigger") r.provenance.sources[0].quote = "Count holds at fifteen.";
    if (mode === "bad-offset") Object.assign(r.provenance.sources[0], { start: 0, end: 3 });
    if (mode === "pretend-quotation") r.src = r.desc;
    if (mode === "contradiction") spec.conflicts = [{ reason: "Explicit count limits disagree." }];
    if (mode === "unknown-reference") r.provenance.ref = "A-15";
    if (mode === "rejected") { r.provenance.ref = "A-15"; el.assumptions = [{ id: "A-15", confirmed: false }]; }
    expect(frozen(spec, el).issues.length).toBeGreaterThan(0);
  });
  it("records open-choice alternatives and requires a revision after a choice changes", () => {
    const spec = specification(), r = spec.requirements[0];
    r.provenance = { kind: "assumption", reasoning: "Choose synchronous clearing for the open reset policy.", alternatives: ["Asynchronous clearing"] };
    r.src = ""; r.rat = "[domain default]"; r.desc = "Clear synchronously.";
    const c = frozen(spec); expect(c.assumptions[0].alternatives).toEqual(["Asynchronous clearing"]);
    r.desc = "Clear asynchronously.";
    expect(assessDesignContract(source, spec, {}).issues[0].id).toBe("CONTRACT");
    const old = spec._designContract;
    spec._designContract = sealDesignContract(source, spec, {}, old);
    expect(spec._designContract).toMatchObject({ previousHash: old.hash, revision: old.revision + 1 });
    expect(assessDesignContract(source, spec, {}).issues).toEqual([]);
  });
  it("can explicitly reclassify a paraphrase as an interpretation without editing behavior", () => {
    const spec = specification(), r = spec.requirements[0]; delete r.provenance; r.src = r.desc;
    const out = applyCitationRepairs(source, spec, [r], { citations: [{ id: r.id, requirement: r.desc, kind: "interpretation", src: "",
      sources: [{ quote: source }], reason: "Saturation of an unsigned four-bit value implies an upper limit of 15." }] });
    expect(out._citationRepair.status).toBe("REPAIRED");
    expect(out.requirements[0]).toMatchObject({ desc: r.desc, pri: r.pri, rat: r.rat, src: "", provenance: { kind: "interpretation" } });
    expect(frozen(out).assumptions[0].kind).toBe("interpretation");
  });
  it("treats defective code as an interpretation trigger but never a direct behavioral quotation", () => {
    const text = "module WordLink(input [4:0] word_i, output word_o); assign word_o=word_i; endmodule\nThis implementation is defective.";
    const spec = { modName: "WordLink", iface: [{ name: "word_o", dir: "output", width: "5" }] };
    const req = { desc: "The module shall expose word_o as an output.", src: "output word_o" };
    expect(inspectCitation(text, req, spec)).toMatchObject({ valid: true, provisional: true });
    expect(interfaceCitation("Ports:\n- output word_o", { ...req, src: "" }, spec)).toBeTruthy();
    expect(inspectCitation(text, { ...req, desc: req.desc + " Always drive zero." }, spec).valid).toBe(false);
    const behavior = { desc: "The module copies a word.", src: "assign word_o=word_i;" };
    expect(inspectCitation(text, behavior, spec).valid).toBe(false);
    expect(inspectCitation(text, { ...behavior, src: "", provenance: { kind: "interpretation", reasoning: "Retain the value-copy intent while correcting the declaration.", sources: [{ quote: behavior.src }] } }, spec).valid).toBe(true);
  });
  it("teaches both Spec entry paths the same distinction without embedding task-specific examples", () => {
    for (const p of [promptSpec({ questions: [], assumptions: [] }, [], source), promptSpecFromDescription(source)]) {
      expect(p.userMessage).toContain("provenance.reasoning");
      expect(p.userMessage).toContain("provenance.alternatives");
      expect(p.userMessage).toContain("contradictory");
    }
  });
});
