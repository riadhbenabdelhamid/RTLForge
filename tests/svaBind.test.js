// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// svaBind — materializing formal_props into a simulation-checkable checker.
//
// Pins the three safety properties the verify/judge wiring relies on:
//   1. only port/param-referencing concurrent properties are bound,
//   2. the emitted snippet is structurally complete (module + bind),
//   3. the helpers used for --assert injection and compile-failure
//      detection behave exactly as the retry logic expects.

import { describe, it, expect } from "vitest";
import {
  buildSvaChecker, injectVerilatorFlag, svaCompileFailed,
  validateAuxModel, formalResetAssume, svaCheckerToImmediate,
  stripOuterParens, clockedOnlyViolations, expandInside, unknownSysFuncs,
  stripStrongWeak } from "../src/pipeline/svaBind.js";

const spec = {
  iface: [
    { name: "clk",   dir: "input",  width: "1" },
    { name: "rst_n", dir: "input",  width: "1" },
    { name: "din",   dir: "input",  width: "DATA_W" },
    { name: "full",  dir: "output", width: "1" },
  ],
  params: [{ name: "DATA_W", type: "parameter", def: 8 }],
};

function fp(properties) { return { properties: properties }; }

describe("buildSvaChecker", function() {
  it("binds a port-only concurrent property and emits module + bind", function() {
    const out = buildSvaChecker(fp([{
      id: "SVA-001", req: "REQ-FUNC-001", type: "assert",
      desc: "full implies not writable",
      code: "assert property (@(posedge clk) disable iff (!rst_n) full |-> !din[0]);",
    }]), spec, "sync_fifo");
    expect(out).not.toBeNull();
    expect(out.included).toEqual(["SVA-001"]);
    expect(out.skipped).toEqual([]);
    expect(out.checkerName).toBe("sync_fifo_rtlforge_sva");
    expect(out.text).toContain("module sync_fifo_rtlforge_sva");
    expect(out.text).toContain("bind sync_fifo sync_fifo_rtlforge_sva u_rtlforge_sva (.*);");
    // Ports + mirrored parameter so [DATA_W-1:0] widths resolve
    expect(out.text).toContain("input logic [DATA_W-1:0] din");
    expect(out.text).toContain("parameter DATA_W = 8");
    expect(out.text).toContain("assert property");
  });

  it("emits no comment line whose first token is 'verilator' (BADVLTPRAGMA — run 10)", function() {
    // Verilator parses any comment starting with the token "verilator" as a
    // metacomment; an unknown keyword after it is a FATAL error that took
    // down a whole verify compile in nemotron run 10.
    const out = buildSvaChecker(fp([{
      id: "SVA-001", req: "REQ-FUNC-001", type: "assert",
      code: "assert property (@(posedge clk) disable iff (!rst_n) full |-> !din[0]);",
    }]), spec, "sync_fifo");
    for (const line of out.text.split("\n")) {
      expect(line).not.toMatch(/^\s*(\/\/|\/\*)\s*verilator\b/i);
    }
  });

  it("skips properties that reference non-port identifiers (would break the compile)", function() {
    const out = buildSvaChecker(fp([
      { id: "SVA-OK",  code: "assert property (@(posedge clk) full |-> full);" },
      { id: "SVA-BAD", code: "assert property (@(posedge clk) internal_count < 4);" },
    ]), spec, "m");
    expect(out.included).toEqual(["SVA-OK"]);
    expect(out.skipped.length).toBe(1);
    expect(out.skipped[0].id).toBe("SVA-BAD");
    expect(out.skipped[0].reason).toMatch(/internal_count/);
    expect(out.text).not.toContain("internal_count");
  });

  it("is not confused by based literals or $system functions", function() {
    // 8'hFF must not yield a fake identifier "hFF"; $past must be allowed.
    const out = buildSvaChecker(fp([{
      id: "SVA-LIT",
      code: "assert property (@(posedge clk) din != 8'hFF |-> $past(full) == 1'b0);",
    }]), spec, "m");
    expect(out).not.toBeNull();
    expect(out.included).toEqual(["SVA-LIT"]);
  });

  it("skips immediate assertions and covers (not bindable in this first cut)", function() {
    const out = buildSvaChecker(fp([
      { id: "SVA-IMM", code: "assert #0 (full == 1'b0);" },
      { id: "COV-001", code: "cover property (@(posedge clk) full);" },
      { id: "SVA-OK",  code: "assume property (@(posedge clk) !din[0]);" },
    ]), spec, "m");
    expect(out.included).toEqual(["SVA-OK"]);   // assume property IS bound
    const reasons = out.skipped.map(function(s) { return s.id; }).sort();
    expect(reasons).toEqual(["COV-001", "SVA-IMM"]);
  });

  it("returns null when nothing is bindable, properties are empty, or iface is missing", function() {
    expect(buildSvaChecker(fp([]), spec, "m")).toBeNull();
    expect(buildSvaChecker(null, spec, "m")).toBeNull();
    expect(buildSvaChecker(
      fp([{ id: "X", code: "assert property (@(posedge clk) mystery);" }]), spec, "m",
    )).toBeNull();
    expect(buildSvaChecker(
      fp([{ id: "X", code: "assert property (@(posedge clk) clk);" }]), { iface: [] }, "m",
    )).toBeNull();
  });
});

