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
import { withSharedPackage, cmdWithFiles, sharedPkgFileName, SHARED_PKG_FILE, childRtlFiles } from "../src/pipeline/cliFiles.js";
import { buildChildInterfaces } from "../src/projectState/childInterfaces.js";

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
    expect(r.order).toEqual(["shared_pkg_waivers.vlt", "uart_pkg.sv", "dut.sv"]);
    expect(r.files["uart_pkg.sv"]).toBe(PKG);
    expect(r.files["dut.sv"]).toContain("module m");
  });

  it("keeps the caller's own order after the package", () => {
    const r = withSharedPackage({ "dut.sv": "a", "tb.sv": "b" }, PKG);
    expect(r.order).toEqual(["shared_pkg_waivers.vlt", "uart_pkg.sv", "dut.sv", "tb.sv"]);
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
      .toBe("verilator --lint-only -Wall shared_pkg_waivers.vlt uart_pkg.sv dut.sv");
    expect(cmdWithFiles("a {RTL} b {RTL}", ["x.sv"])).toBe("a x.sv b x.sv");
  });

  it("leaves a template with no slot alone", () => {
    expect(cmdWithFiles("verilator --version", ["x.sv"])).toBe("verilator --version");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Only the FIRST {RTL} slot is the file list (run 47). The default simCmds
// names {RTL} three times — once for the sources, twice to name the output
// binary — so substituting a multi-file list everywhere produced
// `-o uart_pkg.sv dut.sv.sim` and a run command that could not exist. The
// build failed with an empty evidence string, and triage read that as a
// compilation failure of the design.
// ═══════════════════════════════════════════════════════════════════════════
describe("cmdWithFiles: later slots keep the primary file", () => {
  const SIM = "verilator --binary --build --assert -j 0 -Wall {RTL} {TB} -o {RTL}.sim\n./obj_dir/{RTL}.sim";

  it("expands the sources once and the binary name as one file", () => {
    const out = cmdWithFiles(SIM, ["uart_pkg.sv", "dut.sv"], "dut.sv");
    expect(out).toContain("-Wall uart_pkg.sv dut.sv {TB}");
    expect(out).toContain("-o dut.sv.sim");
    expect(out).toContain("./obj_dir/dut.sv.sim");
    expect(out).not.toContain("-o uart_pkg.sv dut.sv.sim");
  });

  it("defaults the primary to the last file when none is given", () => {
    expect(cmdWithFiles("verilator {RTL} -o {RTL}.sim", ["pkg.sv", "dut.sv"]))
      .toBe("verilator pkg.sv dut.sv -o dut.sv.sim");
  });

  it("the RUN command names the binary, never the source list", () => {
    // simCmds is a multi-line script substituted line by line, so a
    // per-command "first occurrence" rule handed the run line the file list
    // and the shell reported ./obj_dir/uart_pkg.sv: not found.
    expect(cmdWithFiles("./obj_dir/{RTL}.sim", ["uart_pkg.sv", "dut.sv"], "dut.sv"))
      .toBe("./obj_dir/dut.sim".replace("dut.sim", "dut.sv.sim"));
    expect(cmdWithFiles("./{RTL}.sim && echo done", ["pkg.sv", "dut.sv"], "dut.sv"))
      .toBe("./dut.sv.sim && echo done");
  });

  it("recognises the common compiler front-ends", () => {
    for (const cc of ["verilator", "iverilog", "vlog", "xvlog"]) {
      expect(cmdWithFiles(cc + " -Wall {RTL}", ["pkg.sv", "dut.sv"], "dut.sv"))
        .toBe(cc + " -Wall pkg.sv dut.sv");
    }
  });

  it("a single-file run is unchanged in every slot", () => {
    expect(cmdWithFiles(SIM, ["dut.sv"], "dut.sv"))
      .toBe(SIM.replace(/\{RTL\}/g, "dut.sv"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Child RTL travels with the parent (run 47). A top level instantiates its
// children by name, so linting or simulating it ALONE reports "Cannot find
// file containing module" — true of every top level in every system, and not
// a defect in the parent.
// ═══════════════════════════════════════════════════════════════════════════
describe("childRtlFiles", () => {
  it("collects every child that has generated RTL", () => {
    const files = childRtlFiles([
      { modName: "uart_tx", code: "module uart_tx; endmodule" },
      { modName: "uart_rx", code: "module uart_rx; endmodule" },
    ]);
    expect(Object.keys(files).sort()).toEqual(["uart_rx.sv", "uart_tx.sv"]);
    expect(files["uart_tx.sv"]).toContain("module uart_tx");
  });

  it("skips a child whose RTL has not been generated yet", () => {
    expect(childRtlFiles([{ modName: "uart_tx", code: null }])).toEqual({});
    expect(childRtlFiles([{ modName: "uart_tx" }])).toEqual({});
  });

  it("is empty for a leaf module with no children", () => {
    expect(childRtlFiles([])).toEqual({});
    expect(childRtlFiles(null)).toEqual({});
  });

  it("children lead the file list once the package is added", () => {
    const own = Object.assign(childRtlFiles([{ modName: "uart_tx", code: "m" }]), { "top.sv": "t" });
    const r = withSharedPackage(own, "package uart_pkg;\nendpackage");
    expect(r.order[0]).toBe("shared_pkg_waivers.vlt");
    expect(r.order[1]).toBe("uart_pkg.sv");
    expect(r.order).toContain("uart_tx.sv");
    expect(r.order[r.order.length - 1]).toBe("top.sv");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A shared package's unused items are not decidable per module (run 48).
//
// merge_pkg declares N_CH for the arbiter's port widths; the FIFO uses only
// beat_t. Compiling the FIFO against that package under warnings-as-errors
// dies on "Parameter is not used: 'N_CH'" and produces no binary at all.
//
// LATENT rather than live: verify injects -Wno-fatal unless
// verifyWarningsAsErrors is set (run 10), so the default path builds. With
// that flag on, every module that does not use every package item would
// fail — a correct module against a correct package. Lint passes it either
// way (UNUSEDPARAM is hygiene-tier), so the failure lands one stage later
// naming a file the module's fix loop must not change.
// ═══════════════════════════════════════════════════════════════════════════
describe("shared package waiver (run 48)", () => {
  const MERGE_PKG = "`timescale 1ns/1ps\npackage merge_pkg;\n  localparam int N_CH = 2;\nendpackage";

  it("stages a waiver whenever a package is staged", () => {
    const r = withSharedPackage({ "sync_fifo.sv": "m" }, MERGE_PKG);
    expect(r.order).toContain("shared_pkg_waivers.vlt");
    expect(r.files["shared_pkg_waivers.vlt"]).toContain("`verilator_config");
  });

  it("scopes the waiver to the package's own file, not to every file", () => {
    const w = withSharedPackage({ "sync_fifo.sv": "m" }, MERGE_PKG)
      .files["shared_pkg_waivers.vlt"];
    expect(w).toContain('-file "*merge_pkg.sv"');
    expect(w).not.toContain("sync_fifo.sv");
  });

  it("waives only the rules a per-module compile cannot decide", () => {
    const w = withSharedPackage({ "dut.sv": "m" }, MERGE_PKG)
      .files["shared_pkg_waivers.vlt"];
    expect(w).toContain("lint_off -rule UNUSEDPARAM");
    expect(w).toContain("lint_off -rule UNUSEDSIGNAL");
    // a package in the wrong file is decidable, and stays an error
    expect(w).not.toContain("DECLFILENAME");
    // nothing that could hide a real bug in the module under test
    expect(w).not.toContain("WIDTH");
    expect(w).not.toContain("CASEINCOMPLETE");
    expect(w).not.toContain("LATCH");
  });

  it("follows the package's declared name when it changes", () => {
    const w = withSharedPackage({ "dut.sv": "m" }, "package uart_pkg;\nendpackage")
      .files["shared_pkg_waivers.vlt"];
    expect(w).toContain('-file "*uart_pkg.sv"');
  });

  it("leaves a single-module run byte-identical — no package, no waiver", () => {
    const r = withSharedPackage({ "dut.sv": "a", "tb.sv": "b" }, null);
    expect(Object.keys(r.files)).toEqual(["dut.sv", "tb.sv"]);
    expect(r.order).toEqual(["dut.sv", "tb.sv"]);
  });

  it("puts the waiver where a compiler reads it — in the {RTL} file list", () => {
    const { order } = withSharedPackage({ "sync_fifo.sv": "m", "tb.sv": "t" }, MERGE_PKG);
    const cmd = cmdWithFiles("verilator --binary --build -Wall {RTL} -o {RTL}.sim", order);
    expect(cmd).toContain("shared_pkg_waivers.vlt merge_pkg.sv sync_fifo.sv tb.sv");
    // and never into the slot that names the output binary
    expect(cmd).toContain("-o tb.sv.sim");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Hierarchy has no depth limit, so neither can the file set (run 48).
//
// 1c4b36c made a parent's stages compile against its CHILDREN. At depth two
// that is not enough: pkt_merge_top instantiates ingress_channel, which
// instantiates sync_fifo, and staging only the direct children produced
//   %Error-MODMISSING: ingress_channel.sv:73: Cannot find file containing
//                      module: 'sync_fifo'
// attributed to the TOP's source, at a line belonging to another file. The
// lint fix loop was then handed a finding about a module with nothing wrong
// with it, and every fix available to it would have damaged a correct file.
// ═══════════════════════════════════════════════════════════════════════════
describe("descendant RTL travels with the parent (run 48)", () => {
  const modules = {
    pkt_merge_top:   { stageData: { 4: { code: "module pkt_merge_top; endmodule" } } },
    ingress_channel: { stageData: { 4: { code: "module ingress_channel; endmodule" } } },
    rr_arbiter:      { stageData: { 4: { code: "module rr_arbiter; endmodule" } } },
    sync_fifo:       { stageData: { 4: { code: "module sync_fifo; endmodule" } } },
  };
  const instances = {
    u_ch0: { parentModuleId: "pkt_merge_top",   moduleId: "ingress_channel", instanceName: "u_ch0", paramOverrides: { DEPTH: 4 } },
    u_ch1: { parentModuleId: "pkt_merge_top",   moduleId: "ingress_channel", instanceName: "u_ch1", paramOverrides: { DEPTH: 8 } },
    u_arb: { parentModuleId: "pkt_merge_top",   moduleId: "rr_arbiter",      instanceName: "u_arb", paramOverrides: {} },
    u_fifo:{ parentModuleId: "ingress_channel", moduleId: "sync_fifo",       instanceName: "u_fifo", paramOverrides: { DEPTH: "DEPTH" } },
  };

  it("stages the grandchild the top never instantiates directly", () => {
    const ci = buildChildInterfaces("pkt_merge_top", modules, instances);
    const files = childRtlFiles(ci);
    expect(Object.keys(files).sort()).toEqual(
      ["ingress_channel.sv", "rr_arbiter.sv", "sync_fifo.sv"]);
  });

  it("names each module once however many times it is instantiated", () => {
    // ingress_channel is placed twice, so sync_fifo is reachable twice
    const files = childRtlFiles(buildChildInterfaces("pkt_merge_top", modules, instances));
    expect(Object.keys(files).filter((f) => f === "sync_fifo.sv").length).toBe(1);
  });

  it("still gives the parent only its DIRECT children as interfaces", () => {
    // what a parent is TOLD it instantiates must not change — a grandchild is
    // a compilation dependency, not an interface this module wires
    const ci = buildChildInterfaces("pkt_merge_top", modules, instances);
    expect(ci.map((c) => c.moduleId).sort()).toEqual(
      ["ingress_channel", "ingress_channel", "rr_arbiter"]);
  });

  it("a depth-1 parent is unchanged — its children have no children", () => {
    const ci = buildChildInterfaces("ingress_channel", modules, instances);
    expect(Object.keys(childRtlFiles(ci))).toEqual(["sync_fifo.sv"]);
    expect(ci[0].descendants).toEqual([]);
  });

  it("a leaf stages nothing", () => {
    expect(childRtlFiles(buildChildInterfaces("sync_fifo", modules, instances))).toEqual({});
  });

  it("skips a descendant whose RTL has not been generated yet", () => {
    const partial = Object.assign({}, modules, { sync_fifo: { stageData: {} } });
    const files = childRtlFiles(buildChildInterfaces("pkt_merge_top", partial, instances));
    expect(Object.keys(files).sort()).toEqual(["ingress_channel.sv", "rr_arbiter.sv"]);
  });

  it("terminates on a cyclic registry instead of recursing forever", () => {
    const cyclic = {
      a: { parentModuleId: "top", moduleId: "a", instanceName: "u_a", paramOverrides: {} },
      b: { parentModuleId: "a",   moduleId: "b", instanceName: "u_b", paramOverrides: {} },
      c: { parentModuleId: "b",   moduleId: "a", instanceName: "u_c", paramOverrides: {} },
    };
    const mods = {
      top: { stageData: {} },
      a: { stageData: { 4: { code: "module a; endmodule" } } },
      b: { stageData: { 4: { code: "module b; endmodule" } } },
    };
    const files = childRtlFiles(buildChildInterfaces("top", mods, cyclic));
    expect(Object.keys(files).sort()).toEqual(["a.sv", "b.sv"]);
  });

  it("the whole subtree reaches the compiler through the {RTL} slot", () => {
    const own = Object.assign(
      childRtlFiles(buildChildInterfaces("pkt_merge_top", modules, instances)),
      { "pkt_merge_top.sv": "module pkt_merge_top; endmodule" });
    const { order } = withSharedPackage(own, "package merge_pkg;\nendpackage");
    const cmd = cmdWithFiles("verilator --lint-only -Wall {RTL}", order);
    expect(cmd).toContain("sync_fifo.sv");
    expect(cmd).toContain("ingress_channel.sv");
    expect(order[order.length - 1]).toBe("pkt_merge_top.sv");
  });
});
