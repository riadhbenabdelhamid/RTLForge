// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Deterministic wiring checker (SoC roadmap S2).

import { describe, it, expect } from "vitest";
import { checkSystemWiring, parseModuleHeader, parseInstantiation } from "../src/pipeline/wiringCheck.js";

const CHILD = `module cnt #(parameter W = 8, parameter INIT = 0)(
  input  logic clk,
  input  logic rst_n,
  output logic [W-1:0] q
);
endmodule`;

const GOOD_TOP = `module top(input logic clk, input logic rst_n, output logic [7:0] q);
  cnt #(.W(8)) u_cnt0 (.clk(clk), .rst_n(rst_n), .q(q));
endmodule`;

const inst = (over) => [{ instanceName: "u_cnt0", moduleId: "cnt", parentId: "top", paramOverrides: over || { W: 8 } }];

describe("parseModuleHeader / parseInstantiation", () => {
  it("extracts ports with directions and parameter names", () => {
    const h = parseModuleHeader(CHILD, "cnt");
    expect(h.ports).toEqual([
      { name: "clk", dir: "input" }, { name: "rst_n", dir: "input" }, { name: "q", dir: "output" },
    ]);
    expect(h.params).toEqual(["W", "INIT"]);
  });
  it("extracts named connections and overrides with balanced parens", () => {
    const p = parseInstantiation(GOOD_TOP, "cnt", "u_cnt0");
    expect(p.connections).toEqual(["clk", "rst_n", "q"]);
    expect(p.overrides).toEqual(["W"]);
    expect(parseInstantiation("module top; endmodule", "cnt", "u_cnt0")).toBe(null);
  });

  // Run 51, rv_pipeline. A port list is commented like any other code, and
  // those comments sit inside the parentheses this parser splits on commas.
  // "// Instruction memory: address out in fetch, word back in decode" split
  // into an entry ending in `fetch`, and the direction keyword is sticky from
  // the port above, so a phantom `input fetch` joined the interface — along
  // with `memory` from the comment below it. The top was then told to connect
  // two ports that do not exist, and the repair prompt asks for the MINIMAL
  // fix: obeying it means inventing connections that cannot compile.
  it("does not read a comment inside the port list as a port", () => {
    const COMMENTED = [
      "module pipe (",
      "    input  logic        clk,",
      "    input  logic        rst_n,",
      "    // Instruction memory: address out in fetch, word back in decode",
      "    output logic [31:0] imem_addr,",
      "    input  logic [31:0] imem_rdata,",
      "    /* Data memory: address out in memory, word back in write-back */",
      "    output logic [31:0] dmem_addr",
      ");",
      "endmodule",
    ].join("\n");
    const h = parseModuleHeader(COMMENTED, "pipe");
    expect(h.ports.map((p) => p.name))
      .toEqual(["clk", "rst_n", "imem_addr", "imem_rdata", "dmem_addr"]);
    expect(h.ports.map((p) => p.name)).not.toContain("fetch");
    expect(h.ports.map((p) => p.name)).not.toContain("memory");
  });

  it("does not anchor an instantiation scan on the type named in a comment", () => {
    const TOP = [
      "module top;",
      "  logic clk, rst_n, q;",
      "  // one cnt drives the counter below; a second cnt would need its own",
      "  cnt #(.W(8)) u_cnt0 (.clk(clk), .rst_n(rst_n), .q(q));",
      "endmodule",
    ].join("\n");
    const p = parseInstantiation(TOP, "cnt", "u_cnt0");
    expect(p).not.toBe(null);
    expect(p.connections).toEqual(["clk", "rst_n", "q"]);
  });
});

