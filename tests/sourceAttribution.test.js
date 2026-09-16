// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/llm/index.js", () => ({ callLLMJson: vi.fn(), addRetryHint: s => s }));
import { callLLMJson } from "../src/llm/index.js";
import { inspectCitation, interfaceCitation } from "../src/pipeline/sourceAttribution.js";
import { invalidSpecCitations, applyCitationRepairs, repairSpecCitations } from "../src/pipeline/specCitationRepair.js";
import { assessDesignContract, sealDesignContract } from "../src/pipeline/designContract.js";
import { uncitedRequirements, uncoveredDescription } from "../src/pipeline/specTraceability.js";
import { specNode } from "../src/pipeline/nodes/spec.js";
import { runStage } from "../src/projectState/runStage.js";
import { runStages } from "../src/pipeline/runStages.js";
import { blankModule } from "../src/projectState/moduleRegistry.js";
import { promptSpecCitationRepair } from "../src/prompts/specCitationRepair.js";

const reply = data => ({ data, llms: [{ text: JSON.stringify(data), tokensIn: 7, tokensOut: 9 }] });
const req = (desc, src, extra = {}) => ({ id: "REQ-FUNC-017", cat: "Functionality", pri: "Must", desc, src, rat: "[derived from description]", ...extra });
const specFor = requirement => ({ modName: "WordPath", iface: [{ name: "word_i", dir: "input", width: "5" },
  { name: "word_o", dir: "output", width: "5" }], params: [], requirements: [requirement] });
const stFor = source => ({ _userDesc: source, _config: { specReask: true, stageSettings: {} } });
beforeEach(() => callLLMJson.mockReset());

describe("independent source passages and explicit defaults", () => {
  const first = "The output shall equal the input word.";
  const last = "The module shall contain no clocked storage.";
  const source = first + "\n\nThe interface uses five-bit words.\n\n" + last;
  const requirement = req("Copy the input word without clocked storage.", first + "\n" + last);
  const spec = specFor(requirement);
  const decision = { id: requirement.id, requirement: requirement.desc, kind: "derived", src: first,
    sources: [{ quote: first }, { quote: last }], reason: "Both clauses have independent source passages." };
  it("validates separate passages and records exact locations without changing behavior", () => {
    const out = applyCitationRepairs(source, spec, [requirement], { citations: [decision] });
    expect(out._citationRepair.status).toBe("REPAIRED");
    expect(out.requirements[0].desc).toBe(requirement.desc);
    expect(out.requirements[0].rat).toBe(requirement.rat);
    expect(out.iface).toBe(spec.iface);
    for (const s of out.requirements[0].sources) expect(source.slice(s.start, s.end)).toBe(s.quote);
    expect(uncitedRequirements(out.requirements, source, out)).toEqual([]);
    expect(uncoveredDescription(out.requirements, source)).toEqual([]);
    out._designContract = sealDesignContract(source, out, {});
    expect(assessDesignContract(source, out, {}).issues).toEqual([]);
    expect(out._designContract.entries[0].sources).toHaveLength(2);
  });
  it.each(["invented", "offset", "stitched-src"])("rejects %s evidence without changing requirements", kind => {
    const d = structuredClone(decision);
    if (kind === "invented") d.sources[1].quote = "The output shall start at all zeros.";
    if (kind === "offset") Object.assign(d.sources[1], { start: 0, end: last.length });
    if (kind === "stitched-src") d.src = first + "\n" + last;
    const out = applyCitationRepairs(source, spec, [requirement], { citations: [d] });
    expect(out.requirements).toBe(spec.requirements);
    expect(out._citationRepair.status).toBe("UNRESOLVED");
  });
  it("retries an invalid quotation once using validation feedback", async () => {
    callLLMJson.mockResolvedValueOnce(reply({ citations: [{ ...decision, sources: undefined, src: requirement.src }] }))
      .mockResolvedValueOnce(reply({ citations: [decision] }));
    const out = await repairSpecCitations(stFor(source), spec, {});
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    expect(callLLMJson.mock.calls[1][0].userMessage).toContain("PREVIOUS CITATION VALIDATION ERRORS");
    expect(out.spec._citationRepair.status).toBe("REPAIRED");
    expect(out.spec._citationRepair.attempts).toHaveLength(2);
    expect(out.llms).toHaveLength(2);
  });
  it("caps unsuccessful citation repair at two calls", async () => {
    callLLMJson.mockResolvedValue(reply({ citations: [{ ...decision, sources: undefined, src: requirement.src }] }));
    const out = await repairSpecCitations(stFor(source), spec, {});
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    expect(out.spec._citationRepair.status).toBe("UNRESOLVED");
  });
  it("repairs a source-stated scalar default and a separate declaration mechanically", async () => {
    const rule = "All signals are single-bit unless otherwise specified.";
    const source = "Implement module named ControlPath.\n" + rule + "\nPorts:\n- input gate\n- input enable\n- output ready";
    const r = req("The module shall expose enable as a one-bit input port.", rule + "\n- input enable", { id: "REQ-INTF-012", cat: "Interface" });
    const spec = { modName: "ControlPath", iface: [{ name: "enable", dir: "input", width: "1" }], requirements: [r] };
    const out = await repairSpecCitations(stFor(source), spec, {});
    expect(callLLMJson).not.toHaveBeenCalled();
    expect(out.spec._citationRepair.status).toBe("REPAIRED");
    expect(out.spec.requirements[0].sources.map(s => s.quote)).toEqual(["- input enable", rule]);
    expect(out.spec.requirements[0].desc).toBe(r.desc);
    const c = sealDesignContract(source, out.spec, {});
    expect(c.issues).toEqual([]);
    expect(c.entries[0].kind).toBe("derived");
    expect(promptSpecCitationRepair(source, [r]).userMessage).toContain("explicit default or exception rule written by the user");
  });
  it("does not guess scalar width for an unqualified prose declaration", () => {
    const r = req("The module shall expose enable as a one-bit input.", "");
    expect(interfaceCitation("Ports:\n- input enable", r, { iface: [{ name: "enable", dir: "input", width: "1" }] })).toBeNull();
  });
});

