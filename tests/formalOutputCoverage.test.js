// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Output-port property coverage (run 18 autopsy). The dout bug — an output
// register loaded unconditionally instead of gated on its accept condition —
// is exactly what an update-gating property catches, yet nothing guaranteed
// the generated property set observed every output at all. Pins:
//   • uncoveredOutputPorts — deterministic whole-identifier check
//   • the formal_props node's ONE corrective re-ask, non-fatal when ignored
//   • the prompt's required update-gating property class
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { uncoveredOutputPorts } from "../src/pipeline/svaBind.js";
import { promptFormalProps } from "../src/prompts/index.js";

vi.mock("../src/llm/index.js", function() {
  return { callLLMJson: vi.fn(), callLLM: vi.fn(), extractJSON: function(t) { return JSON.parse(t); } };
});
vi.mock("../src/pipeline/applySkillsToPrompt.js", function() {
  return { applySkillsToPrompt: async function(p) { return p; } };
});

const { callLLMJson } = await import("../src/llm/index.js");
const { formalPropsNode } = await import("../src/pipeline/nodes/formal_props.js");

const SPEC = {
  iface: [
    { name: "clk", dir: "input", width: "1" },
    { name: "rst_n", dir: "input", width: "1" },
    { name: "rd_en", dir: "input", width: "1" },
    { name: "dout", dir: "output", width: "8" },
    { name: "full", dir: "output", width: "1" },
    { name: "empty", dir: "output", width: "1" },
  ],
  params: [{ name: "DEPTH", def: 16 }],
  requirements: [],
};

const FULL_EMPTY_ONLY = [
  { id: "SVA-1", code: "assert property (@(posedge clk) disable iff (!rst_n) full |-> !empty);" },
];
const ALL_COVERED = FULL_EMPTY_ONLY.concat([
  { id: "SVA-2", code: "assert property (@(posedge clk) disable iff (!rst_n) !(rd_en && !empty) |=> $stable(dout));" },
]);

describe("uncoveredOutputPorts", function() {
  it("flags outputs no property references (run 18: dout was never observed)", function() {
    expect(uncoveredOutputPorts({ properties: FULL_EMPTY_ONLY, covers: [] }, SPEC)).toEqual(["dout"]);
  });

  it("is satisfied by whole-identifier references in properties or covers", function() {
    expect(uncoveredOutputPorts({ properties: ALL_COVERED, covers: [] }, SPEC)).toEqual([]);
    expect(uncoveredOutputPorts({
      properties: FULL_EMPTY_ONLY,
      covers: [{ id: "COV-1", code: "cover property (@(posedge clk) dout == 8'hA5);" }],
    }, SPEC)).toEqual([]);
  });

  it("does not accept substrings as coverage (dout_valid is not dout)", function() {
    expect(uncoveredOutputPorts({
      properties: [{ id: "S", code: "assert property (@(posedge clk) dout_valid);" }],
      covers: [],
    }, SPEC)).toContain("dout");
  });

  it("returns [] for a spec with no outputs or an empty property set", function() {
    expect(uncoveredOutputPorts({ properties: [], covers: [] }, { iface: [{ name: "a", dir: "input" }] })).toEqual([]);
    expect(uncoveredOutputPorts(null, SPEC).length).toBe(3);
  });
});

describe("formal_props node output-coverage re-ask", function() {
  function state(onLog) {
    return {
      spec: SPEC,
      elicit: { modName: "fifo" },
      rtl_generate: { code: "module fifo(input clk); endmodule" },
      _config: { provider: "openai", model: "m", apiKey: "k", stageSettings: {} },
      _onLog: onLog || vi.fn(),
    };
  }
  const reply = function(data) {
    return { data: data, llms: [{ text: JSON.stringify(data), tokensIn: 1, tokensOut: 1 }] };
  };

  beforeEach(function() { callLLMJson.mockReset(); });

  it("re-asks ONCE naming the uncovered outputs, adopts the covering reply", async function() {
    callLLMJson
      .mockResolvedValueOnce(reply({ properties: FULL_EMPTY_ONLY, covers: [], aux: "" }))
      .mockResolvedValueOnce(reply({ properties: ALL_COVERED, covers: [], aux: "" }));
    const out = await formalPropsNode(state());
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    const p2 = callLLMJson.mock.calls[1][0];
    expect(p2.userMessage).toContain("OUTPUT PROPERTY COVERAGE");
    expect(p2.userMessage).toContain("dout");
    expect(p2.userMessage).toContain("$stable");
    expect(out.formal_props.properties.length).toBe(2);
    expect(out._llms.length).toBe(2);
  });

  it("no re-ask when every output is already observed", async function() {
    callLLMJson.mockResolvedValueOnce(reply({ properties: ALL_COVERED, covers: [], aux: "" }));
    await formalPropsNode(state());
    expect(callLLMJson).toHaveBeenCalledTimes(1);
  });

  it("still-uncovered after the re-ask: loud log, never a halt, result kept", async function() {
    const onLog = vi.fn();
    callLLMJson.mockResolvedValue(reply({ properties: FULL_EMPTY_ONLY, covers: [], aux: "" }));
    const out = await formalPropsNode(state(onLog));           // must not throw
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    expect(out.formal_props.properties.length).toBe(1);
    const logs = onLog.mock.calls.map(function(c) { return c[0]; }).join("\n");
    expect(logs).toMatch(/STILL UNOBSERVED/);
    expect(logs).toMatch(/dout/);
  });
});

describe("promptFormalProps update-gating property class", function() {
  it("requires the $stable update-gating class for sequential modules", function() {
    const p = promptFormalProps(
      "module fifo(input logic clk, input logic rst_n, input logic rd_en,\n"
      + "output logic [7:0] dout);\nalways_ff @(posedge clk) dout <= 8'h0;\nendmodule",
      SPEC, { modName: "fifo" }, [], []);
    expect(p.userMessage).toContain("OUTPUT UPDATE-GATING");
    expect(p.userMessage).toContain("$stable(<output>)");
  });
});
