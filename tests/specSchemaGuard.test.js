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
import { detectMalformedSpec, specFidelityViolations, repairSpecPortNames } from "../src/pipeline/fixLoopHelpers.js";

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
    { name: "full", dir: "output", width: "1", reset: "low after reset" },
    { name: "empty", dir: "output", width: "1", reset: "high after reset" },
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

  it("advises (non-fatally) on a spec with no functional Must requirement (run 17)", function() {
    const spec = Object.assign({}, GOOD_SPEC, {
      requirements: [
        { id: "REQ-INTF-001", cat: "Interface", pri: "Must", desc: "ports" },
        { id: "REQ-FUNC-001", cat: "Functionality", pri: "Should", desc: "stores words" },
      ],
    });
    const r = detectMalformedSpec(spec, FIFO_DESC);
    expect(r).not.toBeNull();
    // ADVISORY, not schema: it must never halt the run — the eval gate keeps
    // final (and user-configurable) authority.
    expect(r.schema).toEqual([]);
    expect(r.advisories.join(" ")).toMatch(/Functionality.*Must|Must.*Functionality/);
  });

  it("does NOT advise on a mismatched (id, cat) pair the cat-alignment step would repair", function() {
    // spec.js aligns cat FROM the id prefix AFTER this guard runs; a
    // REQ-FUNC-* Must with a wrong cat is a contract the pipeline itself
    // fixes — re-asking (or worse) for it would be a false positive.
    const spec = Object.assign({}, GOOD_SPEC, {
      requirements: [{ id: "REQ-FUNC-001", cat: "Interface", pri: "Must", desc: "stores words" }],
    });
    expect(detectMalformedSpec(spec, FIFO_DESC)).toBeNull();
  });

  it("skips the functional-Must advisory when opts.checkFuncMust is false (gate disabled)", function() {
    const spec = Object.assign({}, GOOD_SPEC, {
      requirements: [{ id: "REQ-INTF-001", cat: "Interface", pri: "Must", desc: "ports" }],
    });
    expect(detectMalformedSpec(spec, FIFO_DESC, { checkFuncMust: false })).toBeNull();
    expect(detectMalformedSpec(spec, FIFO_DESC).advisories.length).toBe(1);
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

  it("persistently missing functional Must: re-ask once, then loud advisory, NEVER a halt", async function() {
    const allShould = Object.assign({}, GOOD_SPEC, {
      requirements: [{ id: "REQ-INTF-001", cat: "Interface", pri: "Must", desc: "ports" }],
    });
    callLLMJson.mockResolvedValue(reply(allShould));
    const st = state();
    const out = await specNode(st);                       // must not throw
    expect(callLLMJson).toHaveBeenCalledTimes(2);         // one corrective re-ask
    expect(out.spec.requirements.length).toBe(1);
    const logs = st._onLog.mock.calls.map(function(c) { return c[0]; }).join("\n");
    expect(logs).toMatch(/CONTRACT ADVISORY/);
    expect(logs).toMatch(/eval gate has final authority/);
  });

  it("req_func_must disabled in evalCriteria: no re-ask for a Should-only spec", async function() {
    const allShould = Object.assign({}, GOOD_SPEC, {
      requirements: [{ id: "REQ-INTF-001", cat: "Interface", pri: "Must", desc: "ports" }],
    });
    callLLMJson.mockResolvedValue(reply(allShould));
    const st = state();
    st._config.evalCriteria = { req_func_must: { enabled: false, threshold: 100 } };
    await specNode(st);
    expect(callLLMJson).toHaveBeenCalledTimes(1);         // guard must not out-strict the gate
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

describe("reset-contract advisory (run 29)", function() {
  it("a sequential spec with a bare output gets the advisory (joins the re-ask)", function() {
    const spec = JSON.parse(JSON.stringify(GOOD_SPEC));
    delete spec.iface.find(function(p) { return p.name === "full"; }).reset;
    const r = detectMalformedSpec(spec, FIFO_DESC);
    expect(r).not.toBe(null);
    expect(r.schema.length).toBe(0);                       // advisory, never fatal
    expect(r.advisories.join(" ")).toMatch(/"reset" field/);
    expect(r.advisories.join(" ")).toMatch(/missing on: full/);
  });
  it("a combinational spec (no clock) never gets the advisory", function() {
    const spec = {
      requirements: GOOD_SPEC.requirements,
      iface: [
        { name: "a", dir: "input", width: "8" },
        { name: "y", dir: "output", width: "8" },        // no reset field — fine, no clk
      ],
      params: [],
    };
    expect(detectMalformedSpec(spec, "a combinational mux with inputs a and output y")).toBe(null);
  });
  it("outputs with reset fields (value or retention) pass clean", function() {
    expect(detectMalformedSpec(GOOD_SPEC, FIFO_DESC)).toBe(null);
    const retain = JSON.parse(JSON.stringify(GOOD_SPEC));
    retain.iface.push({ name: "dout", dir: "output", width: "8", reset: "retains last value" });
    expect(detectMalformedSpec(retain, FIFO_DESC + " data output dout.")).toBe(null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Description-fidelity violations (runs 37/38/41/42 — four sightings, both
// models). Replay-validated against seven checkpoints: fires on 37 (dropped
// `done`, renamed rst_n, invented ssel), 38 (dropped CLK_DIV), 41 (WIDTH
// default 32 vs described 8), 42 (six renamed ports, dropped `write`, wrong
// ADDR_W default, scrambled VERSION constant); silent on 33/39/40.
// ═══════════════════════════════════════════════════════════════════════════
describe("specFidelityViolations (the spec interface validator)", () => {
  const DESC = "A register block. Parameter ADDR_W (default 4). Ports: clk, rst_n, sel, write, "
    + "addr[ADDR_W-1:0], wdata[31:0], rdata[31:0], ready, irq. A separate input port event_in "
    + "sets the flag. Address 3 is VERSION (read-only constant 32'h0000_0001).";
  const port = (name) => ({ name, dir: "input", width: "1" });
  const GOOD = {
    iface: ["clk","rst_n","sel","write","addr","wdata","rdata","ready","irq","event_in"].map(port),
    params: [{ name: "ADDR_W", def: 4 }],
    requirements: [{ id: "R1", desc: "VERSION returns 32'h0000_0001" }],
  };

  it("a faithful spec is silent — including the prose-introduced event_in port", () => {
    expect(specFidelityViolations(GOOD, DESC)).toEqual([]);
  });

  it("run-42 shape: renamed and dropped ports each fire, extras are named", () => {
    const bad = Object.assign({}, GOOD, {
      iface: ["clk","rst_n","sel","wr_data_i","rd_data_o","ready_o","irq_o","event_in"].map(port),
    });
    const v = specFidelityViolations(bad, DESC);
    expect(v.some((x) => /"write"/.test(x))).toBe(true);       // dropped
    expect(v.some((x) => /"wdata"/.test(x))).toBe(true);       // renamed
    expect(v.some((x) => /wr_data_i/.test(x) && /exhaustive/.test(x))).toBe(true);
  });

  it("run-41 shape: a wrong parameter default fires; a matching one is silent", () => {
    const bad = Object.assign({}, GOOD, { params: [{ name: "ADDR_W", def: 2 }] });
    expect(specFidelityViolations(bad, DESC).some((x) => /default must be 4/.test(x))).toBe(true);
  });

  it("run-38 shape: a dropped parameter fires", () => {
    const bad = Object.assign({}, GOOD, { params: [] });
    expect(specFidelityViolations(bad, DESC).some((x) => /parameter ADDR_W/.test(x))).toBe(true);
  });

  it("run-42 shape: a scrambled constant fires; normalization tolerates underscores", () => {
    const bad = JSON.parse(JSON.stringify(GOOD));
    bad.requirements[0].desc = "VERSION returns 32'h0000_0100";
    expect(specFidelityViolations(bad, DESC).some((x) => /literal constant/.test(x))).toBe(true);
    const okAlt = JSON.parse(JSON.stringify(GOOD));
    okAlt.requirements[0].desc = "VERSION returns 32'h00000001";  // underscores dropped
    expect(specFidelityViolations(okAlt, DESC)).toEqual([]);
  });

  it("a description with no Ports:/Parameter/literal forms abstains entirely", () => {
    expect(specFidelityViolations(GOOD, "An 8-bit synchronous counter with enable.")).toEqual([]);
  });

  it("detectMalformedSpec carries fidelity[] and the checkFidelity opt-out works", () => {
    const bad = Object.assign({}, GOOD, { params: [] });
    const m = detectMalformedSpec(Object.assign({ requirements: GOOD.requirements }, bad), DESC, {});
    expect((m.fidelity || []).length).toBeGreaterThan(0);
    const off = detectMalformedSpec(Object.assign({ requirements: GOOD.requirements }, bad), DESC, { checkFidelity: false });
    expect(((off || {}).fidelity || []).length).toBe(0);
  });
});

// Run 43: three Spec attempts, three fidelity halts, and nearly every
// violation was a pure DECORATION of a described name (wdata_i, ready_o,
// event_in_i). Renaming those back is mechanical; the repair converts the
// two real rejected specs from 8 violations to 1 and 2, leaving only the
// genuinely non-mechanical residue (a dropped port; we_i vs write).
describe("repairSpecPortNames (run 43)", () => {
  const DESC = "A block. Parameter ADDR_W (default 4). Ports: clk, rst_n, sel, write, "
    + "addr[ADDR_W-1:0], wdata[31:0], rdata[31:0], ready, irq. A separate input port event_in sets the flag.";
  const port = (name) => ({ name, dir: "input", width: "1" });

  it("strips i_/o_ and _i/_o/_in/_out decorations back to described names", () => {
    const spec = { iface: ["clk","rst_n","sel_i","write_i","addr_i","wdata_i","rdata_o","ready_o","irq_o","event_in_i"].map(port),
      params: [{ name: "ADDR_W", def: 4 }] };
    const r = repairSpecPortNames(spec, DESC);
    expect(r.renamed.length).toBe(8);
    const names = r.spec.iface.map((p) => p.name);
    for (const n of ["sel","write","addr","wdata","rdata","ready","irq","event_in"]) {
      expect(names).toContain(n);
    }
    expect(specFidelityViolations(r.spec, DESC)).toEqual([]);
  });

  it("never strips _n — rst_n is active-low semantics, not decoration", () => {
    const spec = { iface: ["clk","rst_n"].map(port), params: [] };
    expect(repairSpecPortNames(spec, DESC).renamed).toEqual([]);
    // and a hypothetical `rst` does NOT get renamed to rst_n's stem either way
  });

  it("semantic inversions and true drops are left for the re-ask", () => {
    // we_i is an abbreviation of write, not a decoration — no rename
    const spec = { iface: ["clk","rst_n","sel","we_i","addr","wdata","rdata","ready","irq","event_in"].map(port), params: [] };
    const r = repairSpecPortNames(spec, DESC);
    expect(r.renamed).toEqual([]);
    expect(specFidelityViolations(r.spec, DESC).length).toBeGreaterThan(0);
  });

  it("ambiguity abstains: two candidates stemming to one target rename nothing", () => {
    const spec = { iface: ["clk","rst_n","sel","write","addr","wdata_i","i_wdata","rdata","ready","irq","event_in"].map(port), params: [] };
    const r = repairSpecPortNames(spec, DESC);
    expect(r.renamed.every((x) => x.to !== "wdata")).toBe(true);
  });

  it("does not mutate its input", () => {
    const spec = { iface: ["sel_i"].map(port), params: [] };
    repairSpecPortNames(spec, DESC);
    expect(spec.iface[0].name).toBe("sel_i");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// missingPorts vs the enumerated ports clause (run 44). The loose snake_case
// scan claimed "event_clear" (a register-map entry) and "h0000_0001" (a
// fragment of 32'h0000_0001) as ports the spec was missing. A compliant model
// ADDS them; specFidelityViolations then rejects them as iface extras and the
// run HALTS — run 43 attempt 4's halt was exactly this contradiction, and run
// 43's own passing spec carries the same two false positives.
// Rule: an enumerated clause is the authority; the loose scan is for
// descriptions that have none.
// ═══════════════════════════════════════════════════════════════════════════
describe("missingPorts vs enumerated ports clause (run 44)", () => {
  const DESC = "A register block. Parameter ADDR_W (default 4). Ports: clk, rst_n, sel, "
    + "write, addr[ADDR_W-1:0], wdata[31:0], rdata[31:0], ready, irq. Address 2 is "
    + "EVENT_CLEAR (write-1-to-clear); address 3 is VERSION (read-only constant "
    + "32'h0000_0001). A separate input port event_in sets the flag.";
  const SPEC = {
    requirements: [
      { id: "REQ-INTF-001", cat: "Interface", pri: "Must", desc: "d", rat: "[domain default]" },
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must",
        desc: "The module shall present 32'h0000_0001 for a read of address 3.", rat: "[domain default]" },
    ],
    iface: ["clk", "rst_n", "sel", "write", "addr", "wdata", "rdata", "ready", "irq", "event_in"]
      .map((n) => ({ name: n, dir: "input", width: "1", desc: "d" })),
    params: [{ name: "ADDR_W", type: "parameter", def: 4, range: "[2:32]", desc: "d" }],
  };

  it("a spec with exactly the enumerated ports claims no missing port", () => {
    const m = detectMalformedSpec(SPEC, DESC);
    expect((m && m.missingPorts) || []).toEqual([]);
    expect((m && m.fidelity) || []).toEqual([]);
  });

  it("register names and literal fragments are never demanded as ports", () => {
    const m = detectMalformedSpec({ ...SPEC, iface: SPEC.iface.slice(0, 9) }, DESC);
    // dropping event_in is a real fidelity violation, but event_clear /
    // h0000_0001 must not appear anywhere in the complaint
    const all = JSON.stringify(m);
    expect(all).not.toContain("event_clear");
    expect(all).not.toContain("h0000_0001");
  });

  it("without an enumerated clause the loose scan still catches a dropped port", () => {
    const d = "A FIFO with an input din and an output dout, plus a full_flag status output.";
    const m = detectMalformedSpec({
      requirements: [{ id: "REQ-INTF-001", cat: "Interface", pri: "Must", desc: "d", rat: "[domain default]" }],
      iface: [{ name: "dout", dir: "output", width: "1", desc: "d" },
              { name: "full_flag", dir: "output", width: "1", desc: "d" }],
      params: [],
    }, d);
    expect(m.missingPorts).toContain("din");
  });

  it("without an enumerated clause a hex literal is still not a port", () => {
    const d = "A block with an input din that outputs the constant 32'h0000_0001 on dout.";
    const m = detectMalformedSpec({
      requirements: [{ id: "REQ-INTF-001", cat: "Interface", pri: "Must", desc: "d", rat: "[domain default]" }],
      iface: [{ name: "din", dir: "input", width: "1", desc: "d" },
              { name: "dout", dir: "output", width: "1", desc: "d" }],
      params: [],
    }, d);
    expect((m && m.missingPorts) || []).toEqual([]);
  });
});
