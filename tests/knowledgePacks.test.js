// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Bundled trained-knowledge packs (docs/training-mode.md, Path B).

import { describe, it, expect } from "vitest";
import {
  KNOWLEDGE_PACKS, knowledgePacksForModel, shippedRuleRecords,
} from "../src/pipeline/knowledgePacks.js";
import { formatErrorsToAvoid, distillRule } from "../src/pipeline/errorsToAvoid.js";

describe("knowledge packs", () => {
  it("every pack record is model-tagged and carries a rule (curated)", () => {
    for (const p of KNOWLEDGE_PACKS) {
      for (const r of p.records) {
        expect(r.model).toBe(p.model);
        expect(r.domain).toBe(p.domain);
        expect(r.rule && r.rule.length).toBeTruthy();
        expect(r.signature).toBeTruthy();
        expect(r.ruleSource).toBe("curated");
      }
    }
  });

  it("pack rule text is byte-identical to RULE_TABLE distillation for the same class", () => {
    // formatErrorsToAvoid dedupes by rendered TEXT: if a pack rule drifts one
    // byte from the table-distilled rule, the SAME lesson injects twice for a
    // user with both sources on. Representative raw messages per pack signature:
    const samples = {
      "SYNTAX|syntax error, unexpected X, expecting X": { code: "SYNTAX", msg: "syntax error, unexpected ']', expecting ':' 29 | logic [W-1]" },
      "SYNTAX|too many digits for N bit number: Xb10000000'": { code: "SYNTAX", msg: "Too many digits for 2 bit number: '2'b10000000'" },
      "SYNTAX|syntax error, unexpected identifier, expecting X": { code: "SYNTAX", msg: "syntax error, unexpected IDENTIFIER, expecting \"'{\" 87 | logic prev = clk;" },
      "SYNTAX|syntax error, unexpected parameter, expecting X": { code: "SYNTAX", msg: "syntax error, unexpected parameter, expecting '[' 6 | parameter DATA_W" },
      "SYNTAX|syntax error, unexpected assign": { code: "SYNTAX", msg: "syntax error, unexpected assign 76 | assign B = 0;" },
      "SYNTAX|syntax error, unexpected X, expecting X or X": { code: "SYNTAX", msg: "syntax error, unexpected ':', expecting ',' or ';' 1 | input rst_n : logic" },
      "UNSUPPORTED|unsupported: complex ports (ieee N-N N.N.N.N/N)": { code: "UNSUPPORTED", msg: "Unsupported: complex ports (IEEE 1800-2023 23.2.2.1/2)" },
      "SYNTAX|syntax error, unexpected always_comb": { code: "SYNTAX", msg: "syntax error, unexpected always_comb 24 | always_comb begin" },
    };
    for (const p of KNOWLEDGE_PACKS) {
      for (const rec of p.records) {
        const s = samples[rec.signature];
        if (!s) continue;                       // pack-only lessons have no table twin
        const table = distillRule(s);
        expect(table, p.id + " / " + rec.signature).toBe(rec.rule);
      }
    }
  });

  it("knowledgePacksForModel filters by exact model id", () => {
    expect(knowledgePacksForModel("nvidia/nemotron-3-nano-omni").length).toBeGreaterThan(0);
    expect(knowledgePacksForModel("some/unknown-model")).toEqual([]);
    expect(knowledgePacksForModel(null)).toEqual([]);
  });
});

describe("shippedRuleRecords (the single switch)", () => {
  it("returns nothing when useShippedRules is off — byte-identical injection", () => {
    expect(shippedRuleRecords({ model: "nvidia/nemotron-3-nano-omni" })).toEqual([]);
    expect(shippedRuleRecords({ useShippedRules: false, model: "nvidia/nemotron-3-nano-omni" })).toEqual([]);
  });

  it("auto-enables only packs whose model equals the active model", () => {
    const on = shippedRuleRecords({ useShippedRules: true, model: "nvidia/nemotron-3-nano-omni" });
    expect(on.length).toBeGreaterThan(0);
    expect(on.every((r) => r.model === "nvidia/nemotron-3-nano-omni")).toBe(true);
    // A model with no pack → nothing (inert).
    expect(shippedRuleRecords({ useShippedRules: true, model: "some/unknown-model" })).toEqual([]);
    // No model set → nothing to scope to.
    expect(shippedRuleRecords({ useShippedRules: true })).toEqual([]);
  });

  it("shipped records render into the prompt section for their domain+model", () => {
    const recs = shippedRuleRecords({ useShippedRules: true, model: "nvidia/nemotron-3-nano-omni" });
    const md = formatErrorsToAvoid(recs, { domain: "rtl", model: "nvidia/nemotron-3-nano-omni", crossModel: false });
    expect(md).toMatch(/COMMON MISTAKES TO AVOID/);
    expect(md).toMatch(/backtick/i);
    // Wrong domain → nothing injected.
    expect(formatErrorsToAvoid(recs, { domain: "tb", model: "nvidia/nemotron-3-nano-omni" })).toBe("");
  });

  it("a shipped rule and a locally-harvested twin dedupe to one injected line", () => {
    const shipped = shippedRuleRecords({ useShippedRules: true, model: "nvidia/nemotron-3-nano-omni" });
    // A local record that distils to the SAME rule text.
    const local = shipped.map((r) => Object.assign({}, r, { signature: r.signature + "-local", count: 3 }));
    const md = formatErrorsToAvoid(shipped.concat(local), { domain: "rtl", model: "nvidia/nemotron-3-nano-omni" });
    const backtickLines = md.split("\n").filter((l) => /backtick/i.test(l));
    expect(backtickLines).toHaveLength(1);   // injected once, counts summed
  });
});
