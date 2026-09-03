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

// ─── missing-endtask (measured: nemotron TB — 34 task decls, 5 endtasks) ────
describe("fixMissingEndtask — dropped endtask before the next module-scope construct", () => {
  it("closes an open, balanced task before the next task declaration", () => {
    const tb = [
      "module tb;",
      "  task automatic t1();",
      "    begin",
      "      check(1, \"A.1\");",
      "    end",
      "",                                 // endtask dropped here
      "  task automatic t2();",
      "    begin check(1, \"B.1\"); end",
      "  endtask",
      "endmodule",
    ].join("\n");
    const r = repairSV(tb);
    expect(r.fixes.some((f) => f.rule === "missing-endtask")).toBe(true);
    const lines = r.code.split("\n").map((l) => l.trim());
    expect(lines.indexOf("endtask")).toBeGreaterThan(lines.indexOf("end"));
    expect(lines.indexOf("endtask")).toBeLessThan(lines.indexOf("task automatic t2();"));
    expect(repairSV(r.code).total).toBe(0);   // idempotent
  });

  it("closes before initial/always/endmodule too (the last task in the file)", () => {
    const tb = [
      "module tb;",
      "  task automatic t1();",
      "    begin check(1, \"A.1\"); end",
      "",                                 // endtask dropped; next is initial
      "  initial begin",
      "    t1();",
      "  end",
      "endmodule",
    ].join("\n");
    const r = repairSV(tb);
    const lines = r.code.split("\n").map((l) => l.trim());
    expect(lines.indexOf("endtask")).toBeLessThan(lines.indexOf("initial begin"));
  });

  it("does NOT insert when the open task's begin/end is unbalanced (different defect)", () => {
    const tb = [
      "module tb;",
      "  task automatic t1();",
      "    begin",
      "      check(1, \"A.1\");",         // end missing — not our repair
      "  task automatic t2();",
      "  endtask",
      "endmodule",
    ].join("\n");
    expect(repairSV(tb).fixes.some((f) => f.rule === "missing-endtask")).toBe(false);
  });

  it("well-formed tasks pass through byte-identical", () => {
    const tb = [
      "module tb;",
      "  task automatic t1();",
      "    begin check(1, \"A.1\"); end",
      "  endtask",
      "  initial t1();",
      "endmodule",
    ].join("\n");
    expect(repairSV(tb).code).toBe(tb);
  });
});

// ─── hyphenated-task-name (measured: `task automatic test_REQ-FUNC-001();`) ─
describe("fixHyphenatedTaskNames — requirement ids pasted as identifiers", () => {
  it("repairs hyphenated declarations AND their bare call statements", () => {
    const tb = [
      "module tb;",
      "  task automatic test_REQ-FUNC-001();",
      "    begin check(1, \"REQ-FUNC-001.1\"); end",   // string label untouched
      "  endtask",
      "  initial begin",
      "    test_REQ-FUNC-001();",
      "  end",
      "endmodule",
    ].join("\n");
    const r = repairSV(tb);
    expect(r.code).toContain("task automatic test_REQ_FUNC_001();");
    expect(r.code).toContain("    test_REQ_FUNC_001();");
    expect(r.code).toContain('check(1, "REQ-FUNC-001.1");');   // marker label preserved
    expect(repairSV(r.code).total).toBe(0);
  });

  it("genuine subtraction in expressions is never touched", () => {
    const tb = [
      "module tb;",
      "  int test_a, b;",
      "  initial begin",
      "    b = test_a-b;",                 // expression, not a call statement
      "    if (test_a-b > 0) b = 1;",
      "  end",
      "endmodule",
    ].join("\n");
    expect(repairSV(tb).code).toBe(tb);
  });
});

// ─── sampling-race-settle (user policy: insert #1, checks only, always) ─────
describe("fixParenReplication — replication missing its outer braces", () => {
  it("rewrites the measured form: q <= (DATA_W){1'b0};", () => {
    const rtl = "module c;\n  always_ff @(posedge clk) q <= (DATA_W){1'b0};\nendmodule";
    const r = repairSV(rtl);
    expect(r.fixes.some((f) => f.rule === "paren-replication")).toBe(true);
    expect(r.code).toContain("q <= {DATA_W{1'b0}};");
    expect(repairSV(r.code).total).toBe(0);   // idempotent
  });

  it("blocking assignment form and expression counts work too", () => {
    const r = repairSV("module c;\n  initial x = (N+1){2'b01};\nendmodule");
    expect(r.code).toContain("x = {N+1{2'b01}};");
  });

  it("legal code is untouched: proper replication, conditionals, comparisons, casts", () => {
    const rtl = [
      "module c;",
      "  assign a = {W{1'b1}};",
      "  assign b = (sel) ? {c} : {d};",
      "  assign e = (x == y);",
      "  initial f = int'(g);",
      "endmodule",
    ].join("\n");
    expect(repairSV(rtl).code).toBe(rtl);
  });
});

