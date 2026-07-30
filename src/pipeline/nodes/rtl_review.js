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
import { promptRTLReview, promptRTLReviewFix, stripFindingEchoes } from "../../prompts/index.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { tagFixes, detectGuttedRewrite, noDeletionDirective, repairRtlCandidate, lastFixWasNoOp } from "../fixLoopHelpers.js";
import { runCli, parseCLIOutput } from "../../cli/index.js";

// Per-stage K-to-X reflow: when rtl_review's fix iteration decides RTL needs
// regenerating to address review issues, the chain runs rtl_generate →
// rtl_review instead of inline promptRTLReviewFix + promptRTLReview calls.
import { planStageReflow } from "../reflowPlanner.js";
import { runReflowChain, resolveReflowMode } from "../reflowRunner.js";
import { getReflowTail, filterEnabledStages } from "../../constants/stages.js";

export async function rtlReviewNode(st) {
  const code = (st.rtl_generate || {}).code || "";
  const allLlms = [];
  const maxReviewIters = st._config.maxRtlReviewIters || 2;
  const _repairLog = function(t, b) { if (st._onLog) st._onLog(t + (b ? "\n" + b : "")); };

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
  //
  // Iteration 1 carries a `_structured` capture of the INITIAL review so the
  // UI's Iterations tab can expand it like every later entry (lint's first
  // iteration is expandable; review's used to render as a dead row). The
  // parsed snapshot is a SHALLOW COPY on purpose: `review._iterations =
  // iterations` is attached to this same object at the end, and storing the
  // live reference here would create a cycle (parsed → _iterations → parsed)
  // that breaks checkpoint serialization.
  const iterations = [{
    iter: 1,
    score: review.score,
    verdict: review.verdict,
    issueCount: (review.issues || []).length,
    _structured: {
      rawText: rr.text || "",
      parsed: Object.assign({}, review),
      parseOk: true,
      beforeCode: code,
      afterCode: code,        // initial review changes nothing — diff is empty
      kind: "initial_review",
    },
  }];
  const fixes = [];

  // Corrective re-ask, shared by the chain and legacy gutted paths. When a fix
  // (inline or chain-regenerated) collapses the module, re-ask ONCE for a
  // COMPLETE working replacement (preserve ports + logic, correct the offending
  // lines) rather than accept the deletion or stall on the flagged original.
  // Returns { code, fd, frText } for a real replacement, or null if it came back
  // gutted again. Re-review of the adopted code is the caller's job (the legacy
  // path already re-reviews below; the chain path adds one).
  async function reaskCompleteModule(baseCode, curReview, iterNum) {
    let rfp = noDeletionDirective(promptRTLReviewFix(baseCode, curReview, st.spec, st.elicit));
    rfp = await applySkillsToPrompt(rfp, st, "rtl_generate");
    const _scF = getStageConfig(st._config, "rtl_review_fix");
    rfp.config = _scF;
    rfp.maxTokens = _scF._maxTokens;
    rfp.onChunk = st._onLog;
    const rfr = await callLLM(rfp);
    allLlms.push(Object.assign({ stage: "rtl_review_fix-reask-iter" + iterNum }, rfr));
    const rfd = extractJSON(rfr.text, rfr);
    if (rfd.code && rfd.code !== baseCode && !detectGuttedRewrite(baseCode, rfd.code)) {
      return { code: rfd.code, fd: rfd, frText: rfr.text || "" };
    }
    return null;
  }

  // ── Review-fix quality bar ──────────────────────────────────────────────
  // A review FIX is generated RTL and gets the same quality steps as
  // rtl_generate output (measured, nemotron run 7: a review fix turned clean
  // RTL into 'q <= (DATA_W){1'b0}' + an embedded _tb module, and the lint
  // stage's LLM couldn't recover): echo-strip → embedded-TB strip +
  // deterministic repair → LINT GATE. The gate rejects a candidate that
  // compiles WORSE than the code it replaces (R1 reject-means-reject; error
  // fixing belongs to the Lint RTL stage, which has the evidence plumbing).
  // No backend / CLI failure → gate abstains (adopt as before) rather than
  // blocking the pipeline on lint infrastructure.
  async function lintErrorCount(rtlCode) {
    if (!st._config.backendUrl) return null;
    const moduleName = (st.elicit && st.elicit.modName) || "module";
    const rtlFileName = moduleName + ".sv";
    const lintCmd = (st._config.lintCmd || "verilator --lint-only -Wall {RTL}")
      .replace("{RTL}", rtlFileName);
    try {
      const res = await runCli(st._config.backendUrl, {
        command: lintCmd, files: { [rtlFileName]: rtlCode },
      }, st._signal, {
        retries:   (st._config.cliRetryCount == null ? 1 : st._config.cliRetryCount),
        timeoutMs: ((st._config.backendTimeoutSec || 600) * 1000),
        logger:    st._logger || null,
      });
      if (!res || res._error || res.exitCode === undefined) return null;
      return parseCLIOutput(res.stderr).errors.length;
    } catch (e) {
      return null;
    }
  }

  async function qualifyReviewFix(candidate, currentCode, iterNum) {
    const echo = stripFindingEchoes(candidate);
    if (echo.stripped > 0) {
      _repairLog("✂ Stripped " + echo.stripped + " echoed finding line(s) (rtl_review iter " + iterNum + ")");
    }
    const repaired = repairRtlCandidate(st._config, echo.code, _repairLog).code;
    if (repaired === currentCode) return { code: currentCode, adopted: false };
    const candErr = await lintErrorCount(repaired);
    if (candErr != null && candErr > 0) {
      const curErr = await lintErrorCount(currentCode);
      if (curErr != null && candErr > curErr) {
        _repairLog("⛔ Review fix rejected — lints worse (rtl_review iter " + iterNum + ")",
          "Candidate has " + candErr + " compile error(s) vs " + curErr + " in the current RTL. Keeping the current code.");
        return { code: currentCode, adopted: false };
      }
    }
    return { code: repaired, adopted: true };
  }

  // Step 2: Fix loop if needed
  let finalCode = code;
  let critMajor = (review.issues || []).filter(function(i) {
    return i.severity === "critical" || i.severity === "major";
  });

  for (let iter = 1; iter <= maxReviewIters && review.verdict === "NEEDS_FIX" && critMajor.length > 0; iter++) {
    // Thrash stop (run 37): the previous iteration's fix produced byte-identical
    // RTL, so this iteration would re-ask the same model with the same inputs
    // and re-review the same code for the same verdict. Stop instead of paying
    // for a fix call plus a review call to learn nothing.
    if (lastFixWasNoOp(iterations)) {
      if (st._onLog) st._onLog("⏹ NO-OP FIX (rtl_review iter " + iter + ")\n"
        + "The previous fix returned byte-identical RTL — the same inputs cannot "
        + "produce a different result, so the loop stops here rather than spend "
        + "another fix + review cycle.");
      break;
    }
    // Chain path: re-run the rtl_generate → rtl_review chain when chaining is
    // available. The chain regenerates RTL and re-reviews it in one walk,
    // replacing the inline fix-then-re-review pair below.
    let chainEntryUsed = false;
    let beforeCode = finalCode;
    let fd = null;
    let frText = "";

    if (_canChain) {
      const activeStages = filterEnabledStages(st._services.allStages, st._config);
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
          // Structural-collapse guard → corrective re-ask. A regenerated
          // empty/near-empty module REVIEWS CLEAN (no issues in nothing) and
          // would ship as a "fixed" stub. Rather than accept the deletion (or
          // stall on the flagged original), re-ask INLINE for a complete working
          // replacement, then RE-REVIEW it so the verdict reflects the adopted
          // code (the chain's verdict was for the gutted output). Keep the
          // current code + prior verdict only if the re-ask also comes back gutted.
          if (rtlAfter !== finalCode && detectGuttedRewrite(finalCode, rtlAfter)) {
            if (st._onLog) st._onLog("↻ COMPLETE-MODULE RE-ASK (rtl_review iter " + iter + ")\n"
              + "Reflow regenerated an empty/near-empty module — re-asking inline for a complete replacement.");
            const rework = await reaskCompleteModule(finalCode, review, iter);
            const _reworkQ = rework ? await qualifyReviewFix(rework.code, finalCode, iter) : null;
            if (_reworkQ && _reworkQ.adopted) {
              finalCode = _reworkQ.code;
              fixes.push(...tagFixes(rework.fd.fixes, iter));
              // Re-review the adopted replacement (the chain reviewed the stub).
              let rrp = promptRTLReview(finalCode, st.spec, st.architect, st.elicit);
              rrp = await applySkillsToPrompt(rrp, st, "rtl_review");
              rrp.config = _sc;
              rrp.maxTokens = _sc._maxTokens;
              rrp.onChunk = st._onLog;
              const rrr = await callLLM(rrp);
              allLlms.push(Object.assign({ stage: "rtl_review-reask-iter" + (iter + 1) }, rrr));
              review = extractJSON(rrr.text, rrr);
              iterations.push({
                iter: iter + 1, score: review && review.score, verdict: review && review.verdict,
                issueCount: ((review && review.issues) || []).length,
                _structured: { rawText: rework.frText, parsed: rework.fd,
                  parseOk: !!(rework.fd && rework.fd.code), beforeCode: beforeCode,
                  afterCode: finalCode, kind: "review_fix_reask" },
              });
              critMajor = ((review && review.issues) || []).filter(function(i) {
                return i.severity === "critical" || i.severity === "major";
              });
              continue;
            }
            if (st._onLog) st._onLog("⚠ REJECT_GUTTED (rtl_review iter " + iter + ")\n"
              + "Re-ask returned an empty module or a lint regression — keeping current RTL and prior review.");
            iterations.push({
              iter: iter + 1, score: review && review.score, verdict: review && review.verdict,
              issueCount: ((review && review.issues) || []).length, gutted: true,
              _structured: { rawText: "", parsed: null, parseOk: true,
                beforeCode: beforeCode, afterCode: finalCode, kind: "review_fix_via_chain",
                chain: walk.chainHistory, chainMode: mode },
            });
            break;
          }
          let _chainFixAdopted = true;
          if (rtlAfter !== finalCode) {
            // Full quality bar (echo-strip → embedded-TB strip + repair →
            // lint gate) — same contract as rtl_generate output. Measured:
            // a review fix re-lost the `timescale backtick after lint had
            // repaired it, and run 7's chain fix shipped a lint regression.
            const q = await qualifyReviewFix(rtlAfter, finalCode, iter);
            _chainFixAdopted = q.adopted;
            if (q.adopted) finalCode = q.code;
          }
          // The chain's last entry is rtl_review itself; adopt its review
          // verdict as the iteration's outcome — but only when its code was
          // adopted (a rejected candidate's verdict describes code we kept out).
          if (_chainFixAdopted && walk.currentState && walk.currentState.rtl_review) {
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
    // Structural-collapse guard → corrective re-ask. An empty module reviews
    // clean and would ship as "fixed post RTL review". Rather than accept the
    // deletion (or stall on the flagged original), re-ask ONCE for a complete,
    // working replacement; keep current RTL only if that also comes back gutted.
    if (fd.code && fd.code !== finalCode && detectGuttedRewrite(finalCode, fd.code)) {
      if (st._onLog) st._onLog("↻ COMPLETE-MODULE RE-ASK (rtl_review iter " + iter + ")\n"
        + "Fix collapsed the module body — re-asking for a complete, working replacement.");
      const rework = await reaskCompleteModule(finalCode, review, iter);
      const _reworkQ2 = rework ? await qualifyReviewFix(rework.code, finalCode, iter) : null;
      if (_reworkQ2 && _reworkQ2.adopted) {
        fd = rework.fd;
        frText = rework.frText;
        finalCode = _reworkQ2.code;
        fixes.push(...tagFixes(rework.fd.fixes, iter));
        // The standard re-review below runs on this reworked finalCode.
      } else {
        if (st._onLog) st._onLog("⚠ REJECT_GUTTED (rtl_review iter " + iter + ")\n"
          + "Re-ask returned an empty module or a lint regression — keeping current RTL.");
        break;
      }
    } else if (fd.code && fd.code !== finalCode) {
      const q = await qualifyReviewFix(fd.code, finalCode, iter);
      if (q.adopted) {
        finalCode = q.code;
        // Tag fixes with their iter for the UI fix-list.
        fixes.push(...tagFixes(fd.fixes, iter));
      } else {
        // Rejected fix, unchanged code: a re-review would re-measure the same
        // artifact — stop here and ship the current code with its honest verdict.
        iterations.push({
          iter: iter + 1, score: review.score, verdict: review.verdict,
          issueCount: (review.issues || []).length, rejected: true,
          _structured: { rawText: frText, parsed: fd, parseOk: !!(fd && fd.code),
            beforeCode: beforeCode, afterCode: finalCode, kind: "review_fix_rejected" },
        });
        break;
      }
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
  // ── Compile-honesty gate (measured: run 21 — the review concluded PASS 82
  // on code with 9 SYNTAX ERRORS; the relative lint gate above only rejects
  // candidates that lint WORSE than what they replace, so equally-broken code
  // sails through and the verdict never has to face the compiler). A PASS
  // verdict cannot stand on non-compiling code: one deterministic lint of the
  // FINAL code downgrades it to NEEDS_FIX with the count attached. Fixing
  // stays the Lint RTL stage's job; this gate only keeps the verdict honest.
  // CLI unavailable → abstain, as everywhere else.
  if (review && review.verdict && review.verdict !== "NEEDS_FIX") {
    const _finalErrs = await lintErrorCount(finalCode);
    if (_finalErrs != null && _finalErrs > 0) {
      if (st._onLog) st._onLog("⛔ REVIEW VERDICT DOWNGRADED (compile-honesty gate)\n"
        + "The final reviewed code has " + _finalErrs + " compile error(s) — a "
        + review.verdict + " verdict cannot stand on non-compiling code. Forcing NEEDS_FIX.");
      review = Object.assign({}, review, {
        verdict: "NEEDS_FIX",
        _compileErrors: _finalErrs,
        summary: "[compile-honesty gate: " + _finalErrs + " compile error(s) in the final code] "
          + (review.summary || ""),
      });
    }
  }

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
