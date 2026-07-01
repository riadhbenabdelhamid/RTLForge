// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// knowledgePacks — bundled, read-only "trained knowledge" rule packs
//                  (docs/training-mode.md, Path B)
//
// Training (`rtlforge train`) harvests a per-model rule corpus into the user's
// mutable catalog. A knowledge PACK is that corpus, curated and SHIPPED with the
// release: static data, bundled into both the browser GUI and the CLI (no fs),
// same record shape as errorsToAvoid so it merges straight into the cold-gen
// injection.
//
// OPT-IN + AUTO-BY-MODEL: a single switch (config.useShippedRules, default off)
// auto-enables every pack whose `model` equals the ACTIVE model. So a pack of
// rules trained on model X only ever appends to prompts when the user is on
// model X — inert on every other model, and off entirely until the switch is on.
//
// Records are read-only and kept SEPARATE from the user's harvested catalog;
// the two merge only at injection time (formatErrorsToAvoid dedups by rendered
// text, so a shipped rule and a locally-harvested twin never double-append).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Curated packs. Each record mirrors an errorsToAvoid catalog row; `ruleSource:
 * "curated"` marks provenance (a shipped, human-reviewed rule — never a review
 * candidate). Add a pack by appending an entry.
 */
export const KNOWLEDGE_PACKS = [
  {
    id: "gpt-oss-120b-tb",
    model: "openai/gpt-oss-120b",
    domain: "tb",
    label: "gpt-oss-120b · TB (mid-block declarations)",
    description: "openai/gpt-oss-120b's dominant measured weakness: declaring variables mid-block in generated testbenches.",
    records: [
      {
        signature: "SYNTAX|midblock variable declaration",
        code: "SYNTAX", sev: "error",
        sample: "syntax error, unexpected IDENTIFIER, expecting '{' ... logic prev = clk;",
        rule: "Declare every variable at the TOP of its block, task, function, or module — before any procedural statement.",
        ruleSource: "curated", domain: "tb", model: "openai/gpt-oss-120b", count: 6,
      },
    ],
  },
  {
    id: "nemotron-3-nano-omni-rtl",
    model: "nvidia/nemotron-3-nano-omni",
    domain: "rtl",
    label: "nemotron-3-nano-omni · RTL (compiler directives)",
    description: "nvidia/nemotron-3-nano-omni omits the leading backtick on compiler directives (harvested live).",
    records: [
      {
        signature: "SYNTAX|compiler directive missing backtick",
        code: "SYNTAX", sev: "error",
        sample: "syntax error, unexpected IDENTIFIER 1 | timescale 1ns/1ps | ^~~~~~~~~",
        rule: "Prefix every compiler directive with a backtick: write `timescale, `include, `define, `default_nettype, `ifdef/`endif.",
        ruleSource: "curated", domain: "rtl", model: "nvidia/nemotron-3-nano-omni", count: 2,
      },
    ],
  },
  {
    id: "lfm2-24b-a2b-rtl",
    model: "liquid/lfm2-24b-a2b",
    domain: "rtl",
    label: "lfm2-24b-a2b · RTL (SV syntax)",
    description: "liquid/lfm2-24b-a2b's recurring SystemVerilog syntax mistakes, harvested + distilled from a 16-run training session.",
    records: [
      {
        signature: "SYNTAX|syntax error, unexpected X, expecting X",
        code: "SYNTAX", sev: "error",
        sample: "syntax error, unexpected ']', expecting ':'  (logic [W-1] missing :0)",
        rule: "Give every packed vector a full range with both bounds: 'logic [WIDTH-1:0] name;'.",
        ruleSource: "curated", domain: "rtl", model: "liquid/lfm2-24b-a2b", count: 17,
      },
      {
        signature: "SYNTAX|too many digits for N bit number: Xb10000000'",
        code: "SYNTAX", sev: "error",
        sample: "Too many digits for 2 bit number: 2'b10000000 / illegal character in binary constant",
        rule: "Write sized literals correctly: keep the value within the declared width and use only 0/1/x/z in a 'b literal (use 'd or 'h for other digits), e.g. 8'b10000000 or 8'h80.",
        ruleSource: "curated", domain: "rtl", model: "liquid/lfm2-24b-a2b", count: 9,
      },
      {
        signature: "SYNTAX|syntax error, unexpected identifier, expecting X",
        code: "SYNTAX", sev: "error",
        sample: "syntax error, unexpected IDENTIFIER, expecting open-brace  (declaration after a statement)",
        rule: "Declare every variable at the TOP of its block, task, function, or module — before any procedural statement.",
        ruleSource: "curated", domain: "rtl", model: "liquid/lfm2-24b-a2b", count: 5,
      },
      {
        signature: "SYNTAX|syntax error, unexpected parameter, expecting X",
        code: "SYNTAX", sev: "error",
        sample: "syntax error, unexpected parameter, expecting '['",
        rule: "Declare parameters in the ANSI header '#(parameter int DATA_W = 8)' before the port list, or as 'parameter DATA_W = 8;' inside the module body.",
        ruleSource: "curated", domain: "rtl", model: "liquid/lfm2-24b-a2b", count: 5,
      },
      {
        signature: "SYNTAX|syntax error, unexpected assign",
        code: "SYNTAX", sev: "error",
        sample: "syntax error, unexpected assign  (continuous assign inside a procedural block)",
        rule: "Use continuous 'assign' at module scope to drive nets, and drive signals inside always/initial blocks with procedural assignment (= or <=).",
        ruleSource: "curated", domain: "rtl", model: "liquid/lfm2-24b-a2b", count: 5,
      },
      {
        signature: "SYNTAX|syntax error, unexpected X, expecting X or X",
        code: "SYNTAX", sev: "error",
        sample: "syntax error, unexpected ':', expecting ',' or ';'  (VHDL-style 'name : type' port)",
        rule: "Declare ports as 'direction type name' (e.g. 'input logic [W-1:0] name') and parameters as 'parameter int NAME = value'.",
        ruleSource: "curated", domain: "rtl", model: "liquid/lfm2-24b-a2b", count: 4,
      },
      {
        signature: "UNSUPPORTED|unsupported: complex ports (ieee N-N N.N.N.N/N)",
        code: "UNSUPPORTED", sev: "error",
        sample: "Unsupported: complex ports (IEEE 1800-2023 23.2.2.1/2)",
        rule: "Declare each port in simple ANSI port style in the module header: 'input logic clk, output logic [7:0] q'.",
        ruleSource: "curated", domain: "rtl", model: "liquid/lfm2-24b-a2b", count: 3,
      },
      {
        signature: "SYNTAX|syntax error, unexpected always_comb",
        code: "SYNTAX", sev: "error",
        sample: "syntax error, unexpected always_comb / always_ff  (block placed outside module body)",
        rule: "Put always_ff/always_comb blocks inside the module body (after the declarations, before endmodule), each with a sensitivity list: always_ff @(posedge clk), always_comb.",
        ruleSource: "curated", domain: "rtl", model: "liquid/lfm2-24b-a2b", count: 3,
      },
    ],
  },
];

/** Packs whose model matches the given active model. */
export function knowledgePacksForModel(model) {
  if (!model) return [];
  return KNOWLEDGE_PACKS.filter(function(p) { return p.model === model; });
}

/**
 * The single switch: when config.useShippedRules is on, return the flat records
 * of every pack matching the active model (config.model). Empty otherwise — so
 * off, or on an unmatched model, injection is byte-identical to before.
 * @returns {Array} catalog-shaped records to merge into cold-gen injection
 */
export function shippedRuleRecords(config) {
  const c = config || {};
  if (!c.useShippedRules) return [];
  const out = [];
  for (const p of knowledgePacksForModel(c.model || null)) {
    for (const r of (p.records || [])) out.push(r);
  }
  return out;
}
