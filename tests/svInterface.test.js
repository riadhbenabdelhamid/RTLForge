// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// svInterface — header extraction for the anti-self-confirmation guard.
//
// These tests pin the property the TB-facing prompts rely on: the extracted
// text contains the module header (so DUT instantiation compiles) and NEVER
// contains the implementation body (so the TB cannot copy expected values
// from a possibly-buggy implementation).

import { describe, it, expect } from "vitest";
import { extractModuleInterface } from "../src/utils/svInterface.js";

describe("extractModuleInterface", function() {
  it("extracts an ANSI header with parameters and multi-line ports", function() {
    const code = [
      "`timescale 1ns/1ps",
      "module sync_fifo #(",
      "  parameter int DATA_W = 8,",
      "  parameter int DEPTH  = 16",
      ") (",
      "  input  logic              clk,",
      "  input  logic              rst_n,",
      "  input  logic [DATA_W-1:0] wr_data,",
      "  output logic              full",
      ");",
      "  logic [DATA_W-1:0] mem [DEPTH];   // secret_internal_memory",
      "  always_ff @(posedge clk) full <= 1'b0;",
      "endmodule",
    ].join("\n");
    const out = extractModuleInterface(code, "sync_fifo");
    expect(out).toContain("module sync_fifo #(");
    expect(out).toContain("parameter int DATA_W = 8");
    expect(out).toContain("input  logic [DATA_W-1:0] wr_data");
    expect(out).toContain("endmodule");
    // The body must be gone — this is the entire point of the module.
    expect(out).not.toContain("secret_internal_memory");
    expect(out).not.toContain("always_ff");
  });

  it("picks the named module when the source holds several", function() {
    const code =
      "module helper(input logic a);\n  assign b = a;\nendmodule\n" +
      "module dut(input logic clk, output logic q);\n  hidden_body_token x;\nendmodule\n";
    const out = extractModuleInterface(code, "dut");
    expect(out).toContain("module dut(");
    expect(out).not.toContain("module helper");
    expect(out).not.toContain("hidden_body_token");
  });

  it("falls back to the first module when the preferred name is absent", function() {
    const code = "module only_one(input logic x);\nendmodule\n";
    const out = extractModuleInterface(code, "nonexistent");
    expect(out).toContain("module only_one(");
  });

  it("is not fooled by semicolons inside comments in the port list", function() {
    const code = [
      "module m (",
      "  input logic a, // note; this semicolon is comment text",
      "  /* block; comment; with; semicolons */",
      "  output logic b",
      ");",
      "  assign b = ~a; // body",
      "endmodule",
    ].join("\n");
    const out = extractModuleInterface(code, "m");
    expect(out).toContain("output logic b");
    expect(out).not.toContain("assign b = ~a");
  });

  it("is not fooled by semicolons inside string literals", function() {
    // Strings rarely appear in headers, but the scanner must not break when
    // a body string precedes a later module's header terminator.
    const code =
      'module m(input logic a);\n  initial $display("semi;colon");\nendmodule\n';
    const out = extractModuleInterface(code, "m");
    expect(out).toContain("module m(input logic a);");
    expect(out).not.toContain("$display");
  });

  it("does not match 'module' inside identifiers or comments", function() {
    const code =
      "// this submodule comment mentions module things\n" +
      "module real_one(input logic c);\nendmodule\n";
    const out = extractModuleInterface(code, "real_one");
    expect(out).toContain("module real_one(");
  });

  it("handles non-ANSI headers (port names only)", function() {
    const code = "module legacy(a, b);\n  input a;\n  output b;\n  assign b = a;\nendmodule\n";
    const out = extractModuleInterface(code, "legacy");
    expect(out).toContain("module legacy(a, b);");
    // Non-ANSI direction declarations live in the body and are withheld with
    // it — the prompt's spec-derived PORT LIST carries that information.
    expect(out).not.toContain("assign b = a");
  });

  it("returns null for empty input, no module, or missing terminator", function() {
    expect(extractModuleInterface("", "x")).toBeNull();
    expect(extractModuleInterface("   \n  ", "x")).toBeNull();
    expect(extractModuleInterface("not verilog at all", "x")).toBeNull();
    expect(extractModuleInterface("module broken(input logic a", "broken")).toBeNull();
  });

  it("appends the body-withheld notice so prompt readers see why", function() {
    const out = extractModuleInterface("module m(input logic a);\nendmodule", "m");
    expect(out).toMatch(/body withheld/i);
  });
});
