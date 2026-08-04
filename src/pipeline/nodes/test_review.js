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
import { tagFixes, detectTbInfraLoss, lastFixWasNoOp, reviewFixRegressed, splitWarnings, lintAdoptionRegression } from "../fixLoopHelpers.js";
import { runCli, parseCLIOutput } from "../../cli/index.js";
import { analyzeCheckCoverage } from "../tbCheckCoverage.js";
import { maybeRepair } from "../syntaxRepair.js";

/**
 * Deterministic check-coverage enforcement (measured: run 13 false PASS —
 * a broken FIFO scored a verified 20/20 because most checks compared the
 * reference model to itself). A requirement whose EVERY labeled check
 * references no DUT-connected signal is NOT verified: inject one critical
 * issue per such requirement and force NEEDS_FIX, so the existing fix loop
 * carries the exact defect list. Returns the (possibly modified) review.
 */
function enforceCheckCoverage(review, tbCode, onLog) {
  if (!review || typeof review !== "object") return review;
  const cov = analyzeCheckCoverage(tbCode);
  const constant = cov.constantChecks || [];
  const weak = cov.weakChecks || [];
  if (cov.total === 0 || (cov.unverifiedReqs.length === 0 && constant.length === 0)) {
    // Weak checks alone never force a fix round — each has a legitimate use
    // and the cost of a false positive here is a wasted iteration — but they
    // are recorded so an autopsy can see them.
    return weak.length > 0
      ? Object.assign({}, review, { _checkCoverage: { total: cov.total,
          dutObserving: cov.dutObserving, unverifiedReqs: [], weakChecks: weak } })
      : review;
  }
  const issues = Array.isArray(review.issues) ? review.issues.slice() : [];
  // A constant-valued condition discriminates NOTHING — it passes (or fails)
  // for every possible design, so it is a defect regardless of which
  // requirement it carries (measured, run 46: `check(1, "REQ-FUNC-003.1")`
  // and `check($isunknown(0), …)` shipped inside a generated testbench).
  for (const c of constant) {
    issues.push({
      severity: "critical",
      req: (/([A-Z]+-[A-Z]+-\d+)/.exec(c.label || "") || [])[1] || "",
      line: null,
      task: "",
      description: "The check labelled " + (c.label || "?") + " has a constant condition ("
        + String(c.cond).slice(0, 60) + ") — it always evaluates to " + c.always
        + ", so it verifies nothing about the DUT (static analysis).",
      fix: "Replace the constant with a comparison of a DUT output against its "
        + "reference value or the constant the requirement states.",
    });
  }
  for (const req of cov.unverifiedReqs) {
    issues.push({
      severity: "critical",
      req: req,
      line: null,
      task: "",
      description: "Every check labeled " + req + " compares the reference model to itself — "
        + "no signal from the DUT instance's port map appears in the condition, so the "
        + "requirement is never verified against the DUT (static analysis).",
      fix: "Make at least one " + req + " check compare a DUT output port to its ref_ "
        + "counterpart (e.g. check(dout == ref_dout, \"" + req + ".n\")).",
    });
  }
  const forced = Object.assign({}, review, {
    issues: issues,
    verdict: "NEEDS_FIX",
    score: Math.min(typeof review.score === "number" ? review.score : 100, 60),
    _checkCoverage: { total: cov.total, dutObserving: cov.dutObserving,
      unverifiedReqs: cov.unverifiedReqs, constantChecks: constant, weakChecks: weak },
  });
  if (onLog) onLog("⛔ NON-DISCRIMINATING CHECKS (deterministic)\n"
    + cov.dutObserving + " of " + cov.total + " check() conditions observe a DUT signal."
    + (cov.unverifiedReqs.length
        ? " Requirements verified only against the reference model itself: "
          + cov.unverifiedReqs.join(", ") + "." : "")
    + (constant.length
        ? " Constant conditions that verify nothing: "
          + constant.map(function(c) { return (c.label || "?") + " (always " + c.always + ")"; }).join(", ") + "." : "")
    + (weak.length
        ? " Weak (reported, not gated): "
          + weak.map(function(w) { return (w.label || "?") + " [" + w.kind + "]"; }).join(", ") + "." : "")
    + " Verdict forced to NEEDS_FIX.");
  return forced;
}
// Per-stage K-to-X reflow (TB-side mirror of rtl_review): chain runs
// test_generate → test_review when test_review's fix iteration needs a
// regenerated testbench.
import { planStageReflow } from "../reflowPlanner.js";
import { runReflowChain, resolveReflowMode } from "../reflowRunner.js";
import { getReflowTail, filterEnabledStages } from "../../constants/stages.js";

