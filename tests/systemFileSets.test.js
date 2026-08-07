// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Every CLI invocation stages the file set the artifact needs (run 47 follow-up)
//
// Run 47 converted the four stages a system run walks through — lint, verify,
// lint_test, integration — to compile against the shared package and the
// children. Five OTHER call sites still staged the module alone, and each
// fails the same way: `import uart_pkg::*;` → "Import package not found",
// which is an error, so nothing downstream of it is even analysed.
//
// What each one reports when that happens is the reason they matter:
//   • best-of-N ranking       every candidate fails identically → the ranking
//                             carries no signal and index 0 wins on the tie
//   • rtl_review lintCountsOf 1→1 errors, 0→0 warnings across a review fix →
//                             the MULTIDRIVEN guard is BLIND, and this one was
//                             live in run 47 (backendUrl was set)
//   • judge re-verify         a working design reported as non-compiling
//   • mutation gate           every mutant INVALID → "no data" on a design
//                             whose testbench is perfectly measurable
//   • coverage strengthening  every measurement null → "no-baseline"
//
// None of them fails loudly. That is the whole class: the run degrades into a
// weaker verdict that still looks like a verdict.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCoverageStrengthening } from "../src/pipeline/coverageStrengthen.js";

const PKG = "package uart_pkg;\n  localparam int BYTE_W = 8;\nendpackage";
const CHILDREN = [{ modName: "uart_tx", code: "module uart_tx; endmodule" }];
const SIM = [
  "verilator --binary --build --assert -j 0 -Wall {RTL} {TB} -o {RTL}.sim",
  "./obj_dir/{RTL}.sim",
];

// ── mutation gate ──────────────────────────────────────────────────────────
// runCli is imported, not injected, so it has to be mocked at the module.
const cap = vi.hoisted(() => ({ calls: [] }));
vi.mock("../src/cli/index.js", async () => {
  const actual = await vi.importActual("../src/cli/index.js");
  return Object.assign({}, actual, {
    runCli: vi.fn(async (_url, payload) => {
      cap.calls.push(payload);
      // Every mutant killed: one [FAIL] line is enough for the gate.
      return { stdout: "[FAIL] t1\n", stderr: "", exitCode: 1 };
    }),
  });
});

const { runMutationGate } = await import("../src/pipeline/mutation.js");

const MUTABLE_RTL = [
  "module uart_loopback(input logic clk, input logic a, input logic b, output logic q);",
  "  always_ff @(posedge clk) begin",
  "    if (a == b) q <= 1'b1;",
  "  end",
  "endmodule",
].join("\n");

function gateArgs(extra) {
  return Object.assign({
    rtl: MUTABLE_RTL,
    tb: "module tb; endmodule",
    cmds: SIM.slice(),
    rtlFileName: "uart_loopback.sv",
    tbFileName: "uart_loopback_tb.sv",
    config: { backendUrl: "local", mutationMaxMutants: 1 },
    cliOpts: {},
    signal: null,
    appendLog: function() {},
  }, extra || {});
}

beforeEach(() => { cap.calls.length = 0; });

