// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// eval/gate — Run enabled criteria against project state, build verdict
//
// Inputs:
//   state    — current pipeline state snapshot (typically the judge node's
//              `currentState`; same shape as accState passed to nodes,
//              which means {spec, rtl_generate, test_generate, verify,
//              lint, lint_test, formal_props, rtl_review, test_review,
//              elicit, judge}). The gate reads only the fields its
//              measurers need; missing stages produce per-criterion
//              "no data" details instead of crashing.
//   evalCfg  — config.evalCriteria (already normalized by criteria.js)
//
// Output (the new judge verdict shape — see judge.js for how this rides
// in finalJudge.eval and judgeHistory[i].eval):
//
//   {
//     overall: "PASS" | "FAIL",
//     score: 0..100,                // = % of enabled criteria that passed
//     totalEnabled: <int>,
//     passed: <int>,
//     failed: <int>,
//     results: [
//       { id, category, label, enabled, threshold, measured,
//         denominator, detail, status: "PASS"|"FAIL"|"SKIP",
//         margin: <number> },        // measured - threshold (signed)
//       ...
//     ],
//     // For convenience: which criteria ids drove the FAIL — the judge
//     // node uses this to decide which upstream stage to triage to next.
//     failingIds: [<id>, ...],
//     // Plus a summary by category (line counts only, for the GUI table).
//     categories: { requirements: {pass: N, fail: N, skipped: N}, ... },
//   }
//
// PASS rule (per the user's spec): a criterion passes when measured ≥ threshold.
// `>=` not `>` — a 100% threshold with measured=100 should pass; the user
// said "exceeds that percentage" but the natural reading there is
// "reaches or exceeds" (otherwise threshold=100 is unreachable).
// If we get pushback we can flip to strict `>`, but `>=` is the
// standard interpretation in coverage tools.
// ═══════════════════════════════════════════════════════════════════════════

import { listCriteria, getCriterion, listCategories } from "./criteria.js";

/**
 * Run the eval gate.
 *
 * @param {object} state     - pipeline state snapshot
 * @param {object} evalCfg   - config.evalCriteria (already normalized)
 * @returns {object} verdict (see header)
 */
export function runEvalGate(state, evalCfg) {
  const cfg = evalCfg || {};
  const all = listCriteria();
  const results = [];
  let passed = 0;
  let failed = 0;
  let totalEnabled = 0;
  const categories = {};
  for (const cat of listCategories()) {
    categories[cat] = { pass: 0, fail: 0, skipped: 0 };
  }
  const failingIds = [];

  for (const meta of all) {
    const userCfg = cfg[meta.id];
    const enabled = userCfg ? !!userCfg.enabled : !!meta.defaultEnabled;
    const threshold = userCfg && typeof userCfg.threshold === "number"
      ? userCfg.threshold : meta.defaultThreshold;

    // Run the measurer regardless of enable state — UI surfaces the
    // measurement so users can see "if I enabled this, would it pass".
    // Only the verdict math counts enabled ones.
    const crit = getCriterion(meta.id);
    let measurement;
    try { measurement = crit.measure(state); }
    catch (e) {
      measurement = {
        measured: 0, denominator: 0,
        detail: "measurer threw: " + (e && e.message ? e.message : String(e)),
      };
    }
    const measured = typeof measurement.measured === "number" ? measurement.measured : 0;
    const denominator = typeof measurement.denominator === "number" ? measurement.denominator : 0;

    let status;
    if (!enabled) {
      status = "SKIP";
      categories[meta.category].skipped++;
    } else {
      totalEnabled++;
      if (measured >= threshold) {
        status = "PASS";
        passed++;
        categories[meta.category].pass++;
      } else {
        status = "FAIL";
        failed++;
        failingIds.push(meta.id);
        categories[meta.category].fail++;
      }
    }

    results.push({
      id: meta.id,
      category: meta.category,
      label: meta.label,
      enabled: enabled,
      threshold: threshold,
      measured: measured,
      denominator: denominator,
      detail: measurement.detail || null,
      status: status,
      margin: measured - threshold,
    });
  }

  // Score: % of enabled criteria passing. Vacuously 100 when nothing
  // enabled (so a project with zero criteria doesn't FAIL — it's just
  // "you've turned off the gate"). overall is FAIL iff at least one
  // enabled criterion FAILed.
  const score = totalEnabled === 0
    ? 100
    : Math.round((passed / totalEnabled) * 100);
  const overall = failed === 0 ? "PASS" : "FAIL";

  return {
    overall: overall,
    score: score,
    totalEnabled: totalEnabled,
    passed: passed,
    failed: failed,
    results: results,
    failingIds: failingIds,
    categories: categories,
  };
}

/**
 * Map failing criteria → which upstream stage's regen would best address
 * them. Used by the judge node's triage step to pick a fix target.
 *
 * Rationale per category:
 *   requirements failing → spec (the requirement isn't met because the
 *                                spec is wrong/missing) or rtl_generate
 *                                (RTL doesn't implement the spec). We
 *                                prefer rtl_generate because regenerating
 *                                the spec is destructive; specFix is
 *                                tried only if RTL keeps regressing.
 *   verify failing       → test_generate (testbench is the most direct
 *                                lever) or rtl_generate.
 *   coverage failing     → test_generate (need more stimulus).
 *   formal failing       → formal_props (regenerate properties).
 *   lint failing         → the corresponding lint stage's fix loop,
 *                                which is part of lint/lint_test itself —
 *                                from judge's perspective this means
 *                                re-running lint, which doesn't drop in
 *                                cleanly today, so we report rtl_generate
 *                                as the best lever.
 *   review failing       → the corresponding review stage's fix path
 *                                (rtl_review or test_review).
 *
 * Returns an ordered priority list — judge tries the first available
 * triage target. If the resulting state still fails, the next iteration
 * picks the next target.
 */
export function triageTargetsFor(verdict) {
  if (!verdict || verdict.failingIds.length === 0) return [];
  // Count failures by category so judge picks the category with the
  // most failures first.
  const cats = {};
  for (const r of verdict.results) {
    if (r.status !== "FAIL") continue;
    cats[r.category] = (cats[r.category] || 0) + 1;
  }
  const sortedCats = Object.keys(cats).sort(function(a, b) { return cats[b] - cats[a]; });
  const TRIAGE_BY_CAT = {
    requirements: ["rtl_generate", "spec"],
    verify:       ["test_generate", "rtl_generate"],
    coverage:     ["test_generate"],
    formal:       ["formal_props"],
    lint:         ["rtl_generate"],
    review:       ["rtl_review", "test_review", "rtl_generate"],
  };
  const out = [];
  const seen = new Set();
  // Attribution failures (req_must_attributed) are TESTBENCH problems —
  // missing or failing `// covers:` links — not spec/RTL problems, so they
  // must route to test_generate ahead of the category-level mapping (their
  // category is "requirements", whose default targets rtl_generate/spec —
  // regenerating RTL cannot add annotations to the TB).
  if (verdict.failingIds.indexOf("req_must_attributed") >= 0) {
    seen.add("test_generate");
    out.push("test_generate");
  }
  for (const cat of sortedCats) {
    for (const t of (TRIAGE_BY_CAT[cat] || [])) {
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out;
}
