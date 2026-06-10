// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// skills/invariants — Per-stage structural invariants
//
// A pipeline node's prompt has CONTRACT clauses the parser depends on:
// it asks for JSON output, it asks for specific fields, it asks for
// fenced code blocks. If a skill's overlay text causes the LLM to drop
// one of those clauses, the parser explodes. These are HARD FAILS by
// default — clear error before the LLM call rather than a confusing
// extractJSON error after.
//
// Each invariant is independent and machine-checkable against the
// COMPOSED prompt (core + skills, not just the skill text). That way a
// skill that explicitly RESTATES the core requirement counts as
// preserving it. We're checking the prompt the LLM will see, not the
// skill in isolation.
//
// CONTINUOUS-DEVELOPMENT PRINCIPLE: invariants are a registry. New
// pipeline node? Add one entry here. New parser change that requires a
// new clause? Add one entry. No greppable switch statements.
//
// SHAPE:
//   {
//     id            : stable id used in `overrides_invariants` frontmatter
//     label         : human-friendly summary for error messages
//     stageKeys     : which stages this applies to (subset of pipeline keys)
//     check(prompt) : returns true if invariant holds, false if violated
//     remedy        : prose hint about how to fix in the skill
//     severity      : "structural" (parser would break) | "semantic" (style)
//   }
//
// `severity: structural` defaults to hard-fail. `severity: semantic` is
// soft-fail (warn-and-continue) by default. The user policy from
// answer 3 (hard-fail on EVERYTHING by default, opt-in to warn-only)
// means: by default both kinds fail. The `severity` is what's used
// when the user opts INTO warn-only mode — they can pick "warn on
// semantic, still fail on structural" by setting policy=warn:semantic
// rather than policy=warn:all.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Each invariant returns true if the prompt CONTAINS the structural cue
 * the parser needs. We check liberally — case-insensitive, allow common
 * paraphrases — because LLMs are forgiving but parsers are not.
 */

