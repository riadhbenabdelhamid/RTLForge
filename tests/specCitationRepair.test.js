// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/llm/index.js", () => ({ callLLMJson: vi.fn(), addRetryHint: s => s }));
const { callLLMJson } = await import("../src/llm/index.js");
const { specNode } = await import("../src/pipeline/nodes/spec.js");
const { invalidSpecCitations, applyCitationRepairs, repairSpecCitations } = await import("../src/pipeline/specCitationRepair.js");
const { buildSourceContract } = await import("../src/pipeline/sourceContract.js");
const { promptSpec } = await import("../src/prompts/spec.js");

const SOURCE = "Implement module named EchoUnit.\nInterface:\n- input word (5 bits)\n- output result (5 bits)\n\n"
  + "The result equals word.\nThe implementation is combinational.";
const REQ = { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must",
  desc: "The module shall copy word to result without clocked storage.",
  src: "The word is forwarded directly to the result.", rat: "[source: assumption A-01]", custom: { preserve: true } };
const SPEC = { modName: "EchoUnit", domain: "copy", requirements: [REQ],
  iface: [{ name: "word", dir: "input", width: "5" }, { name: "result", dir: "output", width: "5" }], params: [],
  customMetadata: { value: 7 } };
const QUOTE = "The result equals word.\nThe implementation is combinational.";
const entry = (extra = {}) => ({ id: REQ.id, requirement: REQ.desc, kind: "derived", src: QUOTE,
  reason: "Equality and combinational implementation together support the entire requirement.", ...extra });
const reply = data => ({ data, llms: [{ text: JSON.stringify(data), tokensIn: 12, tokensOut: 8 }] });
const state = extra => ({ _userDesc: SOURCE, _config: { specReask: true, provider: "openai", stageSettings: {} },
  _onLog: vi.fn(), ...extra });
const behavior = spec => ({ ...spec, requirements: spec.requirements.map(({ src, ...r }) => r) });

