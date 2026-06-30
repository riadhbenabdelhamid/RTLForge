// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Training mode (docs/training-mode.md) — pure core.

import { describe, it, expect } from "vitest";
import {
  trainingBoundaryStage, truncateStagesForTraining,
  distinctSignatureCount, isSaturated, budgetState,
  selectCurriculumTarget, buildSynthSpecPrompt, parseSynthSpec,
  buildRuleRewritePrompt, isValidRewrite, applyRuleRewrite,
} from "../src/pipeline/training.js";

const FULL = ["spec", "architect", "rtl_generate", "lint", "formal_props", "test_generate", "lint_test", "verify", "judge"];

describe("stage truncation", () => {
  it("rtl stops after lint, tb stops after lint_test", () => {
    expect(trainingBoundaryStage("rtl")).toBe("lint");
    expect(trainingBoundaryStage("tb")).toBe("lint_test");
    expect(trainingBoundaryStage("")).toBe(null);
    expect(truncateStagesForTraining(FULL, "rtl")).toEqual(["spec", "architect", "rtl_generate", "lint"]);
    expect(truncateStagesForTraining(FULL, "tb")).toEqual(["spec", "architect", "rtl_generate", "lint", "formal_props", "test_generate", "lint_test"]);
  });
  it("no-op for off mode or an absent boundary (caller must force it active)", () => {
    expect(truncateStagesForTraining(FULL, "")).toEqual(FULL);
    const noLint = ["spec", "architect", "rtl_generate", "test_generate", "verify"];
    expect(truncateStagesForTraining(noLint, "rtl")).toEqual(noLint);
  });
});

describe("distinctSignatureCount + isSaturated", () => {
  const recs = [
    { signature: "A|x", domain: "rtl", model: "M", count: 3 },
    { signature: "B|y", domain: "rtl", model: "M", count: 1 },
    { signature: "A|x", domain: "tb",  model: "M", count: 2 },   // diff domain, same sig text
    { signature: "C|z", domain: "rtl", model: "N", count: 1 },   // diff model
  ];
  it("counts unique signatures, scoped by domain/model", () => {
    expect(distinctSignatureCount(recs, { domain: "rtl" })).toBe(3);          // A,B,C
    expect(distinctSignatureCount(recs, { domain: "rtl", model: "M" })).toBe(2); // A,B
    expect(distinctSignatureCount(recs, {})).toBe(3);                          // A,B,C distinct texts
  });
  it("trips only after `window` consecutive non-growing passes", () => {
    expect(isSaturated([1, 2, 3], 3)).toBe(false);          // not enough points
    expect(isSaturated([3, 4, 4, 4, 4], 3)).toBe(true);     // last == 3-back
    expect(isSaturated([3, 4, 4, 4, 5], 3)).toBe(false);    // grew on the last pass
    expect(isSaturated([5, 5, 5, 5], 3)).toBe(true);
  });
});

describe("budgetState", () => {
  it("trips each limit with the right reason; first-wins order runs→minutes→llm", () => {
    expect(budgetState({ runs: 5 }, { maxRuns: 5 }).reason).toMatch(/max-runs/);
    expect(budgetState({ runs: 0, startMs: 0, nowMs: 31 * 60000 }, { maxMinutes: 30 }).reason).toMatch(/max-minutes/);
    expect(budgetState({ runs: 0, llmCalls: 10 }, { maxLlmCalls: 10 }).reason).toMatch(/max-llm/);
    expect(budgetState({ runs: 1, llmCalls: 1 }, { maxRuns: 5, maxLlmCalls: 5 }).stop).toBe(false);
    // runs checked before llm
    expect(budgetState({ runs: 5, llmCalls: 99 }, { maxRuns: 5, maxLlmCalls: 5 }).reason).toMatch(/max-runs/);
  });
});

