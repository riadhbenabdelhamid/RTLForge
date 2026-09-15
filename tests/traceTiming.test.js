// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildSourceContract, mergeSourceEvidence } from "../src/pipeline/sourceContract.js";
import { applySkillsToPrompt } from "../src/pipeline/applySkillsToPrompt.js";

// Authored examples vary width, data, clock name, and active edge. Neither
// the candidate equations nor waveform values come from a benchmark.
function fixture(width, edge) {
  const spec = { modName: "SampleUnit", iface: [
    { name: "tick", dir: "input", width: 1 }, { name: "payload", dir: "input", width },
    { name: "result", dir: "output", width },
  ], requirements: [] };
  const on = edge === "posedge" ? 1 : 0, off = 1 - on;
  const mask = 2 ** width - 3;
  const rows = ["time tick payload result", `0ns ${off} ${width}'d0 x`];
  let previous;
  for (let i = 0; i < 5; i++) {
    const word = (i * 5 + 3) % 2 ** width;
    const expected = i ? width + "'d" + (previous ^ mask) : "x";
    rows.push(`${7 + i * 14}ns ${on} ${width}'d${word} ${expected}`);
    rows.push(`${14 + i * 14}ns ${off} ${width}'d${word} ${expected}`);
    previous = word;
  }
  const source = "All state updates occur on the " + (on ? "positive" : "negative") + " edge of tick.\n\n" + rows.join("\n");
  const rtl = depth => `module SampleUnit(input tick, input [${width - 1}:0] payload, output reg [${width - 1}:0] result);
    ${depth === 2 ? `reg [${width - 1}:0] prior_word;` : ""}
    always @(${edge} tick) begin
      ${depth === 2 ? "prior_word <= payload;" : ""}
      result <= ${depth === 1 ? "payload" : "prior_word"} ^ ${width}'d${mask};
    end
  endmodule`;
  return { source, spec, rtl };
}
function simulate(rtl, tb) {
  const dir = mkdtempSync(join(tmpdir(), "rtlforge-phase-"));
  try {
    writeFileSync(join(dir, "dut.sv"), rtl); writeFileSync(join(dir, "tb.sv"), tb);
    execFileSync("iverilog", ["-g2012", "-s", "SampleUnit_tb", "-o", "sim", "dut.sv", "tb.sv"], { cwd: dir, timeout: 10000, stdio: "pipe" });
    return execFileSync("vvp", ["sim"], { cwd: dir, timeout: 10000, encoding: "utf8" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("clocked trace timing audit", () => {
  it.each([[5, "posedge"], [9, "negedge"]])("retains both event-order interpretations at width %i, %s", (width, edge) => {
    const f = fixture(width, edge);
    const unresolved = buildSourceContract(f.source, f.spec, "SampleUnit");
    expect(unresolved.status).toBe("UNRESOLVED");
    const audit = unresolved.timingAudit[0];
    expect(audit.edge).toBe(edge);
    expect(audit.coincidentLines).toHaveLength(5);
    expect(audit.events[0]).toMatchObject({ inputsBefore: { payload: width + "'d0" }, inputsAtRow: { payload: width + "'d3" }, outputsAtRow: { result: "x" } });
    const before = buildSourceContract("Inputs are driven before the clock edge.\n" + f.source, f.spec, "SampleUnit");
    const after = buildSourceContract("Inputs are driven after the clock edge.\n" + f.source, f.spec, "SampleUnit");
    expect(before.status).toBe("READY"); expect(after.status).toBe("READY");
    expect(simulate(f.rtl(2), before.suites[0].code)).not.toContain("[FAIL]");
    expect(simulate(f.rtl(1), after.suites[0].code)).not.toContain("[FAIL]");
    expect(simulate(f.rtl(1), before.suites[0].code)).toContain("[FAIL]");
    expect(simulate(f.rtl(2), after.suites[0].code)).toContain("[FAIL]");
    // A conditional success must not resolve the original, unspecified phase.
    expect(mergeSourceEvidence({ cli: true, status: "PASS", tests: [] }, unresolved, [], f.rtl(1)).status).toBe("UNVERIFIED");
  });

  it("identifies the phase ambiguity even when initial unknown inputs prevent executable replay", () => {
    const f = fixture(5, "posedge");
    const contract = buildSourceContract(f.source.replace("0ns 0 5'd0 x", "0ns 0 x x"), f.spec, "SampleUnit");
    expect(contract.status).toBe("UNRESOLVED");
    expect(contract.timingAudit[0].status).toBe("UNRESOLVED");
    expect(contract.timingAudit[0].events[0].inputsBefore.payload).toBe("x");
    expect(contract.tables[0].raw).toContain("0ns 0 x x");
  });

  it("delivers the timing ledger to Elicit and Spec before a generated spec exists", async () => {
    const f = fixture(5, "posedge");
    const description = "Implement a module named SampleUnit with this\n"
      + "interface. All input and output ports are one bit unless otherwise specified.\n"
      + "- input tick\n- input payload (5 bits)\n- output result (5 bits)\n\n" + f.source;
    for (const stage of ["elicit", "spec"]) {
      const p = await applySkillsToPrompt({ userMessage: "original request" }, { _userDesc: description }, stage);
      expect(p.userMessage).toContain("CLOCKED TRACE OBSERVATIONS");
      expect(p.userMessage).toContain('"inputsBefore":{"payload":"5\'d0"}');
      expect(p.userMessage).toContain("provisional hypothesis");
      const again = await applySkillsToPrompt(p, { _userDesc: description }, stage);
      expect(again.userMessage).toBe(p.userMessage);
    }
  });

  it("does not infer a clock when the original source has no clock", () => {
    const spec = { iface: [{ name: "word", dir: "input", width: 1 }, { name: "valid", dir: "output", width: 1 }] };
    expect(buildSourceContract("word valid\n0 0\n1 1", spec, "M").timingAudit).toEqual([]);
  });

  it("does not mistake a data change at the inactive edge for a sampling ambiguity", () => {
    const f = fixture(5, "posedge");
    const source = "All state updates occur on the positive edge of tick.\n"
      + "time tick payload result\n0ns 0 5'd0 x\n7ns 1 5'd0 5'd29\n14ns 0 5'd7 5'd29\n21ns 1 5'd7 5'd26";
    const contract = buildSourceContract(source, f.spec, "SampleUnit");
    expect(contract.status).toBe("READY");
    expect(contract.timingAudit[0].coincidentLines).toEqual([]);
    expect(simulate(f.rtl(1), contract.suites[0].code)).not.toContain("[FAIL]");
    expect(simulate(f.rtl(2), contract.suites[0].code)).toContain("[FAIL]");
  });

  it("honors explicit input-before-clock timing without recommending a different phase", () => {
    const f = fixture(5, "posedge");
    const contract = buildSourceContract("Inputs are driven before the clock edge.\n" + f.source, f.spec, "SampleUnit");
    expect(contract.timingAudit[0]).toMatchObject({ convention: "inputs-before-clock", status: "OBSERVED" });
  });
});