describe("injectVerilatorFlag", function() {
  it("adds the flag to compile lines only, idempotently", function() {
    const cmds = [
      "verilator --binary -Wall -j 0 {RTL} {TB} -o sim",
      "./obj_dir/sim",
      "verilator_coverage --write logs/coverage.dat logs/coverage.dat",
    ];
    const out = injectVerilatorFlag(cmds, "--assert");
    expect(out[0]).toContain("--assert");
    expect(out[1]).toBe("./obj_dir/sim");                       // runtime line untouched
    expect(out[2]).not.toContain("--assert");                   // coverage post-step untouched
    // Idempotent: a second pass must not duplicate the flag
    const again = injectVerilatorFlag(out, "--assert");
    expect(again[0].match(/--assert/g).length).toBe(1);
  });
});

describe("svaCompileFailed", function() {
  it("matches only non-zero exits whose output names the checker", function() {
    const name = "m_rtlforge_sva";
    expect(svaCompileFailed({ exitCode: 1, stderr: "%Error: m.sv:42: " + name + ": syntax error" }, name)).toBe(true);
    expect(svaCompileFailed({ exitCode: 1, stderr: "%Error: tb.sv:7: unrelated" }, name)).toBe(false);
    expect(svaCompileFailed({ exitCode: 0, stdout: name }, name)).toBe(false);
    expect(svaCompileFailed(null, name)).toBe(false);
  });

  it("flags errors located past the raw RTL's last line (appended checker at fault — run 10)", function() {
    // The checker is appended to the RTL file, so an error inside it may not
    // name the checker module at all (run 10: BADVLTPRAGMA on the checker's
    // own header comment at ctr.sv:30 while the raw RTL was 26 lines).
    const name = "m_rtlforge_sva";
    const opts = { rtlFileName: "ctr.sv", rtlLineCount: 26 };
    expect(svaCompileFailed(
      { exitCode: 1, stderr: "%Error-BADVLTPRAGMA: ctr.sv:30:1: Unknown verilator comment" },
      name, opts)).toBe(true);
    // Error INSIDE the raw RTL — the design's fault, keep it.
    expect(svaCompileFailed(
      { exitCode: 1, stderr: "%Error: ctr.sv:12:3: syntax error" },
      name, opts)).toBe(false);
    // Error in another file (the TB) is never the checker's fault.
    expect(svaCompileFailed(
      { exitCode: 1, stderr: "%Error: ctr_tb.sv:99:1: syntax error" },
      name, opts)).toBe(false);
  });
});

// ─── aux model (run-13 follow-up: make occupancy properties bindable) ────────
// The checker sees only DUT ports, so invariants over hidden state (FIFO
// occupancy) were always skipped and formal never ran — the run-13 false
// PASS survived BMC by absence. The aux model closes that: f_-prefixed
// checker-local state driven from ports, validated for identifier closure.
// Live proof (outside CI, sby): the run-13 broken FIFO FAILs SVA-OCC-FULL
// with a counterexample; a correct occupancy-counter FIFO PASSes.

