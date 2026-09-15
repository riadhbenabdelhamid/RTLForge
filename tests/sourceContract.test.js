// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildSourceContract, mergeSourceEvidence, unsupportedBehaviorCitations } from "../src/pipeline/sourceContract.js";
import { applySkillsToPrompt } from "../src/pipeline/applySkillsToPrompt.js";
import { checkerEvidenceInvalidOf } from "../src/pipeline/nodes/judge.js";
import { formalVerifyNode } from "../src/pipeline/nodes/formal_verify.js";

const iface = [{ name: "d", dir: "input", width: "3" }, { name: "q", dir: "output", width: "3" }];
const spec = { modName: "copy_word", iface, requirements: [] };
const source = "Copy d to q.\n\n| d | q |\n| --- | --- |\n| 3'b010 | 3'b010 |\n| 3'b101 | 3'b1?1 |\n| 3'b000 | x |\n";

function simulate(ctx, rtl, tb, top) {
  try { execFileSync("iverilog", ["-V"], { stdio: "ignore" }); }
  catch (e) { if (e.code === "ENOENT" || e.code === "EPERM") { ctx.skip("Icarus unavailable"); return ""; } throw e; }
  const dir = mkdtempSync(join(tmpdir(), "rtlforge-source-"));
  try {
    writeFileSync(join(dir, "dut.sv"), rtl);
    writeFileSync(join(dir, "tb.sv"), tb);
    execFileSync("iverilog", ["-g2012", "-s", top + "_tb", "-o", "sim", "dut.sv", "tb.sv"], { cwd: dir, timeout: 10000 });
    return execFileSync("vvp", ["sim"], { cwd: dir, timeout: 10000, encoding: "utf8" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function packetFixture(width, count, mutation = "") {
  const ports = [
    { name: "clk", dir: "input", width: "1" }, { name: "rst", dir: "input", width: "1" },
    { name: "take", dir: "input", width: "1" }, { name: "word", dir: "input", width: String(width) },
    { name: "done", dir: "output", width: "1" }, { name: "data", dir: "output", width: String(width * count) },
  ];
  const rows = ["time clk rst take word done data", `0ns 0 1 0 ${width}'d0 x x`, `5ns 1 1 0 ${width}'d0 0 x`];
  let expected = 0n;
  for (let i = 0; i < count * 3; i++) {
    const word = (i * 3 + 1) % (2 ** width);
    expected = (expected << BigInt(width) | BigInt(word)) & ((1n << BigInt(width * count)) - 1n);
    const previousDone = i && i % count === 0 ? 1 : 0;
    // Data changes between clock edges. Output rows at those intermediate
    // times deliberately carry don't-cares, including the data register.
    rows.push(`${10 + i * 10}ns 0 ${i ? 0 : 1} ${i ? 1 : 0} ${width}'d${i ? ( (i - 1) * 3 + 1) % (2 ** width) : 0} ${previousDone} x`);
    rows.push(`${12 + i * 10}ns 0 0 1 ${width}'d${word} x x`);
    const done = (i + 1) % count === 0;
    rows.push(`${15 + i * 10}ns 1 0 1 ${width}'d${word} ${done ? 1 : 0} ${done ? width * count + "'h" + expected.toString(16) : "x"}`);
  }
  const bits = width * count;
  const update = mutation === "order" ? `{word, accum[${bits - 1}:${width}]}` : `{accum[${bits - width - 1}:0], word}`;
  const rtl = `module packet(input clk, rst, take, input [${width - 1}:0] word, output reg done, output reg [${bits - 1}:0] data);
    integer n; reg [${bits - 1}:0] accum; reg pending;
    always @(posedge clk) begin
      if (rst) begin n <= 0; done <= 0; pending <= 0; accum <= 0; end
      else begin
        done <= ${mutation === "latency" ? "pending" : "0"}; pending <= 0;
        if (${mutation === "marker" ? "!take" : "take"}${mutation === "bubble" ? " && !done" : ""}) begin
          accum <= ${update};
          if (n == ${count - 1}) begin n <= 0; data <= ${update}; ${mutation === "latency" ? "pending" : "done"} <= 1; end
          else n <= n + 1;
        end
      end
    end
  endmodule`;
  return { rtl, spec: { modName: "packet", iface: ports, requirements: [] }, source: rows.join("\n") };
}

describe("source-derived acceptance contracts", () => {
  it("replays labelled values and masks don't-cares without constraining them to X", ctx => {
    const contract = buildSourceContract(source, spec, "copy_word");
    expect(contract.status).toBe("READY");
    expect(contract.tables[0].raw).toContain("3'b1?1");
    expect(contract.suites[0].ids).toHaveLength(2);
    const rtl = "module copy_word(input [2:0] d, output [2:0] q); assign q=d; endmodule";
    expect(simulate(ctx, rtl, contract.suites[0].code, "copy_word")).not.toContain("[FAIL]");
    expect(simulate(ctx, rtl.replace("q=d", "q=d ^ 3'b100"), contract.suites[0].code, "copy_word")).toContain("[FAIL]");
  });

  for (const [width, count] of [[3, 2], [5, 4]]) {
    it(`catches idle bubbles, latency shifts, order and acceptance faults at width ${width}, length ${count}`, ctx => {
      const good = packetFixture(width, count);
      const contract = buildSourceContract(good.source, good.spec, "packet");
      expect(contract.issues).toEqual([]);
      expect(simulate(ctx, good.rtl, contract.suites[0].code, "packet")).not.toContain("[FAIL]");
      for (const fault of ["bubble", "latency", "order", "marker"]) {
        const bad = packetFixture(width, count, fault);
        expect(simulate(ctx, bad.rtl, contract.suites[0].code, "packet"), fault).toContain("[FAIL]");
      }
    });
  }

  it("abstains on ambiguous literals, widths, missing inputs and simultaneous sampling", () => {
    expect(buildSourceContract(source.replace("3'b010", "10"), spec, "copy_word").issues[0].reason).toMatch(/literal/);
    expect(buildSourceContract(source, { ...spec, iface: [...iface, { name: "en", dir: "input", width: "1" }] }, "copy_word").issues[0].reason).toMatch(/omits/);
    expect(buildSourceContract(source, { ...spec, iface: iface.map(p => ({ ...p, width: "W" })) }, "copy_word").issues[0].reason).toMatch(/width/);
    const fixture = packetFixture(3, 2);
    const simultaneous = fixture.source.replace("12ns 0", "12ns 1");
    expect(buildSourceContract(simultaneous, fixture.spec, "packet").issues[0].reason).toMatch(/sampling phase/);
    expect(buildSourceContract("Inputs are driven before the clock edge.\n" + simultaneous, fixture.spec, "packet").status).toBe("READY");
  });

  it("extends a leading unknown in a sized output literal as don't-care", () => {
    const contract = buildSourceContract(source.replace("3'b1?1", "3'b?1"), spec, "copy_word");
    expect(contract.suites[0].code).toContain("(q & 3'h1) === 3'h1");
  });

  it("does not silently drop an incomplete source row", () => {
    const contract = buildSourceContract(source.replace("| 3'b000 | x |", "| 3'b000 |"), spec, "copy_word");
    expect(contract.status).toBe("UNRESOLVED");
    expect(contract.issues[0].reason).toMatch(/does not match/);
    expect(contract.tables[0].raw).toContain("| 3'b000 |");
  });

  it("keeps raw rows in downstream prompts regardless of rewritten spec metadata", async () => {
    const p = await applySkillsToPrompt({ userMessage: "Generate RTL" }, {
      _userDesc: source, spec: { ...spec, _sourceContract: { tables: [] } },
    }, "rtl_generate");
    expect(p.userMessage).toContain("3'b1?1");
    expect(p.userMessage).toContain("Runtime acceptance checks cannot be changed");
  });

  it("makes source failures mandatory and rejects incomplete, spoofed or stale evidence", () => {
    const contract = buildSourceContract(source, spec, "copy_word");
    const base = { cli: true, status: "PASS", tests: [{ name: "generated", st: "PASS" }] };
    const run = { cli: true, status: "FAIL", tests: contract.suites[0].ids.map(name => ({ name, st: "FAIL" })) };
    const merged = mergeSourceEvidence(base, contract, [run], "rtl");
    expect(merged.status).toBe("FAIL");
    expect(merged._sourceEvidence.status).toBe("FAIL");
    expect(mergeSourceEvidence(base, contract, [{ ...run, tests: run.tests.slice(1) }], "rtl").status).toBe("UNVERIFIED");
    expect(mergeSourceEvidence({ ...base, tests: run.tests }, contract, [run], "rtl").status).toBe("UNVERIFIED");
    const state = { _userDesc: source, spec, elicit: { modName: "copy_word" }, rtl_generate: { code: "rtl" }, verify: merged };
    expect(checkerEvidenceInvalidOf(state)).toBe(false);
    expect(checkerEvidenceInvalidOf({ ...state, rtl_generate: { code: "changed" } })).toBe(true);
    expect(checkerEvidenceInvalidOf({ ...state, _userDesc: source + "new instruction" })).toBe(true);
  });

  it("does not turn defective behavioral quotations into a formal repair oracle", async () => {
    const quote = "assign y = gate ? lhs : rhs;";
    const text = "module broken;\n" + quote + "\nendmodule\nUnfortunately, this module has a bug.\n";
    const req = { id: "REQ-FUNC-001", cat: "Functionality", src: quote };
    expect(unsupportedBehaviorCitations(text, { requirements: [req] })).toHaveLength(1);
    expect(unsupportedBehaviorCitations(text + "\nNormative equation: " + quote, { requirements: [req] })).toEqual([]);
    expect(unsupportedBehaviorCitations("Example:\n```sv\n" + quote + "\n```", { requirements: [req] })).toEqual([]);
    const result = await formalVerifyNode({ _userDesc: text, _config: {},
      spec: { requirements: [req] }, elicit: { modName: "broken" }, rtl_generate: { code: "module broken; endmodule" },
      formal_props: { properties: [{ id: "SVA-A", req: req.id }] },
    });
    expect(result.formal_verify.status).toBe("SKIPPED");
    expect(result.formal_verify.assertionIds).toEqual([]);
    expect(result.formal_verify.formalSkipReasons[0].id).toBe("SVA-A");
  });
});