describe("retained declarations from defective implementations", () => {
  const source = "module WordPath(input [4:0] word_i, output [4:0] word_o);\nassign word_o = ~word_i;\nendmodule\nThis implementation is defective.";
  const r = req("The module shall expose word_i as an input with width 5.", "input [4:0] word_i", { id: "REQ-INTF-004", cat: "Interface" });
  it("allows a matching declaration as a recorded choice, never a behavioral source fact", () => {
    const spec = specFor(r);
    expect(inspectCitation(source, r, spec)).toMatchObject({ valid: true, provisional: true });
    expect(invalidSpecCitations(source, spec)).toEqual([]);
    expect(uncitedRequirements([r], source, spec)).toEqual([]);
    const c = sealDesignContract(source, spec, {});
    expect(c.issues).toEqual([]);
    expect(c.entries[0]).toMatchObject({ kind: "auto_assumption", origin: "retained-interface-declaration" });
  });
  it.each(["width", "extra-behavior", "body-quote", "label-only"])("rejects %s masquerading as interface evidence", kind => {
    const changed = { ...r };
    if (kind === "width") changed.desc = "The module shall expose word_i as an input with width 6.";
    if (kind === "extra-behavior") changed.desc = r.desc.slice(0, -1) + " and always clear word_o.";
    if (kind === "body-quote") changed.src = "assign word_o = ~word_i;";
    if (kind === "label-only") { changed.src = ""; changed.desc = "The module shall reset every stored bit."; }
    const c = sealDesignContract(source, specFor(changed), {});
    expect(c.issues).toHaveLength(1);
  });
  it("includes context-invalid but literal quotations in citation repair targets", () => {
    const bad = req("The module shall invert word_i.", "assign word_o = ~word_i;");
    const spec = specFor(bad);
    expect(invalidSpecCitations(source, spec)).toEqual([bad]);
    const out = applyCitationRepairs(source, spec, [bad], { citations: [{ id: bad.id, requirement: bad.desc,
      kind: "derived", src: bad.src, reason: "Copied from implementation." }] });
    expect(out._citationRepair.status).toBe("UNRESOLVED");
  });
  it("does not restore a rejected choice through a defective-code declaration", () => {
    const changed = { ...r, rat: "[source: assumption A-18]" };
    const c = sealDesignContract(source, specFor(changed), { assumptions: [{ id: "A-18", text: "Retain the input declaration.", confirmed: false }] });
    expect(c.issues[0].reason).toContain("deselected");
    expect(c.entries).toEqual([]);
  });
});

describe("Spec owns attribution failures", () => {
  it("persists the unresolved specification, unmarks completion, and returns failure before Architect", async () => {
    const specification = { ...specFor(req("Preserve the word.", "fabricated source text")),
      status: "UNVERIFIED", _designContract: { issues: [{ id: "REQ-FUNC-017", reason: "missing quotation" }] } };
    const dispatched = [], mod = blankModule(); mod.completed.add(2);
    const out = await runStage({ stageId: 2, stageKey: "spec", targetModId: "WordPath",
      reducerState: { modules: { WordPath: mod } }, uiState: { config: {} },
      services: { allStages: [], pipeline: { invokeNode: async (_, st) => ({ ...st, spec: specification }) } },
      dispatch: action => dispatched.push(action) });
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("SPEC_ATTRIBUTION_UNRESOLVED");
    expect(dispatched).toContainEqual(expect.objectContaining({ type: "MODULE_STAGE_DATA_SET", stageId: 2, data: specification }));
    expect(dispatched.some(a => a.type === "MODULE_STAGE_UNCOMPLETE" && a.stageId === 2)).toBe(true);
    expect(dispatched.some(a => a.type === "MODULE_STAGE_COMPLETE" && a.stageId === 2)).toBe(false);
    const invokeNode = vi.fn(async (_, st) => ({ ...st, spec: specification }));
    await expect(runStages({ invokeNode, hasNode: () => true }, ["spec", "architect"], {})).rejects.toMatchObject({ code: "SPEC_ATTRIBUTION_UNRESOLVED", spec: specification });
    expect(invokeNode).toHaveBeenCalledOnce();
  });
  it("freezes a repaired multi-passage specification through the real Spec node", async () => {
    const source = "Implement module named WordPath.\nInterface:\n- input word_i (5 bits)\n- output word_o (5 bits)\n\n"
      + "word_o equals word_i.\nOther implementation details are open.\nThe implementation is combinational.";
    const r = req("The module shall copy word_i without storage.", "The output copies the word without storage.");
    callLLMJson.mockResolvedValueOnce(reply(specFor(r))).mockResolvedValueOnce(reply({ citations: [{ id: r.id,
      requirement: r.desc, kind: "derived", src: "word_o equals word_i.",
      sources: [{ quote: "word_o equals word_i." }, { quote: "The implementation is combinational." }],
      reason: "Separate source clauses state equality and no storage." }] }));
    const result = await specNode(stFor(source));
    expect(result.spec._designContract.issues).toEqual([]);
    expect(result.spec._sourceContract.status).toBe("READY");
    expect(result.spec._designContract.entries[0].sources).toHaveLength(2);
    expect(result.spec.uncited).toBeUndefined();
  });
});
