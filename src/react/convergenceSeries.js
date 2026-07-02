// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// convergenceSeries — pure data for the convergence timeline (roadmap #9)
//
// The biggest observability gap in long runs: nothing tells the user whether a
// run is CONVERGING or THRASHING. The data already exists per stage —
// lint/lint_test `iterations[]` (error/warning counts per fix round), verify
// `verifyHistory[]` (pass/fail per iteration), judge `judgeHistory[]` (unmet
// criteria) — it is simply never plotted. This module derives plot-ready rows;
// the React panel just renders them. Pure, no React, unit-testable.
// ═══════════════════════════════════════════════════════════════════════════

// Badness per point: the number a converging run drives to zero.
function trendOf(points) {
  if (points.length < 2) return "single";
  const last = points[points.length - 1].bad;
  const prev = points[points.length - 2].bad;
  if (last < prev) return "improving";
  if (last > prev) return "regressing";
  return "stuck";
}

function row(key, label, points) {
  if (!points || points.length === 0) return null;
  return {
    key,
    label,
    points,
    chain: points.map((p) => p.bad).join("→"),
    trend: trendOf(points),
    converged: points[points.length - 1].bad === 0,
  };
}

/**
 * Build timeline rows from stage objects (key-named, each optional):
 * { lint, lint_test, verify, judge, rtl_generate, test_generate }.
 * @returns {{rows: Array, chips: Array<{stage: string, label: string}>}}
 */
export function buildConvergenceSeries(stages) {
  const s = stages || {};
  const rows = [];

  for (const [key, label] of [["lint", "Lint RTL"], ["lint_test", "Lint Test"]]) {
    const its = (s[key] && s[key].iterations) || [];
    rows.push(row(key, label, its.map((it) => ({
      iter: it.iter,
      bad: it.errors || 0,   // errors are the convergence target (tiered exit, roadmap #2)
      detail: (it.errors || 0) + "e/" + (it.warnings || 0) + "w",
    }))));
  }

  const vh = (s.verify && s.verify.verifyHistory) || [];
  rows.push(row("verify", "Verify", vh.map((h) => ({
    iter: h.iter,
    bad: Math.max(0, (h.total || 0) - (h.pass || 0)),
    detail: (h.pass || 0) + "/" + (h.total || 0) + " pass",
  }))));

  const jh = (s.judge && s.judge.judgeHistory) || [];
  rows.push(row("judge", "Judge", jh.map((h) => ({
    iter: h.iter,
    bad: h.unmet || 0,
    detail: (h.unmet || 0) + "/" + (h.total || 0) + " unmet",
  }))));

  // Generation chips: one-line facts that now survive the merge (ownership #4).
  const chips = [];
  for (const [key, label] of [["rtl_generate", "RTL gen"], ["test_generate", "TB gen"]]) {
    const st = s[key];
    if (!st) continue;
    if (Array.isArray(st._syntaxRepairs) && st._syntaxRepairs.length > 0) {
      const total = st._syntaxRepairs.reduce((a, f) => a + (f.count || 1), 0);
      chips.push({ stage: key, label: label + ": " + total + " syntax repair(s)" });
    }
    if (st._bestOfN && st._bestOfN.n > 1) {
      chips.push({ stage: key, label: label + ": best-of-" + st._bestOfN.n + " picked #" + st._bestOfN.winner });
    }
  }

  return { rows: rows.filter(Boolean), chips };
}
