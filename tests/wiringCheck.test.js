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
