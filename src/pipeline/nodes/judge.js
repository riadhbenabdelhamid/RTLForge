// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/judge — Stage 9: Deterministic Eval Gate with Iterative Fix Loop
//
// This node uses a fully deterministic gate driven by user-configured criteria
// rather than an LLM-rubric verdict. The rubric is reproducible, auditable, and
// tuned by the user via Workflow Settings → Evals. The LLM is not asked to
// grade; it is only used for the OPTIONAL triage step (which stage to fix when
// the gate FAILs) and for the regen steps that follow.
//
// FLOW (one judge iteration):
//
//   1. Run runEvalGate(currentState, evalCriteria) → verdict
//   2. Push history[i] with verdict + iter context.
//   3. If verdict.overall === "PASS"     → break, no fix needed
//      If iter >= maxJudgeIters          → break, return best-known
//   4. Stagnation: if verdict score same 2 iters running → break.
//   5. Triage: pick which upstream stage to regen. Use the deterministic
//      triageTargetsFor(verdict) priority list; only call the LLM
//      triage prompt if multiple candidates tie.
//   6. Run regen for the picked stage(s); capture structured before/after
//      into history[i]._structured for the GUI iteration drill-down.
//   7. Re-verify (LLM-based — verify.js owns its own deterministic
//      path when CLI backend is configured).
//   8. Loop.
//
// SHAPE of the returned `judge` object — preserved-with-extensions for
// backward compat with the existing GUI tabs:
//
//   judge: {
//     overall      : "PASS" | "FAIL" | "UNVERIFIED"
//                    PASS requires the eval gate to pass AND the verify data
//                    to come from a real simulation run (verify.cli === true).
//                    A gate-PASS built on LLM-estimated sim results is
//                    downgraded to UNVERIFIED — see the verification-
//                    provenance gate at the bottom of judgeNode.
//     verified     : boolean — true only when verify ran on the CLI backend
//     evalOverall  : "PASS" | "FAIL" — the raw eval-gate outcome BEFORE the
//                    provenance downgrade, preserved so the downgrade is
//                    always auditable/reconstructable
//     unverifiedReason : string, present only when overall === "UNVERIFIED"
//     score        : 0..100                     (from final eval verdict)
//     trace        : [{ req, ok, note }]        (synthesised from req criteria)
//     recs         : [<string>]                 (synthesised from failing crits)
//     eval         : <full verdict>             (auditable per-criterion)
//     judgeHistory : [{ iter, eval, score, overall, totalEnabled, passed,
//                       failed, triageTarget, _structured? }]
//   }
//
// Note: judgeHistory entries keep the RAW gate overall ("PASS"/"FAIL") — the
// provenance downgrade applies only to the final user-facing verdict, because
// the per-iteration history documents what the gate measured, not what we
// chose to claim about it.
//
// Note: judgeHistory entries' `unmet`/`total` keys now count failing eval
// criteria (not unmet-Must-reqs). They're still written so the existing
// JudgeStage Iterations tab keeps working; the per-criterion breakdown lives in
// `eval.results`.
// ═══════════════════════════════════════════════════════════════════════════

import { callLLM, extractJSON } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
// Judge does its own CLI-backed re-verify rather than always calling the LLM,
// using the same primitives verify.js uses so the result shape is identical.
import { runCli, parseTestLine, parseCoverageDat } from "../../cli/index.js";
import { classifyTestResults } from "../classifiers.js";
import {
  promptJudgeTriage,
  promptSpec,
  promptRTL,
  promptTB,
  promptVerify,
} from "../../prompts/index.js";
import { createLogger } from "../log.js";
import { runEvalGate, triageTargetsFor } from "../../eval/gate.js";
import { defaultEvalConfig, normalizeEvalConfig } from "../../eval/criteria.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
// K-to-X reflow planner: when judge picks a triage target, planReflow produces
// the chain of stages to re-run, and runReflowChain invokes each one via the
// pipeline service (the runner is shared so non-judge stages can use it too).
import { planReflow } from "../reflowPlanner.js";
import { runReflowChain } from "../reflowRunner.js";
// SVA-in-simulation for judge's CLI re-verify — mirrors verify.js so a
// re-verified state is checked against the same bound properties. See
// svaBind.js for rationale + safety contract.
import { buildSvaChecker, injectVerilatorFlag, svaCompileFailed } from "../svaBind.js";

/**
 * Build a `trace` array per requirement with evidence-based status.
 *
 * Each req gets a tri-state derived from real evidence (rather than a blanket
 * `ok: true` that would paint ✓ marks even when verify hadn't run):
 *
 *   "ok"        — positive evidence: verify produced ≥1 passing test AND
 *                 the eval criterion for this req's (cat, pri) bucket
 *                 measured ≥ its threshold.
 *   "violated"  — verify ran AND produced ≥1 failing test AND the
 *                 category-criterion failed. (Verify ran but the
 *                 implementation breaks this req.)
 *   "untested"  — verify hasn't run yet, has no tests, or the relevant
 *                 criterion is disabled in the eval config.
 *
 * The renderer (`stages.jsx`) reads `status` and picks the icon (✓/✗/?).
 * For backward compatibility the legacy `ok` boolean is kept; consumers
 * who only check `ok === true` will still work, just less informatively.
 */
