// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/test_review — Stage 7b (optional): LLM Test Review with Fix Loop
//
// Mirror of rtl_review: iterative review→fix→re-review loop over the
// generated testbench. Uses promptTestReview / promptTestReviewFix.
//
// Result shape:
//   test_review   — the final review object with _iterations, _fixes, _reviewedCode
//   test_generate — updated with the fixed testbench (if changed) + _originalCode marker
// ═══════════════════════════════════════════════════════════════════════════

import { callLLM, extractJSON } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { promptTestReview, promptTestReviewFix } from "../../prompts/index.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { tagFixes } from "../fixLoopHelpers.js";
// Per-stage K-to-X reflow (TB-side mirror of rtl_review): chain runs
// test_generate → test_review when test_review's fix iteration needs a
// regenerated testbench.
import { planStageReflow } from "../reflowPlanner.js";
import { runReflowChain, resolveReflowMode } from "../reflowRunner.js";
import { getReflowTail } from "../../constants/stages.js";

export async function testReviewNode(st) {
  const tbCode = (st.test_generate || {}).code || "";
  const rtlCode = (st.rtl_generate || {}).code || "";
  const allLlms = [];
  const maxReviewIters = st._config.maxTestReviewIters || 2;

  // Chain-eligibility check.
  const _hasServices = !!(st._services && typeof st._services.invokeNode === "function");
  const _loggerCtx   = (st._logger && st._logger.context) || {};
  const _alreadyInOwnChain = _loggerCtx.parentStageKey === "test_review";
  const _canChain = _hasServices && !_alreadyInOwnChain;
  const testReviewChainHistory = [];

  // Step 1: Initial review
  let rp = promptTestReview(tbCode, rtlCode, st.spec, st.elicit);
  // Skills targeting "test_review" overlay on the review call.
  rp = await applySkillsToPrompt(rp, st, "test_review");
  const _sc = getStageConfig(st._config, "test_review");
  rp.config = _sc;
  rp.maxTokens = _sc._maxTokens;
  rp.onChunk = st._onLog;
  const rr = await callLLM(rp);
  allLlms.push(Object.assign({ stage: "test_review" }, rr));

  let review = extractJSON(rr.text, rr);

  // Accumulate iterations/fixes in local arrays and reattach at the end (same
  // pattern as rtl_review): reassigning `review` from each re-review would
  // otherwise drop the prior iterations' history.
  const iterations = [{
    iter: 1,
    score: review.score,
    verdict: review.verdict,
    issueCount: (review.issues || []).length,
  }];
  const fixes = [];

  // Step 2: Fix loop if needed
  let finalTB = tbCode;
  let critMajor = (review.issues || []).filter(function(i) {
    return i.severity === "critical" || i.severity === "major";
  });

  for (let iter = 1; iter <= maxReviewIters && review.verdict === "NEEDS_FIX" && critMajor.length > 0; iter++) {
    // Chain path: re-run test_generate → test_review when chaining is available.
    let chainEntryUsed = false;
    let beforeTB = finalTB;
    let fd = null;
    let frText = "";

    if (_canChain) {
      const activeStages = (st._services.allStages || []).slice();
      const tail = getReflowTail("test_review", activeStages);
      const mode = resolveReflowMode("test_review", st._config);
      // Informed loopback: the chain's triage entry (test_generate) receives the
      // review verdict so it can call promptTestReviewFix(tb, rtl, review, spec,
      // el).
      const fixContext = {
        source:        "test_review",
        ownerIter:     iter,
        previousCode:  finalTB,
        previousFixes: fixes,
        reviewResult:  review,
      };
      const chain = planStageReflow({
        ownerKey:   "test_review",
        tail:       tail,
        state:      Object.assign({}, st, { test_generate: { code: finalTB } }),
        mode:       mode,
        fixContext: fixContext,
      });
      if (chain.length > 0) {
        const parentDepth = (_loggerCtx.depth != null) ? _loggerCtx.depth : 0;
        const walk = await runReflowChain({
          chain:        chain,
          st:           st,
          ownerKey:     "test_review",
          ownerIter:    iter,
          parentDepth:  parentDepth,
          currentState: Object.assign({}, st, { test_generate: { code: finalTB } }),
          allLlms:      allLlms,
          appendLog:    function(t, b) { if (st._onLog) st._onLog(t + (b ? "\n" + b : "")); },
          strictOnError: false,
        });
        if (!walk.fallbackToLegacy) {
          chainEntryUsed = true;
          testReviewChainHistory.push({
            iter: iter,
            mode: mode,
            entries: walk.chainHistory,
          });
          const tbAfter = (walk.currentState && walk.currentState.test_generate
                              && walk.currentState.test_generate.code) || finalTB;
          if (tbAfter !== finalTB) {
            finalTB = tbAfter;
          }
          // Chain's last entry is test_review itself; adopt verdict
          if (walk.currentState && walk.currentState.test_review) {
            review = walk.currentState.test_review;
          }
          iterations.push({
            iter: iter + 1,
            score:      review && review.score,
            verdict:    review && review.verdict,
            issueCount: ((review && review.issues) || []).length,
            _structured: {
              rawText: "",
              parsed:  null,
              parseOk: true,
              beforeCode: beforeTB,
              afterCode:  finalTB,
              kind:       "review_fix_via_chain",
              chain:      walk.chainHistory,
              chainMode:  mode,
            },
          });
          critMajor = ((review && review.issues) || []).filter(function(i) {
            return i.severity === "critical" || i.severity === "major";
          });
          continue;
        }
      }
    }

    if (!chainEntryUsed) {
    // ── Legacy inline path (unchanged) ──
    // Fix iteration
    let fp = promptTestReviewFix(finalTB, rtlCode, review, st.spec, st.elicit);
    // Regenerating TB → apply test_generate skills.
    fp = await applySkillsToPrompt(fp, st, "test_generate");
    const _sc2 = getStageConfig(st._config, "test_review_fix");
    fp.config = _sc2;
    fp.maxTokens = _sc2._maxTokens;
    fp.onChunk = st._onLog;
    const fr = await callLLM(fp);
    allLlms.push(Object.assign({ stage: "test_review_fix-iter" + iter }, fr));
    fd = extractJSON(fr.text, fr);
    frText = fr.text || "";
    if (fd.code && fd.code !== finalTB) {
      finalTB = fd.code;
      // Tag fixes with their iter for UI annotation.
      fixes.push(...tagFixes(fd.fixes, iter));
    }

    // Re-review the fixed TB
    let rp2 = promptTestReview(finalTB, rtlCode, st.spec, st.elicit);
    rp2 = await applySkillsToPrompt(rp2, st, "test_review");
    rp2.config = _sc;
    rp2.maxTokens = _sc._maxTokens;
    rp2.onChunk = st._onLog;
    const rr2 = await callLLM(rp2);
    allLlms.push(Object.assign({ stage: "test_review-iter" + (iter + 1) }, rr2));
    review = extractJSON(rr2.text, rr2);
    iterations.push({
      iter: iter + 1,
      score: review.score,
      verdict: review.verdict,
      issueCount: (review.issues || []).length,
      _structured: {
        rawText: frText,
        parsed: fd && typeof fd === "object" ? fd : null,
        parseOk: !!(fd && typeof fd === "object" && fd.code),
        beforeCode: beforeTB,
        afterCode: finalTB,
        kind: "review_fix",
      },
    });
    critMajor = (review.issues || []).filter(function(i) {
      return i.severity === "critical" || i.severity === "major";
    });
    } // close !chainEntryUsed
  }

  // Attach accumulated history to the final review object
  review._iterations = iterations;
  // Preserve iter info for UI annotation, using the { text, iter } shape.
  review._fixes = fixes.map(function(f) {
    if (typeof f === "string") return { text: f, iter: null };
    if (f && typeof f === "object") {
      const id = f.id ? "[" + f.id + "] " : "";
      const text = id + (f.desc || f.description || f._text || JSON.stringify(f));
      return { text: text, iter: typeof f._iter === "number" ? f._iter : null };
    }
    return { text: String(f), iter: null };
  });
  review._reviewedCode = finalTB;
  const tbChanged = finalTB !== tbCode;
  const tbResult = tbChanged
    ? { code: finalTB, _originalCode: tbCode, _fixSource: "fixed post test review" }
    : (st.test_generate || {});

  review._llms = allLlms.slice();
  // Expose chain history when the chain ran.
  if (testReviewChainHistory.length > 0) {
    review._chain = testReviewChainHistory;
  }
  return {
    test_review: review,
    test_generate: tbResult,
    // Full per-call LLM ledger.
    _llms: allLlms.slice(),
    _llm: allLlms.length > 0
      ? allLlms[allLlms.length - 1]
      : { stage: "test_review", tokensIn: 0, tokensOut: 0, latencyMs: 0, model: "", provider: "" },
  };
}
