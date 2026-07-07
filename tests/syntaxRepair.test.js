// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Deterministic syntax repair (docs/syntax-repair.md, T3). Samples mirror the
// REAL mistakes harvested from lfm2-24b-a2b / gpt-oss-120b / nemotron.

import { describe, it, expect } from "vitest";
import { repairSV, maybeRepair } from "../src/pipeline/syntaxRepair.js";

describe("backtick directives", () => {
  it("prefixes bare directives, anchored per-directive", () => {
    expect(repairSV("timescale 1ns/1ps").code).toBe("`timescale 1ns/1ps");
    expect(repairSV('include "dut.svh"').code).toBe('`include "dut.svh"');
    expect(repairSV("define WIDTH 8").code).toBe("`define WIDTH 8");
    expect(repairSV("ifdef SIM\nendif").code).toBe("`ifdef SIM\n`endif");
    expect(repairSV("default_nettype none").code).toBe("`default_nettype none");
  });
  it("leaves already-backticked directives and look-alike identifiers alone", () => {
    expect(repairSV("`timescale 1ns/1ps").total).toBe(0);
    expect(repairSV("logic timescale_sel;").total).toBe(0);   // identifier prefix
    expect(repairSV("x = include_mask;").total).toBe(0);
  });
});

describe("packed range lower bound", () => {
  it("adds :0 to a colon-less packed range after a type or direction keyword", () => {
    expect(repairSV("logic [BIT_WIDTH-1] sum;").code).toBe("logic [BIT_WIDTH-1:0] sum;");
    expect(repairSV("input [W-1] a,").code).toBe("input [W-1:0] a,");
    expect(repairSV("reg [DATA_W-1] q;").code).toBe("reg [DATA_W-1:0] q;");
  });
  it("never touches full ranges, unpacked dims, or array indexing", () => {
    expect(repairSV("logic [7:0] mem [8];").total).toBe(0);   // unpacked [8] is legal
    expect(repairSV("y = mem[addr];").total).toBe(0);          // indexing
    expect(repairSV("logic [W-1:0] x;").total).toBe(0);        // already complete
  });
});

describe("sized-literal base", () => {
  it("rewrites a plainly-decimal 'b literal to 'd, preserving the typed value", () => {
    expect(repairSV("localparam MAX = 32'b25;").code).toBe("localparam MAX = 32'd25;");
    expect(repairSV("x = 4'b9;").code).toBe("x = 4'd9;");
  });
  it("leaves valid binary, hex, and ambiguous too-wide binary alone", () => {
    expect(repairSV("x = 8'b1010;").total).toBe(0);
    expect(repairSV("x = 16'hBEEF;").total).toBe(0);
    expect(repairSV("x = 2'b10000000;").total).toBe(0);   // ambiguous (width vs value) — fix loop's job
  });
});

describe("VHDL-style colon ports/params", () => {
  it("reorders 'name : type' into SystemVerilog declarations", () => {
    expect(repairSV("input rst_n : logic,").code).toBe("input logic rst_n,");
    expect(repairSV("output data : logic [7:0],").code).toBe("output logic [7:0] data,");
    expect(repairSV("parameter DATA_W : int = 8,").code).toBe("parameter int DATA_W = 8,");
  });
  it("leaves correct SV ports alone", () => {
    expect(repairSV("input logic [W-1:0] a,").total).toBe(0);
    expect(repairSV("parameter int DATA_W = 8,").total).toBe(0);
  });
});

describe("mid-block declaration hoisting", () => {
  it("hoists a decl-after-statement to block top, splitting the initializer (the gpt-oss-120b TB failure)", () => {
    const src = [
      "module tb;",
      "  initial begin",
      "    clk = 0;",
      "    logic prev = clk;",
      "    check(prev);",
      "  end",
      "endmodule",
    ].join("\n");
    const r = repairSV(src);
    const lines = r.code.split("\n");
    expect(lines[2].trim()).toBe("logic prev;");          // hoisted below begin
    expect(lines[3].trim()).toBe("clk = 0;");
    expect(lines[4].trim()).toBe("prev = clk;");          // initializer stays in place
    expect(r.fixes).toEqual([{ rule: "midblock-decl-hoist", count: 1 }]);
  });
  it("leaves decls at block top and generate-block decls untouched", () => {
    const top = "initial begin\n  logic a;\n  a = 1;\nend";
    expect(repairSV(top).total).toBe(0);
    const gen = "generate begin : g\n  assign y = x;\n  logic t = y;\nend endgenerate";
    expect(repairSV(gen).total).toBe(0);                   // legal there; splitting init would be wrong
  });
  it("hoists inside nested procedural blocks (if/for under always)", () => {
    const src = [
      "always_ff @(posedge clk) begin",
      "  if (en) begin",
      "    q <= d;",
      "    logic tmp = q;",
      "    r <= tmp;",
      "  end",
      "end",
    ].join("\n");
    const r = repairSV(src);
    const lines = r.code.split("\n");
    expect(lines[2].trim()).toBe("logic tmp;");
    expect(lines[4].trim()).toBe("tmp = q;");
    expect(r.total).toBe(1);
  });
});

