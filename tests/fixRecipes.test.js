// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Cross-run fix recipes (episodic-memory refinement, run 18 follow-up).
//
// The measured contrast that shaped this design: signature-keyed retrieval
// at the decision point (the triage memory) has been useful, while blanket
// rule injection at generation (errors-to-avoid) A/B'd as a wash. Recipes
// extend the former: on a MEASURED improvement, the fixer's own
// minimal-change descriptions are stored with model provenance under the
// failure signature, and later runs failing the SAME way get them injected
// into the fix prompt — never anywhere else.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { fixDescsFrom, formatRecipeEvidence, createInMemoryTriageMemory } from "../src/pipeline/triageMemory.js";
import { promptRTLFromVerifyFail, promptTBFromVerifyFail } from "../src/prompts/verify.js";

const SPEC = { requirements: [{ id: "R1", pri: "Must", desc: "d" }], iface: [], params: [] };
const VR = { tests: [{ name: "t1", st: "FAIL" }], log: "" };

describe("fixDescsFrom", function() {
  it("keeps the fixer's descriptions, capped in count and length", function() {
    const many = [];
    for (let i = 0; i < 9; i++) many.push({ test: "t", desc: "fix " + i });
    expect(fixDescsFrom(many).length).toBe(6);
    const long = fixDescsFrom([{ desc: "x".repeat(400) }]);
    expect(long[0].length).toBe(160);
    expect(fixDescsFrom([{ description: "alt field" }, { desc: "" }, null])).toEqual(["alt field"]);
    expect(fixDescsFrom(null)).toEqual([]);
  });
});

describe("formatRecipeEvidence", function() {
  const win = function(lesson, target, model) {
    return { improved: true, target: target || "rtl_generate",
      recipe: { lessons: [lesson], model: model || "qwen35b" } };
  };

  it("renders improved-with-recipe records only, newest first, with provenance", function() {
    const s = formatRecipeEvidence([
      { improved: false, target: "test_generate", recipe: { lessons: ["loser"] } },
      { improved: true, target: "test_generate" },              // no recipe
      win("gated dout load on rd_en && !empty"),
      win("newer lesson"),
    ]);
    expect(s.split("\n")[0]).toContain("newer lesson");          // newest first
    expect(s).toContain("[rtl_generate, qwen35b] gated dout load");
    expect(s).not.toContain("loser");
  });

  it("dedupes identical lessons and caps at 5 lines", function() {
    const rows = [];
    for (let i = 0; i < 8; i++) rows.push(win("lesson " + i));
    rows.push(win("lesson 7"));                                  // duplicate
    const s = formatRecipeEvidence(rows);
    expect(s.split("\n").length).toBe(5);
    expect(s.match(/lesson 7/g).length).toBe(1);
  });

  it("is empty with no qualifying records", function() {
    expect(formatRecipeEvidence([])).toBe("");
    expect(formatRecipeEvidence([{ improved: true, target: "x" }])).toBe("");
  });
});

describe("recipe injection into fix prompts", function() {
  it("renders the recipes section when supplied, omits it otherwise", function() {
    const recipes = "- [test_generate, qwen35b] sampled dout one cycle late";
    const withR = promptRTLFromVerifyFail("module m; endmodule", VR, SPEC, {}, [], null, null, recipes);
    expect(withR.userMessage).toContain("PRIOR SUCCESSFUL FIX RECIPES");
    expect(withR.userMessage).toContain("sampled dout one cycle late");
    const withoutR = promptRTLFromVerifyFail("module m; endmodule", VR, SPEC, {}, [], null, null, "");
    expect(withoutR.userMessage).not.toContain("PRIOR SUCCESSFUL FIX RECIPES");
    const tb = promptTBFromVerifyFail("module tb; endmodule", "module m; endmodule", VR, SPEC, {}, [], null, null, recipes);
    expect(tb.userMessage).toContain("PRIOR SUCCESSFUL FIX RECIPES");
  });
});

describe("recipe round-trip through the memory adapter", function() {
  it("stores under the signature and renders back for the same failure", function() {
    const mem = createInMemoryTriageMemory();
    mem.record({
      signature: "req_func_must|verify_pass_rate",
      target: "rtl_generate", improved: true,
      recipe: { lessons: fixDescsFrom([{ desc: "gated the dout register on the accepted-read condition" }]), model: "qwen3-coder" },
    });
    mem.record({ signature: "other_sig", target: "rtl_generate", improved: true,
      recipe: { lessons: ["irrelevant"], model: "m" } });
    const s = formatRecipeEvidence(mem.lookup("req_func_must|verify_pass_rate"));
    expect(s).toContain("accepted-read condition");
    expect(s).not.toContain("irrelevant");
  });
});