export async function testReviewNode(st) {
  const tbCode = (st.test_generate || {}).code || "";
  const rtlCode = (st.rtl_generate || {}).code || "";
  const allLlms = [];
  const maxReviewIters = st._config.maxTestReviewIters || 4;

  // Chain-eligibility check.
  const _hasServices = !!(st._services && typeof st._services.invokeNode === "function");
  const _loggerCtx   = (st._logger && st._logger.context) || {};
  const _alreadyInOwnChain = _loggerCtx.parentStageKey === "test_review";
  const _canChain = _hasServices && !_alreadyInOwnChain;
  const testReviewChainHistory = [];

  // Step 1: Initial review
  let rp = promptTestReview(tbCode, rtlCode, st.spec, st.elicit, st._config.tbArchitecture);
  // Skills targeting "test_review" overlay on the review call.
  rp = await applySkillsToPrompt(rp, st, "test_review");
  const _sc = getStageConfig(st._config, "test_review");
  rp.config = _sc;
  rp.maxTokens = _sc._maxTokens;
  rp.onChunk = st._onLog;
  const rr = await callLLM(rp);
  allLlms.push(Object.assign({ stage: "test_review" }, rr));

  let review = extractJSON(rr.text, rr);
  review = enforceCheckCoverage(review, tbCode, st._onLog);

  // Accumulate iterations/fixes in local arrays and reattach at the end (same
  // pattern as rtl_review): reassigning `review` from each re-review would
  // otherwise drop the prior iterations' history.
  // Iteration 1 carries a `_structured` capture of the INITIAL review so the
  // UI can expand it like every later entry — see rtl_review.js for the
  // shallow-copy rationale (a live reference would create a cycle once
  // review._iterations is attached, breaking checkpoint serialization).
  const iterations = [{
    iter: 1,
    score: review.score,
    verdict: review.verdict,
    issueCount: (review.issues || []).length,
    _structured: {
      rawText: rr.text || "",
      parsed: Object.assign({}, review),
      parseOk: true,
      beforeCode: tbCode,
      afterCode: tbCode,      // initial review changes nothing — diff is empty
      kind: "initial_review",
    },
  }];
  const fixes = [];

  // Lint a TB candidate and count its TB-attributed {errors, semantic}
  // (run 39). Stages the RTL alongside — TB lints compile both files — and
  // filters diagnostics to the TB file, exactly like the compile-honesty
  // gate below. Returns null when no CLI is configured or the lint fails to
  // run (the gate then abstains, as rtl_review's does).
  async function lintTbCounts(tbCandidate) {
    if (!st._config.backendUrl) return null;
    const _mod = (st.elicit && st.elicit.modName) || "module";
    const _rtlF = _mod + ".sv", _tbF = _mod + "_tb.sv";
    const _cmd = (st._config.tbLintCmd || "verilator --lint-only -Wall {TB}").replace("{TB}", _tbF);
    try {
      const res = await runCli(st._config.backendUrl, {
        command: _cmd, files: { [_rtlF]: rtlCode, [_tbF]: tbCandidate },
      }, st._signal, {
        retries:   (st._config.cliRetryCount == null ? 1 : st._config.cliRetryCount),
        timeoutMs: ((st._config.backendTimeoutSec || 600) * 1000),
        logger:    st._logger || null,
      });
      if (!res || res._error || res.exitCode === undefined) return null;
      const parsed = parseCLIOutput(res.stderr);
      const tbOnly = function(d) { return !d.file || d.file === _tbF; };
      return {
        errors: parsed.errors.filter(tbOnly).length,
        semantic: splitWarnings((parsed.warnings || []).filter(tbOnly)).semantic.length,
      };
    } catch (e) { return null; }
  }

  // The adoption gate itself (run 39): a candidate that lints WORSE than the
  // TB it replaces — more compile errors, or more bug-hiding warnings — is
  // kept out. Run 39's top-level test_review adopted a headerless candidate
  // carrying 7 compile errors; every downstream stage then worked on or
  // around that corruption. Same two-step cost profile as rtl_review: the
  // baseline lint is only paid for when the candidate has something that
  // could be a regression.
  async function qualifyTbCandidate(candidate, currentTb, iterNum) {
    const cand = await lintTbCounts(candidate);
    if (cand && (cand.errors > 0 || cand.semantic > 0)) {
      const cur = await lintTbCounts(currentTb);
      const why = lintAdoptionRegression(cand, cur);
      if (why) {
        if (st._onLog) st._onLog("⛔ TB fix rejected — lints worse (test_review iter " + iterNum + ")\n"
          + "Candidate has " + (why === "errors" ? cand.errors + " compile error(s) vs " + cur.errors
            : cand.semantic + " bug-hiding warning(s) vs " + cur.semantic)
          + " in the current TB. Keeping the current testbench.");
        return { adopted: false, reason: why };
      }
    }
    return { adopted: true, reason: null };
  }

  // Step 2: Fix loop if needed
  let finalTB = tbCode;
  let critMajor = (review.issues || []).filter(function(i) {
    return i.severity === "critical" || i.severity === "major";
  });

  for (let iter = 1; iter <= maxReviewIters && review.verdict === "NEEDS_FIX" && critMajor.length > 0; iter++) {
    // Thrash stop (run 37): the previous iteration's fix produced byte-identical
    // testbench, so this iteration would re-ask the same model with the same inputs
    // and re-review the same code for the same verdict. Stop instead of paying
    // for a fix call plus a review call to learn nothing.
    if (lastFixWasNoOp(iterations)) {
      if (st._onLog) st._onLog("⏹ NO-OP FIX (test_review iter " + iter + ")\n"
        + "The previous fix returned byte-identical testbench — the same inputs cannot "
        + "produce a different result, so the loop stops here rather than spend "
        + "another fix + review cycle.");
      break;
    }
    // Chain path: re-run test_generate → test_review when chaining is available.
    let chainEntryUsed = false;
    let beforeTB = finalTB;
    let _tbLintReject = null;             // set when the lint gate keeps a candidate out
    const beforeReview = review;          // the review this iteration is fixing
    let fd = null;
    let frText = "";

    if (_canChain) {
      const activeStages = filterEnabledStages(st._services.allStages, st._config);
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
          if (tbAfter !== finalTB && detectTbInfraLoss(finalTB, tbAfter)) {
            // Architectural regression (measured: a chain fix rewrote the
            // whole TB, dropping step()/check()/ref_ model) — keep the
            // current TB; the loop's next iteration re-asks with evidence.
            if (st._onLog) st._onLog("⛔ TB fix rejected — infrastructure lost (test_review chain iter " + iter + ")\n"
              + "The candidate dropped the step()/check()/reference-model infrastructure. Keeping the current TB.");
          } else if (tbAfter !== finalTB) {
            // Deterministic-repair chokepoint (measured: a test-review fix
            // introduced hyphenated task names AFTER lint_test — review-family
            // stages were the only adoption paths without one).
            const _repairedTb = maybeRepair(st._config, tbAfter).code;
            const _q = await qualifyTbCandidate(_repairedTb, finalTB, iter);
            if (_q.adopted) finalTB = _repairedTb;
            else _tbLintReject = _q.reason;
          }
          // Same outcome bookkeeping as rtl_review (run 39): only a model that
          // returned byte-identical code is a no-op; a rejected candidate keeps
          // the loop going up to the cap.
          const _tbFixOutcome = (tbAfter === beforeTB) ? "identical"
            : (_tbLintReject ? "rejected:" + _tbLintReject
               : (finalTB === beforeTB ? "rejected:infra" : "adopted"));
          // Chain's last entry is test_review itself; adopt verdict — unless
          // both signals say the fix went backwards (run 37 drove this TB from
          // 59 to 16 with 5 MORE issues; run 28's 75 → 60 SHIPPED).
          if (!_tbLintReject && walk.currentState && walk.currentState.test_review) {
            const candReview = walk.currentState.test_review;
            if (reviewFixRegressed(beforeReview, candReview)) {
              if (st._onLog) st._onLog("⛔ REVIEW REGRESSION (test_review iter " + iter + ")\n"
                + "Fix scored " + candReview.score + " vs " + beforeReview.score
                + " with no fewer blocking issues. Keeping the pre-fix testbench and verdict.");
              finalTB = beforeTB;
              iterations.push({
                iter: iter + 1, score: candReview.score, verdict: candReview.verdict,
                issueCount: ((candReview.issues) || []).length, regressed: true,
                _structured: { rawText: "", parsed: null, parseOk: true,
                  beforeCode: beforeTB, afterCode: beforeTB,
                  kind: "review_fix_rejected_regression",
                  fixOutcome: "rejected:regression",
                  chain: walk.chainHistory, chainMode: mode },
              });
              continue;   // retry until the cap — a rejection is not a no-op
            }
            review = candReview;
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
              fixOutcome: _tbFixOutcome,
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
    if (fd.code && fd.code !== finalTB && detectTbInfraLoss(finalTB, fd.code)) {
      // Architectural regression — keep the current TB (see chain path).
      // Recorded as a REJECTION, not left implicit: without this the ledger
      // entry read "identical" and the no-op stop ended the loop on a
      // rejected candidate — the bad6727 bug through a different door.
      if (st._onLog) st._onLog("⛔ TB fix rejected — infrastructure lost (test_review iter " + iter + ")\n"
        + "The candidate dropped the module header or the step()/check()/reference-model infrastructure. Keeping the current TB.");
      _tbLintReject = "infra";
    } else if (fd.code && fd.code !== finalTB) {
      const _repairedTb = maybeRepair(st._config, fd.code).code;   // repair chokepoint
      const _q = await qualifyTbCandidate(_repairedTb, finalTB, iter);
      if (_q.adopted) finalTB = _repairedTb;
      else _tbLintReject = _q.reason;
      // Tag fixes with their iter for UI annotation.
      fixes.push(...tagFixes(fd.fixes, iter));
    }
    if (_tbLintReject && !chainEntryUsed) {
      // Rejected candidate, unchanged TB: a re-review would re-measure the
      // same artifact, so skip it — but RETRY to the cap, because a rejection
      // is not a no-op (bad6727). Mirrors rtl_review's legacy path.
      iterations.push({
        iter: iter + 1, score: review.score, verdict: review.verdict,
        issueCount: (review.issues || []).length, rejected: true,
        _structured: { rawText: frText, parsed: fd && typeof fd === "object" ? fd : null,
          parseOk: !!(fd && typeof fd === "object" && fd.code),
          beforeCode: beforeTB, afterCode: finalTB,
          kind: "review_fix_rejected",
          fixOutcome: "rejected:" + _tbLintReject },
      });
      continue;
    }

    // Re-review the fixed TB
    let rp2 = promptTestReview(finalTB, rtlCode, st.spec, st.elicit, st._config.tbArchitecture);
    rp2 = await applySkillsToPrompt(rp2, st, "test_review");
    rp2.config = _sc;
    rp2.maxTokens = _sc._maxTokens;
    rp2.onChunk = st._onLog;
    const rr2 = await callLLM(rp2);
    allLlms.push(Object.assign({ stage: "test_review-iter" + (iter + 1) }, rr2));
    let _candReview = extractJSON(rr2.text, rr2);
    _candReview = enforceCheckCoverage(_candReview, finalTB, st._onLog);
    // Same two-signal gate as the chain path above (see rtl_review).
    if (reviewFixRegressed(review, _candReview)) {
      if (st._onLog) st._onLog("⛔ REVIEW REGRESSION (test_review iter " + iter + ")\n"
        + "Fix scored " + _candReview.score + " vs " + review.score
        + " with no fewer blocking issues. Keeping the pre-fix testbench and verdict.");
      iterations.push({
        iter: iter + 1, score: _candReview.score, verdict: _candReview.verdict,
        issueCount: (_candReview.issues || []).length, regressed: true,
        _structured: { rawText: frText, parsed: fd && typeof fd === "object" ? fd : null,
          parseOk: !!(fd && typeof fd === "object" && fd.code),
          beforeCode: beforeTB, afterCode: beforeTB,
          kind: "review_fix_rejected_regression",
          fixOutcome: "rejected:regression" },
      });
      finalTB = beforeTB;
      continue;   // retry until the cap — a rejection is not a no-op (bad6727)
    }
    review = _candReview;
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
        fixOutcome: _tbLintReject ? "rejected:" + _tbLintReject
          : (finalTB === beforeTB ? "identical" : "adopted"),
      },
    });
    critMajor = (review.issues || []).filter(function(i) {
      return i.severity === "critical" || i.severity === "major";
    });
    } // close !chainEntryUsed
  }

  // ── Compile-honesty gate, TB side (measured: run 22 — test_review PASSed
  // a testbench whose task body was syntax-mangled; lint_test then burned
  // its budget failing to repair it, and the whole run ended 0/1. Exact
  // mirror of rtl_review's run-21 gate: a non-NEEDS_FIX verdict gets one
  // deterministic lint of the FINAL TB (RTL staged alongside — TB lints
  // compile both files); compile errors attributed to the TB force
  // NEEDS_FIX with the count attached. No CLI → abstain.
  if (review && review.verdict && review.verdict !== "NEEDS_FIX" && st._config.backendUrl) {
    try {
      const _mod = (st.elicit && st.elicit.modName) || "module";
      const _rtlF = _mod + ".sv", _tbF = _mod + "_tb.sv";
      const _cmd = (st._config.tbLintCmd || "verilator --lint-only -Wall {TB}").replace("{TB}", _tbF);
      const _res = await runCli(st._config.backendUrl, {
        command: _cmd, files: { [_rtlF]: rtlCode, [_tbF]: finalTB },
      }, st._signal, {
        retries:   (st._config.cliRetryCount == null ? 1 : st._config.cliRetryCount),
        timeoutMs: ((st._config.backendTimeoutSec || 600) * 1000),
        logger:    st._logger || null,
      });
      if (_res && !_res._error && _res.exitCode !== undefined) {
        const _tbErrs = parseCLIOutput(_res.stderr).errors
          .filter(function(e) { return !e.file || e.file === _tbF; });
        if (_tbErrs.length > 0) {
          if (st._onLog) st._onLog("⛔ TEST REVIEW VERDICT DOWNGRADED (compile-honesty gate)\n"
            + "The final testbench has " + _tbErrs.length + " compile error(s) — a "
            + review.verdict + " verdict cannot stand on non-compiling code. Forcing NEEDS_FIX.");
          review = Object.assign({}, review, {
            verdict: "NEEDS_FIX",
            _compileErrors: _tbErrs.length,
            summary: "[compile-honesty gate: " + _tbErrs.length + " compile error(s) in the final TB] "
              + (review.summary || ""),
          });
        }
      }
    } catch (_e) { /* gate abstains on infrastructure failure */ }
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
