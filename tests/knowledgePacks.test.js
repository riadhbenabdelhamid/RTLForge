// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Bundled trained-knowledge packs (docs/training-mode.md, Path B).

import { describe, it, expect } from "vitest";
import {
  KNOWLEDGE_PACKS, knowledgePacksForModel, shippedRuleRecords,
} from "../src/pipeline/knowledgePacks.js";
import { formatErrorsToAvoid } from "../src/pipeline/errorsToAvoid.js";

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
