// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Malformed-spec guard (measured: nemotron run 12). The spec LLM returned a
// bare port-map — no requirements[], no iface[] — and silently dropped the
// user-named wr_en port. Every downstream stage built, reviewed, and judged
// a write-enable-less FIFO against that empty contract for 3.5 hours; the
// judge's requirements criterion passed vacuously (denominator 0). The guard
// re-asks once with the exact contract, then halts honestly on a still-
// broken schema.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectMalformedSpec } from "../src/pipeline/fixLoopHelpers.js";

vi.mock("../src/llm/index.js", function() {
  return { callLLMJson: vi.fn(), addRetryHint: function(s) { return s; } };
});
vi.mock("../src/pipeline/applySkillsToPrompt.js", function() {
  return { applySkillsToPrompt: async function(p) { return p; } };
});

const { callLLMJson } = await import("../src/llm/index.js");
const { specNode } = await import("../src/pipeline/nodes/spec.js");

const FIFO_DESC = "A synchronous FIFO. Ports: clock clk, active-low asynchronous "
  + "reset rst_n, write enable wr_en with data input din, read enable rd_en, "
  + "outputs full and empty.";

const GOOD_SPEC = {
  requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "stores words" }],
  iface: [
    { name: "clk", dir: "input", width: "1" },
    { name: "rst_n", dir: "input", width: "1" },
    { name: "wr_en", dir: "input", width: "1" },
    { name: "rd_en", dir: "input", width: "1" },
    { name: "din", dir: "input", width: "8" },
    { name: "full", dir: "output", width: "1" },
    { name: "empty", dir: "output", width: "1" },
  ],
  params: [],
};

// The run-12 artifact shape: a bare port-map keyed by port names.
const BARE_PORT_MAP = {
  clk: { name: "clk", dir: "input", width: "1" },
  rst_n: { name: "rst_n", dir: "input", width: "1" },
};

describe("detectMalformedSpec", function() {
  it("accepts a complete spec", function() {
    expect(detectMalformedSpec(GOOD_SPEC, FIFO_DESC)).toBeNull();
  });

  it("flags the run-12 bare port-map (no requirements/iface arrays)", function() {
    const r = detectMalformedSpec(BARE_PORT_MAP, FIFO_DESC);
    expect(r).not.toBeNull();
    expect(r.schema.length).toBe(2);
    expect(r.schema.join(" ")).toMatch(/requirements/);
    expect(r.schema.join(" ")).toMatch(/iface/);
  });

  it("flags empty arrays and non-objects", function() {
    expect(detectMalformedSpec({ requirements: [], iface: [] }, "").schema.length).toBe(2);
    expect(detectMalformedSpec(null, "").schema.length).toBe(1);
    expect(detectMalformedSpec("prose", "").schema.length).toBe(1);
  });

  it("flags a spec with no functional Must requirement (run 17: all FUNCs demoted to Should)", function() {
    const spec = Object.assign({}, GOOD_SPEC, {
      requirements: [
        { id: "REQ-INTF-001", cat: "Interface", pri: "Must", desc: "ports" },
        { id: "REQ-FUNC-001", cat: "Functionality", pri: "Should", desc: "stores words" },
      ],
    });
    const r = detectMalformedSpec(spec, FIFO_DESC);
    expect(r).not.toBeNull();
    expect(r.schema.join(" ")).toMatch(/Functionality.*Must|Must.*Functionality/);
  });

  it("reports user-named underscore signals missing from iface (wr_en, run 12)", function() {
    const spec = Object.assign({}, GOOD_SPEC, {
      iface: GOOD_SPEC.iface.filter(function(p) { return p.name !== "wr_en"; }),
    });
    const r = detectMalformedSpec(spec, FIFO_DESC);
    expect(r).not.toBeNull();
    expect(r.schema).toEqual([]);
    expect(r.missingPorts).toEqual(["wr_en"]);
  });

  it("accepts suffixed variants of a user-named signal (wr_en_i counts as wr_en)", function() {
    const spec = Object.assign({}, GOOD_SPEC, {
      iface: GOOD_SPEC.iface.map(function(p) {
        return p.name === "wr_en" ? Object.assign({}, p, { name: "wr_en_i" }) : p;
      }),
    });
    expect(detectMalformedSpec(spec, FIFO_DESC)).toBeNull();
  });

  it("ignores non-underscore prose words (no false positives from plain English)", function() {
    expect(detectMalformedSpec(GOOD_SPEC,
      "A FIFO with full and empty flags and first word fall through")).toBeNull();
  });
});

describe("specNode malformed-spec guard", function() {
  function state() {
    return {
      _userDesc: FIFO_DESC,
      _config: { provider: "openai", model: "m", apiKey: "k", stageSettings: {} },
      _onLog: vi.fn(),
    };
  }
  const reply = (data) => ({ data: data, llms: [{ text: JSON.stringify(data), tokensIn: 1, tokensOut: 1 }] });

  beforeEach(function() { callLLMJson.mockReset(); });

  it("clean spec: no re-ask, single LLM call", async function() {
    callLLMJson.mockResolvedValue(reply(GOOD_SPEC));
    const out = await specNode(state());
    expect(callLLMJson).toHaveBeenCalledTimes(1);
    expect(out.spec.requirements.length).toBe(1);
  });

  it("bare port-map: one corrective re-ask that names the contract, then adopts the fixed spec", async function() {
    callLLMJson
      .mockResolvedValueOnce(reply(BARE_PORT_MAP))
      .mockResolvedValueOnce(reply(GOOD_SPEC));
    const st = state();
    const out = await specNode(st);
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    const p2 = callLLMJson.mock.calls[1][0];
    expect(p2.userMessage).toMatch(/SPEC CONTRACT REQUIREMENTS/);
    expect(p2.userMessage).toMatch(/requirements/);
    expect(out.spec.iface.length).toBe(7);
    // Both attempts ledgered
    expect(out._llms.length).toBe(2);
  });

  it("still schema-broken after the re-ask: honest halt", async function() {
    callLLMJson.mockResolvedValue(reply(BARE_PORT_MAP));
    await expect(specNode(state())).rejects.toThrow(/no usable contract/);
  });

  it("missing user-named port after re-ask: loud log, NOT fatal (rename stays possible)", async function() {
    const noWrEn = Object.assign({}, GOOD_SPEC, {
      iface: GOOD_SPEC.iface.filter(function(p) { return p.name !== "wr_en"; }),
    });
    callLLMJson.mockResolvedValue(reply(noWrEn));
    const st = state();
    const out = await specNode(st);
    expect(out.spec.iface.length).toBe(6);
    const logs = st._onLog.mock.calls.map(function(c) { return c[0]; }).join("\n");
    expect(logs).toMatch(/PORT FIDELITY/);
    expect(logs).toMatch(/wr_en/);
  });
});
