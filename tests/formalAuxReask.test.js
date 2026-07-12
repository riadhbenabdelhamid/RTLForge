// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Aux-model corrective re-ask (measured: run 16 — gpt-oss-20b wrote a
// correct occupancy model sized with the RTL-internal localparam CNT_W;
// the checker only sees spec parameters, so the aux was dropped at bind
// time and every occupancy property silently skipped with it, taking the
// whole formal check down. One re-ask naming the failing identifier and
// the allowed names converts that into a working proof.)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSvaChecker } from "../src/pipeline/svaBind.js";

vi.mock("../src/llm/index.js", function() {
  return { callLLMJson: vi.fn(), addRetryHint: function(s) { return s; } };
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
    { name: "wr_en", dir: "input", width: "1" },
    { name: "rd_en", dir: "input", width: "1" },
    { name: "full", dir: "output", width: "1" },
    { name: "empty", dir: "output", width: "1" },
  ],
  params: [{ name: "DEPTH", def: 16 }],
  requirements: [],
};

const BAD_AUX = "logic [CNT_W-1:0] f_occ;\nalways_ff @(posedge clk) f_occ <= f_occ + (wr_en && !full);";
const GOOD_AUX = "logic [$clog2(DEPTH):0] f_occ;\nalways_ff @(posedge clk) f_occ <= f_occ + (wr_en && !full);";
const PROPS = [{ id: "SVA-OCC", code: "assert property (@(posedge clk) disable iff (!rst_n) f_occ <= DEPTH);" }];

function state() {
  return {
    spec: SPEC,
    elicit: { modName: "fifo" },
    rtl_generate: { code: "module fifo; endmodule" },
    _config: { provider: "openai", model: "m", apiKey: "k", stageSettings: {} },
    _onLog: vi.fn(),
  };
}
const reply = (data) => ({ data: data, llms: [{ text: JSON.stringify(data), tokensIn: 1, tokensOut: 1 }] });

beforeEach(function() { callLLMJson.mockReset(); });

describe("formal_props aux-model corrective re-ask (run 16)", function() {
  it("re-asks once naming the failing identifier and allowed names, then adopts the fix", async function() {
    callLLMJson
      .mockResolvedValueOnce(reply({ properties: PROPS, covers: [], aux: BAD_AUX, suggestedDepth: 20 }))
      .mockResolvedValueOnce(reply({ properties: PROPS, covers: [], aux: GOOD_AUX, suggestedDepth: 20 }));
    const out = await formalPropsNode(state());
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    const p2 = callLLMJson.mock.calls[1][0];
    expect(p2.userMessage).toMatch(/AUX MODEL CORRECTION/);
    expect(p2.userMessage).toMatch(/CNT_W/);
    expect(p2.userMessage).toMatch(/DEPTH/);
    expect(out.formal_props.aux).toBe(GOOD_AUX);
    expect(out._llms.length).toBe(2);
  });

  it("valid aux: single call, no re-ask", async function() {
    callLLMJson.mockResolvedValueOnce(reply({ properties: PROPS, covers: [], aux: GOOD_AUX }));
    const out = await formalPropsNode(state());
    expect(callLLMJson).toHaveBeenCalledTimes(1);
    expect(out.formal_props.aux).toBe(GOOD_AUX);
  });

  it("still-invalid aux after the re-ask: loud log, output kept (graceful drop downstream)", async function() {
    callLLMJson.mockResolvedValue(reply({ properties: PROPS, covers: [], aux: BAD_AUX }));
    const st = state();
    const out = await formalPropsNode(st);
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    const logs = st._onLog.mock.calls.map((c) => c[0]).join("\n");
    expect(logs).toMatch(/STILL INVALID/);
    expect(out.formal_props.aux).toBe(BAD_AUX);
  });
});

describe("buildSvaChecker diag out-param", function() {
  it("reports WHY nothing was bindable even when the return is null", function() {
    const diag = {};
    const out = buildSvaChecker(
      { aux: BAD_AUX, properties: PROPS }, SPEC, "fifo", diag);
    expect(out).toBeNull();
    expect(diag.skipped.some((s) => s.id === "AUX" && /CNT_W/.test(s.reason))).toBe(true);
    expect(diag.skipped.some((s) => s.id === "SVA-OCC" && /f_occ/.test(s.reason))).toBe(true);
  });
});