describe("bounded source citation repair", () => {
  beforeEach(() => callLLMJson.mockReset());

  it("freezes an honestly labelled default from a thin prompt without a citation repair call", async () => {
    const thin = SOURCE.split("\n\n")[0];
    const spec = { ...SPEC, requirements: [{ ...REQ, src: "", rat: "[domain default] Preserve the input value." }] };
    callLLMJson.mockResolvedValueOnce(reply(spec));
    const out = await specNode(state({ _userDesc: thin, _config: { specReask: false, stageSettings: {} } }));
    expect(callLLMJson).toHaveBeenCalledOnce();
    expect(out.spec._designContract.revision).toBe(1);
    expect(out.spec._sourceContract.status).toBe("READY");
    expect(out.spec._sourceContract.assumptions).toHaveLength(1);
    expect(out.spec.requirements[0].src).toBe("");
  });

  it("changes only invalid citations, preserving every behavioral and interface field", () => {
    const spec = structuredClone(SPEC);
    const before = structuredClone(spec);
    const fixed = applyCitationRepairs(SOURCE, spec, invalidSpecCitations(SOURCE, spec), { citations: [entry()] });
    const { _citationRepair, ...result } = fixed;
    expect(behavior(result)).toEqual(behavior(before));
    expect(spec).toEqual(before);
    expect(fixed.requirements[0].src).toBe(QUOTE);
    expect(_citationRepair).toMatchObject({ status: "REPAIRED", remaining: 0 });
    expect(_citationRepair.decisions[0]).toMatchObject({ originalSrc: REQ.src, adopted: true });
    expect(buildSourceContract(SOURCE, before, "EchoUnit").status).toBe("UNRESOLVED");
    expect(buildSourceContract(SOURCE, fixed, "EchoUnit").status).toBe("NONE");
  });

  it.each([
    { requirement: "The module shall invert word." },
    { desc: "The module shall invert word." },
    { pri: "May" },
    { kind: "proven" },
    { reason: "" },
    { src: "A quote that does not appear in the source." },
  ])("rejects malformed or behavior-changing review entries: %j", extra => {
    const fixed = applyCitationRepairs(SOURCE, SPEC, [REQ], { citations: [entry(extra)] });
    expect(fixed.requirements).toBe(SPEC.requirements);
  });

  it("rejects extra specification fields, unknown ids and duplicate ids", () => {
    for (const answer of [
      { citations: [entry()], iface: [] },
      { citations: [entry({ id: "REQ-FUNC-999" })] },
      { citations: [entry(), entry()] },
      { requirements: [] },
    ]) {
      expect(applyCitationRepairs(SOURCE, SPEC, [REQ], answer).requirements).toBe(SPEC.requirements);
    }
  });

  it("retains unresolved compound requirements instead of deleting their unsupported clauses", () => {
    const answer = { citations: [entry({ kind: "unresolved", src: "", reason: "This description does not specify the added behavior." })] };
    const fixed = applyCitationRepairs(SOURCE, SPEC, [REQ], answer);
    expect(fixed.requirements).toEqual(SPEC.requirements);
    expect(fixed._citationRepair.status).toBe("UNRESOLVED");
    expect(buildSourceContract(SOURCE, fixed, "EchoUnit").status).toBe("UNRESOLVED");
  });

  it("never changes a valid citation or an honest empty default during partial repair", () => {
    const valid = { ...REQ, id: "REQ-FUNC-002", src: QUOTE };
    const empty = { ...REQ, id: "REQ-ERR-003", cat: "Error", src: "", rat: "[default — question skipped]" };
    const spec = { ...SPEC, requirements: [REQ, valid, empty] };
    const fixed = applyCitationRepairs(SOURCE, spec, invalidSpecCitations(SOURCE, spec), { citations: [entry()] });
    expect(fixed.requirements[1]).toBe(valid);
    expect(fixed.requirements[2]).toBe(empty);
    expect(buildSourceContract(SOURCE, fixed, "EchoUnit").issues).toEqual([
      expect.objectContaining({ id: empty.id, reason: "Behavioral default is an assumption, not a source-supported requirement" }),
    ]);
    const attempt = applyCitationRepairs(SOURCE, spec, [REQ], { citations: [entry(), entry({ id: valid.id })] });
    expect(attempt.requirements).toBe(spec.requirements);
  });

  it("preserves table labels, literal case and the original line wrapping", () => {
    const source = "mode result\n2'b01 5'h0A\n2'b10 5'h1C";
    const fixed = applyCitationRepairs(source, SPEC, [REQ], { citations: [entry({ src: "2'b01 5'h0A 2'b10 5'h1C" })] });
    expect(fixed.requirements[0].src).toBe("2'b01 5'h0A\n2'b10 5'h1C");
    const wrong = applyCitationRepairs(source, SPEC, [REQ], { citations: [entry({ src: "2'b01 5'h0a 2'b10 5'h1c" })] });
    expect(wrong.requirements).toEqual(SPEC.requirements);
  });

  it("does not promote defective implementation text into behavioral authority", () => {
    const quote = "assign result = ~word;";
    const source = "module DraftUnit;\n" + quote + "\nendmodule\nThis module has a bug.";
    const fixed = applyCitationRepairs(source, SPEC, [REQ], { citations: [entry({ src: quote })] });
    expect(fixed.requirements).toEqual(SPEC.requirements);
    expect(fixed._citationRepair.decisions[0].reason).toMatch(/defective/);
  });

  it("makes no call for valid, empty or legacy citations, opt-out, or imported specs", async () => {
    for (const src of [QUOTE, "", undefined]) {
      const spec = { ...SPEC, requirements: [{ ...REQ, src }] };
      expect((await repairSpecCitations(state(), spec, {})).spec).toBe(spec);
    }
    for (const st of [state({ _userDesc: "" }), state({ _config: { specReask: false } }), state({ _specImport: { text: "owned by user" } })]) {
      expect((await repairSpecCitations(st, SPEC, {})).spec).toBe(SPEC);
    }
    expect(callLLMJson).not.toHaveBeenCalled();
  });

  it("makes one bounded review and accounts for its model call", async () => {
    callLLMJson.mockResolvedValueOnce(reply({ citations: [entry()] }));
    const result = await repairSpecCitations(state(), SPEC, { _maxTokens: 1000 });
    expect(callLLMJson).toHaveBeenCalledTimes(1);
    expect(callLLMJson.mock.calls[0][1]).toEqual({ parseRetries: 0 });
    expect(result.spec._citationRepair.status).toBe("REPAIRED");
    expect(result.llms[0].purpose).toBe("spec_citation_repair");
  });

  it("retains the spec on model failure", async () => {
    const error = Object.assign(new Error("unavailable"), { llms: [{ tokensIn: 3 }] });
    callLLMJson.mockImplementationOnce(async () => { throw error; });
    const result = await repairSpecCitations(state(), SPEC, {});
    expect(result.spec.requirements).toBe(SPEC.requirements);
    expect(result.spec.iface).toBe(SPEC.iface);
    expect(result.llms).toEqual(error.llms);
    expect(callLLMJson).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation instead of continuing the pipeline", async () => {
    const controller = new AbortController();
    callLLMJson.mockImplementationOnce(async () => { controller.abort(); throw new Error("stopped"); });
    await expect(repairSpecCitations(state({ _signal: controller.signal }), SPEC, {})).rejects.toThrow("stopped");
  });

  it("repairs citations at the end of the actual Spec node and refreshes source evidence", async () => {
    callLLMJson.mockResolvedValueOnce(reply(structuredClone(SPEC))).mockResolvedValueOnce(reply({ citations: [entry()] }));
    const result = await specNode(state());
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    expect(result.spec.requirements).toEqual([{ ...REQ, src: QUOTE }]);
    expect(result.spec.iface).toEqual(SPEC.iface);
    expect(result.spec.params).toEqual(SPEC.params);
    expect(result.spec.uncited).toBeUndefined();
    expect(result.spec._sourceContract.status).toBe("READY");
    expect(result.spec._sourceContract.assumptions).toEqual([]);
    expect(result.spec._citationRepair.status).toBe("REPAIRED");
    expect(result._llms).toHaveLength(2);
  });

  it("keeps explicit answers, custom answers, revisions and UI selections intact", () => {
    const el = { domain: "test", modName: "Unit", questions: [
      { id: "FUNC-01", text: "Select behavior", cat: "functionality", recommended: "a default" },
      { id: "FUNC-02", text: "Specify timing", cat: "timing" },
    ], answers: { "FUNC-01": "chosen behavior", "FUNC-02": "Other (specify)" }, customAnswers: { "FUNC-02": "explicit timing" },
    assumptions: [
      { id: "A-01", text: "generated choice", confirmed: true, revised: null },
      { id: "A-02", text: "old choice", confirmed: true, revised: "user revision" },
      { id: "A-03", text: "deselected choice", confirmed: false, revised: null },
    ] };
    const before = structuredClone(el);
    const p = promptSpec(el, [], SOURCE);
    const data = JSON.parse(p.userMessage.split("\n").find(line => line.startsWith('{"domain":')));
    expect(data.answeredQuestions.map(q => q.answer)).toEqual(["chosen behavior", "explicit timing"]);
    expect(data.assumptions.map(a => [a.id, a.sourceKind, a.revised])).toEqual([
      ["A-01", "generated_assumption", null], ["A-02", "explicit_user_revision", "user revision"],
    ]);
    expect(el).toEqual(before);
  });
});
