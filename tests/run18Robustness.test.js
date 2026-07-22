// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Run-18 robustness fixes (measured: qwen3-coder gen / qwen3.6-35b debug,
// sync FIFO, honest fail 33/54). Four deterministic gaps, one test suite:
//
//   1. Reflow honored disabled optional stages nowhere: formal_props ran
//      twice inside verify's reflow chain (3 LLM calls, ~11 min) with
//      formal_props/formal_verify explicitly false in config.optionalStages.
//      → filterEnabledStages, applied at every node's tail derivation.
//   2. LLM triage re-blamed the testbench every iteration while a one-line
//      RTL bug sat untouched (TB regenerated 5×, score frozen at 33/54).
//      → triageFlipTarget (verify) + candidate EXCLUSION (judge).
//   3. The spec renamed the user's "din" to "data_i" undetected — the
//      port-fidelity guard only checked underscore-containing tokens.
//      → port-introducer rule ("input din", "output dout", "clock clk").
//   4. buildOllamaReq sent no num_ctx; Ollama 0.30.x defaults to ~4k and
//      SILENTLY truncates longer prompts. → options.num_ctx from config.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { ALL_STAGES, filterEnabledStages, getReflowTail } from "../src/constants/stages.js";
import { triageFlipTarget } from "../src/pipeline/nodes/verify.js";
import { buildOllamaReq } from "../src/llm/providers/ollama.js";
import { detectMalformedSpec } from "../src/pipeline/fixLoopHelpers.js";
import { getStageConfig } from "../src/constants/providers.js";

// ─── 1. filterEnabledStages / reflow tail composition ────────────────────
describe("filterEnabledStages (run 18: reflow ran disabled formal stages)", function() {
  const run18Config = {
    optionalStages: {
      rtl_review: true, formal_props: false, formal_verify: false,
      lint: true, test_review: true, lint_test: true,
    },
  };

  it("drops disabled optional stages, keeps enabled + non-optional ones", function() {
    const active = filterEnabledStages(ALL_STAGES, run18Config);
    const keys = active.map(function(s) { return s.key; });
    expect(keys).not.toContain("formal_props");
    expect(keys).not.toContain("formal_verify");
    expect(keys).toContain("rtl_review");     // enabled optional
    expect(keys).toContain("verify");         // non-optional
    expect(keys).toContain("judge");          // non-optional
  });

  it("verify's reflow tail excludes the disabled formal stages (the run-18 chain)", function() {
    const active = filterEnabledStages(ALL_STAGES, run18Config);
    const tail = getReflowTail("verify", active);
    const keys = tail.map(function(s) { return s.key; });
    expect(keys).toEqual([
      "rtl_generate", "rtl_review", "lint",
      "test_generate", "test_review", "lint_test", "verify",
    ]);
  });

  it("includes formal stages when enabled (no over-filtering)", function() {
    const cfg = { optionalStages: Object.assign({}, run18Config.optionalStages,
      { formal_props: true, formal_verify: true }) };
    const keys = filterEnabledStages(ALL_STAGES, cfg).map(function(s) { return s.key; });
    expect(keys).toContain("formal_props");
    expect(keys).toContain("formal_verify");
  });

  it("matches getActiveStages semantics with no optionalStages config", function() {
    // An absent map disables every optional stage — same as the main path.
    const keys = filterEnabledStages(ALL_STAGES, {}).map(function(s) { return s.key; });
    expect(keys).toEqual(["elicit", "spec", "architect", "rtl_generate",
      "test_generate", "verify", "judge"]);
  });

  it("keeps stages that carry no optional flag regardless of config (test harnesses)", function() {
    const bare = [{ id: 4, key: "rtl_generate", order: 40 }, { id: 8, key: "verify", order: 80 }];
    expect(filterEnabledStages(bare, {}).length).toBe(2);
    expect(filterEnabledStages(bare, null).length).toBe(2);
  });
});

// ─── 2. triageFlipTarget ──────────────────────────────────────────────────
describe("triageFlipTarget (run 18: TB re-blamed 5× with the score frozen)", function() {
  // The exact run-18 sequence: 33/54 at every iteration, TB blamed every time.
  const run18 = [
    { pass: 33, triageTarget: "test_generate" },
    { pass: 33, triageTarget: "test_generate" },
    { pass: 33 },  // current iteration — target being decided
  ];

  it("flips tb→rtl on the THIRD same-side opinion after two frozen attempts", function() {
    expect(triageFlipTarget(run18, "test_generate", false)).toBe("rtl_generate");
  });

  it("flips rtl→tb symmetrically", function() {
    expect(triageFlipTarget([
      { pass: 10, triageTarget: "rtl_generate" },
      { pass: 9,  triageTarget: "rtl_generate" },
      { pass: 9 },
    ], "rtl_generate", false)).toBe("test_generate");
  });

  it("treats 'spec' as the rtl side", function() {
    expect(triageFlipTarget([
      { pass: 5, triageTarget: "spec" },
      { pass: 5, triageTarget: "rtl_generate" },
      { pass: 5 },
    ], "rtl_generate", false)).toBe("test_generate");
  });

  it("does NOT flip on the second attempt — forward-candidate retry is a designed path", function() {
    expect(triageFlipTarget([
      { pass: 33, triageTarget: "test_generate" },
      { pass: 33 },
    ], "test_generate", false)).toBeNull();
  });

  it("does NOT flip when the pass count improved anywhere in the window", function() {
    expect(triageFlipTarget([
      { pass: 30, triageTarget: "test_generate" },
      { pass: 35, triageTarget: "test_generate" },
      { pass: 40 },
    ], "test_generate", false)).toBeNull();
    expect(triageFlipTarget([
      { pass: 30, triageTarget: "test_generate" },
      { pass: 35, triageTarget: "test_generate" },
      { pass: 35 },
    ], "test_generate", false)).toBeNull();
  });

  it("does NOT flip when the sides differ (the LLM already switched)", function() {
    expect(triageFlipTarget([
      { pass: 33, triageTarget: "test_generate" },
      { pass: 33, triageTarget: "rtl_generate" },
      { pass: 33 },
    ], "test_generate", false)).toBeNull();
  });

  it("NEVER flips evidence-based triage (formal arbiter / compile log)", function() {
    expect(triageFlipTarget(run18, "test_generate", true)).toBeNull();
  });

  it("no flip on early iterations or without pass counts", function() {
    expect(triageFlipTarget([{ pass: 33 }], "test_generate", false)).toBeNull();
    expect(triageFlipTarget([
      { triageTarget: "test_generate" },
      { triageTarget: "test_generate" },
      { pass: 33 },
    ], "test_generate", false)).toBeNull();
  });
});