describe("fixSamplingRace — checks sampling at the posedge get a settle", () => {
  it("inserts #1 between an edge wait and the check on the NEXT line", () => {
    const tb = [
      "module tb;",
      "  initial begin",
      "    @(posedge clk);",
      "    check(count == ref_count, \"REQ-X.1\");",
      "  end",
      "endmodule",
    ].join("\n");
    const r = repairSV(tb);
    expect(r.fixes.some((f) => f.rule === "sampling-race-settle")).toBe(true);
    const lines = r.code.split("\n").map((l) => l.trim());
    expect(lines[lines.indexOf("@(posedge clk);") + 1]).toBe("#1;");
    expect(repairSV(r.code).total).toBe(0);   // idempotent
  });

  it("repairs the one-liner form too", () => {
    const tb = "module tb;\n  initial begin\n    @(posedge clk); check(q == r, \"A.1\");\n  end\nendmodule";
    const r = repairSV(tb);
    expect(r.code).toContain("@(posedge clk); #1; check(q == r");
  });

  it("already-settled and negedge-sampled code passes through byte-identical", () => {
    const tb = [
      "module tb;",
      "  initial begin",
      "    @(posedge clk);",
      "    #1;",
      "    check(a == b, \"A.1\");",
      "    @(negedge clk);",
      "    check(a == b, \"A.2\");",
      "  end",
      "endmodule",
    ].join("\n");
    expect(repairSV(tb).code).toBe(tb);
  });

  it("drive-side statements after the edge are NEVER rewritten (checks only)", () => {
    const tb = [
      "module tb;",
      "  initial begin",
      "    @(posedge clk);",
      "    en = 1'b1;",
      "    data = 8'hA5;",
      "  end",
      "endmodule",
    ].join("\n");
    expect(repairSV(tb).code).toBe(tb);
  });
});

describe("fixParamHeader — instance-override syntax in a module header", () => {
  it("rewrites the measured nemotron form: module … #( .DATA_W(4) )", () => {
    const rtl = [
      "module up_counter #(",
      "    .DATA_W(4)      // Default width per REQ-FUNC-001",
      ") (",
      "    input  logic clk,",
      "    output logic [DATA_W-1:0] q",
      ");",
      "endmodule",
    ].join("\n");
    const r = repairSV(rtl);
    expect(r.fixes.some((f) => f.rule === "ansi-param-header")).toBe(true);
    expect(r.code).toContain("parameter DATA_W = 4");
    expect(r.code).not.toContain(".DATA_W(4)");
    expect(repairSV(r.code).total).toBe(0);   // idempotent
  });

  it("rewrites every entry of a multi-parameter header", () => {
    const rtl = "module fifo #( .DEPTH(16), .W(8) ) (input logic clk);\nendmodule";
    const r = repairSV(rtl);
    expect(r.code).toContain("parameter DEPTH = 16");
    expect(r.code).toContain("parameter W = 8");
  });

  it("module INSTANTIATIONS with .NAME(value) overrides are untouched", () => {
    const rtl = [
      "module top;",
      "  up_counter #(",
      "    .DATA_W(4)",
      "  ) dut (.clk(clk), .q(q));",
      "endmodule",
    ].join("\n");
    expect(repairSV(rtl).code).toBe(rtl);
  });

  it("a legal parameter header and a .N(v) quoted in a comment are untouched", () => {
    const rtl = [
      "// instantiate with .DATA_W(8) to widen",
      "module c #(parameter int DATA_W = 4) (input logic clk);",
      "endmodule",
    ].join("\n");
    expect(repairSV(rtl).code).toBe(rtl);
  });
});

