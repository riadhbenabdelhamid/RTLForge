import { describe, expect, it } from "vitest";
import {
  extractUserInterfaceContract,
  extractRTLInterface,
  interfaceContractViolations,
  validateRTLInterface,
} from "../src/utils/interfaceContract.js";

describe("explicit interface contracts", function() {
  it("preserves an explicitly named module and varied port declarations", function() {
    const c = extractUserInterfaceContract(
      "Implement module named PacketCore with ports: input clk, input [7:0] data_i, "
      + "output [3:0] status, inout io_pad. parameter WIDTH (default 8)."
    );
    expect(c.moduleName).toBe("PacketCore");
    expect(c.ports).toEqual([
      { name: "clk", dir: "input", width: "1" },
      { name: "data_i", dir: "input", width: "[7:0]" },
      { name: "status", dir: "output", width: "[3:0]" },
      { name: "io_pad", dir: "inout", width: "1" },
    ]);
    expect(c.params).toEqual([{ name: "WIDTH", def: "8" }]);
  });

  it("supports declaration lines and does not infer contracts from ordinary prose", function() {
    const c = extractUserInterfaceContract(
      "module CamelCase\n"
      + "input logic [15:0] address;\n"
      + "output logic response;"
    );
    expect(c.moduleName).toBe("CamelCase");
    expect(c.ports).toEqual([
      { name: "address", dir: "input", width: "[15:0]" },
      { name: "response", dir: "output", width: "1" },
    ]);
    expect(extractUserInterfaceContract("A small FIFO with useful input and output signals").explicit.ports).toBe(false);
  });

  it("parses a generated ANSI header and catches name, direction, width, and extras", function() {
    const source = "module PacketCore #(parameter WIDTH = 8) ("
      + "input logic clk, input logic [7:0] data_i, output logic [3:0] status"
      + "); assign status = data_i[3:0]; endmodule";
    const actual = extractRTLInterface(source, "PacketCore");
    expect(actual.moduleName).toBe("PacketCore");
    expect(actual.ports).toHaveLength(3);
    const expected = {
      moduleName: "PacketCore",
      ports: [
        { name: "clk", dir: "input", width: "1" },
        { name: "data_i", dir: "input", width: "8" },
        { name: "status", dir: "output", width: "4" },
      ],
      params: [{ name: "WIDTH", def: "8" }],
      explicit: { moduleName: true, ports: true, params: true },
    };
    expect(interfaceContractViolations(actual, expected, { exactPorts: true })).toEqual([]);
    expect(validateRTLInterface(source.replace("data_i", "data_o"), expected, { exactPorts: true })
      .map(function(x) { return x.kind; })).toContain("missing_port");
  });

  it("keeps case-distinct identifiers distinct and handles multiple ANSI qualifiers", function() {
    const source = "module M (input logic signed [7:0] Data, output logic data); endmodule";
    const actual = extractRTLInterface(source, "M");
    expect(actual.ports).toEqual([
      { name: "Data", dir: "input", width: "[7:0]" },
      { name: "data", dir: "output", width: "1" },
    ]);
    const expected = extractUserInterfaceContract(
      "module named M with ports: input [7:0] Data, output data"
    );
    expect(interfaceContractViolations(actual, expected, { exactPorts: true })).toEqual([]);
  });

  it("parses typed parameters and inherits ANSI direction and width", function() {
    const source = "module M #(parameter int WIDTH = 8, parameter logic [3:0] MODE = 2) ("
      + "input logic [7:0] a, b, output logic y); endmodule";
    expect(extractRTLInterface(source, "M")).toEqual({
      moduleName: "M",
      ports: [
        { name: "a", dir: "input", width: "[7:0]" },
        { name: "b", dir: "input", width: "[7:0]" },
        { name: "y", dir: "output", width: "1" },
      ],
      params: [
        { name: "WIDTH", def: "8" },
        { name: "MODE", def: "2" },
      ],
      complete: true,
    });
  });

  it("treats port spelling as case-sensitive for exact contracts", function() {
    const actual = extractRTLInterface("module M (input data); endmodule", "M");
    const issues = interfaceContractViolations(actual, {
      moduleName: "M",
      ports: [{ name: "Data", dir: "input", width: "1" }],
      explicit: { moduleName: true, ports: true },
    }, { exactPorts: true });
    expect(issues.map(function(issue) { return issue.kind; })).toEqual(["missing_port", "extra_port"]);
  });

  it("distinguishes an exhaustive port list from a partial declaration", function() {
    const complete = extractUserInterfaceContract("module named M with ports: input clk, output done");
    expect(complete.explicit.portsExhaustive).toBe(true);
    const partial = extractUserInterfaceContract("module named M\ninput clk;\nThe remaining interface is described below.");
    expect(partial.ports).toEqual([{ name: "clk", dir: "input", width: "1" }]);
    expect(partial.explicit.portsExhaustive).toBe(false);

    const actual = extractRTLInterface("module M (input clk, output done); endmodule", "M");
    expect(interfaceContractViolations(actual, partial, { exactPorts: partial.explicit.portsExhaustive })
      .map(function(issue) { return issue.kind; })).toEqual([]);
  });

  it("ignores module words in comments while selecting the real header", function() {
    const source = "// module Fake(input bad);\nmodule Real(input logic good); endmodule";
    expect(extractRTLInterface(source, "Real").moduleName).toBe("Real");
    expect(extractRTLInterface(source, "Real").ports[0].name).toBe("good");
  });

  it("reports a missing header without treating implementation text as an interface", function() {
    const issues = validateRTLInterface("assign x = y;", { moduleName: "M", ports: [{ name: "x", dir: "output", width: "1" }], explicit: { moduleName: true, ports: true } });
    expect(issues).toEqual([{ kind: "header", message: "module header could not be parsed" }]);
  });
});