const FIFO_SPEC = {
  iface: [
    { name: "clk",    dir: "input",  width: "1" },
    { name: "rst_n",  dir: "input",  width: "1", desc: "active-low async reset" },
    { name: "wr_en",  dir: "input",  width: "1" },
    { name: "rd_en",  dir: "input",  width: "1" },
    { name: "data_i", dir: "input",  width: "DATA_W" },
    { name: "dout",   dir: "output", width: "DATA_W" },
    { name: "full",   dir: "output", width: "1" },
    { name: "empty",  dir: "output", width: "1" },
  ],
  params: [{ name: "DATA_W", def: 8 }, { name: "DEPTH", def: 16 }],
};
const OCC_AUX = [
  "logic [$clog2(DEPTH):0] f_occ;",
  "always_ff @(posedge clk or negedge rst_n)",
  "  if (!rst_n) f_occ <= '0;",
  "  else f_occ <= f_occ + (wr_en && !full) - (rd_en && !empty);",
].join("\n");

describe("validateAuxModel", function() {
  const ports = new Set(FIFO_SPEC.iface.map((p) => p.name));
  const params = new Set(FIFO_SPEC.params.map((p) => p.name));

  it("accepts the occupancy model (ports + params + f_ names only)", function() {
    const v = validateAuxModel(OCC_AUX, ports, params);
    expect(v.error).toBeUndefined();
    expect(Array.from(v.names)).toEqual(["f_occ"]);
  });

  it("rejects names without the f_ prefix (collision risk when inlined)", function() {
    const v = validateAuxModel("logic occ;\nalways_ff @(posedge clk) occ <= occ;", ports, params);
    expect(v.error).toMatch(/prefixed f_/);
  });

  it("rejects references to non-port identifiers (would break the compile)", function() {
    const v = validateAuxModel("logic f_x;\nalways_ff @(posedge clk) f_x <= internal_count;", ports, params);
    expect(v.error).toMatch(/internal_count/);
  });

  it("rejects empty / declaration-free blocks", function() {
    expect(validateAuxModel("", ports, params).error).toBe("empty");
    expect(validateAuxModel("// just a comment about f_things", ports, params).error).toMatch(/declares no f_/);
  });

  it("comment prose is not identifiers (run 28: verbatim aux killed by its own comment)", function() {
    // laguna's run-28 aux — valid checker code whose trailing comment
    // ("placeholder: actual data modeled from input stream…") tokenized into
    // identifiers and dropped the whole aux model, taking the connecting
    // f_occ properties with it.
    const aux = [
      "logic [$clog2(DEPTH):0] f_occ;",
      "logic [DATA_W-1:0] f_expected_dout;",
      "always_ff @(posedge clk or negedge rst_n) begin",
      "  if (!rst_n) begin",
      "    f_occ <= '0;",
      "    f_expected_dout <= '0;",
      "  end else begin",
      "    f_occ <= f_occ + (wr_en && !full) - (rd_en && !empty);",
      "    if (rd_en && !empty) begin",
      "      f_expected_dout <= data_i; // placeholder: actual data modeled from input stream at write time would require deeper tracking",
      "    end",
      "  end",
      "end",
    ].join("\n");
    const v = validateAuxModel(aux, ports, params);
    expect(v.error).toBeUndefined();
    expect(Array.from(v.names).sort()).toEqual(["f_expected_dout", "f_occ"]);
    // Comments survive into the returned text (legal in the emitted checker).
    expect(v.text).toContain("placeholder");
  });

  it("a commented-out declaration neither trips the f_ rule nor declares state", function() {
    const aux = [
      "// bit stale_helper; (disabled — would shadow a port)",
      "/* logic other_helper; */",
      "logic f_occ;",
      "always_ff @(posedge clk) f_occ <= f_occ + (wr_en && !full);",
    ].join("\n");
    const v = validateAuxModel(aux, ports, params);
    expect(v.error).toBeUndefined();
    expect(Array.from(v.names)).toEqual(["f_occ"]);
  });
});