function synthesisedTrace(state, evalVerdict) {
  const reqs = (state && state.spec && state.spec.requirements) || [];
  const verify = state && state.verify;
  const hasVerifyData = verify && (verify.total || 0) > 0;
  const verifyAnyFail = hasVerifyData && (verify.fail || 0) > 0;

  // Map each req to its category-criterion result. The eval-verdict
  // results carry per-criterion status; we look up the requirement's
  // category × priority bucket.
  const verdictBy = new Map();
  if (evalVerdict && Array.isArray(evalVerdict.results)) {
    for (const r of evalVerdict.results) verdictBy.set(r.id, r);
  }

  function reqCriterionId(req) {
    const rc = (req.cat || "").toLowerCase();
    const catId =
      /^(func|functional|functionality)$/.test(rc) ? "func"   :
      /^(verif|verification|test|testbench)$/.test(rc) ? "verif"  :
      /^(timing|perf|performance)$/.test(rc)         ? "timing" :
      /^(intf|interface|io|port)$/.test(rc)          ? "intf"   :
      null;
    if (!catId) return null;
    const rp = (req.pri || "").toLowerCase();
    if (rp === "must")    return "req_" + catId + "_must";
    if (rp === "should")  return "req_" + catId + "_should";
    return null;  // unknown priority → no direct criterion mapping
  }

  return reqs.map(function(r) {
    const critId = reqCriterionId(r);
    const critResult = critId ? verdictBy.get(critId) : null;
    let status, note, ok;

    if (!hasVerifyData) {
      status = "untested";
      note = "no verify run yet";
      ok = false;
    } else if (!critResult || !critResult.enabled) {
      status = "untested";
      note = "no eval criterion enabled for " + (r.cat || "?") + "/" + (r.pri || "?");
      ok = false;
    } else if (critResult.status === "PASS") {
      status = "ok";
      note = critResult.detail || "criterion " + critId + " passing";
      ok = true;
    } else if (critResult.status === "FAIL" && verifyAnyFail) {
      status = "violated";
      note = critResult.detail || "criterion " + critId + " failing";
      ok = false;
    } else {
      // Criterion failed but no concrete failing test points at this
      // req — treat as untested rather than violated. (e.g. coverage-
      // driven fail wouldn't mean any specific req is violated.)
      status = "untested";
      note = "indirect failure via " + critId;
      ok = false;
    }

    return { req: r.id, ok: ok, status: status, note: note };
  });
}

/**
 * Build human-readable recommendations from a FAIL verdict.
 */
function recommendationsFor(verdict) {
  if (!verdict) return [];
  const out = [];
  for (const r of verdict.results) {
    if (r.status !== "FAIL") continue;
    out.push(
      "[" + r.category + "] " + r.label + ": " +
      r.measured + "% (need ≥" + r.threshold + "%, short by " + Math.abs(r.measured - r.threshold) + ")"
      + (r.detail ? " — " + r.detail : "")
    );
  }
  if (out.length === 0 && verdict.overall === "PASS") {
    out.push("All " + verdict.totalEnabled + " enabled criteria passed.");
  }
  return out;
}

/**
 * Pick a triage target. Strategy:
 *   1. Use triageTargetsFor(verdict) to get an ordered list.
 *   2. If exactly one candidate, no LLM call needed.
 *   3. If 2+ candidates, call promptJudgeTriage and constrain its pick
 *      to the deterministic candidate set.
 */
async function pickTriageTarget(verdict, currentState, st, allLlms, jIter, appendLog) {
  // Test-only hook: pin a specific triage target via st._config._testTriageTarget
  // so tests can exercise the chain path without stubbing the triage LLM call.
  if (st && st._config && typeof st._config._testTriageTarget === "string") {
    return { target: st._config._testTriageTarget, reason: "test override", viaLLM: false };
  }
  const candidates = triageTargetsFor(verdict);
  if (candidates.length === 0) {
    return { target: "rtl_generate", reason: "no failing criteria but FAIL — defaulting", viaLLM: false };
  }
  if (candidates.length === 1) {
    return { target: candidates[0], reason: "single candidate from eval gate", viaLLM: false };
  }
  const fakeJudgeData = {
    overall: "FAIL",
    score: verdict.score,
    trace: synthesisedTrace(currentState, verdict),
    recs: recommendationsFor(verdict),
  };
  const ttp = promptJudgeTriage(fakeJudgeData, currentState.spec, currentState.elicit);
  const _scT = getStageConfig(st._config, "judge");
  ttp.config = _scT;
  ttp.maxTokens = _scT._maxTokens;
  ttp.onChunk = function(t, m) { appendLog.stream("Triage", t); if (st._onLog) st._onLog(appendLog.buf, m); };
  const ttr = await callLLM(ttp);
  allLlms.push(Object.assign({ stage: "judge-triage-" + jIter }, ttr));
  let triage;
  try { triage = extractJSON(ttr.text); }
  catch (e) { triage = { target: candidates[0], reason: "parse error → first deterministic candidate" }; }
  if (candidates.indexOf(triage.target) < 0) {
    appendLog("Triage override", "LLM picked " + triage.target + " not in {" + candidates.join(",") +
      "}; using first deterministic candidate '" + candidates[0] + "'");
    triage.target = candidates[0];
  }
  return { target: triage.target, reason: triage.reason || "", viaLLM: true };
}

