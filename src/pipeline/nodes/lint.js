// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/lint — Stage 6: Lint Analysis with Iterative Fix Loop
//
// The most complex node in the pipeline. It does:
//
//   1. Try the real CLI backend first (Verilator --lint-only -Wall),
//      fall back to LLM-estimated lint via promptLint.
//   2. Iteratively fix RTL via promptRTLFix (up to MAX_LINT_ITERS).
//   3. Patch integrity check: if the LLM returned identical code despite
//      claiming fixes, REJECT_INVALID_PATCH and increment stagnation.
//   4. Classifier-gated accept/reject: re-lint via CLI, then call
//      classifyDiagnostics against the ORIGINAL BASELINE (not just the
//      previous iteration). This catches whack-a-mole regressions.
//   5. Track best-known state by issue count; restore if final iter is worse.
//   6. Stagnation detection: same outcome signature repeated → break.
//   7. Memorise previous fixes to inject into the non-monotonic policy.
//   8. TASK_STATUS assessment: COMPLETE / INCOMPLETE / BLOCKED_NONCODE.
//
// Result delta:
//   lint         — final lint report with .iterations[], _fullLog, _taskStatus
//   rtl_generate — { code, _originalCode?, _fixSource? }
// ═══════════════════════════════════════════════════════════════════════════

import { callLLM, extractJSON } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { runCli, parseCLIOutput, CliBackendError } from "../../cli/index.js";
import { classifyDiagnostics } from "../classifiers.js";
import { isProseLeak, buildRuleIndex } from "../errorsToAvoid.js";
import { shippedRuleRecords } from "../knowledgePacks.js";
import { maybeRepairWithLog } from "../syntaxRepair.js";
import { FIX_SCHEMA, PATCH_SCHEMA } from "../../prompts/schemas.js";
import { applyEdits } from "../applyEdits.js";
import { promptLint, promptRTLFix, patchModeFixPrompt } from "../../prompts/index.js";
import { createLogger } from "../log.js";
import { tagFixes, createCodeChurnTracker, lintConverged, detectGuttedRewrite, noDeletionDirective } from "../fixLoopHelpers.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
// Per-stage K-to-X reflow: when lint's internal fix-loop decides RTL needs
// regenerating, the chain runs rtl_generate → rtl_review → lint instead of the
// inline callLLM patch. See reflowPlanner.js and reflowRunner.js.
import { planStageReflow } from "../reflowPlanner.js";
import { runReflowChain, resolveReflowMode } from "../reflowRunner.js";
import { getReflowTail } from "../../constants/stages.js";

