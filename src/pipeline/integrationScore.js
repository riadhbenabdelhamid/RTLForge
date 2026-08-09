// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// pipeline/integrationScore — the system verdict, computed rather than asked for
//
// Every input to the integration verdict is a hard measurement: Verilator's
// exit status, the system testbench's pass count, each module's own judge
// result. The verdict itself used to be neither — the rubric was printed into
// the int_judge prompt and the model returned a number, which the pipeline
// stored verbatim as the headline result of the whole run.
//
// Two things were wrong with that.
//
// Nothing checked the answer. A model could return "PASS" with lint errors
// present, or 100 with three modules failing, and the run would print it. The
// three inputs were measured and the one number a user reads was an opinion
// resting on top of them.
//
// And the rubric could not reach 100. Its lines are tiers, not additions —
// lint PASS +30 OR warnings-only +15, testbench 100% +30 OR >=80% +15, all
// modules PASS +25 OR all >=70 +15, package +5 — so a flawless run topped out
// at 90 against a header that said "out of 100". Read the other way, where a
// 100% pass rate also earns the >=80% line, it summed to 120.
//
// Weights here are rescaled so a flawless run is exactly 100, and a component
// that does not APPLY is removed from the denominator rather than deducted
// from the numerator. That distinction matters for the shared package: whether
// a design needs shared type definitions is a fact about the design, not a
// measure of its quality, so a system with no package must still be able to
// score 100 — while a system whose modules DO import one and lack it is
// broken, and scored as such. That case is not hypothetical: run 51 shipped
// exactly that file set out of `export`.
// ═══════════════════════════════════════════════════════════════════════════

/** Weights, summing to 100 when every component applies. */
export const WEIGHTS = { lint: 35, systemTb: 35, modules: 25, sharedPackage: 5 };

/** Does any module's RTL import a package? Then the design requires one. */
export function packageRequired(moduleRtls) {
  const re = /^[^\S\n]*import\s+([A-Za-z_]\w*)\s*::/m;
  for (const code of (moduleRtls || [])) {
    if (re.test(String(code || "").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " "))) {
      return true;
    }
  }
  return false;
}

/**
 * Compute the integration score and verdict from measurements alone.
 *
 * @param {object}   args
 * @param {object}   args.lintData        { status, issues: [{sev}] } | null
 * @param {object}   args.verData         { pass, total, fail } | null
 * @param {Array}    args.perModuleJudges [{ modId, score, overall }]
 * @param {object}   args.sharedPackage   { code } | null
 * @param {string[]} args.moduleRtls      each module's RTL, to see if a package is imported
 * @returns {{score:number, overall:string, components:Array, reasons:string[]}}
 */
export function scoreIntegration(args) {
  const a = args || {};
  const lintData = a.lintData || null;
  const verData = a.verData || null;
  const judges = Array.isArray(a.perModuleJudges) ? a.perModuleJudges : [];
  const pkgCode = a.sharedPackage && a.sharedPackage.code ? String(a.sharedPackage.code) : "";

  const components = [];
  const reasons = [];

  // ── lint ────────────────────────────────────────────────────────────────
  // Absent lint data is not a pass. A run that could not lint has not
  // demonstrated anything, so the component applies and earns nothing.
  const issues = (lintData && Array.isArray(lintData.issues)) ? lintData.issues : [];
  const lintErrors = issues.filter(function(i) { return i && i.sev === "error"; }).length;
  const lintWarnings = issues.filter(function(i) { return i && i.sev === "warning"; }).length;
  const lintRan = !!lintData && lintData.status !== "N/A";
  let lintEarned = 0;
  if (!lintRan) reasons.push("integration lint did not run");
  else if (lintErrors > 0) reasons.push(lintErrors + " integration lint error(s)");
  else if (lintWarnings > 0) { lintEarned = WEIGHTS.lint * 0.6; reasons.push(lintWarnings + " integration lint warning(s)"); }
  else lintEarned = WEIGHTS.lint;
  components.push({ name: "lint", weight: WEIGHTS.lint, earned: lintEarned, applies: true });

  // ── system testbench ────────────────────────────────────────────────────
  const total = verData && Number(verData.total) > 0 ? Number(verData.total) : 0;
  const pass = verData && Number(verData.pass) >= 0 ? Number(verData.pass) : 0;
  const rate = total > 0 ? pass / total : 0;
  let tbEarned = 0;
  if (total === 0) reasons.push("no system testbench results");
  else if (rate >= 1) tbEarned = WEIGHTS.systemTb;
  else if (rate >= 0.8) { tbEarned = WEIGHTS.systemTb * 0.6; reasons.push((total - pass) + " system check(s) failing"); }
  else reasons.push("system testbench pass rate " + Math.round(rate * 100) + "%");
  components.push({ name: "systemTb", weight: WEIGHTS.systemTb, earned: tbEarned, applies: true });

  // ── per-module judges ───────────────────────────────────────────────────
  const allPass = judges.length > 0 && judges.every(function(j) { return j && j.overall === "PASS"; });
  const allSeventy = judges.length > 0 && judges.every(function(j) { return j && Number(j.score) >= 70; });
  let modEarned = 0;
  if (judges.length === 0) reasons.push("no per-module judge results");
  else if (allPass) modEarned = WEIGHTS.modules;
  else if (allSeventy) { modEarned = WEIGHTS.modules * 0.6; reasons.push("not every module judged PASS"); }
  else {
    const weak = judges.filter(function(j) { return !j || Number(j.score) < 70; }).map(function(j) { return j.modId; });
    reasons.push("module(s) below 70: " + weak.join(", "));
  }
  components.push({ name: "modules", weight: WEIGHTS.modules, earned: modEarned, applies: true });

  // ── shared package ──────────────────────────────────────────────────────
  // Applies only when the design actually imports one. A system with no shared
  // definitions is not worse for having none, so it is scored out of the
  // remaining components rather than out of a total it cannot reach.
  const required = packageRequired(a.moduleRtls);
  const pkgApplies = required || pkgCode !== "";
  let pkgEarned = 0;
  if (pkgApplies) {
    if (pkgCode !== "") pkgEarned = WEIGHTS.sharedPackage;
    else reasons.push("modules import a package the system does not provide");
  }
  components.push({
    name: "sharedPackage", weight: WEIGHTS.sharedPackage, earned: pkgEarned, applies: pkgApplies,
  });

  const possible = components.reduce(function(s, c) { return s + (c.applies ? c.weight : 0); }, 0);
  const earned = components.reduce(function(s, c) { return s + (c.applies ? c.earned : 0); }, 0);
  const score = possible > 0 ? Math.round((100 * earned) / possible) : 0;

  // The verdict is not a threshold on the score alone: a design can clear 70
  // on breadth while failing the two things that make an integration real.
  const overall = (score >= 70 && lintRan && lintErrors === 0 && allPass) ? "PASS" : "FAIL";

  return { score, overall, components, reasons };
}
