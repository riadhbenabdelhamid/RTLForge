// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// bench/scorer — turn one pipeline run into comparable metrics
//
// WHY THIS EXISTS:
//
// The pipeline's prompts and fix loops have been validated STRUCTURALLY (the
// vitest + verifier suites) but never EMPIRICALLY — nothing said whether a
// prompt change actually raised first-pass success or cut iterations. This
// scorer reads a single run's final pipeline state and produces a flat,
// diffable metrics object so the benchmark runner (bench/run.mjs) can score
// the golden spec suite and the report (bench/report.mjs) can compare runs
// across git SHAs.
//
// INPUT: the `finalState` accumulator returned by runStages — stage results
// live on it keyed by stage key (finalState.lint, .verify, .judge, …), each
// carrying a `._llms` per-call ledger. This is exactly the headless drive
// path smoke.mjs uses; no React, no reducer, no live services needed, so the
// scorer is pure and unit-testable against synthetic states.
//
// DESIGN: every metric is null when its stage didn't run, so the aggregator
// can tell "absent" from "ran and scored zero" — the same honesty rule the
// eval gate uses for its denominators.
//
// SCOPE NOTE: the benchmark drives the LINEAR pipeline (runStages), so K-to-X
// reflow chains fall back to their legacy inline path. That means one `_llms`
// array per stage (no nested double-counting) and fewer confounds when
// attributing a metric change to a prompt change — a deliberate simplification.
// ═══════════════════════════════════════════════════════════════════════════

import { estimateCost } from "../src/llm/cost.js";

const STAGE_KEYS = [
  "elicit", "spec", "architect", "rtl_generate", "rtl_review",
  "formal_props", "lint", "test_generate", "test_review", "lint_test",
  "verify", "judge",
];

function asArray(v) { return Array.isArray(v) ? v : null; }

/** first-pass = stage reached a PASS on its FIRST iteration, no fix needed. */
function lintFirstPass(s) {
  const it = s && asArray(s.iterations);
  return it && it[0] ? it[0].status === "PASS" : null;
}
function verifyFirstPass(s) {
  const h = s && asArray(s.verifyHistory);
  if (h && h[0]) return h[0].status === "PASS";
  // Fallback for results that predate verifyHistory: a clean run.
  if (s && typeof s.fail === "number") return s.fail === 0;
  return null;
}
function judgeFirstPass(s) {
  const h = s && asArray(s.judgeHistory);
  return h && h[0] ? h[0].overall === "PASS" : null;
}

/** fix iterations = (recorded iterations) − 1; the first is the initial pass. */
function fixIters(len) {
  return typeof len === "number" ? Math.max(0, len - 1) : null;
}

/**
 * Sum the per-call LLM ledger across every stage on the final state.
 * @returns {{ tokens, costUsd, byStage }}
 */
function tallyLlms(finalState) {
  let tokIn = 0, tokOut = 0, calls = 0, costUsd = 0;
  const byStage = {};
  for (const key of STAGE_KEYS) {
    const stage = finalState[key];
    const llms = stage && asArray(stage._llms);
    if (!llms) continue;
    let sIn = 0, sOut = 0, sCost = 0;
    for (const c of llms) {
      if (!c) continue;
      const ci = c.tokensIn || 0;
      const co = c.tokensOut || 0;
      const cc = estimateCost(ci, co, c.provider);
      sIn += ci; sOut += co; sCost += cc;
      calls++;
    }
    if (llms.length > 0) {
      byStage[key] = {
        calls: llms.length,
        tokensIn: sIn, tokensOut: sOut,
        costUsd: round4(sCost),
      };
    }
    tokIn += sIn; tokOut += sOut; costUsd += sCost;
  }
  return {
    tokens: { in: tokIn, out: tokOut, calls: calls },
    costUsd: round4(costUsd),
    byStage: byStage,
  };
}

function round4(n) { return Math.round(n * 10000) / 10000; }

/**
 * Score one pipeline run.
 *
 * @param {object} finalState  the runStages accumulator (stage results keyed
 *                             by stage key, each with optional `._llms`).
 * @returns {object} a flat metrics record (see header for the contract).
 */
export function scoreRun(finalState) {
  const fs = finalState || {};
  const judge = fs.judge || null;
  const verify = fs.verify || null;
  const lint = fs.lint || null;
  const lintTest = fs.lint_test || null;
  const rtlReview = fs.rtl_review || null;
  const testReview = fs.test_review || null;

  const llmTally = tallyLlms(fs);

  return {
    completed: !!(judge && judge.overall),
    verdict: judge && judge.overall ? judge.overall : null,
    verified: judge && typeof judge.verified === "boolean" ? judge.verified : null,
    // The raw gate outcome, before the UNVERIFIED provenance downgrade.
    evalVerdict: judge && judge.evalOverall ? judge.evalOverall : null,
    score: judge && typeof judge.score === "number" ? judge.score : null,

    firstPass: {
      lint:      lintFirstPass(lint),
      lint_test: lintFirstPass(lintTest),
      verify:    verifyFirstPass(verify),
      judge:     judgeFirstPass(judge),
    },
    fixIters: {
      lint:        fixIters(lint && asArray(lint.iterations) ? lint.iterations.length : null),
      lint_test:   fixIters(lintTest && asArray(lintTest.iterations) ? lintTest.iterations.length : null),
      verify:      fixIters(verify && asArray(verify.verifyHistory) ? verify.verifyHistory.length : null),
      judge:       fixIters(judge && asArray(judge.judgeHistory) ? judge.judgeHistory.length : null),
      rtl_review:  fixIters(rtlReview && asArray(rtlReview._iterations) ? rtlReview._iterations.length : null),
      test_review: fixIters(testReview && asArray(testReview._iterations) ? testReview._iterations.length : null),
    },

    verify: verify ? {
      pass: verify.pass != null ? verify.pass : null,
      total: verify.total != null ? verify.total : null,
      cli: !!verify.cli,
      coverage: verify.cov ? {
        line: verify.cov.line != null ? verify.cov.line : null,
        branch: verify.cov.branch != null ? verify.cov.branch : null,
        toggle: verify.cov.toggle != null ? verify.cov.toggle : null,
      } : null,
    } : null,

    // Testbench-strength gate (only present when mutationTesting was on).
    mutation: verify && verify.mutation ? {
      score: verify.mutation.score,
      killed: verify.mutation.killed,
      total: verify.mutation.total,
      invalid: verify.mutation.invalid,
      survived: Array.isArray(verify.mutation.survived) ? verify.mutation.survived.length : 0,
    } : null,

    // Formal-property binding provenance (only when svaInSim ran a real sim).
    sva: verify && verify.sva ? {
      bound: Array.isArray(verify.sva.bound) ? verify.sva.bound.length : 0,
      skipped: Array.isArray(verify.sva.skipped) ? verify.sva.skipped.length : 0,
      bindFailed: !!verify.sva.bindFailed,
    } : null,

    tokens: llmTally.tokens,
    costUsd: llmTally.costUsd,
    byStage: llmTally.byStage,
  };
}