describe("fixFenceBackticks — markdown fence leakage from the reasoning channel", () => {
  it("strips the measured forms: `//-comment backtick and a lone ` after endmodule", () => {
    const rtl = [
      "module c(input logic clk);",
      "`// Synthesisable subset compliance:",
      "// - single driver per signal",
      "endmodule // c",
      "`",
    ].join("\n");
    const r = repairSV(rtl);
    expect(r.fixes.some((f) => f.rule === "fence-backtick-strip")).toBe(true);
    expect(r.code).toContain("\n// Synthesisable subset compliance:");
    expect(r.code).not.toMatch(/^\s*`\s*$/m);
    expect(repairSV(r.code).total).toBe(0);   // idempotent
  });

  it("removes ``` fence lines with or without a language tag", () => {
    const rtl = "```systemverilog\nmodule c(input logic clk);\nendmodule\n```";
    const r = repairSV(rtl);
    expect(r.code).not.toContain("```");
    expect(r.code).toContain("module c(input logic clk);");
  });

  it("real directives and macro uses are untouched", () => {
    const rtl = [
      "`timescale 1ns/1ps",
      "`define W 4",
      "`ifdef W",
      "module c(input logic clk);",
      "endmodule",
      "`endif",
    ].join("\n");
    expect(repairSV(rtl).code).toBe(rtl);
  });

  it("HTML markup lines and endmodule-glued garbage are stripped (measured: run 9 tail)", () => {
    const tb = [
      "module tb;",
      "  initial $finish;",
      "endmodule;",
      "`",
      "</textarea>",
      "</body>",
      "</html>",
    ].join("\n");
    const r = repairSV(tb);
    expect(r.code).toContain("endmodule");
    expect(r.code).not.toContain("endmodule;");
    expect(r.code).not.toContain("</");
    expect(repairSV(r.code).total).toBe(0);   // idempotent
  });

  it("endmodule`; single-line form is cleaned; comparisons a<b never match the tag strip", () => {
    const tb = "module tb;\n  initial if (a<b && c>d) $finish;\nendmodule`;";
    const r = repairSV(tb);
    expect(r.code.trimEnd().endsWith("endmodule")).toBe(true);
    expect(r.code).toContain("if (a<b && c>d)");
  });
});

describe("C-leakage transforms (measured, nemotron run 5)", () => {
  it("c-include-strip removes a C #include line; `include is untouched", () => {
    const tb = [
      "#include \"verilator_top.h\"",
      "`include \"common.svh\"",
      "module tb;",
      "endmodule",
    ].join("\n") + "\n";
    const r = repairSV(tb);
    expect(r.fixes.some((f) => f.rule === "c-include-strip")).toBe(true);
    expect(r.code).not.toContain("#include");
    expect(r.code).toContain("`include \"common.svh\"");
    expect(repairSV(r.code).total).toBe(0);   // idempotent
  });

  it("cpp-static-assert becomes an initial $fatal guard (measured, run 25: 2 lines defeated ~90 min of fix loops)", () => {
    const rtl = [
      "module sync_fifo #(parameter int DEPTH = 16) (input logic clk);",
      "  static_assert(DEPTH >= 2 && (DEPTH & (DEPTH - 1)) == 0, \"DEPTH must be a power of two\");",
      "  static_assert(DEPTH <= 1024);",
      "endmodule",
    ].join("\n") + "\n";
    const r = repairSV(rtl);
    expect(r.fixes.some((f) => f.rule === "cpp-static-assert")).toBe(true);
    expect(r.code).not.toContain("static_assert");
    // Message form: expr and message both preserved.
    expect(r.code).toContain("initial if (!(DEPTH >= 2 && (DEPTH & (DEPTH - 1)) == 0)) $fatal(1, \"DEPTH must be a power of two\");");
    // Message-less form: generic message.
    expect(r.code).toContain("initial if (!(DEPTH <= 1024)) $fatal(1, \"parameter check failed\");");
    expect(repairSV(r.code).total).toBe(0);   // idempotent
  });

  it("cpp-static-assert leaves quoted mentions and multi-line forms alone", () => {
    const tb = [
      "module tb;",
      "  initial $display(\"static_assert(x, y); is not SV\");",
      "  static_assert(A,",
      "    \"split across lines\");",
      "endmodule",
    ].join("\n") + "\n";
    const r = repairSV(tb);
    expect(r.code).toContain("$display(\"static_assert(x, y); is not SV\")");
    expect(r.code).toContain("static_assert(A,");   // multi-line: left for the fix loop
  });

  // SystemVerilog has no `0x` prefix: `0x11` parses as the number 0 followed
  // by an identifier `x11`. Measured (run 49, laguna-s-2.1): five of them in
  // the sync_fifo testbench, which therefore never compiled — verify 0/1 —
  // and the fix loop could not converge on them across many iterations.
  // Recovered from the recorded call, the real 465-line testbench went from
  // 5 syntax errors to 0 under this transform.
  it("c-hex-literal rewrites the measured 0x form to an unsized 'h literal", () => {
    const tb = [
      "module tb;",
      "  initial begin",
      "    wr_beat = DATA_W'(0x11);",
      "    wdata   = DATA_W'(0xFF);",
      "  end",
      "endmodule",
    ].join("\n") + "\n";
    const r = repairSV(tb);
    expect(r.code).toContain("DATA_W'('h11)");
    expect(r.code).toContain("DATA_W'('hFF)");
    expect(r.fixes.find((f) => f.rule === "c-hex-literal").count).toBe(2);
  });

  it("c-hex-literal invents no width and leaves correct literals alone", () => {
    const tb = "module tb;\n  initial y = 8'hAB;\nendmodule\n";
    expect(repairSV(tb).code).toContain("8'hAB");
  });

  it("c-hex-literal does not touch a don't-care bit inside a based literal", () => {
    // the `0x` in 4'b0x1z is preceded by a word character and must not match
    const tb = "module tb;\n  initial x = 4'b0x1z;\nendmodule\n";
    expect(repairSV(tb).code).toContain("4'b0x1z");
  });

  it("c-hex-literal leaves strings and comments alone", () => {
    const tb = [
      "module tb;",
      "  // a comment mentioning 0xAB",
      "  initial $display(\"0xDEAD\");",
      "endmodule",
    ].join("\n") + "\n";
    const r = repairSV(tb);
    expect(r.code).toContain("// a comment mentioning 0xAB");
    expect(r.code).toContain("$display(\"0xDEAD\")");
  });

  it("char-literal-unsized rewrites the measured '0' form; strings protected", () => {
    const tb = [
      "module tb;",
      "  initial begin",
      "    check(q == '0', \"REQ-FUNC-004.2\");",
      "    check(r == '1', \"REQ-FUNC-004.3\");",
      "    $display(\"expected '0' here\");",
      "  end",
      "endmodule",
    ].join("\n") + "\n";
    const r = repairSV(tb);
    expect(r.code).toContain("check(q == '0, \"REQ-FUNC-004.2\");");
    expect(r.code).toContain("check(r == '1, \"REQ-FUNC-004.3\");");
    expect(r.code).toContain("$display(\"expected '0' here\");");   // string untouched
    expect(repairSV(r.code).total).toBe(0);   // idempotent — correct '0 never rematches
  });

  it("decl after statements in a BARE-BODY task is hoisted (measured: run 8 'int expected = 1')", () => {
    const tb = [
      "module tb;",
      "  task automatic test_req_func_001();",
      "    en = 1'b1;",
      "    @(posedge clk);",
      "    int expected = 1;",
      "    check(count == expected, \"REQ-FUNC-001\");",
      "  endtask",
      "endmodule",
    ].join("\n");
    const r = repairSV(tb);
    expect(r.fixes.some((f) => f.rule === "midblock-decl-hoist")).toBe(true);
    const lines = r.code.split("\n").map((l) => l.trim());
    expect(lines.indexOf("int expected;")).toBe(lines.indexOf("task automatic test_req_func_001();") + 1);
    expect(r.code).toContain("expected = 1;");
    expect(repairSV(r.code).total).toBe(0);   // idempotent
  });

  it("one-line task…endtask and decl-at-top task bodies are untouched", () => {
    const tb = [
      "module tb;",
      "  task automatic step(input int n = 1); repeat (n) begin @(posedge clk); #1; end endtask",
      "  task automatic t2();",
      "    int a = 0;",
      "    a++;",
      "  endtask",
      "  task automatic t3();",
      "    begin",
      "      int b = 1;",
      "      b++;",
      "    end",
      "  endtask",
      "endmodule",
    ].join("\n");
    expect(repairSV(tb).code).toBe(tb);
  });

  it("string decl mid-block is hoisted like any variable (measured: watchdog $sformatf msg)", () => {
    const tb = [
      "module tb;",
      "  initial begin",
      "    #(TIMEOUT_NS);",
      "    string msg = $sformatf(\"[FAIL] watchdog: exceeded %0d ns\", TIMEOUT_NS);",
      "    check(1'b0, msg);",
      "  end",
      "endmodule",
    ].join("\n");
    const r = repairSV(tb);
    expect(r.fixes.some((f) => f.rule === "midblock-decl-hoist")).toBe(true);
    const lines = r.code.split("\n").map((l) => l.trim());
    expect(lines.indexOf("string msg;")).toBeLessThan(lines.indexOf("#(TIMEOUT_NS);"));
    expect(r.code).toContain("msg = $sformatf(");
    expect(repairSV(r.code).total).toBe(0);   // idempotent
  });

  it("markdown heading wrapping a directive is stripped; real delays untouched", () => {
    const tb = [
      "# `timescale 1ns/1ps",
      "module tb;",
      "  initial begin",
      "    #10;",
      "    #(CLK_PERIOD_NS/2) clk = ~clk;",
      "  end",
      "endmodule",
    ].join("\n");
    const r = repairSV(tb);
    expect(r.code.split("\n")[0]).toBe("`timescale 1ns/1ps");
    expect(r.code).toContain("    #10;");
    expect(r.code).toContain("#(CLK_PERIOD_NS/2) clk = ~clk;");
    expect(repairSV(r.code).total).toBe(0);   // idempotent
  });

  it("hallucinated-pli maps $describe to $display; real tasks untouched", () => {
    const tb = "module tb;\n  initial begin\n    $describe(\"hi\");\n    $display(\"ok\");\n  end\nendmodule\n";
    const r = repairSV(tb);
    expect(r.code).toContain("$display(\"hi\");");
    expect(r.code).not.toContain("$describe");
  });

});

describe("fixVerilatorMetacomment — prose comments parsed as pragmas (measured, run 10)", () => {
  it("neutralizes a line comment whose first word is Verilator (the run-10 form)", () => {
    const src = [
      "module m(input logic clk);",
      "// Verilator evaluates them during simulation (compile with --assert).",
      "endmodule",
    ].join("\n");
    const r = repairSV(src);
    expect(r.code).toContain("// NOTE: Verilator evaluates them during simulation");
    expect(r.fixes.some(f => f.rule === "verilator-metacomment")).toBe(true);
    expect(repairSV(r.code).total).toBe(0);   // idempotent
  });

  it("neutralizes the block-comment form", () => {
    const src = "module m;\n/*verilator checks these at runtime*/\nendmodule\n";
    const r = repairSV(src);
    expect(r.code).toContain("/*NOTE: verilator checks these at runtime*/");
  });

  it("leaves real metacomment pragmas byte-identical", () => {
    const src = [
      "module m(input logic clk);",
      "/* verilator lint_off UNUSEDSIGNAL */",
      "logic unused_ok;",
      "/* verilator lint_on UNUSEDSIGNAL */",
      "// verilator tracing_off",
      "endmodule",
    ].join("\n");
    const r = repairSV(src);
    expect(r.code).toBe(src);
  });

  it("ignores the word verilator mid-comment and inside strings", () => {
    const src = [
      "module m;",
      "// compile with verilator --binary",
      "initial $display(\"verilator run\");",
      "endmodule",
    ].join("\n");
    const r = repairSV(src);
    expect(r.code).toBe(src);
  });
});

describe("run-15 families (qwen9b): backtick-param, stray tick, duplicate decl", () => {
  it("strips the backtick from a macro-style reference to a declared parameter", () => {
    const src = [
      "module m;",
      "  parameter ADDR_W = 8;",
      "  logic [7:0] data_mem[`ADDR_W'];  // the run-15 artifact form",
      "endmodule",
    ].join("\n");
    const r = repairSV(src);
    expect(r.code).toContain("data_mem[ADDR_W]");
    expect(r.fixes.some(f => f.rule === "backtick-param-ref")).toBe(true);
    expect(r.fixes.some(f => f.rule === "stray-tick-bracket")).toBe(true);
    expect(repairSV(r.code).total).toBe(0);   // idempotent
  });

  it("leaves real macros and directives untouched", () => {
    const src = [
      "`define WIDTH 8",
      "module m;",
      "  parameter DEPTH = 4;",
      "  logic [`WIDTH-1:0] a;",       // real macro — not a param
      "  `ifdef SIM",
      "  logic dbg;",
      "  `endif",
      "endmodule",
    ].join("\n");
    expect(repairSV(src).code).toBe(src);
  });

  it("keeps a backticked name that is BOTH a param and a define (ambiguous → untouched)", () => {
    const src = [
      "`define ADDR_W 4",
      "module m;",
      "  parameter ADDR_W = 8;",
      "  logic [`ADDR_W-1:0] a;",
      "endmodule",
    ].join("\n");
    expect(repairSV(src).code).toBe(src);
  });

  it("removes the LATER exact-duplicate module-scope declaration (run-15 TB)", () => {
    const src = [
      "module tb;",
      "int cycle_count;",
      "logic clk;",
      "int cycle_count;",
      "initial cycle_count = 0;",
      "endmodule",
    ].join("\n");
    const r = repairSV(src);
    const decls = r.code.split("\n").filter(l => l.trim() === "int cycle_count;");
    expect(decls.length).toBe(1);
    expect(r.code.indexOf("logic clk;")).toBeGreaterThan(r.code.indexOf("int cycle_count;"));
    expect(r.fixes.some(f => f.rule === "duplicate-module-decl")).toBe(true);
  });

  it("never touches identical locals in two different tasks", () => {
    const src = [
      "module tb;",
      "task automatic a();",
      "  int i;",
      "endtask",
      "task automatic b();",
      "  int i;",
      "endtask",
      "endmodule",
    ].join("\n");
    expect(repairSV(src).code).toBe(src);
  });
});

describe("dangling-select repair (run 29)", () => {
  it("drops the orphan part-select after a complete statement", () => {
    const bad = "      wdata = $urandom_range(0, (1<<DATA_W)-1);[DATA_W-1:0];\n";
    const r = repairSV(bad);
    expect(r.code).toContain("wdata = $urandom_range(0, (1<<DATA_W)-1);");
    expect(r.code).not.toContain("[DATA_W-1:0];");
    expect(r.total).toBeGreaterThan(0);
  });
  it("never touches legal selects (LHS, RHS, declarations) and is idempotent", () => {
    const good = [
      "logic [DATA_W-1:0] din;",
      "assign y = mem[rd_ptr][DATA_W-1:0];",
      "din[3:0] = nib;",
    ].join("\n");
    const r = repairSV(good);
    expect(r.code).toBe(good);
    const once = repairSV("x = f(a);[7:0];");
    expect(repairSV(once.code).code).toBe(once.code);
  });
});

describe("midblock comma-list hoist (run 30)", () => {
  it("hoists 'bit [W-1:0] wdata, rdata;' after a statement to block top", () => {
    const bad = [
      "task automatic drain();",
      "  begin",
      "    step(1);",
      "    bit [DATA_W_TB-1:0] wdata, rdata_ref;",
      "    wdata = '0;",
      "  end",
      "endtask",
    ].join("\n");
    const r = repairSV(bad);
    expect(r.total).toBeGreaterThan(0);
    const lines = r.code.split("\n");
    const declIdx = lines.findIndex((l) => /bit \[DATA_W_TB-1:0\] wdata, rdata_ref;/.test(l));
    const stmtIdx = lines.findIndex((l) => /step\(1\);/.test(l));
    expect(declIdx).toBeGreaterThan(-1);
    expect(declIdx).toBeLessThan(stmtIdx);            // hoisted above the first statement
  });
  it("comma lists already at block top and module scope stay untouched", () => {
    const good = "module tb;\n  bit [7:0] a, b;\n  task t();\n    begin\n      bit [3:0] x, y;\n      x = 1;\n    end\n  endtask\nendmodule";
    const r = repairSV(good);
    expect(r.code).toContain("bit [7:0] a, b;");      // module scope untouched
    expect(repairSV(r.code).code).toBe(r.code);        // idempotent
  });
});

describe("module-scope signal-init repair (run 30)", () => {
  it("splits the run 30 verbatim frozen flags into decl + assign", () => {
    const bad = [
      "module tb;",
      "  logic [4:0] ref_occupancy;",
      "  logic ref_full  = (ref_occupancy == DEPTH_TB);",
      "  logic ref_empty = (ref_occupancy == 0);",
      "endmodule",
    ].join("\n");
    const r = repairSV(bad);
    expect(r.code).toContain("logic ref_full;");
    expect(r.code).toContain("assign ref_full = (ref_occupancy == DEPTH_TB);");
    expect(r.code).toContain("assign ref_empty = (ref_occupancy == 0);");
    expect(repairSV(r.code).code).toBe(r.code);          // idempotent
  });
  it("constant/parameter initializers and in-block declarations stay untouched", () => {
    const good = [
      "module tb;",
      "  logic clk = 1'b0;",                              // literal init — the standard clock seed
      "  bit [7:0] seed = 8'hC0;",                         // literal
      "  logic [3:0] w = WIDTH_PARAM;",                    // ALL-CAPS parameter ref? (kept: no lowercase id)
      "  initial begin",
      "    int x = compute_it(y);",                        // in-block — hoist transform's turf
      "  end",
      "endmodule",
    ].join("\n");
    const r = repairSV(good);
    expect(r.code).toContain("logic clk = 1'b0;");
    expect(r.code).toContain("bit [7:0] seed = 8'hC0;");
    expect(r.code).toContain("logic [3:0] w = WIDTH_PARAM;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The two one-line-TB repairs (runs 36 + 39). Each of these single-token
// defects compile-failed a shipped TB and zeroed a run's verify signal:
// run 36's undeclared `ref_sclk_prev_snap` hid a 218/36 measurement, run 39's
// module-scope `void'()` sat in front of a 65/74 one. Replay-validated: the
// auto-repaired run-36 TB reproduces 218/36 exactly.
// ═══════════════════════════════════════════════════════════════════════════
describe("module-scope-statement wrap (run 39)", () => {
  it("wraps the run-39 shape in `initial`", () => {
    const r = repairSV("module m_tb;\n  void'($urandom(32'hC0FFEE));\nendmodule");
    expect(r.code).toContain("initial void'($urandom(32'hC0FFEE));");
    expect(r.fixes.some((f) => f.rule === "module-scope-statement")).toBe(true);
  });
  it("wraps a bare system-task call at module scope too", () => {
    const r = repairSV("module m_tb;\n  $display(\"hi\");\nendmodule");
    expect(r.code).toContain("initial $display");
  });
  it("the same text INSIDE a block is legal and untouched", () => {
    const src = "module m_tb;\n  initial begin\n    void'($urandom(1));\n  end\nendmodule";
    expect(repairSV(src).code).toBe(src);
  });
  it("the body of a block-less `initial` on the previous line is untouched", () => {
    const src = "module m_tb;\n  initial\n    void'($urandom(1));\nendmodule";
    expect(repairSV(src).code).toBe(src);
  });
  it("a self-contained `initial clk = 1'b0;` does not drift the depth counter", () => {
    const r = repairSV("module m_tb;\n  logic clk;\n  initial clk = 1'b0;\n  void'($urandom(2));\nendmodule");
    expect(r.code).toContain("initial void'($urandom(2));");
  });
  it("is idempotent", () => {
    const once = repairSV("module m_tb;\n  void'($urandom(3));\nendmodule").code;
    expect(repairSV(once).code).toBe(once);
  });
});

describe("undeclared-scalar-decl (run 36)", () => {
  const RUN36_SHAPE = [
    "module spi_tb;",
    "  logic sclk;",
    "  always @(posedge sclk) begin",
    "    if (sclk && !ref_sclk_prev_snap) begin",
    "    end",
    "    ref_sclk_prev_snap = sclk;",
    "  end",
    "endmodule",
  ].join("\n");

  it("declares the run-36 signal: assigned, read, scalar-evidenced, never declared", () => {
    const r = repairSV(RUN36_SHAPE);
    expect(r.code).toContain("logic ref_sclk_prev_snap;");
    expect(r.fixes.some((f) => f.rule === "undeclared-scalar-decl")).toBe(true);
  });
  it("a LONE occurrence is more likely a typo — never declared (would hide the typo)", () => {
    const src = "module m_tb;\n  logic ref_x;\n  initial begin\n  end\n  always @(posedge ref_x) ref_x_typo = 1'b1;\nendmodule";
    expect(repairSV(src).code).not.toContain("logic ref_x_typo");
  });
  it("an INDEXED identifier has an unknowable width — never declared", () => {
    const src = "module m_tb;\n  always @(*) begin\n  end\n  initial begin\n    mem_word = 1'b1;\n    if (!mem_word) $display(\"%0d\", mem_word[3]);\n  end\nendmodule";
    expect(repairSV(src).code).not.toContain("logic mem_word;");
  });
  it("no scalar evidence (run 39's dividend shape) — never declared", () => {
    const src = "module m_tb;\n  task automatic t();\n    dividend = '0;\n    dividend = 8'hA5;\n  endtask\nendmodule";
    expect(repairSV(src).code).not.toContain("logic dividend;");
  });
  it("more than 4 candidates is a broken file, not missing declarations — abstain", () => {
    const lines = ["module m_tb;"];
    for (let i = 0; i < 6; i++) lines.push("  initial begin s" + i + " = 1'b0; if (!s" + i + ") $display(\"x\"); end");
    lines.push("endmodule");
    // wrap each in initial so only the decl rule is in play
    expect(repairSV(lines.join("\n")).code).not.toContain("logic s0;");
  });
  it("already-declared names are left alone, and the repair is idempotent", () => {
    const once = repairSV(RUN36_SHAPE).code;
    expect(repairSV(once).total).toBe(0);
    const declared = "module m_tb;\n  logic a;\n  initial begin a = 1'b0; if (!a) $display(\"y\"); end\nendmodule";
    expect(repairSV(declared).code).toBe(declared);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// User-defined-type declarations (run 45). fixUndeclaredScalar knew only the
// built-in types, so `state_e state;` read as undeclared and the repair
// injected a second `logic state;` — turning a correct, lint-clean SHA-256
// core into a duplicate-declaration SYNTAX error, which then propagated
// through review and lint. A repair that corrupts valid code is worse than
// one that declines, so any `<Identifier> <identifier>;` at statement
// position now counts as a declaration.
// ═══════════════════════════════════════════════════════════════════════════
describe("fixUndeclaredScalar: user-defined types (run 45)", () => {
  const wrap = (body) => "module m(input logic clk, input logic rst_n);\n" + body + "\nendmodule\n";

  it("an enum-typedef declaration is not re-declared", () => {
    const code = wrap(`
  typedef enum logic [1:0] { S_IDLE, S_RUN } state_e;
  state_e state;
  always_ff @(posedge clk) begin
    if (!rst_n) state <= S_IDLE;
    else if (state == S_IDLE) state <= S_RUN;
  end`);
    expect(maybeRepair({ syntaxRepair: true }, code).code).toBe(code);
  });

  it("a package-qualified type declaration is not re-declared", () => {
    const code = wrap(`
  my_pkg::cmd_t cmd;
  always_ff @(posedge clk) begin
    if (!rst_n) cmd <= '0;
    else if (!cmd) cmd <= '1;
  end`);
    expect(maybeRepair({ syntaxRepair: true }, code).code).toBe(code);
  });

  it("a struct-typedef declaration with a packed dimension is not re-declared", () => {
    const code = wrap(`
  word_t [3:0] regs;
  always_ff @(posedge clk) begin
    if (!rst_n) regs <= '0;
    else if (~regs) regs <= '1;
  end`);
    expect(maybeRepair({ syntaxRepair: true }, code).code).toBe(code);
  });

  it("a genuinely undeclared scalar is STILL declared — the repair keeps working", () => {
    const code = wrap(`
  always_ff @(posedge clk) begin
    if (!rst_n)
      flag <= 1'b0;
    else if (!flag)
      flag <= 1'b1;
  end`);
    const out = maybeRepair({ syntaxRepair: true }, code).code;
    expect(out).toContain("logic flag;");
    expect(out).toContain("[syntax-repair]");
  });

  it("`return x;` and similar statement heads are not read as declarations", () => {
    const code = wrap(`
  function automatic logic f(input logic x);
    return x;
  endfunction
  always_ff @(posedge clk) begin
    if (!rst_n)
      busy_flag <= 1'b0;
    else if (!busy_flag)
      busy_flag <= 1'b1;
  end`);
    expect(maybeRepair({ syntaxRepair: true }, code).code).toContain("logic busy_flag;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bare replication (run 46). A local model wrote `4{w[31]}` inside a
// concatenation where SystemVerilog requires `{4{w[31]}}`; four sites in one
// file, and the module did not parse. A decimal count directly followed by a
// braced body has no legal reading unless a `{` already precedes the count —
// which is the well-formed replication this must leave alone.
// ═══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// Enumeration members (run 53). Same false-positive class
// as the run-45 user-defined types above: an enum member with an explicit
// value sits at statement position as `NAME = value,`, so fixUndeclaredScalar
// read it as an assignment to an undeclared signal and injected a duplicate
// declaration into a clean module. That single injected line then consumed the
// design's whole fix loop.
// ══════════════════════════════════════════════════════════════════════════
describe("fixUndeclaredScalar: enum members (run 53)", () => {
  const FSM = [
    "module top_module(",
    "    input clk,",
    "    input areset,",
    "    input ground,",
    "    output logic aaah",
    ");",
    "    typedef enum logic [2:0] {",
    "        WALK_LEFT  = 3'd0,",
    "        WALK_RIGHT = 3'd1,",
    "        FALLING    = 3'd2,",
    "        DIGGING    = 3'd3,",
    "        SPLAT      = 3'd4",
    "    } state_t;",
    "",
    "    state_t state, next_state;",
    "",
    "    always_comb begin",
    "        if (state == FALLING && next_state == FALLING) begin",
    "            next_state = ground ? WALK_LEFT : FALLING;",
    "        end",
    "    end",
    "",
    "    assign aaah = (state == FALLING);",
    "endmodule",
  ].join("\n");

  it("does not declare an enum member that is 'assigned' by its own enum entry", () => {
    const r = repairSV(FSM);
    expect(r.code).toBe(FSM);
    expect(r.code).not.toMatch(/logic\s+FALLING\s*;/);
  });

  it("the members of a bare (non-typedef) enum are known too", () => {
    const src = [
      "module m(input clk, output logic o);",
      "  enum { IDLE = 2'd0, BUSY = 2'd1 } st;",
      "  always_comb o = (st == BUSY) && (st != IDLE);",
      "endmodule",
    ].join("\n");
    expect(repairSV(src).code).toBe(src);
  });

  it("a genuinely undeclared scalar next to an enum is STILL declared", () => {
    const src = [
      "module m(input clk, output logic o);",
      "  typedef enum logic [1:0] { IDLE = 2'd0, RUN = 2'd1 } st_t;",
      "  st_t st;",
      "  always_ff @(posedge clk) begin",
      "    seen_run <= (st == RUN);",
      "    o <= !seen_run;",
      "  end",
      "endmodule",
    ].join("\n");
    const r = repairSV(src);
    expect(r.code).toMatch(/logic\s+seen_run\s*;/);
    expect(r.code).not.toMatch(/logic\s+RUN\s*;/);
    expect(r.code).not.toMatch(/logic\s+IDLE\s*;/);
  });
});

describe("fixBareReplication (run 46)", () => {
  const mod = (body) => "module m;\n  logic [31:0] a, b;\n  always_comb begin\n" + body + "\n  end\nendmodule\n";

  it("adds the outer braces inside a concatenation", () => {
    const out = maybeRepair({ syntaxRepair: true }, mod("    b = {a[30:28], 4{a[31]}};")).code;
    expect(out).toContain("{a[30:28], {4{a[31]}}}");
  });

  it("repairs every site in one pass", () => {
    const out = maybeRepair({ syntaxRepair: true },
      mod("    b = {a[30:28], 4{a[31]}} ^ {a[30:25], 7{a[31]}};")).code;
    expect(out).toContain("{4{a[31]}}");
    expect(out).toContain("{7{a[31]}}");
  });

  it("leaves well-formed replication untouched", () => {
    for (const src of [
      "module m; logic [3:0] z; assign z = {4{1'b1}}; endmodule\n",
      "module m; logic [7:0] z; assign z = {2{4'hA}}; endmodule\n",
    ]) {
      expect(maybeRepair({ syntaxRepair: true }, src).code).toBe(src);
    }
  });

  it("leaves sized literals and assignment patterns alone", () => {
    const src = "module m;\n  logic [3:0] x = 4'h5;\n  logic [1:0] p [2];\n"
      + "  initial p = '{2'd1, 2'd2};\nendmodule\n";
    expect(maybeRepair({ syntaxRepair: true }, src).code).toBe(src);
  });

  it("does not fire on a bare number followed by a block", () => {
    // `repeat (4) begin … end` and friends never present `N{`
    const src = mod("    repeat (4) b = a;");
    expect(maybeRepair({ syntaxRepair: true }, src).code).toBe(src);
  });

  it("leaves paren-replication's own output alone", () => {
    const src = "module c;\n  initial x = (N+1){2'b01};\nendmodule\n";
    const out = maybeRepair({ syntaxRepair: true }, src).code;
    expect(out).toContain("x = {N+1{2'b01}};");
    expect(out).not.toContain("{N+{1{");
  });

  it("declines the first concatenation element, where the legal form is ambiguous", () => {
    // `{4{x}, y}` cannot be distinguished from a legal `{4{x}}` by shape, so
    // the repair stays out rather than risk corrupting working code.
    const src = mod("    b = {4{a[31]}, a[7:0]};");
    expect(maybeRepair({ syntaxRepair: true }, src).code).toBe(src);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Multi-line routine signatures (run 47). hoistMidBlockDecls anchored a
// task/function frame at the HEADER line, so a signature spanning several
// lines had the body's declarations hoisted INTO its parameter list:
//     task automatic sample_frame(output logic [7:0] got,
//       logic [7:0] b;                        ← inserted into the signature
//                                  output logic stop_ok);
// A valid 353-line testbench came back with 47 syntax errors. The frame now
// anchors where the signature actually ends.
// ═══════════════════════════════════════════════════════════════════════════
describe("hoistMidBlockDecls: multi-line signatures (run 47)", () => {
  it("leaves a task with a multi-line signature untouched", () => {
    const src = `module tb;
  task automatic sample(output logic [7:0] got,
                        output logic ok);
    logic [7:0] b;
    int guard;
    guard = 0;
    b = 8'h00;
    got = b;
    ok = 1'b1;
  endtask
endmodule
`;
    expect(maybeRepair({ syntaxRepair: true }, src).code).toBe(src);
  });

  it("leaves a multi-line function signature untouched", () => {
    const src = `module m;
  function automatic logic [7:0] f(input logic [7:0] a,
                                   input logic [7:0] b);
    logic [7:0] t;
    t = a ^ b;
    return t;
  endfunction
endmodule
`;
    expect(maybeRepair({ syntaxRepair: true }, src).code).toBe(src);
  });

  it("still hoists a declaration that genuinely follows a statement", () => {
    const src = `module m;
  initial begin
    $display("go");
    logic [7:0] late;
    late = 8'h01;
  end
endmodule
`;
    const out = maybeRepair({ syntaxRepair: true }, src).code;
    expect(out).not.toBe(src);
    // the declaration moved ahead of the statement
    expect(out.indexOf("logic [7:0] late;")).toBeLessThan(out.indexOf('$display("go")'));
  });

  it("a single-line signature keeps its existing behaviour", () => {
    const src = `module m;
  task automatic t(input int x);
    $display("%0d", x);
    logic [7:0] late;
    late = 8'h02;
  endtask
endmodule
`;
    const out = maybeRepair({ syntaxRepair: true }, src).code;
    expect(out).toContain("logic [7:0] late;");
    expect(out.indexOf("logic [7:0] late;")).toBeLessThan(out.indexOf('$display'));
  });
});