describe("mutation gate stages the system file set", () => {
  it("puts the package first, the children next, and the mutant in its own slot", async () => {
    const r = await runMutationGate(gateArgs({ sharedPackageCode: PKG, childInterfaces: CHILDREN }));
    expect(r.total).toBeGreaterThan(0);
    expect(cap.calls.length).toBeGreaterThan(0);
    const p = cap.calls[0];
    expect(Object.keys(p.files)).toEqual([
      "uart_pkg.sv", "uart_tx.sv", "uart_loopback.sv", "uart_loopback_tb.sv",
    ]);
    // The MUTANT is what gets staged as the design, not the original.
    expect(p.files["uart_loopback.sv"]).not.toBe(MUTABLE_RTL);
    expect(p.files["uart_pkg.sv"]).toBe(PKG);
  });

  it("names sources once and the binary once — the run line is not a file list", async () => {
    await runMutationGate(gateArgs({ sharedPackageCode: PKG, childInterfaces: CHILDREN }));
    const cmds = cap.calls[0].commands;
    expect(cmds[0]).toContain("uart_pkg.sv uart_tx.sv uart_loopback.sv uart_loopback_tb.sv");
    expect(cmds[0]).toContain("-o uart_loopback.sv.sim");
    expect(cmds[1]).toBe("./obj_dir/uart_loopback.sv.sim");
  });

  it("a single-module run is byte-for-byte what it was before", async () => {
    await runMutationGate(gateArgs());
    const p = cap.calls[0];
    expect(Object.keys(p.files)).toEqual(["uart_loopback.sv", "uart_loopback_tb.sv"]);
    expect(p.commands).toEqual([
      "verilator --binary --build --assert -j 0 -Wall uart_loopback.sv uart_loopback_tb.sv -o uart_loopback.sv.sim",
      "./obj_dir/uart_loopback.sv.sim",
    ]);
  });
});

// ── coverage strengthening ─────────────────────────────────────────────────
describe("coverage strengthening stages the system file set", () => {
  function csArgs(extra) {
    const calls = [];
    const args = Object.assign({
      rtl: "module uart_loopback; endmodule",
      tb: "module tb; endmodule",
      cmds: SIM.slice(),
      rtlFileName: "uart_loopback.sv",
      tbFileName: "uart_loopback_tb.sv",
      spec: { requirements: [] },
      elicit: {},
      thresholds: { line: 80 },
      config: { backendUrl: "local" },
      cliOpts: {},
      signal: null,
      appendLog: function() {},
      // No coverage data → the loop stops at "no-baseline"/"no-gaps" after the
      // BASELINE measurement, which is the call this test is about.
      runCli: async function(_url, payload) { calls.push(payload); return { stdout: "", stderr: "", exitCode: 0, files: {} }; },
      callLLM: async function() { return { text: "{}" }; },
      extractJSON: JSON.parse,
    }, extra || {});
    return { args, calls };
  }

  it("measures against the package and the children", async () => {
    const { args, calls } = csArgs({ sharedPackageCode: PKG, childInterfaces: CHILDREN });
    await runCoverageStrengthening(args);
    expect(calls.length).toBeGreaterThan(0);
    expect(Object.keys(calls[0].files)).toEqual([
      "uart_pkg.sv", "uart_tx.sv", "uart_loopback.sv", "uart_loopback_tb.sv",
    ]);
    expect(calls[0].commands[0]).toContain("uart_pkg.sv uart_tx.sv uart_loopback.sv uart_loopback_tb.sv");
    expect(calls[0].commands[1]).toBe("./obj_dir/uart_loopback.sv.sim");
  });

  it("a single-module run stages the pair alone, as before", async () => {
    const { args, calls } = csArgs();
    await runCoverageStrengthening(args);
    expect(Object.keys(calls[0].files)).toEqual(["uart_loopback.sv", "uart_loopback_tb.sv"]);
  });
});

// ── the invariant itself ───────────────────────────────────────────────────
// Five sites were missed because each expanded {RTL} on its own. Expanding it
// is now cliFiles' job alone, so a sixth site cannot be added by accident:
// a raw replace anywhere under src/pipeline/ fails this test by construction.
describe("{RTL} is expanded in exactly one place", () => {
  const DIR = join(process.cwd(), "src", "pipeline");

  function jsFiles(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...jsFiles(join(dir, e.name)));
      else if (e.name.endsWith(".js")) out.push(join(dir, e.name));
    }
    return out;
  }

  it("no module under src/pipeline expands the slot itself — cliFiles does", () => {
    const RAW = /\.replace\(\s*(?:"\{RTL\}"|'\{RTL\}'|\/\\\{RTL\\\}\/)/;
    const offenders = jsFiles(DIR)
      .filter((f) => !f.endsWith("cliFiles.js"))
      .filter((f) => RAW.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(f.indexOf("src/pipeline")));
    expect(offenders).toEqual([]);
  });
});
