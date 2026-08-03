// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Recommended defaults for unanswered elicit questions (run 44).
//
// A non-interactive run answers NOTHING — run 44's checkpoint carried
// `answeredQuestions: []` for all fifteen questions — so every question
// vanished between elicit and spec and the assumptions carried the entire
// contract. The one question that would have settled a real ambiguity (which
// CTRL bits are storage) was never resolved, and two independently generated
// designs then implemented opposite readings of it.
//
// Elicit now attaches a `recommended` option per question, and promptSpec
// folds the unanswered-but-recommended ones in as DEFAULTS — labelled as the
// model's own, never as user intent, and still citing the skipped-question
// rationale.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { promptSpec } from "../src/prompts/spec.js";
import { promptElicit } from "../src/prompts/elicit.js";

const Q = (id, recommended) => ({
  id, cat: "functionality", text: id + "?",
  opts: ["full storage", "reserved, reads 0", "Other (specify)"],
  ...(recommended ? { recommended } : {}),
});
const el = (questions, answers) => ({
  domain: "d", modName: "m", assumptions: [], questions,
  answers: answers || {},
});

describe("elicit prompt asks for a recommended default", () => {
  it("names the field in the schema and states the rule", () => {
    const u = promptElicit("a register block").userMessage;
    expect(u).toContain('"recommended"');
    expect(u).toContain("RECOMMENDED DEFAULT");
  });
});

describe("promptSpec folds in unanswered recommendations", () => {
  it("carries the recommended option for an unanswered question", () => {
    const u = promptSpec(el([Q("FUNC-01", "full storage")]), [], "desc").userMessage;
    expect(u).toContain("RECOMMENDED DEFAULTS");
    expect(u).toContain("FUNC-01");
    expect(u).toContain("full storage");
  });

  it("labels them as defaults, not user decisions", () => {
    const u = promptSpec(el([Q("FUNC-01", "full storage")]), [], "desc").userMessage;
    expect(u).toContain("they\nare defaults, not user decisions");
    expect(u).toContain('cite "[default — question skipped]"');
    // the description still outranks them
    expect(u).toMatch(/ORIGINAL USER DESCRIPTION says otherwise/);
  });

  it("an ANSWERED question stays in answeredQuestions and out of the defaults", () => {
    const p = promptSpec(el([Q("FUNC-01", "full storage")], { "FUNC-01": "reserved, reads 0" }), [], "d");
    expect(p.userMessage).not.toContain("RECOMMENDED DEFAULTS");
    expect(p.userMessage).toContain("reserved, reads 0");
  });

  it("questions without a recommendation are left out of the block", () => {
    const u = promptSpec(el([Q("FUNC-01", "full storage"), Q("INTF-09")]), [], "d").userMessage;
    const block = u.slice(u.indexOf("RECOMMENDED DEFAULTS"), u.indexOf("NOTE:"));
    expect(block).toContain("FUNC-01");
    expect(block).not.toContain("INTF-09");
  });

  it("no block at all when nothing is recommended — old behaviour intact", () => {
    const u = promptSpec(el([Q("FUNC-01"), Q("INTF-09")]), [], "d").userMessage;
    expect(u).not.toContain("RECOMMENDED DEFAULTS");
    expect(u).toContain("elicitation question(s) were deliberately left unanswered");
  });

  it("a blank or non-string recommendation is ignored", () => {
    for (const bad of ["", "   ", 42, null]) {
      const q = { id: "FUNC-01", cat: "functionality", text: "t?", opts: ["a"], recommended: bad };
      expect(promptSpec(el([q]), [], "d").userMessage).not.toContain("RECOMMENDED DEFAULTS");
    }
  });
});
