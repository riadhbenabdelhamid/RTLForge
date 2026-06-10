// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// skills/validate — Rule-based contradiction detector
//
// Runs each invariant for the stage against the COMPOSED prompt. Returns
// a structured report:
//
//   {
//     contradictions : Array<{
//       invariantId, label, severity, remedy,
//       overriddenBy: string|null,    // skill id if overridden via frontmatter
//     }>
//     hardFails    : same shape, where the contradiction is NOT overridden
//                    (these stop the run by default)
//     warnings     : same shape, soft (semantic) failures or overridden
//                    structural failures
//   }
//
// The user policy from the design conversation:
//   default: hard-fail on EVERYTHING (structural + semantic)
//   user opts INTO warn-only via:
//     - config.skillContradictionPolicy = "warn" (warn on all)
//     - config.skillContradictionPolicy = "warn-semantic" (warn on semantic
//       only; structural still fails)
//     - skill frontmatter `overrides_invariants: [<id>]` (per-skill override)
//
// `applyPolicy` takes the report + policy and returns the FINAL hardFails
// the run should stop on. validate.js itself doesn't decide the policy;
// it just labels each contradiction and lets the orchestrator gate.
// ═══════════════════════════════════════════════════════════════════════════

import { invariantsForStage, findInvariant } from "./invariants.js";

/**
 * @typedef {Object} ContradictionReport
 * @property {Array<Contradiction>} contradictions  - all invariant violations
 * @property {Array<string>} unknownOverrides       - frontmatter `overrides_invariants`
 *                                                    that named non-existent invariant ids
 */

/**
 * Build the "set of invariant ids overridden by at least one skill in this
 * composition" — used so a power-user can deliberately break a rule and
 * the validator just warns instead of failing.
 */
function collectOverrides(skills) {
  const overrides = new Map();           // invariantId → first skill id that overrides
  const unknown = [];                    // override ids that don't match any invariant
  for (const s of skills || []) {
    if (!Array.isArray(s.overrides) || s.overrides.length === 0) continue;
    for (const id of s.overrides) {
      if (!findInvariant(id)) {
        unknown.push({ skillId: s.id, invariantId: id });
        continue;
      }
      if (!overrides.has(id)) overrides.set(id, s.id);
    }
  }
  return { overrides, unknown };
}

/**
 * Validate a composed prompt against invariants for the given stage.
 *
 * @param {object} args
 * @param {string} args.stageKey
 * @param {string} args.composedText      - composeWithSkills().text
 * @param {Array}  args.skills             - the loaded skills used in compose
 * @returns {ContradictionReport}
 */
export function validateComposedPrompt(args) {
  const { stageKey, composedText, skills } = args;
  const invariants = invariantsForStage(stageKey);
  const { overrides, unknown } = collectOverrides(skills);

  const contradictions = [];
  for (const inv of invariants) {
    let ok;
    try { ok = !!inv.check(composedText); }
    catch (_e) { ok = false; }     // a check that throws → treat as failure
    if (ok) continue;
    const overriddenBy = overrides.get(inv.id) || null;
    contradictions.push({
      invariantId: inv.id,
      label: inv.label,
      severity: inv.severity,
      remedy: inv.remedy,
      overriddenBy: overriddenBy,
    });
  }

  return {
    contradictions: contradictions,
    unknownOverrides: unknown.map(function(u) {
      return { skillId: u.skillId, invariantId: u.invariantId };
    }),
  };
}

/**
 * Apply the user's contradiction policy and split the report into
 * hardFails (run should stop) and warnings (run continues with note).
 *
 * Policy values:
 *   "fail"           → default — every contradiction is a hard fail
 *                      (overridden contradictions are still warnings)
 *   "warn"           → all contradictions are warnings (no hard fails)
 *   "warn-semantic"  → semantic contradictions warn; structural still fail
 *
 * Per-skill `overrides_invariants` ALWAYS turns the named contradiction
 * into a warning regardless of global policy — that's the entire point
 * of the override.
 */
export function applyPolicy(report, policy) {
  const p = policy || "fail";
  const hardFails = [];
  const warnings = [];

  for (const ctr of report.contradictions) {
    // Frontmatter override always wins → warning.
    if (ctr.overriddenBy) { warnings.push(ctr); continue; }
    // Global policy
    if (p === "warn") { warnings.push(ctr); continue; }
    if (p === "warn-semantic" && ctr.severity === "semantic") { warnings.push(ctr); continue; }
    hardFails.push(ctr);
  }

  // Unknown override ids are always warnings — typo-prevention surface
  // (we don't fail because the user might be writing a skill against an
  // invariant from a future version of rtlforge).
  for (const u of report.unknownOverrides) {
    warnings.push({
      invariantId: u.invariantId,
      label: "skill `" + u.skillId + "` declares overrides_invariants: [" + u.invariantId + "] but no such invariant exists in this rtlforge version",
      severity: "config",
      remedy: "remove the entry or upgrade rtlforge",
      overriddenBy: null,
    });
  }
  return { hardFails: hardFails, warnings: warnings };
}
