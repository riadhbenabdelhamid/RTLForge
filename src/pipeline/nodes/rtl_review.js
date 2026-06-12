// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/rtl_review — Stage 4b (optional): LLM Code Review with Fix Loop
//
// Iterative review→fix→re-review loop:
//   1. Review current RTL via promptRTLReview
//   2. If NEEDS_FIX and critical/major issues exist, apply promptRTLReviewFix
//   3. Re-review the fixed RTL
//   4. Repeat until max iterations or verdict = PASS or no crit/major left
//
// Result shape:
//   rtl_review   — the final review object with _iterations, _fixes, _reviewedCode
//   rtl_generate — updated with the fixed code (if changed) + _originalCode marker
// ═══════════════════════════════════════════════════════════════════════════

import { callLLM, extractJSON } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { promptRTLReview, promptRTLReviewFix } from "../../prompts/index.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { tagFixes } from "../fixLoopHelpers.js";
// Per-stage K-to-X reflow: when rtl_review's fix iteration decides RTL needs
// regenerating to address review issues, the chain runs rtl_generate →
// rtl_review instead of inline promptRTLReviewFix + promptRTLReview calls.
import { planStageReflow } from "../reflowPlanner.js";
import { runReflowChain, resolveReflowMode } from "../reflowRunner.js";
import { getReflowTail } from "../../constants/stages.js";

