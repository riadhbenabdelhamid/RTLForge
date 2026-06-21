// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// pipeline/coverageStrengthen — coverage-driven TB strengthening (task #19)
//
// The coverage eval criteria MEASURE under-coverage (line/branch/toggle/…) but
// nothing ACTS on it: a weak-but-passing testbench is a dead end. This module
// closes that loop — it finds the gaps, asks the LLM to ADD targeted tests, and
// keeps the result only if it provably helped.
//
// Mirrors pipeline/mutation.js (runMutationGate): opt-in, real-backend-only,
// runs AFTER a verify PASS. The orchestration takes runCli/callLLM/extractJSON
// as INJECTED deps, and the decision helpers (findCoverageGaps,
// acceptStrengthening) are pure — so the whole thing is unit-testable without a
// live backend.
//
// SOUNDNESS BOUNDARY — additive · non-regressing · positive-evidence-only:
//   • the prompt forbids touching existing tests;
//   • a candidate is adopted ONLY IF it has no failing test, regresses no
//     previously-passing test, AND improves a gated coverage kind or covers a
//     previously-uncovered requirement.
//   • worst case: a few LLM calls and the ORIGINAL TB is kept.
// ═══════════════════════════════════════════════════════════════════════════

import { parseCoverageDat, parseCoverageBuckets, parseTestLine } from "../cli/index.js";
import { parseCoversAnnotations } from "./coversParser.js";
import { promptTBStrengthen } from "../prompts/testGen.js";

const COVERAGE_KINDS = ["line", "branch", "toggle", "fsm", "expr"];

/** Set of requirement ids that a TB's `// covers:` annotations already cover. */
export function coveredReqIds(coversMap) {
  const ids = new Set();
  const tasks = (coversMap && coversMap.tasks) || [];
  for (const t of tasks) { if (t && t.req) ids.add(String(t.req).toUpperCase()); }
  return ids;
}

/**
 * Compute the coverage gaps to target.
 * @param {object} a
 * @param {object} a.cov          parseCoverageDat output {line,branch,…}
 * @param {object} a.buckets      parseCoverageBuckets output {uncovered,byKind}
 * @param {object} a.thresholds   {kind: minPct} — from enabled coverage criteria
 * @param {Array}  a.requirements spec.requirements [{id,desc,pri}]
 * @param {object} a.coversMap    parseCoversAnnotations(tb)
 * @returns {{weakKinds:Array, uncoveredPoints:Array, uncoveredReqs:Array}}
 */
export function findCoverageGaps(a) {
  const cov = (a && a.cov) || {};
  const thresholds = (a && a.thresholds) || {};
  const buckets = (a && a.buckets) || { uncovered: [] };

  const weakKinds = [];
  for (const kind of COVERAGE_KINDS) {
    const thr = thresholds[kind];
    if (thr == null) continue;                 // only chase kinds we gate on
    const measured = cov[kind];
    if (measured == null) continue;            // no data for this kind
    if (measured < thr) weakKinds.push({ kind: kind, measured: measured, threshold: thr });
  }

  const covered = coveredReqIds(a && a.coversMap);
  const priRank = { Must: 0, Should: 1, May: 2 };
  const uncoveredReqs = ((a && a.requirements) || [])
    .filter(function(r) { return r && r.id && (r.pri === "Must" || r.pri === "Should"); })
    .filter(function(r) { return !covered.has(String(r.id).toUpperCase()); })
    .map(function(r) { return { id: r.id, desc: r.desc, pri: r.pri }; })
    .sort(function(x, y) {
      // NB: `|| 9` would mis-rank Must (rank 0 is falsy) — use a null check.
      const rx = priRank[x.pri]; const ry = priRank[y.pri];
      return (rx == null ? 9 : rx) - (ry == null ? 9 : ry);
    });

  return {
    weakKinds: weakKinds,
    uncoveredPoints: Array.isArray(buckets.uncovered) ? buckets.uncovered : [],
    uncoveredReqs: uncoveredReqs,
  };
}