describe("buildSvaChecker with an aux model", function() {
  const fpWithAux = {
    aux: OCC_AUX,
    properties: [
      { id: "SVA-OCC-FULL", code: "assert property (@(posedge clk) disable iff (!rst_n) full |-> f_occ == DEPTH);" },
      { id: "SVA-PORTS",    code: "assert property (@(posedge clk) disable iff (!rst_n) empty |-> !full);" },
    ],
  };

  it("admits properties referencing aux names and emits the aux block in the checker", function() {
    const out = buildSvaChecker(fpWithAux, FIFO_SPEC, "sync_fifo");
    expect(out.included).toEqual(["SVA-OCC-FULL", "SVA-PORTS"]);
    expect(out.skipped).toEqual([]);
    expect(out.text).toContain("logic [$clog2(DEPTH):0] f_occ;");
    expect(out.text.indexOf("f_occ;")).toBeLessThan(out.text.indexOf("SVA-OCC-FULL"));
    expect(out.auxLines.length).toBe(4);
  });

  it("drops an invalid aux with a reason; its properties skip through admission", function() {
    const out = buildSvaChecker({
      aux: "logic f_x;\nalways_ff @(posedge clk) f_x <= hidden_sig;",
      properties: [
        { id: "SVA-AUXREF", code: "assert property (@(posedge clk) f_x == 0);" },
        { id: "SVA-PORTS",  code: "assert property (@(posedge clk) empty |-> !full);" },
      ],
    }, FIFO_SPEC, "sync_fifo");
    expect(out.included).toEqual(["SVA-PORTS"]);
    expect(out.skipped.some((s) => s.id === "AUX" && /hidden_sig/.test(s.reason))).toBe(true);
    expect(out.skipped.some((s) => s.id === "SVA-AUXREF" && /f_x/.test(s.reason))).toBe(true);
    expect(out.auxLines).toEqual([]);
  });

  it("svaCheckerToImmediate carries aux lines through untouched and translates the properties", function() {
    const out = buildSvaChecker(fpWithAux, FIFO_SPEC, "sync_fifo");
    const fc = svaCheckerToImmediate(out.text);
    expect(fc.translated).toBe(2);
    expect(fc.text).toContain("always_ff @(posedge clk or negedge rst_n)");
  });

  // Run 24: `$isunknown(full||empty) |-> 0` translated into the BMC build and
  // FAILed the whole formal stage on solver-chosen undef values — X-detection
  // is a simulation construct, so it stays sim-checked only. And the skip
  // label must be the PROPERTY ID: the old comment regex never matched
  // buildSvaChecker's "// SVA-008 (covers …)" format, so every skipped
  // property was logged as the fallback "prop".
  it("$isunknown properties skip the formal build, labeled with their real id", function() {
    const fp = {
      aux: OCC_AUX,
      properties: [
        { id: "SVA-OCC-FULL", code: "assert property (@(posedge clk) disable iff (!rst_n) full |-> f_occ == DEPTH);", req: "REQ-1" },
        { id: "SVA-XCHK", code: "assert property (@(posedge clk) disable iff (!rst_n) $isunknown(full || empty) |-> 0);", req: "REQ-2" },
      ],
    };
    const out = buildSvaChecker(fp, FIFO_SPEC, "sync_fifo");
    expect(out.included).toEqual(["SVA-OCC-FULL", "SVA-XCHK"]);  // still sim-bound
    const fc = svaCheckerToImmediate(out.text);
    expect(fc.translated).toBe(1);
    expect(fc.text).not.toContain("$isunknown");
    expect(fc.skippedFormal).toEqual(["SVA-XCHK"]);              // real id, not "prop"
  });
});

describe("formalResetAssume", function() {
  it("derives an active-low assume from _n naming", function() {
    expect(formalResetAssume(FIFO_SPEC)).toBe("initial assume (!rst_n);");
  });
  it("derives an active-high assume otherwise", function() {
    expect(formalResetAssume({ iface: [{ name: "reset", dir: "input", width: "1" }] }))
      .toBe("initial assume (reset);");
  });
  it("returns null with no reset port", function() {
    expect(formalResetAssume({ iface: [{ name: "clk", dir: "input", width: "1" }] })).toBeNull();
  });
});