export async function rtlReviewNode(st) {
  const code = (st.rtl_generate || {}).code || "";
  const allLlms = [];
  const maxReviewIters = st._config.maxRtlReviewIters || 2;

  // Chain-eligibility check.
  const _hasServices = !!(st._services && typeof st._services.invokeNode === "function");
  const _loggerCtx   = (st._logger && st._logger.context) || {};
  const _alreadyInOwnChain = _loggerCtx.parentStageKey === "rtl_review";
  const _canChain = _hasServices && !_alreadyInOwnChain;
  const rtlReviewChainHistory = [];

  // Step 1: Initial review
  let rp = promptRTLReview(code, st.spec, st.architect, st.elicit);
  // Skills targeting "rtl_review" overlay on the review call.
  rp = await applySkillsToPrompt(rp, st, "rtl_review");
  const _sc = getStageConfig(st._config, "rtl_review");
  rp.config = _sc;
  rp.maxTokens = _sc._maxTokens;
  rp.onChunk = st._onLog;
  const rr = await callLLM(rp);
  allLlms.push(Object.assign({ stage: "rtl_review" }, rr));

  let review = extractJSON(rr.text, rr);

  // Accumulate iterations/fixes in local arrays and reattach at the end.
  // Assigning `review._iterations` and then reassigning `review` from the next
  // re-review would replace the whole object and silently drop prior entries.
  const iterations = [{
    iter: 1,
    score: review.score,
    verdict: review.verdict,
    issueCount: (review.issues || []).length,
  }];
  const fixes = [];

  // Step 2: Fix loop if needed
  let finalCode = code;
  let critMajor = (review.issues || []).filter(function(i) {
    return i.severity === "critical" || i.severity === "major";
  });

  for (let iter = 1; iter <= maxReviewIters && review.verdict === "NEEDS_FIX" && critMajor.length > 0; iter++) {
    // Chain path: re-run the rtl_generate → rtl_review chain when chaining is
    // available. The chain regenerates RTL and re-reviews it in one walk,
    // replacing the inline fix-then-re-review pair below.
    let chainEntryUsed = false;
    let beforeCode = finalCode;
    let fd = null;
    let frText = "";

    if (_canChain) {
      const activeStages = (st._services.allStages || []).slice();
      const tail = getReflowTail("rtl_review", activeStages);
      const mode = resolveReflowMode("rtl_review", st._config);
      // Informed loopback: the chain's triage entry (rtl_generate) receives the
      // review verdict so it can call promptRTLReviewFix(code, review, spec, el)
      // and address the specific issues the reviewer flagged.
      const fixContext = {
        source:        "rtl_review",
        ownerIter:     iter,
        previousCode:  finalCode,
        previousFixes: fixes,
        reviewResult:  review,
      };
      const chain = planStageReflow({
        ownerKey:   "rtl_review",
        tail:       tail,
        state:      Object.assign({}, st, { rtl_generate: { code: finalCode } }),
        mode:       mode,
        fixContext: fixContext,
      });
      if (chain.length > 0) {
        const parentDepth = (_loggerCtx.depth != null) ? _loggerCtx.depth : 0;
        const walk = await runReflowChain({
          chain:        chain,
          st:           st,
          ownerKey:     "rtl_review",
          ownerIter:    iter,
          parentDepth:  parentDepth,
          currentState: Object.assign({}, st, { rtl_generate: { code: finalCode } }),
          allLlms:      allLlms,
          appendLog:    function(t, b) { if (st._onLog) st._onLog(t + (b ? "\n" + b : "")); },
          strictOnError: false,
        });
        if (!walk.fallbackToLegacy) {
          chainEntryUsed = true;
          rtlReviewChainHistory.push({
            iter: iter,
            mode: mode,
            entries: walk.chainHistory,
          });
          const rtlAfter = (walk.currentState && walk.currentState.rtl_generate
                              && walk.currentState.rtl_generate.code) || finalCode;
          if (rtlAfter !== finalCode) {
            finalCode = rtlAfter;
          }
          // The chain's last entry is rtl_review itself; adopt its
          // review verdict as the iteration's outcome
          if (walk.currentState && walk.currentState.rtl_review) {
            review = walk.currentState.rtl_review;
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
              beforeCode: beforeCode,
              afterCode:  finalCode,
              kind:       "review_fix_via_chain",
              chain:      walk.chainHistory,
              chainMode:  mode,
            },
          });
          critMajor = ((review && review.issues) || []).filter(function(i) {
            return i.severity === "critical" || i.severity === "major";
          });
          continue;  // skip the legacy inline body
        }
      }
    }

    if (!chainEntryUsed) {
    // ── Legacy inline path (unchanged) ──
    // Fix iteration
    let fp = promptRTLReviewFix(finalCode, review, st.spec, st.elicit);
    // This regenerates RTL, so apply rtl_generate skills.
    fp = await applySkillsToPrompt(fp, st, "rtl_generate");
    const _sc2 = getStageConfig(st._config, "rtl_review_fix");
    fp.config = _sc2;
    fp.maxTokens = _sc2._maxTokens;
    fp.onChunk = st._onLog;
    const fr = await callLLM(fp);
    allLlms.push(Object.assign({ stage: "rtl_review_fix-iter" + iter }, fr));
    fd = extractJSON(fr.text, fr);
    frText = fr.text || "";
    if (fd.code && fd.code !== finalCode) {
      finalCode = fd.code;
      // Tag fixes with their iter for the UI fix-list.
      fixes.push(...tagFixes(fd.fixes, iter));
    }

    // Re-review the fixed code
    let rp2 = promptRTLReview(finalCode, st.spec, st.architect, st.elicit);
    rp2 = await applySkillsToPrompt(rp2, st, "rtl_review");
    rp2.config = _sc;
    rp2.maxTokens = _sc._maxTokens;
    rp2.onChunk = st._onLog;
    const rr2 = await callLLM(rp2);
    allLlms.push(Object.assign({ stage: "rtl_review-iter" + (iter + 1) }, rr2));
    review = extractJSON(rr2.text, rr2);
    iterations.push({
      iter: iter + 1,
      score: review.score,
      verdict: review.verdict,
      issueCount: (review.issues || []).length,
      // Capture structured data for the UI viewer (parsed fix JSON +
      // before/after code).
      _structured: {
        rawText: frText,
        parsed: fd && typeof fd === "object" ? fd : null,
        parseOk: !!(fd && typeof fd === "object" && fd.code),
        beforeCode: beforeCode,
        afterCode: finalCode,
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
  // Preserve iter info for UI annotation using the same { text, iter } shape as
  // lint/verify/lint_test, which the panels.jsx fix-list reader handles
  // uniformly.
  review._fixes = fixes.map(function(f) {
    if (typeof f === "string") return { text: f, iter: null };
    if (f && typeof f === "object") {
      const id = f.id ? "[" + f.id + "] " : "";
      const text = id + (f.desc || f.description || f._text || JSON.stringify(f));
      return { text: text, iter: typeof f._iter === "number" ? f._iter : null };
    }
    return { text: String(f), iter: null };
  });
  review._reviewedCode = finalCode;
  const rtlChanged = finalCode !== code;
  const rtlResult = rtlChanged
    ? { code: finalCode, _originalCode: code, _fixSource: "fixed post RTL review" }
    : (st.rtl_generate || {});

  review._llms = allLlms.slice();
  // Expose chain history when the chain ran.
  if (rtlReviewChainHistory.length > 0) {
    review._chain = rtlReviewChainHistory;
  }
  return {
    rtl_review: review,
    rtl_generate: rtlResult,
    // Full per-call LLM ledger.
    _llms: allLlms.slice(),
    _llm: allLlms.length > 0
      ? allLlms[allLlms.length - 1]
      : { stage: "rtl_review", tokensIn: 0, tokensOut: 0, latencyMs: 0, model: "", provider: "" },
  };
}
