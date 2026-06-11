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
import { buildSvaChecker, injectVerilatorFlag, svaCompileFailed } from "../src/pipeline/svaBind.js";

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
});
