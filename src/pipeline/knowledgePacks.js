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
        rule: "Declare every variable at the TOP of its block, task, function, or module — before any procedural statement. Never place a 'logic …;' / 'int …;' declaration mid-block after an assignment or call.",
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
        rule: "Prefix every compiler directive with a backtick: write `timescale, `include, `define, `default_nettype, `ifdef/`endif — never the bare word. A directive without its leading backtick is parsed as an identifier and rejected.",
        ruleSource: "curated", domain: "rtl", model: "nvidia/nemotron-3-nano-omni", count: 2,
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
