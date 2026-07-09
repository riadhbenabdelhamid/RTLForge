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