describe("stripOuterParens + parenthesized-implication translation (run 29)", () => {
  it("strips whole-expression wrappers, leaves early-closing parens alone", () => {
    expect(stripOuterParens("(full |-> f_occ == DEPTH)")).toBe("full |-> f_occ == DEPTH");
    expect(stripOuterParens("((a |-> b))")).toBe("a |-> b");
    expect(stripOuterParens("(a || b) && c")).toBe("(a || b) && c");   // closes early
    expect(stripOuterParens("a |-> b")).toBe("a |-> b");
    expect(stripOuterParens("(unbalanced")).toBe("(unbalanced");
  });

  it("run 29 verbatim: '(full |-> f_occ == DEPTH)' emits a balanced immediate assert", () => {
    const checker = [
      "  // SVA-004",
      "  assert property (@(posedge clk) disable iff (!rst_n) (full |-> f_occ == DEPTH));",
    ].join("\n");
    const r = svaCheckerToImmediate(checker);
    expect(r.translated).toBe(1);
    expect(r.assertLines.join("\n")).toContain("if (full) assert (f_occ == DEPTH);");
    // The old output was "if ((full) assert (f_occ == DEPTH));" — yosys TOK_ASSERT.
    expect(r.assertLines.join("\n")).not.toContain("((full) assert");
  });

  it("unparenthesized implications translate exactly as before", () => {
    const checker = "  assert property (@(posedge clk) disable iff (!rst_n) (wr_en && full) |-> !$changed(f_wr));";
    const r = svaCheckerToImmediate(checker);
    expect(r.translated).toBe(1);
    expect(r.assertLines[0]).toContain("if ((wr_en && full)) assert (!$changed(f_wr));");
  });
});

describe("clockedOnlyViolations (run 30 formal-fixer guard)", () => {
  it("flags $past in an assign (the run 30 fixer-candidate shape)", () => {
    const v = clockedOnlyViolations([
      "module m(input clk);",
      "  logic [4:0] occ;",
      "  assign stable_occ = (occ == $past(occ));",
      "endmodule",
    ].join("\n"));
    expect(v.length).toBe(1);
    expect(v[0].fn).toBe("$past");
    expect(v[0].line).toBe(3);
  });
  it("accepts the translated one-liner asserts and multi-line always_ff bodies", () => {
    const v = clockedOnlyViolations([
      "always @(posedge clk) if (!(!rst_n)) begin if ((full && wr_en)) assert (f_occ == $past(f_occ)); end",
      "always_ff @(posedge clk or negedge rst_n) begin",
      "  if (rst_n) begin",
      "    x <= $stable(y) ? a : b;",
      "  end",
      "end",
      "assign z = a + b;",   // after the block closes — no clocked-only use
    ].join("\n"));
    expect(v).toEqual([]);
  });
  it("always_comb and initial contexts are violations; comments are ignored", () => {
    const v = clockedOnlyViolations([
      "always_comb begin",
      "  y = $changed(x);",
      "end",
      "initial z = $rose(a);",
      "// $past(commented) is fine",
      "/* $fell(blocked) too */",
    ].join("\n"));
    expect(v.map((x) => x.fn)).toEqual(["$changed", "$rose"]);
  });
  it("code after a closed clocked block is outside it (no context leak)", () => {
    const v = clockedOnlyViolations([
      "always @(posedge clk) q <= d;",
      "assign w = $past(q);",
    ].join("\n"));
    expect(v.length).toBe(1);
    expect(v[0].line).toBe(2);
  });
});