export async function judgeNode(st) {
  const allLlms = [];
  const judgeHistory = [];
  let finalVerdict = null;
  let currentState = Object.assign({}, st);
  let bestState = Object.assign({}, st);
  let bestScore = -1;
  let lastSig = null;
  let stagnation = 0;

  const appendLog = createLogger(st._onLog, "thin");

  // Resolve eval criteria from config; fall back to conservative defaults.
  const evalCfg = (st._config && st._config.evalCriteria)
    ? normalizeEvalConfig(st._config.evalCriteria).config
    : defaultEvalConfig();

  const _maxJudgeIters = (st._config && st._config.maxJudgeIters) || 3;

  for (let jIter = 1; jIter <= _maxJudgeIters; jIter++) {
    appendLog(
      "Judge — iteration " + jIter + "/" + _maxJudgeIters,
      "Running deterministic eval gate against project state…",
    );

    const verdict = runEvalGate(currentState, evalCfg);

    const historyEntry = {
      iter: jIter,
      eval: verdict,
      // Back-compat fields for the existing Iterations tab.
      overall: verdict.overall,
      score: verdict.score,
      unmet: verdict.failed,
      total: verdict.totalEnabled,
    };
    judgeHistory.push(historyEntry);

    if (verdict.score > bestScore) {
      bestScore = verdict.score;
      bestState = Object.assign({}, currentState);
      appendLog("Best state updated (iter " + jIter + ")",
        "Score: " + bestScore + ", " + verdict.failed + " of " + verdict.totalEnabled + " enabled criteria failing");
    }

    if (verdict.overall === "PASS") {
      finalVerdict = verdict;
      break;
    }
    if (jIter >= _maxJudgeIters) {
      finalVerdict = verdict;
      break;
    }

    // Stagnation
    const sig = verdict.score + "|" + verdict.failingIds.slice().sort().join(",");
    if (sig === lastSig) {
      stagnation++;
      if (stagnation >= 2) {
        appendLog(
          "⛔ STAGNATION DETECTED (judge iter " + jIter + ")",
          "Same eval result repeated " + stagnation + "× with no improvement. Stopping judge loop.",
        );
        finalVerdict = verdict;
        break;
      }
    } else {
      stagnation = 0;
    }
    lastSig = sig;

    // ── Run-budget gate (before triage + the K-to-X reflow chain) ──
    // The eval gate above is free; everything below — triage, regen chain,
    // re-verify — is where judge's (multiplicative) LLM spend happens. When
    // the run budget is exhausted, stop here with the current verdict; the
    // best-known-restore at the bottom still applies, so the user keeps the
    // best state measured so far.
    if (st._budget && st._budget.enabled) {
      const over = st._budget.overWith(allLlms);
      if (over) {
        appendLog("⛔ RUN BUDGET EXHAUSTED (judge iter " + jIter + ")",
          over.message + "\nStopping the judge loop; keeping the best-known state.");
        finalVerdict = verdict;
        break;
      }
    }

    // Triage
    appendLog("Triage — iter " + jIter, "Picking fix target from "
      + verdict.failingIds.length + " failing criteria…");
    const triage = await pickTriageTarget(verdict, currentState, st, allLlms, jIter, appendLog);
    historyEntry.triageTarget = triage.target;
    appendLog("Routing", "→ " + triage.target + ": " + (triage.reason || ""));

    // K-to-X reflow chain
    //
    // When services.invokeNode is available (top-level orchestrator),
    // we replace the legacy point-fix path with a planner-driven chain
    // that re-runs the entire pipeline tail from the triage target.
    // The chain reuses each stage's NODE — so lint/lint_test/verify
    // get their full internal iteration loops AT THE NESTED level (each
    // stage's iter counter resets to its base or nested-override limit).
    //
    // Legacy point-fix path (the original spec/rtl/tb/re-verify
    // inline code below) stays in place as a fallback for environments
    // without an orchestrator-provided invokeNode (unit tests, smoke
    // drivers). When the chain executes, _legacyPath is set to false
    // and the inline blocks bail out at their guards.
    let _legacyPath = true;
    if (st._services && typeof st._services.invokeNode === "function") {
      const reflowMode = (st._config && st._config.judgeReflowMode === "strict") ? "strict" : "smart";
      const activeStages = (st._services.allStages || []).slice().sort(function(a, b) {
        return (a.order || 0) - (b.order || 0);
      });
      // Informed loopback: judge attaches the verify failure data AND the judge
      // verdict to the chain's triage entry. The previousCode field depends on
      // where triage pointed:
      //   triage="rtl_generate" or "spec" → previous RTL
      //   triage="test_generate"          → previous TB
      // The triage entry's generation node will detect source="judge"
      // and call promptRTLFromVerifyFail / promptTBFromVerifyFail
      // (preferred when verifyResult is present) or fall back to
      // promptRTLFix synthesized from judgeVerdict.failingIds.
      const judgeFixContext = {
        source:        "judge",
        ownerIter:     jIter,
        previousCode:  (triage.target === "test_generate")
                          ? ((currentState.test_generate && currentState.test_generate.code) || "")
                          : ((currentState.rtl_generate  && currentState.rtl_generate.code)  || ""),
        previousFixes: [],
        verifyResult:  currentState.verify || null,
        judgeVerdict:  verdict,
      };
      const chain = planReflow({
        triageTarget: triage.target,
        activeStages: activeStages,
        state:        currentState,
        mode:         reflowMode,
        fixContext:   judgeFixContext,
      });
      if (chain.length > 0) {
        appendLog("Reflow chain (" + reflowMode + ", " + chain.length + " stages)",
          chain.map(function(c) { return c.stageKey + "[" + c.reason + "]"; }).join(" → "));
        // Run the shared chain runner: ownerKey="judge", ownerIter=jIter,
        // parentDepth=0. strictOnError reflects judge's strictJudgeCli mode, so
        // a CLI-backed re-verify failure halts the chain in strict mode.
        const walkResult = await runReflowChain({
          chain:         chain,
          st:            st,
          ownerKey:      "judge",
          ownerIter:     jIter,
          parentDepth:   0,
          currentState:  currentState,
          allLlms:       allLlms,
          appendLog:     appendLog,
          strictOnError: !!st._config.strictJudgeCli,
        });
        if (!walkResult.fallbackToLegacy) {
          currentState = walkResult.currentState;
          // Attach chain history to the iteration record so trace panel
          // can render it.
          historyEntry._chain = walkResult.chainHistory;   // rendered by the trace panel
          historyEntry._reflowMode = reflowMode;
          _legacyPath = false;
        }
      }
    }

    // Spec fix path (LEGACY — only runs when reflow chain unavailable)
    if (_legacyPath && triage.target === "spec") {
      if (st._onLoopback) st._onLoopback(2);
      const specCtx = Object.assign({}, currentState.elicit, {
        _judgeFailures: verdict.failingIds,
        _judgeRecs: recommendationsFor(verdict),
      });
      let sp2 = promptSpec(specCtx);
      // Regenerating spec → apply spec skills.
      sp2 = await applySkillsToPrompt(sp2, st, "spec");
      const _scSpec = getStageConfig(st._config, "spec");
      sp2.config = _scSpec;
      sp2.maxTokens = _scSpec._maxTokens;
      sp2.onChunk = function(t, m) { appendLog.stream("Spec Fix", t); if (st._onLog) st._onLog(appendLog.buf, m); };
      const sr2 = await callLLM(sp2);
      allLlms.push(Object.assign({ stage: "spec-fix-judge-" + jIter }, sr2));
      const beforeSpec = currentState.spec || {};
      let parsedSpec = null;
      try {
        const sd2 = extractJSON(sr2.text);
        parsedSpec = sd2 && typeof sd2 === "object" ? sd2 : null;
        currentState = Object.assign({}, currentState, { spec: sd2 });
      } catch (e) {
        appendLog(
          "⚠ Spec fix JSON parse failed (judge iter " + jIter + ")",
          "Keeping previous spec. Reason: " + (e && e.message ? e.message : String(e)),
        );
      }
      if (!historyEntry._structured) historyEntry._structured = {};
      historyEntry._structured.specFix = {
        rawText: (sr2 && sr2.text) || "",
        parsed: parsedSpec,
        parseOk: !!parsedSpec,
        beforeCode: JSON.stringify(beforeSpec, null, 2),
        afterCode:  JSON.stringify(parsedSpec || beforeSpec, null, 2),
        kind: "judge_spec_fix",
      };
      if (st._onLoopback) st._onLoopback(null);
    }

    // RTL regen path (always after spec fix; also when triage selects rtl_generate directly)
    // Legacy point-fix path only: the reflow chain above re-runs the
    // rtl_generate NODE (with its full prompt/skill pipeline), so we skip this
    // inline regen when the chain executed.
    if (_legacyPath && (triage.target === "spec" || triage.target === "rtl_generate")) {
      if (st._onLoopback) st._onLoopback(4);
      let rp2 = promptRTL(
        currentState.architect,
        currentState.spec,
        currentState.elicit,
        st._childInterfaces || null,
        st._sharedPackageCode || null,
      );
      // Regenerating RTL → apply rtl_generate skills.
      rp2 = await applySkillsToPrompt(rp2, st, "rtl_generate");
      const _scRtl = getStageConfig(st._config, "rtl_generate");
      rp2.config = _scRtl;
      rp2.maxTokens = _scRtl._maxTokens;
      rp2.onChunk = function(t, m) { appendLog.stream("RTL Regen", t); if (st._onLog) st._onLog(appendLog.buf, m); };
      const rr2 = await callLLM(rp2);
      allLlms.push(Object.assign({ stage: "rtl-regen-judge-" + jIter }, rr2));
      const beforeRtlCode = (currentState.rtl_generate || {}).code || "";
      let parsedRtl = null;
      let afterRtlCode = beforeRtlCode;
      try {
        const rd2 = extractJSON(rr2.text);
        parsedRtl = rd2 && typeof rd2 === "object" ? rd2 : null;
        if (rd2.code && rd2.code !== (currentState.rtl_generate || {}).code) {
          afterRtlCode = rd2.code;
          currentState = Object.assign({}, currentState, { rtl_generate: { code: rd2.code } });
        } else if (rd2.code) {
          appendLog("⚠ RTL regen returned identical code (judge iter " + jIter + ")", "Patch integrity: no change.");
        }
      } catch (e) {
        appendLog(
          "⚠ RTL regen JSON parse failed (judge iter " + jIter + ")",
          "Keeping previous RTL. Reason: " + (e && e.message ? e.message : String(e)),
        );
      }
      if (!historyEntry._structured) historyEntry._structured = {};
      historyEntry._structured.rtlRegen = {
        rawText: (rr2 && rr2.text) || "",
        parsed: parsedRtl,
        parseOk: !!(parsedRtl && parsedRtl.code),
        beforeCode: beforeRtlCode,
        afterCode: afterRtlCode,
        kind: "judge_rtl_regen",
      };
      if (st._onLoopback) st._onLoopback(null);
    }

    // TB regen — always (even when triage was "test_generate" alone)
    // Legacy point-fix path only: when the reflow chain executed,
    // test_generate's node already produced the regenerated TB with full
    // prompt+skill+iter behavior, so this inline regen would be redundant.
    if (_legacyPath) {
      appendLog("TB Regen — iter " + jIter, "Regenerating testbench to address failing criteria…");
      if (st._onLoopback) st._onLoopback(7);
      let tbp2 = promptTB(
        currentState.rtl_generate.code || "",
        currentState.spec,
        currentState.elicit,
        st._childInterfaces || null,
      );
    // Regenerating TB → apply test_generate skills.
    tbp2 = await applySkillsToPrompt(tbp2, st, "test_generate");
    const _scTb = getStageConfig(st._config, "test_generate");
    tbp2.config = _scTb;
    tbp2.maxTokens = _scTb._maxTokens;
    tbp2.onChunk = function(t, m) { appendLog.stream("TB Regen", t); if (st._onLog) st._onLog(appendLog.buf, m); };
    const tbr2 = await callLLM(tbp2);
    allLlms.push(Object.assign({ stage: "tb-regen-judge-" + jIter }, tbr2));
    const beforeTbCode = (currentState.test_generate || {}).code || "";
    let parsedTb = null;
    let afterTbCode = beforeTbCode;
    try {
      const tbd2 = extractJSON(tbr2.text);
      parsedTb = tbd2 && typeof tbd2 === "object" ? tbd2 : null;
      if (tbd2.code && tbd2.code !== (currentState.test_generate || {}).code) {
        afterTbCode = tbd2.code;
        currentState = Object.assign({}, currentState, { test_generate: { code: tbd2.code } });
      } else if (tbd2.code) {
        appendLog("⚠ TB regen returned identical code (judge iter " + jIter + ")", "Patch integrity: no change.");
      }
    } catch (e) {
      appendLog(
        "⚠ TB regen JSON parse failed (judge iter " + jIter + ")",
        "Keeping previous TB. Reason: " + (e && e.message ? e.message : String(e)),
      );
    }
    if (!historyEntry._structured) historyEntry._structured = {};
    historyEntry._structured.tbRegen = {
      rawText: (tbr2 && tbr2.text) || "",
      parsed: parsedTb,
      parseOk: !!(parsedTb && parsedTb.code),
      beforeCode: beforeTbCode,
      afterCode: afterTbCode,
      kind: "judge_tb_regen",
    };
    if (st._onLoopback) st._onLoopback(null);
    } // close legacy TB regen _legacyPath block

    // Re-verify — only on the legacy point-fix path.
    // The reflow chain above invoked the verify NODE (CLI-backed when
    // configured) as part of K-to-X, so the chain's verify result is
    // already merged into currentState.verify.
    if (_legacyPath) {
    appendLog("Re-verify — iter " + jIter, "Running simulation after fixes…");
    let vd2 = null;
    let _reverifySource = null;

    // Try the CLI backend FIRST when configured, routing through the real
    // backend the same way verify.js does. Calling the LLM here would silently
    // produce AI-estimated simulation results in judge's later iterations.
    //
    // The CLI path runs the simCmds template against the current
    // RTL/TB, harvests the same parsed test results (PASS/FAIL +
    // cycles + ms), and updates currentState.verify with real data.
    //
    // Fallback to LLM only when: (a) no backendUrl is configured AND
    // (b) the user has NOT enabled strict-CLI mode for judge. Strict
    // mode (`strictJudgeCli`) makes judge hard-fail if the backend is
    // missing or errors — no silent estimation.
    const hasBackend = !!(st._config && st._config.backendUrl);
    const hasSimCmds = !!(st._config && st._config.simCmds && st._config.simCmds.trim());
    const strictJudgeCli = !!(st._config && st._config.strictJudgeCli);

    if (hasBackend && hasSimCmds) {
      try {
        vd2 = await _judgeReverifyViaCli(st, currentState, jIter, appendLog);
        _reverifySource = "cli";
      } catch (cliErr) {
        appendLog("⚠ Re-verify CLI error (judge iter " + jIter + ")",
          (cliErr && cliErr.message ? cliErr.message : String(cliErr)));
        if (strictJudgeCli) {
          // Strict mode: re-throw so the caller sees the failure.
          throw cliErr;
        }
        // Non-strict: fall through to LLM path below
      }
    } else if (strictJudgeCli) {
      // User explicitly opted into strict mode but no backend configured.
      // Surface a clear error rather than silently degrading.
      const msg = "Judge strict-CLI mode is enabled but " +
        (!hasBackend ? "no backend URL is configured" : "simulation commands are empty") +
        ". Configure both, or disable Strict Judge CLI in Settings.";
      appendLog("⛔ Judge strict CLI failed", msg);
      throw new Error(msg);
    }

    if (vd2 == null) {
      // Fallback: LLM-estimated re-verify (legacy path, default behavior
      // when no backend is wired). The result is flagged with an
      // `_estimated: true` marker so downstream consumers — and the
      // user via the Log panel — can tell this isn't real simulation.
      let vp2 = promptVerify(
        currentState.test_generate.code || "",
        currentState.rtl_generate.code || "",
        currentState.spec,
      );
      // This is verify being re-run by judge → apply verify skills.
      vp2 = await applySkillsToPrompt(vp2, st, "verify");
      const _scV = getStageConfig(st._config, "verify");
      vp2.config = _scV;
      vp2.maxTokens = _scV._maxTokens;
      vp2.onChunk = function(t, m) { appendLog.stream("Re-verify", t); if (st._onLog) st._onLog(appendLog.buf, m); };
      const vr2 = await callLLM(vp2);
      allLlms.push(Object.assign({ stage: "verify-judge-" + jIter }, vr2));
      try {
        vd2 = extractJSON(vr2.text);
        vd2._estimated = true;  // mark AI-estimated (no CLI backend)
        _reverifySource = "llm-estimated";
        // Surface this in the run log explicitly so the user sees it
        if (st._logger) st._logger.state({
          iter: jIter,
          message: "Judge re-verify used AI-estimated simulation (no CLI backend or fallback). " +
            "Enable Settings → CLI → Strict Judge CLI to require real simulation.",
        });
      } catch (e) {
        appendLog(
          "⚠ Re-verify JSON parse failed (judge iter " + jIter + ")",
          "Keeping previous verify result. Reason: " + (e && e.message ? e.message : String(e)),
        );
      }
    }

    if (vd2 != null) {
      // Tag the result with provenance so the user (and Layer 3 of the
      // eval gate) can distinguish CLI-real from LLM-estimated.
      if (_reverifySource && !vd2._source) vd2._source = _reverifySource;
      currentState = Object.assign({}, currentState, { verify: vd2 });
    }
    } // close legacy re-verify _legacyPath block
  }

  // Best-known restore
  if (bestScore > (finalVerdict ? finalVerdict.score : -1) && bestState !== currentState) {
    appendLog(
      "Best-known state restored",
      "Final score " + (finalVerdict ? finalVerdict.score : 0) + " < best score " + bestScore +
      ". Using best iteration's RTL/TB.",
    );
    currentState = bestState;
    finalVerdict = runEvalGate(currentState, evalCfg);
  }

  if (!finalVerdict) {
    finalVerdict = runEvalGate(currentState, evalCfg);
  }

  // ── Verification-provenance gate ──────────────────────────────────────────
  // The eval gate measures whatever numbers sit in `state.verify`; it cannot
  // tell whether they came from a real Verilator run (verify.cli === true) or
  // from the LLM "estimating" simulation results (the fallback path used when
  // no CLI backend is configured). An LLM predicting that its own generated
  // RTL passes its own generated tests is NOT verification — so a gate-PASS
  // built on estimated numbers is downgraded to "UNVERIFIED" here, at the one
  // place where the user-facing verdict is assembled.
  //
  //   PASS        gate passed AND the simulation was real
  //   UNVERIFIED  gate passed but the simulation was LLM-estimated
  //               (or verify never ran at all)
  //   FAIL        gate failed — provenance doesn't matter; a failing
  //               estimated run is still failing
  //
  // Downstream consumers:
  //   - JudgeStage (stages.jsx) renders UNVERIFIED in yellow and shows
  //     `unverifiedReason` under the verdict.
  //   - Package export stays gated on overall === "PASS", so an UNVERIFIED
  //     run can never produce a "verified deliverable".
  //   - The terminal export report prints the provenance line.
  // Contributors: if you add a new consumer of judge.overall, handle all
  // three values — treating UNVERIFIED as PASS re-opens the hole this closes.
  const verified = !!(currentState.verify && currentState.verify.cli === true);
  const downgraded = finalVerdict.overall === "PASS" && !verified;
  if (downgraded) {
    appendLog(
      "⚠ Verdict downgraded to UNVERIFIED",
      "The eval gate passed, but verify's numbers were LLM-estimated (no CLI "
      + "backend) — nothing was actually simulated. Configure a backend in "
      + "Settings → CLI and re-run verify to earn a real PASS.",
    );
  }

  const trace = synthesisedTrace(currentState, finalVerdict);
  const recs = recommendationsFor(finalVerdict);
  const finalJudge = {
    overall: downgraded ? "UNVERIFIED" : finalVerdict.overall,
    score: finalVerdict.score,
    trace: trace,
    recs: recs,
    eval: finalVerdict,
    judgeHistory: judgeHistory,
    verified: verified,
    evalOverall: finalVerdict.overall,
  };
  if (downgraded) {
    finalJudge.unverifiedReason = currentState.verify
      ? "Simulation results were LLM-estimated (no CLI backend) — the eval "
        + "gate passed, but nothing was actually simulated. Configure a "
        + "backend (Settings → CLI) and re-run verify for a real PASS."
      : "Verify produced no simulation results. Run the verify stage with a "
        + "CLI backend for a real PASS.";
  }

  const judgeOrigRTL = (st.rtl_generate || {}).code || "";
  const judgeOrigTB = (st.test_generate || {}).code || "";
  let judgeRTL = currentState.rtl_generate || {};
  let judgeTB = currentState.test_generate || {};
  const jRtlChanged = (judgeRTL.code || "") !== judgeOrigRTL;
  const jTbChanged = (judgeTB.code || "") !== judgeOrigTB;
  if (jRtlChanged && !judgeRTL._fixSource) {
    judgeRTL = Object.assign({}, judgeRTL, { _originalCode: judgeOrigRTL, _fixSource: "fixed post judge" });
  }
  if (jTbChanged && !judgeTB._fixSource) {
    judgeTB = Object.assign({}, judgeTB, { _originalCode: judgeOrigTB, _fixSource: "fixed post judge" });
  }

  finalJudge._llms = allLlms.slice();
  return {
    judge: finalJudge,
    spec: currentState.spec,
    rtl_generate: judgeRTL,
    test_generate: judgeTB,
    verify: currentState.verify,
    // Expose the full per-call LLM ledger so Duration and
    // Tokens tabs can render per-stage / per-iteration / per-loopback
    // breakdowns. Each entry carries {stage, tokensIn, tokensOut,
    // latencyMs, startedAtMs, endedAtMs, provider, model} thanks to
    // the callLLM instrumentation.
    _llms: allLlms.slice(),
    _llm: allLlms.length > 0
      ? allLlms[allLlms.length - 1]
      : { stage: "judge", tokensIn: 0, tokensOut: 0, latencyMs: 0, model: "deterministic-eval", provider: "internal" },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// _judgeReverifyViaCli — CLI-backed re-verify helper
//
// Mirrors verify.js's runVerifyOnce but limited to the CLI execution
// path (no LLM fallback at this layer — judge handles that). Returns
// the same shape `currentState.verify` consumes so downstream eval
// logic doesn't care whether the data came from verify or judge.
// ═══════════════════════════════════════════════════════════════════════════
async function _judgeReverifyViaCli(st, currentState, jIter, appendLog) {
  const rtl = (currentState.rtl_generate && currentState.rtl_generate.code) || "";
  const tb  = (currentState.test_generate && currentState.test_generate.code) || "";
  const rtlFileName = "rtl.sv";
  const tbFileName  = "tb.sv";

  let cmds = (st._config.simCmds || "")
    .split("\n").filter(function(c) { return c.trim(); });

  // Auto-inject --coverage when enabled (mirror verify.js logic so judge's
  // re-verify shows the same coverage numbers).
  if (st._config.enableCoverage) {
    cmds = cmds.map(function(c) {
      const isCompile = /verilator(\s|$)/.test(c) &&
        /(--binary|--cc|--main|--exe|-o\s)/.test(c) &&
        !/verilator_coverage/.test(c);
      if (isCompile && !/--coverage/.test(c)) {
        return c.replace(/verilator(\s|$)/, "verilator --coverage$1");
      }
      return c;
    });
    const hasCovStep = cmds.some(function(c) { return /verilator_coverage/.test(c); });
    if (!hasCovStep) {
      cmds.push("verilator_coverage --write logs/coverage.dat logs/coverage.dat 2>/dev/null || true");
    }
  }

  const _cliOpts = {
    retries:   (st._config.cliRetryCount == null ? 1 : st._config.cliRetryCount),
    timeoutMs: ((st._config.backendTimeoutSec || 600) * 1000),
    logger:    st._logger || null,
  };

  // SVA-in-simulation — same contract as verify.js's runVerifyOnce: bind the
  // formal properties into the build (+ --assert), and if the checker itself
  // breaks compilation, retry without it instead of failing the design.
  const _modName = (currentState.elicit && currentState.elicit.modName)
    || (st.elicit && st.elicit.modName) || "module";
  const svaChecker = (st._config.svaInSim !== false)
    ? buildSvaChecker(currentState.formal_props || st.formal_props, currentState.spec || st.spec, _modName)
    : null;

  async function execCli(withSva) {
    const attemptCmds = withSva ? injectVerilatorFlag(cmds, "--assert") : cmds;
    const rtlPayload = withSva ? rtl + "\n" + svaChecker.text : rtl;
    return runCli(st._config.backendUrl, {
      commands: attemptCmds.map(function(c) { return c.replace("{RTL}", rtlFileName).replace("{TB}", tbFileName); }),
      files: { [rtlFileName]: rtlPayload, [tbFileName]: tb },
    }, st._signal, _cliOpts);
  }

  let _svaActive = !!svaChecker;
  let cliResult = await execCli(_svaActive);
  let _svaBindFailed = false;
  if (_svaActive && cliResult && !cliResult._error
      && svaCompileFailed(cliResult, svaChecker.checkerName)) {
    appendLog("⚠ SVA checker broke the re-verify build — retrying without it",
      "Generated property checker failed to compile; re-running without bound SVA.");
    _svaActive = false;
    _svaBindFailed = true;
    cliResult = await execCli(false);
  }

  if (!cliResult || cliResult._error) {
    throw new Error("Judge re-verify CLI failed: " + ((cliResult && cliResult._msg) || "unknown"));
  }

  // Parse test results from stdout — same regex as verify.js.
  const tests = [];
  (cliResult.stdout || "").split("\n").forEach(function(l) {
    const parsed = parseTestLine(l);
    if (!parsed) return;
    tests.push({
      name: parsed.name,
      st:   parsed.status,
      cyc:  parsed.cyc,
      ms:   parsed.ms,
    });
  });
  if (tests.length === 0 && cliResult.exitCode !== 0) {
    tests.push({ name: "compilation", st: "FAIL", cyc: 0, ms: 0 });
  }
  // Non-zero exit with only [PASS] markers = the sim died after the last
  // marker (bound SVA assertion fired via $stop, or a crash). Surface it as
  // a failing pseudo-test — mirrors the identical guard in verify.js.
  if (cliResult.exitCode !== 0 && tests.length > 0
      && tests.every(function(t) { return t.st === "PASS"; })) {
    tests.push({
      name: _svaActive ? "sva_assertion_or_abnormal_exit" : "abnormal_exit",
      st: "FAIL", cyc: 0, ms: 0,
    });
  }
  const pass = tests.filter(function(t) { return t.st === "PASS"; }).length;

  // Coverage from logs/coverage.dat
  let covRaw = cliResult.coverage;
  if (typeof covRaw !== "string") {
    covRaw = (cliResult.files && (cliResult.files["logs/coverage.dat"]
      || cliResult.files["coverage.dat"]))
      || (cliResult.artifacts && cliResult.artifacts["coverage.dat"])
      || null;
  }
  const covParsed = parseCoverageDat(covRaw || "");
  const cov = {
    line:   covParsed.line   != null ? covParsed.line   : 0,
    branch: covParsed.branch != null ? covParsed.branch : 0,
    toggle: covParsed.toggle != null ? covParsed.toggle : 0,
    fsm:    covParsed.fsm    != null ? covParsed.fsm    : 0,
    expr:   covParsed.expr   != null ? covParsed.expr   : 0,
    _source: covRaw ? "verilator-coverage-dat" : "no-data",
  };

  appendLog("✓ Judge re-verify via CLI (iter " + jIter + ")",
    pass + "/" + tests.length + " tests passing");

  return {
    sim: "Verilator (CLI, from judge)",
    total: tests.length || 1,
    pass,
    fail: (tests.length || 1) - pass,
    cov,
    tests,
    cli: true,
    log: cliResult.stdout || "",
    // SVA binding provenance — same shape as verify.js's result.
    sva: svaChecker ? {
      bound: _svaActive ? svaChecker.included : [],
      skipped: svaChecker.skipped,
      bindFailed: _svaBindFailed,
    } : null,
  };
}