/**
 * Decide whether to adopt a strengthened candidate over the current TB. Pure.
 * @param {{cov:object, tests:Array}} before   {name, st} tests, st === "PASS"/"FAIL"
 * @param {{cov:object, tests:Array}} after
 * @param {object} [opts] { kinds?: string[], reqNewlyCovered?: number }
 * @returns {{accept:boolean, reason:string, gain:object}}
 */
export function acceptStrengthening(before, after, opts) {
  const o = opts || {};
  const kinds = o.kinds || COVERAGE_KINDS;
  const beforeCov = (before && before.cov) || {};
  const afterCov = (after && after.cov) || {};
  const afterTests = (after && after.tests) || [];
  const beforeTests = (before && before.tests) || [];

  // 1. The candidate itself must pass clean — a new FAILING test means the
  //    strengthening is not adoptable as-is (route to the RTL-fix loop instead).
  if (afterTests.some(function(t) { return t && t.st !== "PASS"; })) {
    return { accept: false, reason: "candidate-test-failed", gain: {} };
  }
  // 2. No previously-passing test may disappear or regress.
  const afterByName = {};
  afterTests.forEach(function(t) { if (t && t.name) afterByName[t.name] = t.st; });
  for (const t of beforeTests) {
    if (t && t.st === "PASS" && afterByName[t.name] !== "PASS") {
      return { accept: false, reason: "regression", gain: {} };
    }
  }
  // 3. Positive evidence: a gated kind improved, or a requirement is now covered.
  const kindGain = {};
  let kindImproved = false;
  for (const k of kinds) {
    const delta = (afterCov[k] || 0) - (beforeCov[k] || 0);
    if (delta > 0) { kindGain[k] = delta; kindImproved = true; }
  }
  const reqsCovered = o.reqNewlyCovered || 0;
  const improved = kindImproved || reqsCovered > 0;
  return {
    accept: improved,
    reason: improved ? "improved" : "no-improvement",
    gain: { kinds: kindGain, reqsCovered: reqsCovered },
  };
}

/**
 * Augment plain sim commands with Verilator coverage (mirrors the inline logic
 * in verify.js): add `--coverage` to the compile step and append a
 * `verilator_coverage` post-step if absent. Pure.
 * @param {string[]} cmds
 * @returns {string[]}
 */
export function withCoverageCmds(cmds) {
  const list = (Array.isArray(cmds) ? cmds : []).map(function(c) {
    const isCompile = /verilator(\s|$)/.test(c) &&
      /(--binary|--cc|--main|--exe|-o\s)/.test(c) &&
      !/verilator_coverage/.test(c);
    if (isCompile && !/--coverage/.test(c)) return c.replace(/verilator(\s|$)/, "verilator --coverage$1");
    return c;
  });
  if (!list.some(function(c) { return /verilator_coverage/.test(c); })) {
    list.push("verilator_coverage --write logs/coverage.dat logs/coverage.dat 2>/dev/null || true");
  }
  return list;
}

// Run the sim for one TB and read back coverage + test results. Returns null on
// backend trouble (so a flaky backend never masquerades as an improvement).
async function measure(args, tb) {
  const cliResult = await args.runCli(args.config.backendUrl, {
    commands: args.cmds.map(function(c) {
      return c.replace("{RTL}", args.rtlFileName).replace("{TB}", args.tbFileName);
    }),
    files: { [args.rtlFileName]: args.rtl, [args.tbFileName]: tb },
  }, args.signal, args.cliOpts);
  if (!cliResult || cliResult._error) return null;
  const covRaw = (cliResult.files && (cliResult.files["logs/coverage.dat"] || cliResult.files["coverage.dat"])) || "";
  const tests = (cliResult.stdout || "").split("\n")
    .map(function(l) { return parseTestLine(l); })
    .filter(Boolean)
    .map(function(t) { return { name: t.name, st: t.status }; });
  return { cov: parseCoverageDat(covRaw), buckets: parseCoverageBuckets(covRaw), tests: tests };
}

/**
 * Run the coverage-strengthening loop. See module header for the contract.
 * @param {object} args { rtl, tb, cmds, rtlFileName, tbFileName, spec, elicit,
 *                        thresholds, config, cliOpts, signal, appendLog,
 *                        runCli, callLLM, extractJSON }
 * @returns {Promise<object>} report
 */