describe("expandInside (yosys inside-operator compat, run 34)", () => {
  it("expands the run 34 verbatim FSM membership test into an OR chain", () => {
    const out = expandInside("assign shift_en = strobe && (state inside {D0, D1, D2});");
    expect(out).toContain("state == D0 || state == D1 || state == D2");
    expect(out).not.toContain("inside");
  });
  it("handles an indexed LHS and single-item sets", () => {
    expect(expandInside("x[1:0] inside {A}")).toContain("x[1:0] == A");
    expect(expandInside("y inside {A, B}")).toBe("(y == A || y == B)");
  });
  it("leaves RANGE sets alone (no safe one-line equivalent — fail loudly)", () => {
    expect(expandInside("x inside {[3:7]}")).toBe("x inside {[3:7]}");
  });
  it("code without inside is byte-identical", () => {
    const src = "always_ff @(posedge clk) q <= d;";
    expect(expandInside(src)).toBe(src);
  });
});

describe("unknownSysFuncs + $-function admission (run 35)", () => {
  it("flags the run 35 hallucination and accepts the real ones", () => {
    expect(unknownSysFuncs("assert property (@(posedge clk) $onehotf(grant));")).toEqual(["onehotf"]);
    expect(unknownSysFuncs("$onehot(g) && $onehot0(h) && $past(x) && $stable(y) && $countones(z)")).toEqual([]);
    expect(unknownSysFuncs("no dollar functions here")).toEqual([]);
  });
  it("reports each unknown once and ignores comments", () => {
    expect(unknownSysFuncs("$foo(a) || $foo(b) || $bar(c)")).toEqual(["foo", "bar"]);
    expect(unknownSysFuncs("// $madeup(x)\nassert property (@(posedge clk) $onehot(g));")).toEqual([]);
  });
  it("a property using an unknown $-function is SKIPPED, not emitted (task-saving)", () => {
    const out = buildSvaChecker(fp([
      { id: "SVA-OK",  code: "assert property (@(posedge clk) $onehot(full));" },
      { id: "SVA-BAD", code: "assert property (@(posedge clk) $onehotf(full));" },
    ]), spec, "m");
    expect(out.included).toEqual(["SVA-OK"]);
    expect(out.skipped.length).toBe(1);
    expect(out.skipped[0].id).toBe("SVA-BAD");
    expect(out.skipped[0].reason).toMatch(/\$onehotf/);
    expect(out.text).not.toContain("onehotf");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// strong()/weak() wrapper strip (run 40). laguna wrote the done-pulse
// property as `$rose(done) |-> strong(##1 !done)[*1]` and the identifier
// filter read `strong` as an unresolvable signal — three properties of
// exactly the class that names run 40's done-level defect were skipped.
// ═══════════════════════════════════════════════════════════════════════════
describe("stripStrongWeak (run 40)", () => {
  it("strips the wrapper and the identity repetition, keeping the sequence", () => {
    expect(stripStrongWeak("a |-> strong(##1 !done)[*1]")).toBe("a |-> (##1 !done)");
    expect(stripStrongWeak("a |-> weak(b ##1 c)")).toBe("a |-> (b ##1 c)");
  });
  it("leaves ordinary properties untouched, including identifiers containing the words", () => {
    const p = "assert property (@(posedge clk) strongest |-> weakling);";
    expect(stripStrongWeak(p)).toBe(p);
    expect(stripStrongWeak("x[*2] |-> y[*1:3]")).toBe("x[*2] |-> y[*1:3]");
  });
  it("run-40 replay shape: the three strong() properties become bindable", () => {
    const spec = { iface: [
      { name: "clk", dir: "input", width: "1" }, { name: "rst_n", dir: "input", width: "1" },
      { name: "done", dir: "output", width: "1" }, { name: "div_by_zero", dir: "output", width: "1" },
    ], params: [] };
    const fp = { properties: [
      { id: "SVA-004", type: "assert", code: "assert property (@(posedge clk) disable iff (!rst_n) $rose(done) && !div_by_zero |-> strong(##1 !done)[*1]);" },
      { id: "SVA-009", type: "assert", code: "assert property (@(posedge clk) disable iff (!rst_n) done |-> (r_internal == 0));" },
    ] };
    const r = buildSvaChecker(fp, spec, "m", null);
    expect(r.included).toContain("SVA-004");
    expect(r.skipped.map((s) => s.id)).toContain("SVA-009");   // internal signal still skipped
  });
});
