// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Waveform-grounded verify fixes (docs/improvement-roadmap.md #7) — pure core.

import { describe, it, expect } from "vitest";
import { parseVCD, parseVCDSignals, firstFailTime, signalWindow, injectDumpvars } from "../src/pipeline/vcdWindow.js";
import { promptRTLFromVerifyFail } from "../src/prompts/verify.js";

// A minimal Verilator-shaped VCD: clk toggling every 5, count changing, a fail region.
const VCD = [
  "$date today $end",
  "$timescale 1ns $end",
  "$scope module tb $end",
  "$var wire 1 ! clk $end",
  "$var wire 1 \" rst_n $end",
  "$scope module dut $end",
  "$var wire 8 # count [7:0] $end",
  "$upscope $end",
  "$upscope $end",
  "$enddefinitions $end",
  "#0", "0!", "0\"", "b00000000 #",
  "#5", "1!",
  "#10", "0!", "1\"",
  "#15", "1!", "b00000001 #",
  "#25", "1!", "b00000010 #",
  "#35", "1!", "b11111111 #",   // the suspicious jump
  "#45", "1!", "b00000000 #",
  "#50",
].join("\n");

describe("parseVCD / parseVCDSignals", () => {
  it("parses signals with scope paths and widths", () => {
    const sigs = parseVCDSignals(VCD);
    expect(sigs.map((s) => s.name)).toEqual(["clk", "rst_n", "count"]);
    expect(sigs.find((s) => s.name === "count")).toMatchObject({ id: "#", width: 8, path: "tb.dut" });
  });
  it("parses scalar and vector changes with times", () => {
    const { changes, endTime } = parseVCD(VCD);
    expect(endTime).toBe(50);
    expect(changes).toContainEqual([15, "#", "00000001"]);
    expect(changes).toContainEqual([5, "!", "1"]);
  });
});

describe("firstFailTime", () => {
  it("extracts the time from common failing-line dialects", () => {
    expect(firstFailTime("[FAIL] test_wrap at time 35 expected 3 got 255")).toBe(35);
    expect(firstFailTime("%Error: assertion failed @ 120")).toBe(120);
    expect(firstFailTime("[PASS] all good\nsome noise time 99")).toBe(null);   // only failing lines count
  });
});

describe("signalWindow", () => {
  it("renders a bounded table around the anchor, preferred signals first", () => {
    const w = signalWindow(VCD, { aroundTime: 35, preferSignals: ["count"] });
    expect(w).toMatch(/SIGNALS AROUND THE FIRST FAILURE \(time 35/);
    const header = w.split("\n")[1];
    expect(header.startsWith("time | count")).toBe(true);   // preferred column first
    expect(w).toMatch(/11111111/);                          // the failing value is visible
    expect(w.length).toBeLessThan(2600);
  });
  it("empty string on garbage input", () => {
    expect(signalWindow("", {})).toBe("");
    expect(signalWindow("not a vcd", {})).toBe("");
  });
  it("solver-internal anyseq_* nets are noise-filtered like smt_/anyinit_ (sby cex traces)", () => {
    const cex = [
      "$timescale 1ns $end",
      "$scope module dut $end",
      "$var wire 1 ! clk $end",
      "$var wire 1 \" anyseq_auto_setundef_cc_550 $end",
      "$var wire 1 # wr_en $end",
      "$upscope $end",
      "$enddefinitions $end",
      "#0", "0!", "0\"", "0#",
      "#5", "1!", "1\"", "1#",
      "#10",
    ].join("\n");
    const w = signalWindow(cex, { span: Infinity });
    expect(w).toContain("wr_en");
    expect(w).not.toContain("anyseq");
  });
});

describe("injectDumpvars", () => {
  it("injects before the last endmodule; no-op when a dump exists", () => {
    const tb = "module tb;\n  initial x = 1;\nendmodule\n";
    const out = injectDumpvars(tb);
    expect(out).toMatch(/\$dumpfile\("wave\.vcd"\)/);
    expect(out.indexOf("$dumpvars")).toBeLessThan(out.indexOf("endmodule"));
    expect(injectDumpvars(out)).toBe(out);                  // idempotent
    expect(injectDumpvars("no module here")).toBe("no module here");
  });
});

describe("fix prompts carry the wave excerpt", () => {
  const spec = { iface: { ports: [] }, params: {}, requirements: [] };
  const base = { pass: 0, fail: 1, total: 1, tests: [{ name: "t", st: "FAIL" }], log: "" };
  it("byte-identical without _waveExcerpt; section present with it", () => {
    const a = promptRTLFromVerifyFail("module m; endmodule", base, spec, { modName: "m" }, [], null).userMessage;
    const b = promptRTLFromVerifyFail("module m; endmodule",
      Object.assign({}, base, { _waveExcerpt: "SIGNALS AROUND THE FIRST FAILURE (time 35):\ntime | count\n35 | 11111111" }),
      spec, { modName: "m" }, [], null).userMessage;
    expect(b).not.toBe(a);
    expect(b).toMatch(/SIGNALS AROUND THE FIRST FAILURE/);
    expect(b).toMatch(/ground truth/);
    expect(a).not.toMatch(/SIGNALS AROUND/);
  });
});