describe("string/comment protection + frame-stack fixes (review findings)", () => {
  it("one-line `if (x) begin y=1; end` is depth-neutral — later decls hoist to the BLOCK top", () => {
    const src = [
      "module tb;",
      "  initial begin",
      "    x = 1;",
      "    if (a) begin y = 1; end",
      "    z = 2;",
      "    logic t = q;",
      "    use(t);",
      "  end",
      "endmodule",
    ].join("\n");
    const lines = repairSV(src).code.split("\n");
    expect(lines[2].trim()).toBe("logic t;");           // right below `initial begin`
    expect(lines[3].trim()).toBe("x = 1;");
    expect(lines[6].trim()).toBe("t = q;");
  });

  it("'end' inside a $display string no longer pops the frame — the hoist happens", () => {
    const src = [
      "module tb;",
      "  initial begin",
      '    $display("test end of phase");',
      "    logic t = q;",
      "    use(t);",
      "  end",
      "endmodule",
    ].join("\n");
    const r = repairSV(src);
    expect(r.fixes).toEqual([{ rule: "midblock-decl-hoist", count: 1 }]);
    expect(r.code.split("\n")[2].trim()).toBe("logic t;");
  });

  it("transforms never rewrite string-literal or comment contents", () => {
    const src = 'initial begin\n  a = 1;\n  $display("val=32\'b25 logic [W-1] input x : logic");\n  // note: timescale 1ns/1ps and logic [W-1] here\nend';
    const r = repairSV(src);
    expect(r.code).toBe(src);                            // byte-identical
    expect(r.total).toBe(0);
  });

  it("'begin' inside a block comment does not open a phantom frame", () => {
    const src = [
      "always_comb begin",
      "  /* legacy begin block",
      "     spanning lines end */",
      "  y = 0;",
      "  logic t = y;",
      "  z = t;",
      "end",
    ].join("\n");
    const lines = repairSV(src).code.split("\n");
    expect(lines[1].trim()).toBe("logic t;");            // hoisted below the real begin
  });

  it("escaped quotes inside strings are handled", () => {
    const src = 'initial begin\n  x = 1;\n  $display("say \\"end\\" now");\n  logic t = x;\n  use(t);\nend';
    const r = repairSV(src);
    expect(r.total).toBe(1);
    expect(r.code.split("\n")[1].trim()).toBe("logic t;");
  });

  it("a decl after a multi-line nested block is recognized as mid-block and hoisted", () => {
    const src = [
      "initial begin",
      "  if (a) begin",
      "    y = 1;",
      "  end",
      "  logic t = y;",   // after a statement (the if-block) — illegal, must hoist
      "  use(t);",
      "end",
    ].join("\n");
    const r = repairSV(src);
    expect(r.total).toBe(1);
    expect(r.code.split("\n")[1].trim()).toBe("logic t;");
  });

  it("maybeRepair passes non-string code through untouched on BOTH paths", () => {
    const obj = { nested: "module m; endmodule" };
    expect(maybeRepair({ syntaxRepair: true }, obj).code).toBe(obj);
    expect(maybeRepair({}, obj).code).toBe(obj);
  });
});