export async function lintNode(st) {
  const originalCode = st.rtl_generate.code || "";
  const moduleName = (st.elicit && st.elicit.modName) || "module";
  const rtlFileName = moduleName + ".sv";
  // Trained-rule index for the fixer: a finding's class gets a model-rewritten
  // or curated rule from the catalog when one exists (same sources + scoping as
  // the cold-gen avoidance section), else the static distillRule table.
  const _ruleIndex = buildRuleIndex(
    st._config,
    (st._services && st._services.errorMemory) ? st._services.errorMemory.all() : [],
    shippedRuleRecords(st._config),
    "rtl",
  );
  const allLlms = [];
  const iterations = [];
  let finalLint = null;
  let finalCode = originalCode;
  let bestCode = originalCode;
  let bestIssueCount = Infinity;
  let previousFixes = [];
  let baselineIssues = null;
  let lastOutcomeSig = null;
  let stagnationCount = 0;
  // Most recent classifyDiagnostics result (full object, with the resolved/
  // persisting/introduced diagnostic arrays). Fed into the NEXT iteration's
  // fix prompt so the model sees what its last patch actually achieved —
  // without it, the model can't tell a failed strategy from an untried one.
  let lastClassification = null;
  // Candidate-churn tracker: catches oscillation (A→B→A reverts to an
  // earlier attempt) and cosmetic re-emissions that the plain
  // candidate===base integrity check below cannot see. Seeded with the
  // baseline so an exact revert-to-original also counts as a repeat.
  const churnTracker = createCodeChurnTracker();
  churnTracker.record(originalCode, 0);

  // CLI robustness: retries and timeouts come from config.
  const _cliOpts = {
    retries:   (st._config.cliRetryCount == null ? 1 : st._config.cliRetryCount),
    timeoutMs: ((st._config.backendTimeoutSec || 600) * 1000),
    logger:    st._logger || null,   // captures CLI events for the Log panel
  };
  // Strict CLI: when a backend URL is configured and the CLI fails, throw
  // instead of silently falling back to LLM. Default ON.
  const _strictCli = (st._config.strictCli !== false) && !!st._config.backendUrl;

  // Shared logger; lint uses thick triple-line dividers for high visibility.
  const appendLog = createLogger(st._onLog, "thick");

  // Chain-eligibility check.
  //
  // When lint decides RTL needs regenerating to fix issues, it can either:
  //   • CHAIN  — call runReflowChain to walk lint's K-to-X tail (rtl_generate
  //              → rtl_review → lint). This re-runs the full pipeline-style
  //              regeneration of RTL with prompt overrides, skills, etc.
  //   • LEGACY — call promptRTLFix inline (fast, targeted patch).
  //
  // We chain when:
  //   (a) services.invokeNode is available (we're inside the orchestrator,
  //       not a unit test), AND
  //   (b) we're NOT already inside a lint-owned chain (otherwise infinite
  //       recursion — the inner lint at the tail of OUR chain would chain again).
  //
  // The "already inside a lint chain" check uses the logger context that
  // runReflowChain stamps onto each sub-stage's logger: when we are the
  // tail of a parent lint chain, our context has parentStageKey === "lint".
  // Inner lint runs the LEGACY inline fix path so it can converge naturally.
  //
  // Nested cases like judge → lint or verify → lint still chain: their
  // parentStageKey is "judge" or "verify", not "lint", so the gate opens.
  const _hasServices = !!(st._services && typeof st._services.invokeNode === "function");
  const _loggerCtx   = (st._logger && st._logger.context) || {};
  const _alreadyInOwnChain = _loggerCtx.parentStageKey === "lint";
  const _canChain = _hasServices && !_alreadyInOwnChain;
  // Track chain history so we can attach it to the lint result for the
  // trace panel.
  const lintChainHistory = [];

  const _maxLintIters = st._config.maxLintIters || 3;
  for (let iter = 1; iter <= _maxLintIters; iter++) {
    appendLog("Lint — iteration " + iter + "/" + _maxLintIters, "Running lint analysis…");
    // Emit a state event so the Log panel surfaces loop progression beyond the
    // bare LLM/CLI events.
    if (st._logger) st._logger.state({
      iter: iter, message: "Lint iteration " + iter + "/" + _maxLintIters,
    });

    // ─── Step A: Try real CLI first ───
    let cliResult = await runCli(st._config.backendUrl, {
      command: (st._config.lintCmd || "verilator --lint-only -Wall {RTL}").replace("{RTL}", rtlFileName),
      files: { [rtlFileName]: finalCode },
    }, st._signal, _cliOpts);

    let lintData;
    let _cliErrorMsg = null;
    if (cliResult && cliResult._error) {
      console.warn("[RTL Forge] CLI backend error:", cliResult._msg, "(after " + (cliResult._attempts || 1) + " attempts)");
      _cliErrorMsg = cliResult._msg + " — after " + (cliResult._attempts || 1) + " attempt(s)";
      if (_strictCli) {
        // Backend was configured by the user; do NOT silently substitute LLM
        // estimation — raise so the stage shows a clear error to the user.
        appendLog("⛔ STRICT CLI MODE — failing", _cliErrorMsg + "\n\nDisable Strict CLI mode in Settings → CLI to allow LLM fallback.");
        throw new CliBackendError(_cliErrorMsg, cliResult._attempts || 1);
      }
      cliResult = null;
    }
    if (cliResult && cliResult.exitCode !== undefined) {
      const parsed = parseCLIOutput(cliResult.stderr);
      lintData = {
        tool: "Verilator (CLI — real)",
        status: cliResult.exitCode === 0 && parsed.errors.length === 0 ? "PASS" : "FAIL",
        warnings: parsed.warnings,
        errors: parsed.errors,
        summary: parsed.errors.length + " errors, " + parsed.warnings.length + " warnings",
        log: (cliResult.stdout || "") + "\n" + (cliResult.stderr || ""),
        cli: true,
      };
      appendLog("CLI result (iter " + iter + ")", lintData.summary + "\n" + lintData.log);
    } else {
      appendLog("LLM Lint (iter " + iter + ")", "No CLI available, using LLM estimation…");
      let lp = promptLint(finalCode, st.elicit);
      // Skills targeting "lint" overlay on the lint-check call. Per-call (not
      // per-stage) so iter 2's lint sees the same overlay as iter 1's. The
      // overlay is a no-op if there's no bridge or no applicable skill.
      lp = await applySkillsToPrompt(lp, st, "lint");
      const _sc = getStageConfig(st._config, "lint");
      lp.config = _sc;
      lp.maxTokens = _sc._maxTokens;
      lp.onChunk = function(t, m) { appendLog.stream("LLM Lint output", t); if (st._onLog) st._onLog(appendLog.buf, m); };
      const lr = await callLLM(lp);
      allLlms.push(Object.assign({ stage: "lint-iter" + iter }, lr));
      lintData = extractJSON(lr.text, lr);
      if (_cliErrorMsg) lintData._cliError = _cliErrorMsg;
    }

    lintData.iteration = iter;
    const currentIssues = (lintData.errors || []).concat(lintData.warnings || []);
    // Track baseline from first iteration
    if (iter === 1) baselineIssues = currentIssues.slice();
    // Track best-known state by issue count
    if (currentIssues.length < bestIssueCount) {
      bestIssueCount = currentIssues.length;
      bestCode = finalCode;
    }
    iterations.push({
      iter,
      status: lintData.status,
      errors: (lintData.errors || []).length,
      warnings: (lintData.warnings || []).length,
      errorList: (lintData.errors || []).slice(),
      warningList: (lintData.warnings || []).slice(),
    });

    // ─── Step B: Done if converged or max iters reached ───
    // Tiered exit (roadmap #2): 0 errors converges even when warnings remain —
    // Verilator exits non-zero under -Wall for warnings alone, and the old
    // status-FAIL check made a 0-error result loop to the cap (measured: 0 of 7
    // loops ever stopped early). lintWarningsAsErrors opts back into strict.
    const treatWarningsAsErrors = !!st._config.lintWarningsAsErrors;
    if (lintConverged(lintData, treatWarningsAsErrors) || iter >= _maxLintIters) {
      finalLint = lintData;
      break;
    }

    // ─── Step B2: Run-budget gate (before the expensive fix work) ───
    // st._budget is the run-wide guard from runStage (see pipeline/budget.js).
    // Checking here — after the free lint, before the LLM fix — means a run
    // that crosses its ceiling stops with the current lint result intact
    // rather than starting another fix round it can't afford.
    if (st._budget && st._budget.enabled) {
      const over = st._budget.overWith(allLlms);
      if (over) {
        appendLog("⛔ RUN BUDGET EXHAUSTED (iter " + iter + ")",
          over.message + "\nStopping the lint fix loop; keeping the current result.");
        finalLint = lintData;
        finalLint._budgetHalted = true;
        break;
      }
    }

    // Errors-first fix scope (docs/reliability.md R2): while errors exist,
    // the fixer sees ONLY errors. Warnings are not the convergence target
    // (the tiered exit above stops at 0 errors) — including them inflates the
    // ask into a rewrite, and big rewrites are where regressions come from
    // (measured: the 3→43 spike). In strict mode (lintWarningsAsErrors)
    // warnings ARE the target, so the full result passes through.
    const fixScope = (!treatWarningsAsErrors && (lintData.errors || []).length > 0)
      ? Object.assign({}, lintData, { warnings: [] })
      : lintData;

    // ─── Step C: Fix RTL — via K-to-X chain (preferred) or inline callLLM (legacy) ───
    //
    // When chaining is available, lint re-runs the full K-to-X tail
    // (rtl_generate → rtl_review → lint) instead of emitting a targeted patch
    // via promptRTLFix. The chain produces a freshly regenerated RTL (and
    // re-runs review if enabled); we then continue with the CLI re-lint
    // regression check below.
    let candidateCode;     // fed into the recheck step below
    let fd            = null;  // legacy structured fix output; left null on chain path
    let frTextForUi   = "";    // raw LLM text for the iteration's structured viewer
    let chainEntryUsed = false;

    if (_canChain) {
      // Build lint's K-to-X tail from active stages provided by services
      const activeStages = (st._services.allStages || []).slice();
      const tail = getReflowTail("lint", activeStages);
      const mode = resolveReflowMode("lint", st._config);
      // Informed loopback: attach a fixContext describing the lint failure so
      // the chain's triage entry (rtl_generate) calls
      // promptRTLFix(code, lintResult, el, previousFixes) instead of cold-
      // regenerating from spec — otherwise the LLM wouldn't know what to fix.
      const fixContext = {
        source:        "lint",
        ownerIter:     iter,
        previousCode:  finalCode,
        previousFixes: previousFixes,
        lintResult:    fixScope,
      };
      const chain = planStageReflow({
        ownerKey:   "lint",
        tail:       tail,
        state:      Object.assign({}, st, { rtl_generate: { code: finalCode } }),
        mode:       mode,
        fixContext: fixContext,
      });
      if (chain.length > 0) {
        appendLog("Reflow chain (lint, " + mode + ", " + chain.length + " entries)",
          chain.map(function(c) { return c.stageKey + "[" + c.reason + "]"; }).join(" → "));
        const parentDepth = (_loggerCtx.depth != null) ? _loggerCtx.depth : 0;
        const walk = await runReflowChain({
          chain:        chain,
          st:           st,
          ownerKey:     "lint",
          ownerIter:    iter,
          parentDepth:  parentDepth,
          currentState: Object.assign({}, st, { rtl_generate: { code: finalCode } }),
          allLlms:      allLlms,
          appendLog:    appendLog,
          strictOnError: false,
        });
        // Note: the chain's last entry IS lint itself running inside its
        // own tail. That inner lint sees parentStageKey === "lint" so it
        // takes the LEGACY path (recursion bottoms out). The inner lint's
        // result has the post-fix rtl_generate.code merged in; we extract
        // that as the new candidate.
        if (!walk.fallbackToLegacy) {
          chainEntryUsed = true;
          lintChainHistory.push({
            iter: iter,
            mode: mode,
            entries: walk.chainHistory,
          });
          const rtlAfter = (walk.currentState && walk.currentState.rtl_generate
                             && walk.currentState.rtl_generate.code) || finalCode;
          candidateCode = rtlAfter;
          // Structured viewer: mark this iteration as chain-driven so the
          // UI can render the chain history rather than the legacy
          // before/after diff.
          iterations[iterations.length - 1]._structured = {
            rawText: "",
            parsed:  null,
            parseOk: true,
            beforeCode: finalCode,
            afterCode:  candidateCode,
            kind:      "rtl_fix_via_chain",
            chain:     walk.chainHistory,
            chainMode: mode,
          };
        }
      }
    }

    if (!chainEntryUsed) {
      // ── Legacy inline path ──
      appendLog("RTL Fix — iteration " + iter, "Applying fixes for " + (lintData.errors || []).length + " errors, " + (lintData.warnings || []).length + " warnings…");
      // Patch-mode (roadmap #2, gated fixPatchMode): ask for exact-match EDITS
      // instead of the whole file — ~10× smaller output, no truncation ladder,
      // no whole-file churn. Fail-closed: edits that don't apply fall back to
      // ONE full-file ask, so the worst case is exactly the pre-patch behavior.
      const _patchTry = !!st._config.fixPatchMode;
      for (let _fa = 0; _fa < (_patchTry ? 2 : 1); _fa++) {
        let fp = promptRTLFix(finalCode, fixScope, st.elicit, previousFixes, lastClassification, _ruleIndex);
        if (_patchTry && _fa === 0) fp = patchModeFixPrompt(fp);
        // This sub-call regenerates RTL, so apply rtl_generate skills (the user's
        // SystemVerilog style rules) rather than lint skills: a `lint` skill is
        // about what counts as a lint issue, while we're writing RTL here.
        fp = await applySkillsToPrompt(fp, st, "rtl_generate");
        const _sc2 = getStageConfig(st._config, "rtl_fix");
        fp.config = _sc2;
        fp.maxTokens = _sc2._maxTokens;
        fp.jsonSchema = fp._patchMode ? PATCH_SCHEMA : FIX_SCHEMA;   // structured outputs (roadmap #1)
        fp.onChunk = function(t, m) { appendLog.stream("RTL Fix output (iter " + iter + ")", t); if (st._onLog) st._onLog(appendLog.buf, m); };
        const fr = await callLLM(fp);
        allLlms.push(Object.assign({ stage: "rtl-fix-iter" + iter }, fr));
        fd = extractJSON(fr.text, fr);
        frTextForUi = fr.text || "";
        if (fp._patchMode) {
          const _ap = applyEdits(finalCode, fd && fd.edits);
          if (_ap.ok) {
            appendLog("Patch mode", _ap.applied + " edit(s) applied cleanly.");
            candidateCode = _ap.code;
            break;
          }
          appendLog("Patch mode fallback",
            "Edits failed to apply (" + _ap.failReason + ") — re-asking for the full file.");
          candidateCode = finalCode;
          continue;   // second pass: full-file prompt (today's behavior)
        }
        candidateCode = fd.code || finalCode;
        break;
      }

      // Issue: structured viewer support. Capture per-iteration data so the
      // UI can render parsed JSON, fixes list, and before/after code with
      // syntax highlighting + diff. The raw text is what was streamed; the
      // parsed object is the validated JSON shape; before/after are the RTL
      // source pre- and post-this-iteration's fix.
      iterations[iterations.length - 1]._structured = {
        rawText: frTextForUi,
        parsed: fd && typeof fd === "object" ? fd : null,
        parseOk: !!(fd && typeof fd === "object" && (fd.code || Array.isArray(fd.edits))),
        beforeCode: finalCode,
        afterCode: candidateCode,
        kind: "rtl_fix",
      };
    }

    // Deterministic syntax repair at the loop chokepoint (opt-in): LLM fixes
    // can REINTRODUCE mechanical errors (measured in the sr-e2e run) — repair
    // every candidate before it is integrity-checked and re-linted. Idempotent,
    // so an unchanged candidate stays unchanged and the check below still fires.
    candidateCode = maybeRepairWithLog(st._config, candidateCode, appendLog).code;

    // ── Structural-collapse guard → corrective re-ask ──
    // A candidate that empties the module body (`module X;\nendmodule`) or drops
    // most of it LINTS CLEAN, so the classifier below would read the baseline
    // findings as "resolved" and the issue-count best-known tracker would prefer
    // 0 over N — the stub would ship. Deleting the code that caused a finding is
    // not a fix. But neither is stalling on the problematic original: re-ask ONCE
    // for a WORKING REPLACEMENT (preserve every port and all logic, correct the
    // offending lines). Only if that also comes back gutted do we keep the
    // current code as a last resort and count toward stagnation.
    if (candidateCode !== finalCode && detectGuttedRewrite(finalCode, candidateCode)) {
      appendLog("↻ COMPLETE-MODULE RE-ASK (iter " + iter + ")",
        "Fix candidate collapsed the module body — re-asking for a complete, working replacement (preserve ports + logic, correct the offending lines).");
      let rfp = noDeletionDirective(promptRTLFix(finalCode, fixScope, st.elicit, previousFixes, lastClassification, _ruleIndex));
      rfp = await applySkillsToPrompt(rfp, st, "rtl_generate");
      const _scR = getStageConfig(st._config, "rtl_fix");
      rfp.config = _scR;
      rfp.maxTokens = _scR._maxTokens;
      rfp.jsonSchema = FIX_SCHEMA;
      rfp.onChunk = function(t, m) { appendLog.stream("RTL Fix output (re-ask, iter " + iter + ")", t); if (st._onLog) st._onLog(appendLog.buf, m); };
      const rfr = await callLLM(rfp);
      allLlms.push(Object.assign({ stage: "rtl-fix-reask-iter" + iter }, rfr));
      const rfd = extractJSON(rfr.text, rfr);
      const reworked = maybeRepairWithLog(st._config, rfd.code || finalCode, appendLog).code;

      if (reworked !== finalCode && !detectGuttedRewrite(finalCode, reworked)) {
        // Got a real replacement — adopt it and fall through to the normal
        // integrity/churn/recheck path so it is validated like any candidate.
        appendLog("✓ Re-ask produced a complete module (iter " + iter + ")",
          "Proceeding to re-lint the working replacement.");
        candidateCode = reworked;
        fd = rfd;
        frTextForUi = rfr.text || "";
        iterations[iterations.length - 1]._structured = {
          rawText: frTextForUi,
          parsed: rfd && typeof rfd === "object" ? rfd : null,
          parseOk: !!(rfd && typeof rfd === "object" && rfd.code),
          beforeCode: finalCode,
          afterCode: candidateCode,
          kind: "rtl_fix_reask",
        };
      } else {
        // Still gutted (or a no-op) — keep the current, working-but-flagged code
        // rather than ship an empty shell. Count toward stagnation.
        stagnationCount++;
        appendLog("⚠ REJECT_GUTTED (iter " + iter + ")",
          "Re-ask still returned an empty/near-empty module. Keeping the current code (a lint finding is better than a deleted design).");
        iterations[iterations.length - 1].gutted = true;
        previousFixes = previousFixes.concat(tagFixes(fd && fd.fixes, iter));
        if (stagnationCount >= 2) {
          appendLog("⛔ STAGNATION DETECTED (iter " + iter + ")",
            "The fix loop keeps returning gutted candidates. Stopping lint fix loop.");
          finalLint = lintData;
          break;
        }
        continue;
      }
    }

    // ── Patch integrity verification ──
    // If the LLM claims fixes but returned identical code, it's an invalid patch.
    let patchIntegrityOk = true;
    if (candidateCode === finalCode) {
      patchIntegrityOk = false;
      appendLog("⚠ REJECT_INVALID_PATCH (iter " + iter + ")", "LLM returned identical code despite claiming fixes. Patch integrity failed.");
      iterations[iterations.length - 1].patchInvalid = true;
    }

    if (!patchIntegrityOk) {
      // Stagnation check: identical code returned = no-op
      stagnationCount++;
      if (stagnationCount >= 2) {
        appendLog("⛔ STAGNATION DETECTED (iter " + iter + ")", "Same ineffective fix strategy repeated " + stagnationCount + "× with no net progress. Stopping lint fix loop.");
        finalLint = lintData;
        break;
      }
      // Skip the recheck — code didn't change. Tag each fix with its iter so
      // the UI fix-list can render "fixed post lint iteration N". On the chain
      // path fd is null, so tagFixes returns [] and nothing accumulates — fine,
      // since previousFixes only seeds the next inline-patch call.
      previousFixes = previousFixes.concat(tagFixes(fd && fd.fixes, iter));
      continue;
    }

    // ── Candidate-churn check (oscillation / cosmetic re-emission) ──
    // The candidate differs from the current base (integrity check above
    // passed) — but if it matches an EARLIER attempt, its outcome is already
    // known: re-validating it wastes a CLI run and cannot make progress
    // (classic A→B→A ping-pong). Treated like an invalid patch: count toward
    // stagnation, skip the recheck, keep the current base.
    const churn = churnTracker.assess(candidateCode);
    if (churn.verdict !== "new") {
      stagnationCount++;
      appendLog("⚠ " + (churn.verdict === "repeat" ? "REPEAT" : "NEAR-REPEAT")
          + " CANDIDATE (iter " + iter + ")",
        "Fix output " + (churn.verdict === "repeat"
          ? "matches"
          : "is " + (Math.round(churn.similarity * 1000) / 10) + "% similar to")
        + " the candidate from iteration " + churn.matchedIter
        + " — its outcome is already known. Skipping revalidation.");
      iterations[iterations.length - 1].patchRepeat = {
        verdict: churn.verdict,
        matchedIter: churn.matchedIter,
      };
      previousFixes = previousFixes.concat(tagFixes(fd && fd.fixes, iter));
      if (stagnationCount >= 2) {
        appendLog("⛔ STAGNATION DETECTED (iter " + iter + ")",
          "The fix loop is cycling between already-tried candidates. Stopping lint fix loop.");
        finalLint = lintData;
        break;
      }
      continue;
    }
    churnTracker.record(candidateCode, iter);

    // ── Regression check via CLI re-lint, classified against ORIGINAL BASELINE ──
    const recheck = await runCli(st._config.backendUrl, {
      command: (st._config.lintCmd || "verilator --lint-only -Wall {RTL}").replace("{RTL}", rtlFileName),
      files: { [rtlFileName]: candidateCode },
    }, st._signal, _cliOpts);

    if (recheck && recheck._error && _strictCli) {
      // Same robustness story as the primary call: fail loudly, not silently.
      appendLog("⛔ STRICT CLI MODE — recheck failed", recheck._msg);
      throw new CliBackendError(recheck._msg, recheck._attempts || 1);
    }
    if (recheck && recheck.exitCode !== undefined) {
      const recheckParsed = parseCLIOutput(recheck.stderr);
      const allCandidate = recheckParsed.errors.concat(recheckParsed.warnings);
      // Compare against ORIGINAL BASELINE (first iteration), not just the current iteration
      const classification = classifyDiagnostics(baselineIssues || [], allCandidate);

      const classLog = "PATCH VALIDATION (iter " + iter + "):\n" +
        "  PATCH_DECISION: " + classification.patchDecision + "\n" +
        "  TASK_STATUS:    " + classification.taskStatus + "\n" +
        "  Resolved:   " + classification.resolved.length + (classification.resolved.length > 0 ? " — " + classification.resolved.map(function(d) { return d.code; }).join(", ") : "") + "\n" +
        "  Persisting: " + classification.persisting.length + "\n" +
        "  Introduced: " + classification.introduced.length + (classification.introduced.length > 0 ? " — " + classification.introduced.map(function(d) { return d.code + ": " + (d.msg || "").substring(0, 60); }).join("; ") : "") + "\n" +
        "  Revealed:   " + classification.revealed.length + (classification.revealed.length > 0 ? " — " + classification.revealed.map(function(d) { return d.code; }).join(", ") : "") + "\n" +
        "  Score: " + classification.score;
      appendLog("Patch Validation (iter " + iter + ")", classLog);

      iterations[iterations.length - 1].classification = {
        resolved: classification.resolved.length,
        persisting: classification.persisting.length,
        introduced: classification.introduced.length,
        revealed: classification.revealed.length,
        score: classification.score,
        patchDecision: classification.patchDecision,
        taskStatus: classification.taskStatus,
      };
      // Keep the FULL object (with the diagnostic arrays) for the next fix
      // prompt's patch-outcome section — the counts above are UI-only.
      lastClassification = classification;

      // Adopt or reject the candidate (docs/reliability.md R1).
      //
      // REJECT_REGRESSION: the candidate is NOT adopted — measured (the
      // 3→43→1 lint-test chain), forwarding a regressed candidate makes the
      // next iteration dig out of a self-made hole instead of retrying from
      // good code. The next fix call re-asks against the CURRENT code with
      // lastClassification telling the model exactly what the rejected
      // attempt introduced. An earlier design that reverted was changed to
      // "forward" because the model re-produced the same fix; the churn
      // tracker (fast stagnation stop) and the patch-outcome section did not
      // exist then — with both in place, reject-means-reject is strictly
      // better on regressions.
      //
      // Every other decision forwards: progress/equivalent candidates carry
      // no damage, and NO_IMPROVEMENT forwarding lets the next fix see fresh
      // diagnostics. Best-known state is still tracked via bestCode and
      // restored at the end if no later iteration does better.
      if (classification.patchDecision === "REJECT_REGRESSION" || classification.patchDecision === "REJECT_INVALID_PATCH") {
        appendLog("⚠ " + classification.patchDecision + " (iter " + iter + ")",
          classification.patchDecision === "REJECT_REGRESSION"
            ? "Fix introduced " + classification.introduced.length + " new unrelated issues (score=" + classification.score + "). REJECTED — keeping current code; the next attempt is told what this patch broke."
            : "Patch integrity check failed. REJECTED — keeping current code.");
        iterations[iterations.length - 1].regression = true;
      } else if (classification.patchDecision === "REJECT_NO_IMPROVEMENT") {
        finalCode = candidateCode;
        appendLog("○ REJECT_NO_IMPROVEMENT (iter " + iter + ")",
          "No baseline issues resolved and no regression. Forwarding candidate to next iter so the next fix call sees fresh diagnostics.");
      } else if (classification.patchDecision === "ACCEPT_PROGRESS") {
        finalCode = candidateCode;
        appendLog("✓ ACCEPT_PROGRESS (iter " + iter + ")", "Resolved " + classification.resolved.length + " baseline issues" +
          (classification.revealed.length > 0 ? ", " + classification.revealed.length + " newly uncovered issues to address in next iteration" : "") +
          ". Score: " + classification.score);
      } else {
        // ACCEPT_EQUIVALENT (any other classification falls through here too)
        finalCode = candidateCode;
        appendLog("≈ ACCEPT_EQUIVALENT (iter " + iter + ")", "No net improvement but no regression. Keeping candidate.");
      }
    } else {
      // No CLI for recheck — accept the fix optimistically
      finalCode = candidateCode;
    }

    // Track previous fixes for context in the next iteration (fd is null on
    // the chain path, so tagFixes returns []).
    previousFixes = previousFixes.concat(tagFixes(fd && fd.fixes, iter));

    // ── Stagnation detection by outcome signature ──
    const iterClass = iterations[iterations.length - 1].classification;
    const currentSig = iterClass
      ? (iterClass.patchDecision + "|" + iterClass.persisting + "|" + iterClass.introduced + "|" + iterClass.revealed)
      : ("no-cli|" + ((lintData.errors || []).length + (lintData.warnings || []).length));
    if (currentSig === lastOutcomeSig) {
      stagnationCount++;
      if (stagnationCount >= 2) {
        appendLog("⛔ STAGNATION DETECTED (iter " + iter + ")", "Same outcome signature repeated " + stagnationCount + "× with no net progress. Stopping lint fix loop to prevent infinite retry.");
        finalLint = lintData;
        break;
      }
    } else {
      stagnationCount = 0;
    }
    lastOutcomeSig = currentSig;
  }

  finalLint.iterations = iterations;
  finalLint._fullLog = appendLog.buf;

  // Harvest first-pass lint errors into the cross-run "errors to avoid" catalog
  // (#26–28) — opt-in + best-effort. Iter-1 errors are what cold RTL-gen got
  // wrong, exactly what the next cold gen should be warned about.
  if (st._config && st._config.errorsToAvoid && st._services && st._services.errorMemory) {
    try {
      const _firstErrors = (iterations[0] && iterations[0].errorList) || (finalLint.errors || []);
      for (const _e of _firstErrors) {
        if (_e && (_e.code || _e.msg)) {
          if (isProseLeak(_e)) continue;   // skip spec-prose leaked into RTL (harvest-quality guard)
          st._services.errorMemory.record({ code: _e.code, sev: _e.sev || "error", msg: _e.msg, domain: "rtl", model: st._config.model || null });
        }
      }
    } catch (_e) { /* advisory — never fail the run */ }
  }

  // Use best-known state if final iteration wasn't the best
  const finalIssueCount = ((finalLint.errors || []).length + (finalLint.warnings || []).length);
  if (bestIssueCount < finalIssueCount && bestCode !== finalCode) {
    appendLog("Best-known state restored", "Final iteration had " + finalIssueCount + " issues but best-known had " + bestIssueCount + ". Using best-known code.");
    finalCode = bestCode;
  }

  // ── TASK_STATUS assessment ──
  const remainingIssues = (finalLint.errors || []).length + (finalLint.warnings || []).length;
  if (remainingIssues === 0) {
    finalLint._taskStatus = "COMPLETE";
  } else if ((finalLint.errors || []).length === 0
             && lintConverged(finalLint, !!st._config.lintWarningsAsErrors)) {
    // Tiered convergence (roadmap #2): 0 errors, warnings remain — converged.
    finalLint._taskStatus = "COMPLETE_WARNINGS";
    appendLog("TASK_STATUS: COMPLETE_WARNINGS",
      (finalLint.warnings || []).length + " warning(s) remain — converged at the 0-errors tier"
      + " (set lintWarningsAsErrors to keep iterating on warnings).");
  } else if (stagnationCount >= 2) {
    // Stagnation + remaining issues = likely blocked
    const hasInterfaceIssues = (finalLint.errors || []).concat(finalLint.warnings || []).some(function(d) {
      return (d.msg || "").toLowerCase().indexOf("port") >= 0 || (d.msg || "").toLowerCase().indexOf("interface") >= 0;
    });
    if (hasInterfaceIssues || !finalLint.cli) {
      finalLint._taskStatus = "BLOCKED_NONCODE";
      appendLog("TASK_STATUS: BLOCKED_NONCODE", hasInterfaceIssues
        ? "Remaining issues involve module interface/port changes — these require spec-level changes, not code fixes."
        : "No CLI backend available — LLM lint estimation has stagnated. Connect a real Verilator backend for accurate diagnostics.");
    } else {
      finalLint._taskStatus = "INCOMPLETE";
    }
  } else {
    finalLint._taskStatus = "INCOMPLETE";
  }

  // Determine if code was modified
  const codeChanged = finalCode !== originalCode;
  // Surface the accumulated fix descriptions so the RTL Gen split-view fix
  // panel can show them (otherwise the snapshot shows post-fix code but the fix
  // panel says "No fixes applied"). We store the fixes on BOTH the lint result
  // (for users browsing the lint stage) AND on rtl_generate (so the RTL Gen
  // split view reads stageData[6]._fixes the way it reads stageData[10]._fixes
  // for RTL Review).
  //
  // Each entry preserves the iter that produced it, as { text, iter }. Plain-
  // string consumers still work: panels.jsx coerces objects via _text/
  // _description, and the fix-list renderer handles the {text, iter} shape.
  finalLint._fixes = previousFixes.map(function(f) {
    if (typeof f === "string") return { text: f, iter: null };
    if (f && typeof f === "object") {
      const id = f.id ? "[" + f.id + "] " : "";
      const text = id + (f.desc || f.description || f._text || JSON.stringify(f));
      return { text: text, iter: typeof f._iter === "number" ? f._iter : null };
    }
    return { text: String(f), iter: null };
  });
  // Propagate fixed code back with annotation
  // MERGE the prior rtl_generate slot, don't replace it: a bare { code } here
  // wipes _syntaxRepairs/_bestOfN via the StateGraph shallow-merge (the known
  // clobber pattern). Lint-owned transient keys are stripped and re-stamped so
  // a stale _originalCode from an earlier run can't survive mislabeled.
  const rtlResult = Object.assign({}, st.rtl_generate, { code: finalCode });
  delete rtlResult._originalCode;
  delete rtlResult._fixSource;
  delete rtlResult._fixes;
  if (codeChanged) {
    rtlResult._originalCode = originalCode;
    rtlResult._fixSource = "fixed post lint";
    rtlResult._fixes = finalLint._fixes;   // mirror onto rtl_generate too
  }
  // Attach _llms to the per-stage result. The runStage.js dispatch writes
  // `newState[stageKey]` into stageData[id], so a top-level _llms would be
  // dropped; putting it on the stage's own object lands it in
  // stageData[id]._llms where the Duration/Tokens tabs can find it.
  finalLint._llms = allLlms.slice();
  // Expose any chain history so the trace panel can render nested K-to-X
  // re-runs. Empty when this lint took the legacy inline path (no _services,
  // or already inside its own chain).
  if (lintChainHistory.length > 0) {
    finalLint._chain = lintChainHistory;
  }

  return {
    lint: finalLint,
    rtl_generate: rtlResult,
    // Keep top-level _llms too for back-compat with any direct readers,
    // and _llm for legacy code paths that consumed the singular.
    _llms: allLlms.slice(),
    _llm: allLlms.length > 0
      ? allLlms[allLlms.length - 1]
      : { stage: "lint", tokensIn: 0, tokensOut: 0, latencyMs: 0, model: "cli", provider: "cli" },
  };
}