const INVARIANTS = [
  // ── Stages whose pipeline node calls extractJSON on the LLM output ──
  // These need the prompt to ask for JSON. We check for either an explicit
  // "JSON" mention or a `{ ... }` schema block, both of which reliably
  // produce JSON output in practice.
  {
    id: "json_output_required",
    label: "Stage parser requires JSON output from the LLM",
    stageKeys: [
      "elicit", "spec", "architect", "rtl_generate", "formal_props",
      "lint",   "rtl_review", "test_generate", "test_review", "lint_test",
      "verify", "judge",
    ],
    check: function(composed) {
      const lower = composed.toLowerCase();
      // The invariant is "the prompt INSTRUCTS the LLM to produce JSON".
      // Mere appearance of the word "json" doesn't satisfy that — a
      // skill that says "no JSON, just code" would trip a naïve match.
      // Look for instruction-style phrases: "return JSON", "respond with
      // JSON", "JSON object", "output JSON", etc. OR a {...} schema-like
      // block which reliably elicits JSON output regardless of prose.
      if (/\b(return|respond|reply|output|emit|produce|give|provide)\s+(?:only\s+)?(?:a\s+|an\s+)?(?:valid\s+|plain\s+|raw\s+)?json\b/i.test(composed)) return true;
      if (/\bjson\s+(object|response|output|format|only)\b/i.test(lower)) return true;
      // JSON-looking schema fragment: '{' ... '"foo":' ... '}'
      if (/\{[\s\S]*"[A-Za-z_][A-Za-z0-9_]*"\s*:/.test(composed)) return true;
      return false;
    },
    remedy: "your skill's content reduced the prompt below the structural minimum — re-add an instruction that asks for JSON output (e.g. `Return only a JSON object...`)",
    severity: "structural",
  },

  // ── Stages whose output schema must contain a `code` field ──
  {
    id: "code_field_required",
    label: "Stage requires a `code` field in the output (RTL/TB code goes there)",
    stageKeys: ["rtl_generate", "test_generate"],
    check: function(composed) {
      // Either schema literal `"code":` or prose mentioning "field code"
      if (/"code"\s*:/.test(composed)) return true;
      if (/\bfield[s]?\s+["`']?code["`']?/i.test(composed)) return true;
      // Prose mention "code field" / "in 'code'"
      if (/code\s+(field|key|property)/i.test(composed)) return true;
      return false;
    },
    remedy: "the output schema must declare a `code` field — re-add the schema fragment to the prompt",
    severity: "structural",
  },

  // ── stages where the output must include a `fixes` field ──
  {
    id: "fixes_field_required",
    label: "Fix-loop stage requires a `fixes` array in the output",
    stageKeys: ["lint", "lint_test", "verify", "rtl_review", "test_review"],
    check: function(composed) {
      if (/"fixes"\s*:/.test(composed)) return true;
      if (/\bfixes\s+(field|key|array|list)/i.test(composed)) return true;
      return false;
    },
    remedy: "fix-loop nodes require the LLM to enumerate fixes in a `fixes` array — re-add the schema fragment",
    severity: "structural",
  },

  // ── verify stage requires per-test results (`tests` array) ──
  {
    id: "tests_field_required",
    label: "Verify stage requires a `tests` array in output",
    stageKeys: ["verify"],
    check: function(composed) {
      if (/"tests"\s*:/.test(composed)) return true;
      if (/\btests\s+(field|key|array|list)/i.test(composed)) return true;
      return false;
    },
    remedy: "verify output must include a `tests` array (one entry per testbench item)",
    severity: "structural",
  },

  // ── judge stage requires a verdict ──
  {
    id: "judge_verdict_required",
    label: "Judge stage requires a verdict (`verdict` or `overall`)",
    stageKeys: ["judge"],
    check: function(composed) {
      if (/"(verdict|overall)"\s*:/.test(composed)) return true;
      if (/\b(verdict|overall)\s+(field|key)/i.test(composed)) return true;
      return false;
    },
    remedy: "judge output must include a `verdict` field (or `overall`)",
    severity: "structural",
  },

  // ── SEMANTIC invariants — these are advisory; only fail in strict mode ──
  // Example: stage explicitly says "do not pre-suppose reset polarity";
  // a skill that says "always assume active-low reset" contradicts that.
  // LLM-judge checks could be added here; for now keep one structural-but-soft
  // example to exercise the severity dimension.

  {
    id: "elicit_not_self_answer",
    label: "Elicit stage must not pre-answer questions on the user's behalf",
    stageKeys: ["elicit"],
    check: function(composed) {
      // Soft check: if a skill rams in lines like "always answer X with Y"
      // it's likely contradicting elicit's role. Heuristic, not exact.
      if (/answer\s+(this|the|each|all)\s+question[s]?\s+(with|as)/i.test(composed)) {
        return false;  // skill is telling elicit to pre-answer
      }
      return true;
    },
    remedy: "elicit's role is to ASK clarifying questions, not answer them. Move pre-answer logic into a `spec` skill instead",
    severity: "semantic",
  },
];

/**
 * Get all invariants applicable to a stage key.
 */
export function invariantsForStage(stageKey) {
  return INVARIANTS.filter(function(inv) { return inv.stageKeys.indexOf(stageKey) >= 0; });
}

/**
 * Look up an invariant by id (used by `overrides_invariants` frontmatter).
 */
export function findInvariant(id) {
  return INVARIANTS.find(function(inv) { return inv.id === id; }) || null;
}

/**
 * Test seam: register a synthetic invariant. Returns an unregister fn.
 */
export function _testRegister(invariant) {
  INVARIANTS.push(invariant);
  return function() {
    const idx = INVARIANTS.indexOf(invariant);
    if (idx >= 0) INVARIANTS.splice(idx, 1);
  };
}

/**
 * Read all invariants — used by `rtlforge skills check` so the user can
 * see what's enforced.
 */
export function listAllInvariants() {
  return INVARIANTS.slice();
}
