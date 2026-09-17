// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, expect, it, vi } from "vitest";
import { formalVerifyNode } from "../src/pipeline/nodes/formal_verify.js";
import { sbyAvailable } from "../src/cli/formalRunner.js";
import { judgeNode } from "../src/pipeline/nodes/judge.js";
import { defaultEvalConfig } from "../src/eval/criteria.js";
import { verificationSummaryText } from "../src/utils/verificationPresentation.js";

function state(properties, runner) {
  return {
    _config: { maxFormalIters: 0, formalProve: false, formalDepth: 4, formalTimeoutSec: 15 },
    _services: runner ? { formalRunner: runner } : {},
    elicit: { modName: "ParityUnit" },
    spec: { iface: [
      { name: "clk", dir: "input", width: 1 },
      { name: "payload", dir: "input", width: 6 },
      { name: "parity", dir: "output", width: 1 },
    ], params: [] },
    rtl_generate: { code: "module ParityUnit(input clk, input [5:0] payload, output parity);\nassign parity = ^payload;\nendmodule" },
    formal_props: { properties },
  };
}

describe("formal admission and evidence", () => {
  it.each([false, true])("keeps unsupported obligations visible without invoking the solver or RTL repair (mixed=%s)", async mixed => {
    const properties = [{ id: "STRUCTURE", req: "REQ-SHAPE", type: "assert",
      code: "assert property (@(posedge clk) 1'b0); /* UNTESTED: structural identity is not observable */" }];
    if (mixed) properties.push({ id: "PARITY", code: "assert property (@(posedge clk) parity == ^payload);" });
    const unexpected = vi.fn(() => { throw new Error("Unsupported evidence must not invoke a tool or repair"); });
    const st = state(properties, { sbyAvailable: unexpected, checkFormalSyntax: unexpected, runBmc: unexpected });
    st._config = { ...st._config, maxFormalIters: 2, maxJudgeIters: 3,
      optionalStages: { formal_verify: true }, _llmReplay: unexpected,
      evalCriteria: Object.fromEntries(Object.entries(defaultEvalConfig()).map(([id, c]) => [id,
        { ...c, enabled: ["verify_pass_rate", "formal_proven"].includes(id) }])) };
    st._services.invokeNode = unexpected;
    st._services.allStages = [];
    st.spec.requirements = [];
    st.test_generate = { code: "frozen independent checker" };
    st.verify = { status: "MEASURED", cli: true, pass: 2, fail: 0, total: 2,
      tests: [{ name: "even", st: "PASS" }, { name: "odd", st: "PASS" }] };
    const original = structuredClone(properties);
    const result = await formalVerifyNode(st);
    expect(result.rtl_generate).toBeUndefined();
    expect(result.formal_verify).toMatchObject({ status: "SKIPPED", assertionIds: [], assumptionIds: [],
      properties: [], formalSkipped: ["STRUCTURE"], _llms: [],
      propertyQualification: { status: "UNVERIFIED", scope: "property-admission" } });
    expect(result.formal_verify.formalSkipReasons).toEqual([{ id: "STRUCTURE", req: "REQ-SHAPE",
      category: "declared-untested", reason: "property explicitly marked UNTESTED: structural identity is not observable" }]);
    const final = await judgeNode({ ...st, ...result });
    expect(final.rtl_generate.code).toBe(st.rtl_generate.code);
    expect(final.verify).toEqual(st.verify);
    expect(final.judge).toMatchObject({ overall: "UNVERIFIED", verified: false, stopReason: "formal-evidence-incomplete" });
    const text = verificationSummaryText({ 8: final.verify, 9: final.judge, 13: result.formal_verify });
    expect(text).toContain("Verification incomplete");
    expect(text).toContain("Simulation: PASS — 2/2 measured checks");
    expect(text).toContain("Formal: SKIPPED");
    expect(text).toContain("STRUCTURE");
    expect(unexpected).not.toHaveBeenCalled();
    expect(properties).toEqual(original);
  });

  it("does not run a partial proof while obligations remain unsupported", async () => {
    let assembled;
    const runner = { checkFormalSyntax: async () => ({ status: "PASS" }), sbyAvailable: () => true, runBmc: o => {
      assembled = o.source;
      return { status: "PASS", log: "DONE (PASS)", elapsedMs: 1 };
    } };
    const out = await formalVerifyNode(state([
      { id: "CHECK-PARITY", code: "assert #0 (parity == ^payload);" },
      { id: "CHECK-SEQUENCE", code: "assert property (@(posedge clk) (payload[0] |=> parity) and (payload[1] |=> !parity));" },
    ], runner));
    expect(out.formal_verify.status).toBe("SKIPPED");
    expect(out.formal_verify.formalSkipReasons[0].reason).toMatch(/compound/);
    expect(assembled).toBeUndefined();
  });

  it("never establishes a verdict from assumptions alone", async () => {
    const runner = { sbyAvailable: () => { throw new Error("solver must not run"); } };
    const out = await formalVerifyNode(state([
      { id: "ENV", code: "assume (payload != 0);" },
      { id: "UNSUPPORTED", code: "assert property (@(posedge clk) payload[0] |=> ##3 parity);" },
    ], runner));
    expect(out.formal_verify.status).toBe("SKIPPED");
    expect(out.formal_verify.properties).toEqual([]);
    expect(out.formal_verify.formalSkipped).toEqual(["UNSUPPORTED"]);
  });

  it.each(["Assert failed in ParityUnit: ", "failed assertion example at "])(
    "retains a counterexample assertion at a zero-repair budget: %s", async prefix => {
      const runner = { checkFormalSyntax: async () => ({ status: "PASS" }), sbyAvailable: () => true, runBmc: o => {
        const line = o.source.split("\n").findIndex(l => l.includes("assert (")) + 1;
        return { status: "FAIL", log: prefix + "dut.sv:" + line + ".4-" + line + ".22 step 2\nDONE (FAIL)", elapsedMs: 1 };
      } };
      const out = await formalVerifyNode(state([{ id: "CHECK", code: "assert (parity == 0);" }], runner));
      expect(out.formal_verify.violated).toContain("assert (parity == 0)");
      expect(out.formal_verify.fixIterations).toBe(0);
    }
  );
});

