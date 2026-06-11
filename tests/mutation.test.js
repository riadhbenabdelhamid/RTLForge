// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// mutation — TB-strength gate (pipeline/mutation.js).
//
// Pins the safety properties of the mutant generator: operators only fire
// on real code (never comments/strings), the dangerous lookalikes (`<=`
// NBA, `+:` part-select, `==?` wildcard) are never touched, and selection
// under the cap is deterministic.

import { describe, it, expect } from "vitest";
import { maskNonCode, generateMutants } from "../src/pipeline/mutation.js";

describe("maskNonCode", function() {
  it("blanks comments and strings, preserves code and length", function() {
    const src = 'a == b; // x == y\n$display("p == q"); /* z == w */ c && d;';
    const masked = maskNonCode(src);
    expect(masked.length).toBe(src.length);
    expect(masked).toContain("a == b;");
    expect(masked).toContain("c && d;");
    expect(masked).not.toContain("x == y");
    expect(masked).not.toContain("p == q");
    expect(masked).not.toContain("z == w");
  });

  it("handles escaped quotes inside strings", function() {
    const masked = maskNonCode('$display("say \\"hi\\" =="); e == f;');
    expect(masked).toContain("e == f;");
    expect(masked).not.toContain("hi");
  });
});

describe("generateMutants", function() {
  it("mutates ==, &&, bit constants, and if-conditions", function() {
    const rtl = [
      "module m(input logic clk, input logic a, input logic b, output logic q);",
      "  always_ff @(posedge clk) begin",
      "    if (a == b && q) q <= 1'b1;",
      "  end",
      "endmodule",
    ].join("\n");
    const muts = generateMutants(rtl, { maxMutants: 10 });
    const ops = muts.map(function(m) { return m.op; });
    expect(ops).toContain("eq_to_neq");
    expect(ops).toContain("and_to_or");
    expect(ops).toContain("const_flip");
    expect(ops).toContain("if_negate");
    // Each mutant is a single edit of the original
    for (const m of muts) {
      expect(m.code).not.toBe(rtl);
      expect(m.line).toBeGreaterThan(0);
    }
    const neq = muts.find(function(m) { return m.op === "eq_to_neq"; });
    expect(neq.code).toContain("a != b");
    const flip = muts.find(function(m) { return m.op === "const_flip"; });
    expect(flip.code).toContain("1'b0");
  });

  it("if_negate wraps the full condition including nested parens", function() {
    const rtl = "module m; always_comb begin if ((a && (b || c))) q = 1; end endmodule";
    const muts = generateMutants(rtl, { maxMutants: 10 });
    const neg = muts.find(function(m) { return m.op === "if_negate"; });
    expect(neg).toBeTruthy();
    expect(neg.code).toContain("if (!((a && (b || c))))");
  });

  it("never mutates inside comments or strings", function() {
    const rtl = [
      "module m(input logic a);",
      "  // this comment says a == b && 1'b1",
      '  initial $display("eq == and && lit 1\'b1");',
      "endmodule",
    ].join("\n");
    expect(generateMutants(rtl, { maxMutants: 10 })).toEqual([]);
  });

  it("guards the SV lookalikes: <= NBA, +: part-select, ==? wildcard", function() {
    const rtl = [
      "module m(input logic clk, input logic [7:0] d, output logic [7:0] q);",
      "  always_ff @(posedge clk) q <= d[0 +: 8];",         // NBA + part-select
      "  always_comb x = (d ==? 8'b1xxx0000);",              // wildcard equality
      "endmodule",
    ].join("\n");
    const ops = generateMutants(rtl, { maxMutants: 10 }).map(function(m) { return m.op; });
    expect(ops).not.toContain("eq_to_neq");       // ==? untouched
    expect(ops).not.toContain("plus_to_minus");   // +: untouched
    // (`<=` is never an operator rule at all.)
  });

  it("mutates a genuine binary plus", function() {
    const rtl = "module m; always_comb s = a + b; endmodule";
    const muts = generateMutants(rtl, { maxMutants: 10 });
    const pm = muts.find(function(m) { return m.op === "plus_to_minus"; });
    expect(pm).toBeTruthy();
    expect(pm.code).toContain("a - b");
  });

  it("caps mutants deterministically with an even spread", function() {
    // 6 const_flip sites; cap at 3 → indices 0, 2, 4 of the sorted sites.
    const rtl = "module m; assign {a,b,c,d,e,f} = {1'b1, 1'b1, 1'b1, 1'b1, 1'b1, 1'b1}; endmodule";
    const muts1 = generateMutants(rtl, { maxMutants: 3 });
    const muts2 = generateMutants(rtl, { maxMutants: 3 });
    expect(muts1.length).toBe(3);
    expect(muts1.map(function(m) { return m.line + ":" + m.op; }))
      .toEqual(muts2.map(function(m) { return m.line + ":" + m.op; }));
  });

  it("returns [] for empty or mutation-free source", function() {
    expect(generateMutants("", {})).toEqual([]);
    expect(generateMutants("module m; endmodule", {})).toEqual([]);
  });
});
