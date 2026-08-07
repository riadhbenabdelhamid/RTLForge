// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Shared package in the CLI file set (run 47, the first system run).
//
// A module in a multi-module system imports the shared package — that is the
// point of having one. The per-module stages compiled the module ALONE, so
// `import uart_pkg::*;` failed with "Import package not found", and the fix
// loop would then have pushed the model to DELETE the import to satisfy lint,
// breaking the contract the package exists to enforce.
//
// Two details the real toolchain forced, both measured against Verilator:
//   • the package must LEAD the file list — elaboration is in order;
//   • the file must be named after the package, or DECLFILENAME fires, and
//     under warnings-as-errors that warning fails the stage.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { withSharedPackage, cmdWithFiles, sharedPkgFileName, SHARED_PKG_FILE } from "../src/pipeline/cliFiles.js";

const PKG = "`timescale 1ns/1ps\npackage uart_pkg;\n  localparam int CLKS_PER_BIT = 4;\nendpackage : uart_pkg\n";

describe("sharedPkgFileName", () => {
  it("names the file after the package", () => {
    expect(sharedPkgFileName(PKG)).toBe("uart_pkg.sv");
    expect(sharedPkgFileName("package p;\nendpackage")).toBe("p.sv");
  });

  it("falls back when there is no package declaration to read", () => {
    expect(sharedPkgFileName("")).toBe(SHARED_PKG_FILE);
    expect(sharedPkgFileName(null)).toBe(SHARED_PKG_FILE);
    expect(sharedPkgFileName("module m; endmodule")).toBe(SHARED_PKG_FILE);
  });
});

describe("withSharedPackage", () => {
  it("puts the package FIRST so it elaborates before its importer", () => {
    const r = withSharedPackage({ "dut.sv": "module m; endmodule" }, PKG);
    expect(r.order).toEqual(["uart_pkg.sv", "dut.sv"]);
    expect(r.files["uart_pkg.sv"]).toBe(PKG);
    expect(r.files["dut.sv"]).toContain("module m");
  });

  it("keeps the caller's own order after the package", () => {
    const r = withSharedPackage({ "dut.sv": "a", "tb.sv": "b" }, PKG);
    expect(r.order).toEqual(["uart_pkg.sv", "dut.sv", "tb.sv"]);
  });

  it("is a no-op for a single-module run with no package", () => {
    for (const empty of [null, "", "   ", undefined]) {
      const r = withSharedPackage({ "dut.sv": "a" }, empty);
      expect(r.order).toEqual(["dut.sv"]);
      expect(Object.keys(r.files)).toEqual(["dut.sv"]);
    }
  });

  it("does not mutate the caller's file map", () => {
    const own = { "dut.sv": "a" };
    withSharedPackage(own, PKG);
    expect(Object.keys(own)).toEqual(["dut.sv"]);
  });
});

describe("cmdWithFiles", () => {
  it("substitutes every {RTL} slot with the ordered file list", () => {
    const { order } = withSharedPackage({ "dut.sv": "a" }, PKG);
    expect(cmdWithFiles("verilator --lint-only -Wall {RTL}", order))
      .toBe("verilator --lint-only -Wall uart_pkg.sv dut.sv");
    expect(cmdWithFiles("a {RTL} b {RTL}", ["x.sv"])).toBe("a x.sv b x.sv");
  });

  it("leaves a template with no slot alone", () => {
    expect(cmdWithFiles("verilator --version", ["x.sv"])).toBe("verilator --version");
  });
});