export async function runCoverageStrengthening(args) {
  const log = args.appendLog || function() {};
  const maxRounds = (args.config && args.config.coverageStrengthenRounds) || 2;

  const original = await measure(args, args.tb);
  if (!original) return { strengthened: false, reason: "no-baseline" };

  let gaps = findCoverageGaps({
    cov: original.cov, buckets: original.buckets, thresholds: args.thresholds,
    requirements: (args.spec && args.spec.requirements) || [], coversMap: parseCoversAnnotations(args.tb),
  });
  if (gaps.weakKinds.length === 0 && gaps.uncoveredReqs.length === 0) {
    return { strengthened: false, reason: "no-gaps", before: covSummary(original) };
  }

  log("Coverage strengthening — gaps found",
    gaps.weakKinds.map(function(w) { return w.kind + " " + w.measured + "%<" + w.threshold + "%"; }).join(", ")
    + (gaps.uncoveredReqs.length ? " · " + gaps.uncoveredReqs.length + " uncovered req(s)" : ""));

  const kinds = gaps.weakKinds.map(function(w) { return w.kind; });
  let bestTB = args.tb;
  let current = original;
  let rounds = 0;
  let strengthened = false;

  for (let r = 0; r < maxRounds; r++) {
    if (args.signal && args.signal.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    rounds++;
    const prompt = promptTBStrengthen(bestTB, args.rtl, gaps, args.spec, args.elicit);
    const llm = await args.callLLM(prompt);
    const parsed = args.extractJSON(llm.text, llm);
    const candTB = parsed && parsed.code;
    if (!candTB || typeof candTB !== "string") continue;

    const cand = await measure(args, candTB);
    if (!cand) continue;

    const candCovered = coveredReqIds(parseCoversAnnotations(candTB));
    const reqNewlyCovered = gaps.uncoveredReqs
      .filter(function(req) { return candCovered.has(String(req.id).toUpperCase()); }).length;

    const verdict = acceptStrengthening(current, cand, { kinds: kinds.length ? kinds : COVERAGE_KINDS, reqNewlyCovered: reqNewlyCovered });
    if (verdict.accept) {
      bestTB = candTB;
      current = cand;
      strengthened = true;
      gaps = findCoverageGaps({
        cov: cand.cov, buckets: cand.buckets, thresholds: args.thresholds,
        requirements: (args.spec && args.spec.requirements) || [], coversMap: parseCoversAnnotations(candTB),
      });
      if (gaps.weakKinds.length === 0 && gaps.uncoveredReqs.length === 0) break;
    }
  }

  const gain = {};
  for (const k of COVERAGE_KINDS) {
    const d = (current.cov[k] || 0) - (original.cov[k] || 0);
    if (d !== 0) gain[k] = d;
  }
  const newlyCoveredReqs = (function() {
    const orig = coveredReqIds(parseCoversAnnotations(args.tb));
    const fin = coveredReqIds(parseCoversAnnotations(bestTB));
    const out = [];
    fin.forEach(function(id) { if (!orig.has(id)) out.push(id); });
    return out;
  })();

  log(strengthened ? "✓ Coverage strengthening" : "Coverage strengthening — no adoptable improvement",
    strengthened
      ? "rounds=" + rounds + ", +" + Math.max(0, current.tests.length - original.tests.length) + " test(s), "
        + "gain=" + JSON.stringify(gain) + (newlyCoveredReqs.length ? ", +" + newlyCoveredReqs.length + " req(s)" : "")
      : "kept original TB (rounds=" + rounds + ")");

  return {
    strengthened: strengthened,
    rounds: rounds,
    code: bestTB,
    before: covSummary(original),
    after: covSummary(current),
    addedTests: Math.max(0, current.tests.length - original.tests.length),
    coverageGain: gain,
    newlyCoveredReqs: newlyCoveredReqs,
  };
}

function covSummary(m) {
  return { cov: m.cov, passing: (m.tests || []).filter(function(t) { return t.st === "PASS"; }).length, total: (m.tests || []).length };
}
