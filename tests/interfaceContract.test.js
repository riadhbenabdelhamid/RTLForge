import { describe, expect, it } from "vitest";
import {
  extractUserInterfaceContract,
  extractRTLInterface,
  interfaceContractViolations,
  validateRTLInterface,
  validateRequiredModuleName,
} from "../src/utils/interfaceContract.js";

describe("explicit interface contracts", function() {
  it("scopes ports and parameters to the requested child rather than the enclosing code", function() {
    const c = extractUserInterfaceContract("Implement module named Leaf with the following\n"
      + "interface. All ports are one bit.\n- input tick\n- output ready\n\n"
      + "Consider the enclosing implementation:\nmodule Container #(parameter LANES = 7) (\n"
      + "input [6:0] payload,\ninput tick,\noutput [6:0] result);\nendmodule");
    expect(c.ports).toEqual([{ name: "tick", dir: "input", width: "1" }, { name: "ready", dir: "output", width: "1" }]);
    expect(c.params).toEqual([]);
    expect(c.explicit.portsExhaustive).toBe(true);
  });

  it("recognizes an interface introduced by a sentence without making a partial list exhaustive", function() {
    const c = extractUserInterfaceContract("Consider a top-level module with the following interface:\n\n- input tick\n- output ready");
    expect(c.ports.map(p => p.name)).toEqual(["tick", "ready"]);
    expect(c.explicit.portsExhaustive).toBe(false);
  });
  it("reads a labelled interface followed by prose without promoting an example heading", function() {
    const list = "Interface. Signal widths appear in parentheses.\n- input tick\n- input word (9 bits)\n- output result (9 bits)";
    const c = extractUserInterfaceContract("Implement module named CaptureUnit with this\n" + list);
    expect(c.ports).toEqual([
      { name: "tick", dir: "input", width: "1" },
      { name: "word", dir: "input", width: "9" },
      { name: "result", dir: "output", width: "9" },
    ]);
    expect(c.explicit.portsExhaustive).toBe(false);
    expect(extractUserInterfaceContract("For example:\n" + list).ports).toEqual([]);
    expect(extractUserInterfaceContract("An incidental interface mention.\n- input word").ports).toEqual([]);
  });

  it("does not freeze declarations from an implementation annotated as defective afterward", function() {
    for (const fenced of [false, true]) {
      const broken = "module DraftUnit #(parameter LANES = 3) (\ninput data_i,\noutput data_o\n);\nassign data_o = data_i;\nendmodule";
      const desc = "Inspect this implementation:\n" + (fenced ? "```sv\n" : "") + broken
        + (fenced ? "\n```" : "") + "\n\nUnfortunately, this module has a bug. Repair it.\n\n"
        + "The required module named CorrectUnit has ports: input [5:0] data_i, output [5:0] data_o.";
      const c = extractUserInterfaceContract(desc);
      expect(c.moduleName).toBe("CorrectUnit");
      expect(c.params).toEqual([]);
      expect(c.ports).toEqual([
        { name: "data_i", dir: "input", width: "[5:0]" },
        { name: "data_o", dir: "output", width: "[5:0]" },
      ]);
    }
  });

  it("keeps normative declarations when an unrelated later implementation is defective", function() {
    const c = extractUserInterfaceContract("module ContractUnit (\ninput [4:0] payload,\noutput valid\n);\nendmodule\n\n"
      + "Separately:\nmodule DraftUnit (\ninput bad\n);\nendmodule\nThis implementation is incorrect.");
    expect(c.moduleName).toBe("ContractUnit");
    expect(c.ports.map(p => p.name)).toEqual(["payload", "valid"]);
  });

  it("does not treat a mention of a repaired or absent bug as a defect annotation", function() {
    for (const note of ["This module has no bugs.", "This implementation fixes a bug in an earlier version."]) {
      const c = extractUserInterfaceContract("module ValidUnit (\ninput request,\noutput grant\n);\nendmodule\n" + note);
      expect(c.moduleName).toBe("ValidUnit");
      expect(c.ports.map(p => p.name)).toEqual(["request", "grant"]);
    }
  });

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

  it("rejects a generated RTL name that violates an optional exported-name contract", function() {
    const source = "module InternalName (input clk); endmodule";
    const expected = { moduleName: "InternalName", ports: [{ name: "clk", dir: "input", width: "1" }],
      explicit: { moduleName: true, ports: true } };
    const issues = validateRTLInterface(source, expected, { requiredModuleName: "RequiredTop" });
    expect(issues.map(function(issue) { return issue.kind; })).toContain("required_module_name");
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

  it("accepts an explicitly complete Markdown port list without reading examples", function() {
    const complete = extractUserInterfaceContract(
      "Interface ports (complete):\n- input clk\n- input [7:0] data_i\n- output ready"
    );
    expect(complete.ports.map(function(p) { return p.name; })).toEqual(["clk", "data_i", "ready"]);
    expect(complete.explicit.portsExhaustive).toBe(true);
    const example = extractUserInterfaceContract(
      "For example:\n```systemverilog\ninput bad;\n```\nThe actual interface is described elsewhere."
    );
    expect(example.explicit.ports).toBe(false);
  });

  it("does not promote module or parameter declarations from marked code examples", function() {
    const c = extractUserInterfaceContract(
      "For reference only:\n```systemverilog // buggy example\n"
      + "module WrongTop; parameter WIDTH = 99; input bad; endmodule\n```\n"
      + "The required module named RightTop is authoritative."
    );
    expect(c.moduleName).toBe("RightTop");
    expect(c.params).toEqual([]);
    expect(c.ports).toEqual([]);
  });

  it("ignores an example-only Ports list while retaining later declarations", function() {
    const c = extractUserInterfaceContract(
      "For example Ports: input toy, output sample_out.\n"
      + "Required interface ports: input clk, output done."
    );
    expect(c.ports.map(function(p) { return p.name; })).toEqual(["clk", "done"]);
    expect(c.explicit.portsExhaustive).toBe(true);
  });

  it("keeps a heading-scoped complete list exhaustive through trailing prose", function() {
    const description = [
      "## Complete interface ports",
      "- input clk",
      "- input rst_i",
      "- input [3:0] addr_i",
      "- input [7:0] data_i",
      "- output [7:0] data_o",
      "- output ready_o",
      "The paragraph after the list explains timing.",
      "## Implementation notes",
      "- input internal_debug",
    ].join("\n");
    const c = extractUserInterfaceContract(description);
    expect(c.ports.map(function(p) { return p.name; })).toEqual([
      "clk", "rst_i", "addr_i", "data_i", "data_o", "ready_o",
    ]);
    expect(c.explicit.portsExhaustive).toBe(true);
  });

  it("does not mark a complete list exhaustive when a bullet is unsupported", function() {
    const c = extractUserInterfaceContract(
      "Ports (complete):\n- input clk\n- output done\n- reset behavior is synchronous"
    );
    expect(c.ports.map(function(p) { return p.name; })).toEqual(["clk", "done"]);
    expect(c.explicit.portsExhaustive).toBe(false);
  });

  it("validates an optional exported name and rejects an authoritative conflict", function() {
    expect(validateRequiredModuleName("ExportedTop", { explicit: { moduleName: false } })).toBe("ExportedTop");
    expect(function() { validateRequiredModuleName("2bad", null); }).toThrow(/identifier/);
    expect(function() { validateRequiredModuleName("module", null); }).toThrow(/reserved/);
    expect(function() { validateRequiredModuleName("initial", null); }).toThrow(/reserved/);
    expect(function() { validateRequiredModuleName("class", null); }).toThrow(/reserved/);
    expect(validateRequiredModuleName("Module", null)).toBe("Module");
    expect(function() { validateRequiredModuleName(42, null); }).toThrow(/string/);
    expect(function() {
      validateRequiredModuleName("OtherTop", { moduleName: "NamedTop", explicit: { moduleName: true } });
    }).toThrow(/conflicts/);
  });

  it("selects a requested module when a helper module precedes the top module", function() {
    const source = "module helper (input x); endmodule\n"
      + "module RequiredTop (input clk); endmodule";
    expect(extractRTLInterface(source, "RequiredTop").moduleName).toBe("RequiredTop");
    expect(extractRTLInterface(source, "MissingTop").moduleName).toBe("helper");
  });
});
