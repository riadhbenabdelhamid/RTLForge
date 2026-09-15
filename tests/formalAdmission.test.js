// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, expect, it } from "vitest";
import { formalVerifyNode } from "../src/pipeline/nodes/formal_verify.js";
import { sbyAvailable } from "../src/cli/formalRunner.js";

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
  it("reports only translated properties and names the unsupported obligations", async () => {
    let assembled;
    const runner = { sbyAvailable: () => true, runBmc: o => {
      assembled = o.source;
      return { status: "PASS", log: "DONE (PASS)", elapsedMs: 1 };
    } };
    const out = await formalVerifyNode(state([
      { id: "CHECK-PARITY", code: "assert #0 (parity == ^payload);" },
      { id: "CHECK-SEQUENCE", code: "assert property (@(posedge clk) (payload[0] |=> parity) and (payload[1] |=> !parity));" },
    ], runner));
    expect(out.formal_verify.properties).toEqual(["CHECK-PARITY"]);
    expect(out.formal_verify.formalSkipped).toEqual(["CHECK-SEQUENCE"]);
    expect(out.formal_verify.formalSkipReasons[0].reason).toMatch(/compound/);
    expect(assembled).toContain("always @* begin assert (parity == ^payload); end");
    expect(assembled).not.toContain("|=>");
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
      const runner = { sbyAvailable: () => true, runBmc: o => {
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
