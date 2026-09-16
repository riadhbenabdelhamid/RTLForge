// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
vi.mock("../src/llm/index.js", () => ({ callLLMJson: vi.fn() }));
vi.mock("../src/cli/index.js", async () => ({ ...await vi.importActual("../src/cli/index.js"), runCli: vi.fn() }));
import { callLLMJson } from "../src/llm/index.js";
import { runCli } from "../src/cli/index.js";
import { sealDesignContract, assessDesignContract } from "../src/pipeline/designContract.js";
import { buildSourceContract } from "../src/pipeline/sourceContract.js";
import { completeSourceConventions } from "../src/pipeline/completeSourceConventions.js";
import { sourceConventionLedger } from "../src/pipeline/sourceConventions.js";
import { createReviewAcceptance } from "../src/pipeline/reviewAcceptance.js";

const source = `Sample data on the rising edge of clock. Clear sets result to zero.
time clock clr data result
0ns 0 1 00 x
5ns 1 1 00 00
10ns 0 0 0b x
15ns 1 0 0b 0b
20ns 0 0 0b 0b
25ns 1 0 1c 1c`;
const baseSpec = { modName: "Sampler", requirements: [], iface: [
  { name: "clock", dir: "input", width: "1" }, { name: "clear", dir: "input", width: "1" },
  { name: "data", dir: "input", width: "5" }, { name: "result", dir: "output", width: "5" },
] };
const choice = (kind, column, value) => ({ table: "SOURCE.T1", kind, ...(column ? { column } : {}), value,
  reasoning: "Interpret the source table using its port declarations and displayed values.",
  sources: [{ quote: "time clock clr data result" }], alternatives: ["Leave notation unresolved"] });
const choices = [choice("alias", "clr", "clear"), choice("radix", "data", 16),
  choice("radix", "result", 16), choice("phase", null, "inputs-before-clock")];
function specFor(text = source, conventions = choices) {
  const spec = { ...baseSpec, sourceConventions: structuredClone(conventions) };
  spec._designContract = sealDesignContract(text, spec, {});
  return spec;
}
beforeEach(() => { callLLMJson.mockReset(); runCli.mockReset(); });