describe("checkSystemWiring", () => {
  const children = [{ modName: "cnt", code: CHILD }];

  it("clean system → no issues", () => {
    expect(checkSystemWiring({ topRTL: GOOD_TOP, children, instances: inst() }).issues).toEqual([]);
  });
  it("connection to a nonexistent child port is an error", () => {
    const top = GOOD_TOP.replace(".q(q)", ".qq(q)");
    const { issues } = checkSystemWiring({ topRTL: top, children, instances: inst() });
    expect(issues.some((i) => i.kind === "NO_SUCH_PORT" && i.sev === "error")).toBe(true);
    expect(issues.some((i) => i.kind === "UNCONNECTED_OUTPUT")).toBe(true);   // q now dangling
  });
  it("an unconnected child INPUT is an error; output only a warning", () => {
    const top = GOOD_TOP.replace(".rst_n(rst_n), ", "");
    const { issues } = checkSystemWiring({ topRTL: top, children, instances: inst() });
    const rst = issues.find((i) => i.kind === "UNCONNECTED_INPUT");
    expect(rst.sev).toBe("error");
    expect(rst.instance).toBe("u_cnt0");
  });
  it("a paramOverride the child does not declare is an error", () => {
    const { issues } = checkSystemWiring({ topRTL: GOOD_TOP, children, instances: inst({ DEPTH: 16 }) });
    expect(issues.some((i) => i.kind === "BAD_PARAM" && /DEPTH/.test(i.msg))).toBe(true);
  });
  it("a planned instance missing from the top is an error; unknown module type too", () => {
    const { issues } = checkSystemWiring({ topRTL: "module top; endmodule", children, instances: inst() });
    expect(issues.some((i) => i.kind === "MISSING_INSTANCE")).toBe(true);
    const unknown = checkSystemWiring({ topRTL: GOOD_TOP, children: [], instances: inst() });
    expect(unknown.issues.some((i) => i.kind === "UNKNOWN_MODULE")).toBe(true);
  });
  it("duplicate instance names and never-instantiated modules are flagged", () => {
    const dup = checkSystemWiring({ topRTL: GOOD_TOP, children, instances: [...inst(), ...inst()] });
    expect(dup.issues.some((i) => i.kind === "DUPLICATE_INSTANCE")).toBe(true);
    const unused = checkSystemWiring({
      topRTL: GOOD_TOP, children: [...children, { modName: "orphan", code: "module orphan(input logic a); endmodule" }],
      instances: inst(),
    });
    expect(unused.issues.some((i) => i.kind === "UNUSED_MODULE" && i.sev === "warning")).toBe(true);
  });
  it("degrades to warnings on unparseable style — never a false error", () => {
    const positional = "module top(input logic clk);\n  cnt u_cnt0 (clk, 1'b1, );\nendmodule";
    const { issues } = checkSystemWiring({ topRTL: positional, children, instances: inst({}) });
    expect(issues.every((i) => i.sev === "warning")).toBe(true);
    expect(issues.some((i) => i.kind === "UNPARSED_CONNECTIONS")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A hierarchy the checker had never seen (run 48).
//
// Two defects, both invisible at depth one with one instance per type:
//
//   u_ch1  — parseInstantiation anchored on the FIRST occurrence of the type
//            name and scanned forward to the instance name, so for a type
//            placed twice the span between u_ch0's occurrence and u_ch1's
//            name held u_ch0's own `);` and the statement guard rejected it.
//            Every instance after the first read as MISSING_INSTANCE.
//
//   u_fifo — every planned instance was checked against the TOP's source,
//            including one whose parent is a child module. The top was told
//            to instantiate its own grandchild.
//
// Both findings were errors against a system that was correct, and the
// repair prompt they produced would have damaged it.
// ═══════════════════════════════════════════════════════════════════════════
describe("repeated instances and depth-2 hierarchy (run 48)", () => {
  const CH = `module ingress_channel #(parameter int DEPTH = 4) (
  input logic clk, input logic rst_n, input logic in_valid, output logic in_ready,
  output logic req, input logic gnt, output logic out_valid, input logic out_ready
);
  sync_fifo #(.DEPTH(DEPTH)) u_fifo (.clk(clk), .rst_n(rst_n));
endmodule`;
  const ARB = `module rr_arbiter (
  input logic clk, input logic rst_n, input logic req, input logic done, output logic gnt
);
endmodule`;
  const FIFO = `module sync_fifo #(parameter int DEPTH = 4) (
  input logic clk, input logic rst_n
);
endmodule`;
  const TOP = `module pkt_merge_top (
  input logic clk, input logic rst_n, output logic out_valid
);
  ingress_channel #(.DEPTH(4)) u_ch0 (
    .clk(clk), .rst_n(rst_n), .in_valid(v0), .in_ready(r0),
    .req(q0), .gnt(g0), .out_valid(ov0), .out_ready(or0)
  );

  ingress_channel #(.DEPTH(8)) u_ch1 (
    .clk(clk), .rst_n(rst_n), .in_valid(v1), .in_ready(r1),
    .req(q1), .gnt(g1), .out_valid(ov1), .out_ready(or1)
  );

  rr_arbiter u_arb (.clk(clk), .rst_n(rst_n), .req(q0), .done(d), .gnt(g0));
endmodule`;

  const children = [
    { modName: "ingress_channel", code: CH },
    { modName: "rr_arbiter", code: ARB },
    { modName: "sync_fifo", code: FIFO },
  ];
  const instances = [
    { instanceName: "u_ch0", moduleId: "ingress_channel", parentModuleId: "pkt_merge_top", paramOverrides: { DEPTH: 4 } },
    { instanceName: "u_ch1", moduleId: "ingress_channel", parentModuleId: "pkt_merge_top", paramOverrides: { DEPTH: 8 } },
    { instanceName: "u_arb", moduleId: "rr_arbiter", parentModuleId: "pkt_merge_top", paramOverrides: {} },
    { instanceName: "u_fifo", moduleId: "sync_fifo", parentModuleId: "ingress_channel", paramOverrides: { DEPTH: "DEPTH" } },
  ];
  const sys = { topRTL: TOP, children, instances, topModuleId: "pkt_merge_top" };

  it("finds the SECOND instance of a type placed twice", () => {
    const p = parseInstantiation(TOP, "ingress_channel", "u_ch1");
    expect(p).not.toBeNull();
    expect(p.connections).toContain("out_ready");
    expect(p.overrides).toContain("DEPTH");
  });

  it("still finds the first one", () => {
    expect(parseInstantiation(TOP, "ingress_channel", "u_ch0")).not.toBeNull();
  });

  it("reports no issue at all on a correct depth-2 system", () => {
    expect(checkSystemWiring(sys).issues).toEqual([]);
  });

  it("does not ask the top to instantiate its own grandchild", () => {
    const kinds = checkSystemWiring(sys).issues.map((i) => i.instance);
    expect(kinds).not.toContain("u_fifo");
  });

  it("does not call a module unused because a CHILD is what places it", () => {
    const issues = checkSystemWiring(sys).issues;
    expect(issues.filter((i) => i.kind === "UNUSED_MODULE")).toEqual([]);
  });

  it("still reports an instance the top genuinely never places", () => {
    const missing = instances.concat([{
      instanceName: "u_ch2", moduleId: "ingress_channel",
      parentModuleId: "pkt_merge_top", paramOverrides: {},
    }]);
    const issues = checkSystemWiring(Object.assign({}, sys, { instances: missing })).issues;
    expect(issues.some((i) => i.kind === "MISSING_INSTANCE" && i.instance === "u_ch2")).toBe(true);
  });

  it("keeps checking every instance when no topModuleId is supplied", () => {
    // older callers pass no top id — behaviour must not silently narrow
    const issues = checkSystemWiring({ topRTL: TOP, children, instances }).issues;
    expect(issues.some((i) => i.instance === "u_fifo")).toBe(true);
  });
});