// Independent synthetic functions and temporal obligations, never benchmark
// references. These catch both tool errors and vacuous success after filtering.
describe.skipIf(!sbyAvailable())("formal translation with real SymbiYosys", () => {
  it("does not discard a constant-false assertion that is not declared untested", async () => {
    const st = state([{ id: "IMPOSSIBLE", code: "assert property (@(posedge clk) 1'b0);" }]);
    expect((await formalVerifyNode(st)).formal_verify.status).toBe("FAIL");
    st.formal_props.properties[0].code = "assert property (@(posedge clk) (parity != ^payload) |-> 1'b0);";
    expect((await formalVerifyNode(st)).formal_verify.status).toBe("PASS");
    st.rtl_generate.code = st.rtl_generate.code.replace("^payload", "payload[0]");
    expect((await formalVerifyNode(st)).formal_verify.status).toBe("FAIL");
  }, 40000);

  it.each([3, 6, 11])("checks every bit of a %i-bit combinational function", async width => {
    const st = state([{ id: "PARITY", code: "assert #0 (parity == ^payload);" }]);
    st.spec.iface[1].width = width;
    st.spec.iface = st.spec.iface.filter(p => p.name !== "clk");
    const header = "module ParityUnit(input [" + (width - 1) + ":0] payload, output parity);\n";
    st.rtl_generate.code = header + "assign parity = ^payload;\nendmodule";
    expect((await formalVerifyNode(st)).formal_verify.status).toBe("PASS");
    st.rtl_generate.code = header + "assign parity = payload[0];\nendmodule";
    const bad = (await formalVerifyNode(st)).formal_verify;
    expect(bad.status).toBe("FAIL");
    expect(bad.violated).toContain("assert (");
  }, 40000);

  it("checks next-cycle obligations against both correct and incorrect sequential RTL", async () => {
    const st = state([{ id: "DELAY", code: "assert property (@(posedge clk) payload[0] |=> parity);" }]);
    const header = "module ParityUnit(input clk, input [5:0] payload, output reg parity);\n";
    st.rtl_generate.code = header + "always @(posedge clk) parity <= payload[0];\nendmodule";
    expect((await formalVerifyNode(st)).formal_verify.status).toBe("PASS");
    st.rtl_generate.code = header + "always @(posedge clk) parity <= !payload[0];\nendmodule";
    expect((await formalVerifyNode(st)).formal_verify.status).toBe("FAIL");
  }, 40000);
});