describe("frozen source notation interpretations", () => {
  it("requires a sealed choice, preserves rows and masks, and reports conditional provenance", () => {
    expect(buildSourceContract(source, baseSpec, "Sampler").status).toBe("UNRESOLVED");
    expect(buildSourceContract(source, { ...baseSpec, sourceConventions: choices }, "Sampler").status).toBe("UNRESOLVED");
    const spec = specFor(), contract = buildSourceContract(source, spec, "Sampler", {});
    expect(contract.issues).toEqual([]);
    expect(contract.status).toBe("READY");
    expect(contract.tables[0].raw).toBe(source.split("\n").slice(1).join("\n"));
    expect(contract.suites[0].code).toContain("5'h1c");
    expect(contract.suites[0].ids).toHaveLength(4);
    expect(contract.assumptions).toHaveLength(4);
    expect(contract.assumptions.every(a => a.userConfirmation === "unconfirmed" && a.kind === "interpretation")).toBe(true);
    expect(contract.timingAudit[0]).toMatchObject({ status: "OBSERVED", convention: "inputs-before-clock" });
  });
  it.each(["phase", "radix", "alias"])("invalidates checker authority when a frozen %s changes", kind => {
    const spec = specFor(), original = spec._designContract.hash;
    const entry = spec.sourceConventions.find(c => c.kind === kind);
    entry.value = kind === "phase" ? "clock-before-inputs" : kind === "radix" ? 10 : "clock";
    expect(assessDesignContract(source, spec, {}).issues).not.toEqual([]);
    expect(buildSourceContract(source, spec, "Sampler").status).toBe("UNRESOLVED");
    spec._designContract = sealDesignContract(source, spec, {}, spec._designContract);
    expect(spec._designContract).toMatchObject({ previousHash: original, revision: 2 });
  });
  it.each([
    choice("alias", "data", "clear"), choice("alias", "clr", "missing"),
    choice("radix", "data", 8), choice("phase", null, "candidate-dependent"),
    { ...choices[0], table: "SOURCE.T9" }, { ...choices[0], sources: [{ quote: "Invented source quotation" }] },
    { ...choices[0], reasoning: "" }, { ...choices[0], alternatives: [] }, { ...choices[0], expected: 0 },
  ])("rejects invalid or behavior-editing choices: %j", invalid => {
    expect(sourceConventionLedger(source, { ...baseSpec, sourceConventions: [invalid] }).issues).toHaveLength(1);
  });
  it("rejects duplicate choices and conflicts with explicit source conventions", () => {
    expect(sourceConventionLedger(source, { ...baseSpec, sourceConventions: [choices[0], choices[0]] }).issues).toHaveLength(1);
    for (const prefix of ["Inputs are driven after the clock edge.", "Column data is decimal.", "Signal alias: clr = clock."]) {
      const text = prefix + "\n" + source, spec = specFor(text);
      expect(spec._designContract.issues).not.toEqual([]);
      expect(buildSourceContract(text, spec, "Sampler").status).toBe("UNRESOLVED");
    }
  });
  it("runs one bounded source-only completion and preserves all behavioral fields", async () => {
    callLLMJson.mockResolvedValue({ data: { sourceConventions: choices }, llms: [{ tokensOut: 22 }] });
    const st = { _config: { specReask: true }, _userDesc: source, elicit: { _llms: [{ text: "PRIVATE_HISTORY" }] },
      rtl_generate: { code: "PRIVATE_RTL" }, verify: { log: "PRIVATE_MEASUREMENTS" } };
    const result = await completeSourceConventions(st, baseSpec, {});
    expect(result.spec.requirements).toBe(baseSpec.requirements);
    expect(result.spec.iface).toBe(baseSpec.iface);
    expect(result.spec._sourceConventionReview.status).toBe("RECORDED");
    expect(result.llms[0].purpose).toBe("source_convention_completion");
    expect(callLLMJson).toHaveBeenCalledTimes(1);
    expect(callLLMJson.mock.calls[0][1]).toEqual({ parseRetries: 0 });
    expect(callLLMJson.mock.calls[0][0].userMessage).not.toMatch(/PRIVATE_/);
  });
  it("does not call a model for already explicit notation, opt-out, or imported specs", async () => {
    const explicit = "Signal alias: clr = clear.\nColumn data is hexadecimal.\nColumn result is hexadecimal.\nInputs are driven before the clock edge.\n" + source;
    for (const st of [{ _userDesc: explicit, _config: { specReask: true } },
      { _userDesc: source, _config: { specReask: false } },
      { _userDesc: source, _config: { specReask: true }, _specImport: {} }]) {
      expect((await completeSourceConventions(st, baseSpec, {})).spec).toBe(baseSpec);
    }
    expect(callLLMJson).not.toHaveBeenCalled();
  });
  it("keeps unresolved notation when completion fails or attempts behavioral changes", async () => {
    const st = { _userDesc: source, _config: { specReask: true } };
    for (const data of [{ sourceConventions: choices, requirements: [] }, { sourceConventions: [{ ...choices[0], value: "missing" }] }]) {
      callLLMJson.mockResolvedValueOnce({ data });
      const out = await completeSourceConventions(st, baseSpec, {});
      expect(out.spec.sourceConventions).toBeUndefined();
      expect(out.spec._sourceConventionReview.status).toBe("UNRESOLVED");
    }
    callLLMJson.mockRejectedValueOnce(new Error("model unavailable"));
    expect((await completeSourceConventions(st, baseSpec, {})).spec._sourceConventionReview.status).toBe("UNRESOLVED");
  });
  it("accepts a real measured repair using frozen source rows and rejects a subsequent regression", async () => {
    runCli.mockImplementation(async (_, request) => {
      const dir = mkdtempSync(join(tmpdir(), "notation-acceptance-"));
      try {
        for (const [name, code] of Object.entries(request.files)) writeFileSync(join(dir, name), code);
        return { exitCode: 0, stdout: execFileSync("bash", ["-c", request.command], { cwd: dir, timeout: 10000, encoding: "utf8" }), stderr: "" };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    const good = "module Sampler(input clock,clear,input [4:0] data,output reg [4:0] result); always @(posedge clock) if(clear) result<=0; else result<=data; endmodule";
    const bad = good.replace("result<=data", "result<=0");
    const st = { _userDesc: source, spec: specFor(), elicit: { modName: "Sampler" }, rtl_generate: { code: bad },
      _config: { backendUrl: "mock", simCmds: "iverilog -g2012 -s Sampler_tb -o sim {RTL} {TB}\nvvp sim" } };
    const guard = createReviewAcceptance(st, bad);
    const result = await guard.compare(good, bad);
    expect(result.adopted).toBe(true);
    expect(result.baseline.fail).toBe(3);
    expect(result.proposed.fail).toBe(0);
    expect((await guard.compare(bad, good)).reason).toBe("PASSED_CHECK_REGRESSION");
  });
});