describe("selectCurriculumTarget", () => {
  it("empty catalog → first archetype (start broad)", () => {
    const t = selectCurriculumTarget([], "rtl");
    expect(t.code).toBe("WIDTH");
    expect(t.count).toBe(0);
    expect(t.archetype).toMatch(/datapath/i);
  });
  it("picks the thinnest class and maps it to an archetype", () => {
    // WIDTH is well-covered, LATCH absent → target LATCH.
    const recs = [
      { code: "WIDTH", domain: "rtl", count: 9 },
      { code: "CASEINCOMPLETE", domain: "rtl", count: 4 },
      { code: "BLKSEQ", domain: "rtl", count: 4 },
      { code: "COMBDLY", domain: "rtl", count: 4 },
      { code: "UNDRIVEN", domain: "rtl", count: 4 },
      { code: "UNUSEDSIGNAL", domain: "rtl", count: 4 },
    ];
    const t = selectCurriculumTarget(recs, "rtl");
    expect(t.code).toBe("LATCH");
    expect(t.archetype).toMatch(/combinational/i);
  });
  it("scopes counts to the domain", () => {
    const recs = [{ code: "WIDTH", domain: "tb", count: 50 }];   // tb-only, ignored for rtl
    expect(selectCurriculumTarget(recs, "rtl").count).toBe(0);
  });
});

describe("buildSynthSpecPrompt + parseSynthSpec", () => {
  it("prompt names the target archetype and asks for JSON", () => {
    const p = buildSynthSpecPrompt({ archetype: "a round-robin arbiter" }, { recentTitles: ["UART RX"] });
    expect(p).toMatch(/round-robin arbiter/);
    expect(p).toMatch(/JSON/);
    expect(p).toMatch(/UART RX/);   // avoids recent
  });
  it("parses a valid JSON spec and sanitizes the id", () => {
    const text = 'noise {"id":"My Counter!!","title":"Counter","tags":["seq"],"description":"An 8-bit counter with clk, rst, en and output count[7:0]. On each rising clk edge when en is high, count increments and wraps at 255."} trailer';
    const s = parseSynthSpec(text);
    expect(s.id).toBe("my_counter");
    expect(s.title).toBe("Counter");
    expect(s.description).toMatch(/8-bit counter/);
    expect(s.tags).toEqual(["seq"]);
  });
  it("rejects a degenerate spec (too thin / not hardware-shaped)", () => {
    expect(parseSynthSpec('{"description":"do something"}')).toBe(null);     // too short
    expect(parseSynthSpec('{"description":"' + "a quick brown fox ".repeat(5) + '"}')).toBe(null); // no ports/clock
    expect(parseSynthSpec("not json at all")).toBe(null);
    expect(parseSynthSpec("")).toBe(null);
  });
});

describe("Q2 model rule rewrite", () => {
  it("prompt includes the raw symptom and asks for ONE rule", () => {
    const p = buildRuleRewritePrompt({ sample: "unexpected IDENTIFIER, expecting '{'", rule: "draft" });
    expect(p).toMatch(/unexpected IDENTIFIER/);
    expect(p).toMatch(/ONE/);
  });
  it("validates rewrites: rejects empty, over-long, or echo of the symptom", () => {
    const lesson = { sample: "raw symptom text" };
    expect(isValidRewrite("Declare variables before statements.", lesson)).toBe(true);
    expect(isValidRewrite("  ", lesson)).toBe(false);
    expect(isValidRewrite("x".repeat(300), lesson)).toBe(false);
    expect(isValidRewrite("raw symptom text", lesson)).toBe(false);   // just echoes
  });
  it("applyRuleRewrite updates only the matching lesson, marking ruleSource model", () => {
    const recs = [
      { signature: "S1", domain: "tb", model: "A", rule: "old", ruleSource: "table" },
      { signature: "S1", domain: "tb", model: "B", rule: "old", ruleSource: "table" },  // diff model
    ];
    const out = applyRuleRewrite(recs, { signature: "S1", domain: "tb", model: "A" }, "new crisp rule");
    expect(out[0]).toMatchObject({ rule: "new crisp rule", ruleSource: "model" });
    expect(out[1]).toMatchObject({ rule: "old", ruleSource: "table" });   // untouched
    expect(out).not.toBe(recs);   // pure (new array)
  });
});
