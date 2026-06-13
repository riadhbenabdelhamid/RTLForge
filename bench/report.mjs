// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// bench/report — aggregate scored runs and diff one batch against a baseline
//
// Pure functions over an array of run RECORDS. A record is what bench/run.mjs
// writes per spec:
//
//   { specId, ok, error?, durationMs, metrics }   metrics = scoreRun(finalState)
//
// `aggregate` rolls a batch into headline numbers; `compare` deltas two
// aggregates (a new SHA vs a baseline); the `format*` helpers render plain
// monospace tables for the terminal and the results file. Every average
// skips null metrics — "stage didn't run" never drags a mean toward zero.
// ═══════════════════════════════════════════════════════════════════════════

const FP_STAGES = ["lint", "lint_test", "verify", "judge"];
const FIX_STAGES = ["lint", "lint_test", "verify", "judge", "rtl_review", "test_review"];

function nums(records, pick) {
  const out = [];
  for (const r of records) {
    const v = pick(r);
    if (typeof v === "number" && isFinite(v)) out.push(v);
  }
  return out;
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function bools(records, pick) {
  const out = [];
  for (const r of records) {
    const v = pick(r);
    if (v === true || v === false) out.push(v);
  }
  return out;
}
function rate(arr) { return arr.length ? arr.filter(Boolean).length / arr.length : null; }
function round(n, d) { if (n == null) return null; const f = Math.pow(10, d); return Math.round(n * f) / f; }

/**
 * Roll a batch of run records into headline metrics.
 * @param {Array} records
 * @returns {object}
 */
export function aggregate(records) {
  const recs = records || [];
  const completed = recs.filter((r) => r.metrics && r.metrics.completed);

  const verdicts = { PASS: 0, UNVERIFIED: 0, FAIL: 0, none: 0 };
  for (const r of recs) {
    const v = r.metrics && r.metrics.verdict;
    if (v === "PASS" || v === "UNVERIFIED" || v === "FAIL") verdicts[v]++;
    else verdicts.none++;
  }

  const firstPassRate = {};
  const meanFixIters = {};
  for (const s of FP_STAGES) {
    firstPassRate[s] = round(rate(bools(recs, (r) => r.metrics && r.metrics.firstPass && r.metrics.firstPass[s])), 3);
  }
  for (const s of FIX_STAGES) {
    meanFixIters[s] = round(mean(nums(recs, (r) => r.metrics && r.metrics.fixIters && r.metrics.fixIters[s])), 2);
  }

  const costs = nums(recs, (r) => r.metrics && r.metrics.costUsd);
  const durs = nums(recs, (r) => r.durationMs);
  const tokIn = nums(recs, (r) => r.metrics && r.metrics.tokens && r.metrics.tokens.in);
  const tokOut = nums(recs, (r) => r.metrics && r.metrics.tokens && r.metrics.tokens.out);

  return {
    n: recs.length,
    completedN: completed.length,
    verdicts: verdicts,
    passRate: round(recs.length ? verdicts.PASS / recs.length : null, 3),
    verifiedRate: round(rate(bools(recs, (r) => r.metrics && r.metrics.verified)), 3),
    meanScore: round(mean(nums(recs, (r) => r.metrics && r.metrics.score)), 1),
    firstPassRate: firstPassRate,
    meanFixIters: meanFixIters,
    meanMutationScore: round(mean(nums(recs, (r) => r.metrics && r.metrics.mutation && r.metrics.mutation.score)), 1),
    totalCostUsd: round(costs.reduce((a, b) => a + b, 0), 4),
    meanCostUsd: round(mean(costs), 4),
    totalTokens: { in: tokIn.reduce((a, b) => a + b, 0), out: tokOut.reduce((a, b) => a + b, 0) },
    meanDurationMs: round(mean(durs), 0),
  };
}

/**
 * Delta one aggregate against a baseline. Positive delta = current is higher.
 * Cost/iterations/duration: lower is better (the formatter marks direction).
 */
export function compare(cur, base) {
  const d = (a, b) => (a == null || b == null) ? null : round(a - b, 4);
  const fpd = {}, fid = {};
  for (const s of FP_STAGES) fpd[s] = d(cur.firstPassRate[s], base.firstPassRate[s]);
  for (const s of FIX_STAGES) fid[s] = d(cur.meanFixIters[s], base.meanFixIters[s]);
  return {
    passRate: d(cur.passRate, base.passRate),
    verifiedRate: d(cur.verifiedRate, base.verifiedRate),
    meanScore: d(cur.meanScore, base.meanScore),
    firstPassRate: fpd,
    meanFixIters: fid,
    meanMutationScore: d(cur.meanMutationScore, base.meanMutationScore),
    totalCostUsd: d(cur.totalCostUsd, base.totalCostUsd),
    meanDurationMs: d(cur.meanDurationMs, base.meanDurationMs),
  };
}

// ─── formatting ──────────────────────────────────────────────────────────────

function pad(s, w) { s = String(s); return s.length >= w ? s : s + " ".repeat(w - s.length); }
function padl(s, w) { s = String(s); return s.length >= w ? s : " ".repeat(w - s.length) + s; }
function fp(v) { return v === true ? "✓" : v === false ? "✗" : "–"; }

/** One row per spec. */
export function formatRunTable(records) {
  const lines = [];
  lines.push(pad("spec", 18) + pad("verdict", 12) + padl("score", 6)
    + "  " + pad("fp l/v/j", 10) + pad("fix l/v/j", 11) + padl("mut", 5) + padl("$", 9) + padl("sec", 7));
  lines.push("─".repeat(88));
  for (const r of records || []) {
    const m = r.metrics || {};
    const fpc = m.firstPass || {};
    const fic = m.fixIters || {};
    const fixStr = [fic.lint, fic.verify, fic.judge].map((x) => x == null ? "–" : x).join("/");
    lines.push(
      pad(r.specId || "?", 18)
      + pad(r.ok === false ? "ERROR" : (m.verdict || "—"), 12)
      + padl(m.score == null ? "—" : m.score, 6)
      + "  " + pad([fp(fpc.lint), fp(fpc.verify), fp(fpc.judge)].join("/"), 10)
      + pad(fixStr, 11)
      + padl(m.mutation ? m.mutation.score : "–", 5)
      + padl(m.costUsd == null ? "–" : m.costUsd.toFixed(3), 9)
      + padl(r.durationMs == null ? "–" : (r.durationMs / 1000).toFixed(1), 7),
    );
  }
  return lines.join("\n");
}

/** Summary block for one aggregate. */
export function formatAggregate(agg) {
  const v = agg.verdicts;
  return [
    "Runs: " + agg.n + " (" + agg.completedN + " completed)",
    "Verdicts: PASS " + v.PASS + " · UNVERIFIED " + v.UNVERIFIED + " · FAIL " + v.FAIL + " · none " + v.none,
    "Pass rate: " + pct(agg.passRate) + "   Verified rate: " + pct(agg.verifiedRate)
      + "   Mean score: " + (agg.meanScore == null ? "—" : agg.meanScore),
    "First-pass rate — lint " + pct(agg.firstPassRate.lint)
      + " · verify " + pct(agg.firstPassRate.verify)
      + " · judge " + pct(agg.firstPassRate.judge),
    "Mean fix iters — lint " + nz(agg.meanFixIters.lint)
      + " · verify " + nz(agg.meanFixIters.verify)
      + " · judge " + nz(agg.meanFixIters.judge),
    "Mean mutation score: " + (agg.meanMutationScore == null ? "— (not run)" : agg.meanMutationScore),
    "Total cost: $" + (agg.totalCostUsd == null ? "0" : agg.totalCostUsd)
      + "   Mean/run: $" + (agg.meanCostUsd == null ? "0" : agg.meanCostUsd)
      + "   Tokens: " + agg.totalTokens.in + " in / " + agg.totalTokens.out + " out",
  ].join("\n");
}

/** Diff block: current vs baseline. */
export function formatComparison(cur, base) {
  const c = compare(cur, base);
  const arrow = (delta, lowerIsBetter) => {
    if (delta == null) return "  —";
    if (delta === 0) return "  =0";
    const better = lowerIsBetter ? delta < 0 : delta > 0;
    return (delta > 0 ? "+" : "") + delta + (better ? " ↑good" : " ↓worse");
  };
  return [
    "Δ pass rate:      " + arrow(c.passRate, false),
    "Δ verified rate:  " + arrow(c.verifiedRate, false),
    "Δ mean score:     " + arrow(c.meanScore, false),
    "Δ fp verify:      " + arrow(c.firstPassRate.verify, false),
    "Δ fp judge:       " + arrow(c.firstPassRate.judge, false),
    "Δ fix iters verify:" + arrow(c.meanFixIters.verify, true),
    "Δ fix iters judge: " + arrow(c.meanFixIters.judge, true),
    "Δ mutation score: " + arrow(c.meanMutationScore, false),
    "Δ total cost:     " + arrow(c.totalCostUsd, true),
    "Δ mean duration:  " + arrow(c.meanDurationMs, true),
  ].join("\n");
}

function pct(r) { return r == null ? "—" : Math.round(r * 100) + "%"; }
function nz(v) { return v == null ? "—" : v; }