// ─── 3. Port-fidelity guard: non-underscore port names ────────────────────
describe("detectMalformedSpec port-introducer rule (run 18: din → data_i rename)", function() {
  // The exact run-18 shape: user wrote "data input din"; the spec shipped
  // data_i instead and no guard fired.
  const FIFO_DESC = "A synchronous FIFO. Ports: clock clk, active-low asynchronous "
    + "reset rst_n, write enable wr_en with data input din, read enable rd_en "
    + "with data output dout, and status outputs full and empty. First-word "
    + "fall-through is NOT required: dout updates on the clock edge of an "
    + "accepted read.";
  const iface = function(names) {
    return names.map(function(n) { return { name: n, dir: "input", width: "1" }; });
  };
  const spec = function(portNames) {
    return {
      requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "stores" }],
      iface: iface(portNames),
      params: [],
    };
  };

  it("flags the run-18 rename: 'din' typed by the user, data_i shipped", function() {
    const r = detectMalformedSpec(
      spec(["clk", "rst_n", "wr_en", "rd_en", "data_i", "full", "empty", "dout"]),
      FIFO_DESC,
    );
    expect(r).not.toBeNull();
    expect(r.schema).toEqual([]);
    expect(r.missingPorts).toEqual(["din"]);
  });

  it("accepts the faithful interface (din present)", function() {
    expect(detectMalformedSpec(
      spec(["clk", "rst_n", "wr_en", "rd_en", "din", "full", "empty", "dout"]),
      FIFO_DESC,
    )).toBeNull();
  });

  it("does not mistake prose after an introducer for a port ('clock edge')", function() {
    // "on the clock edge of an accepted read" matches the introducer pattern
    // but "edge" is a stopword, not a missing port.
    expect(detectMalformedSpec(
      spec(["clk", "rst_n", "wr_en", "rd_en", "din", "full", "empty", "dout"]),
      FIFO_DESC,
    )).toBeNull();
  });

  it("catches a dropped introducer-named status output ('outputs full')", function() {
    const r = detectMalformedSpec(
      spec(["clk", "rst_n", "wr_en", "rd_en", "din", "empty", "dout"]),
      FIFO_DESC,
    );
    expect(r).not.toBeNull();
    expect(r.missingPorts).toContain("full");
  });

  it("stays silent on plain English with no introducer-named signals", function() {
    expect(detectMalformedSpec(
      spec(["a", "b"]),
      "A design where the output is registered and the input data arrives when the enable is high",
    )).toBeNull();
  });
});

// ─── 4. buildOllamaReq num_ctx ────────────────────────────────────────────
describe("buildOllamaReq num_ctx (run 18: silent ~4k truncation on Ollama)", function() {
  it("defaults num_ctx to 32768 when the config carries no value", function() {
    const r = buildOllamaReq({ model: "m" }, "sys", "usr", 4096, null);
    expect(r.body.options.num_ctx).toBe(32768);
  });

  it("honors an explicit ollamaNumCtx", function() {
    const r = buildOllamaReq({ model: "m", ollamaNumCtx: 8192 }, "sys", "usr", 4096, null);
    expect(r.body.options.num_ctx).toBe(8192);
  });

  it("omits num_ctx entirely at ollamaNumCtx: 0 (defer to Modelfile/server)", function() {
    const r = buildOllamaReq({ model: "m", ollamaNumCtx: 0 }, "sys", "usr", 4096, null);
    expect("num_ctx" in r.body.options).toBe(false);
  });

  it("reaches the builder through getStageConfig (the fresh-object drop trap)", function() {
    // getStageConfig builds a FRESH config object; any field it does not
    // explicitly copy is silently dropped (that is how the recorder tap first
    // went missing). Pin that ollamaNumCtx survives the rebuild.
    const sc = getStageConfig({ provider: "ollama", model: "m", ollamaNumCtx: 16384 }, "rtl_generate");
    expect(sc.ollamaNumCtx).toBe(16384);
    const r = buildOllamaReq(sc, "sys", "usr", 4096, null);
    expect(r.body.options.num_ctx).toBe(16384);
  });
});