describe("repairSV composition", () => {
  it("is idempotent — repairing repaired code changes nothing", () => {
    const messy = [
      "timescale 1ns/1ps",
      "module m #(parameter W : int = 8) (",
      "  input rst_n : logic,",
      "  output [W-1] q",
      ");",
      "  localparam INIT = 32'b25;",
      "  initial begin",
      "    q = 0;",
      "    logic t = q;",
      "    use(t);",
      "  end",
      "endmodule",
    ].join("\n");
    const once = repairSV(messy);
    expect(once.total).toBeGreaterThanOrEqual(5);          // every class fired
    expect(repairSV(once.code).total).toBe(0);             // fixpoint
  });
  it("clean code is untouched byte-for-byte", () => {
    const clean = [
      "`timescale 1ns/1ps",
      "module m #(parameter int W = 8) (",
      "  input  logic clk,",
      "  input  logic [W-1:0] d,",
      "  output logic [W-1:0] q",
      ");",
      "  always_ff @(posedge clk) q <= d;",
      "endmodule",
    ].join("\n");
    const r = repairSV(clean);
    expect(r.code).toBe(clean);
    expect(r.total).toBe(0);
  });
});

describe("maybeRepair gate (opt-in)", () => {
  const broken = "logic [W-1] x;";
  it("off (default) → input returned byte-identical, fixes null", () => {
    expect(maybeRepair({}, broken)).toEqual({ code: broken, fixes: null, total: 0 });
    expect(maybeRepair(null, broken).code).toBe(broken);
    expect(maybeRepair({ syntaxRepair: false }, broken).code).toBe(broken);
  });
  it("on → repaired, fixes reported", () => {
    const r = maybeRepair({ syntaxRepair: true }, broken);
    expect(r.code).toBe("logic [W-1:0] x;");
    expect(r.fixes).toEqual([{ rule: "packed-range-bound", count: 1 }]);
  });
});

// ─── procedural-wire-to-var (measured: nemotron's counter, PROCASSWIRE) ─────
describe("fixProceduralWire — procedurally-assigned wires become logic", () => {
  it("repairs the exact measured case: output port driven from always_ff", () => {
    const rtl = [
      "module counter_4bit (input  clk,",
      "                   input  rst_n,",
      "                   input  en,",
      "                   output [3:0] q);",
      "  always_ff @(posedge clk or negedge rst_n) begin",
      "    if (!rst_n)",
      "      q <= 4'd0;",
      "    else if (en)",
      "      q <= q + 1'b1;",
      "  end",
      "endmodule",
    ].join("\n");
    const r = repairSV(rtl);
    expect(r.fixes.some((f) => f.rule === "procedural-wire-to-var")).toBe(true);
    expect(r.code).toContain("output logic [3:0] q");
    expect(repairSV(r.code).total).toBe(0);   // idempotent
  });

  it("rewrites `output wire` and standalone `wire` decls when driven procedurally", () => {
    const rtl = [
      "module m(input clk, output wire [7:0] d);",
      "  wire [7:0] state;",
      "  always @(posedge clk) begin",
      "    state = state + 1;",
      "    d <= state;",
      "  end",
      "endmodule",
    ].join("\n");
    const r = repairSV(rtl);
    expect(r.code).toContain("output logic [7:0] d");
    expect(r.code).toContain("logic [7:0] state");
  });

  it("a comparison `a <= b` inside an assign expression marks NOTHING", () => {
    const rtl = [
      "module m(input [3:0] a, input [3:0] b, output wire y, output wire [3:0] w);",
      "  assign y = (a <= b);",
      "  assign w = a;",
      "endmodule",
    ].join("\n");
    const r = repairSV(rtl);
    expect(r.code).toBe(rtl);                 // continuous-only nets untouched
  });

  it("inout ports are never rewritten (tristates must stay nets)", () => {
    const rtl = [
      "module m(input clk, input oe, inout wire [3:0] bus);",
      "  logic [3:0] v;",
      "  always @(posedge clk) v <= v + 1;",
      "  assign bus = oe ? v : 4'bz;",
      "endmodule",
    ].join("\n");
    const r = repairSV(rtl);
    expect(r.code).toContain("inout wire [3:0] bus");
  });

  it("already-typed declarations pass through (output logic / output reg)", () => {
    const rtl = [
      "module m(input clk, output logic [3:0] p, output reg [3:0] r);",
      "  always @(posedge clk) begin p <= p + 1; r <= r + 1; end",
      "endmodule",
    ].join("\n");
    expect(repairSV(rtl).code).toBe(rtl);
  });

  it("single-statement always without begin/end still detects the assignment", () => {
    const rtl = [
      "module m(input clk, output [3:0] q);",
      "  always @(posedge clk)",
      "    q <= q + 1;",
      "endmodule",
    ].join("\n");
    expect(repairSV(rtl).code).toContain("output logic [3:0] q");
  });
});
