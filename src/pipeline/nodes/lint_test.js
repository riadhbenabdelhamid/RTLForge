// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/lint_test — Stage 7d: Lint TESTBENCH with Iterative Fix Loop
//
// Optional stage that runs between Test Gen / Test Review and Verify.
// Modelled after the RTL lint node, but:
//   - Operates on st.test_generate.code (the TB), not st.rtl_generate.code.
//   - Uses promptTBLint / promptTBLintFix (testbench-aware vocabulary).
//   - The CLI command is the same Verilator invocation (Verilator lints
//     the TB just like RTL — what's testbench-specific is the LLM
//     fallback's vocabulary and false-positive guards).
//   - Result delta updates `lint_test` and `test_generate` (NOT `lint` /
//     `rtl_generate`).
//
// Architecture mirrors lint.js for easy auditability:
//   1. Try real CLI first; fall back to LLM via promptTBLint.
//   2. Iteratively fix the TB via promptTBLintFix.
//   3. Patch integrity check (identical-code rejection).
//   4. Classifier-gated accept/reject against the original baseline.
//   5. Best-known restore on regression.
//   6. Stagnation detection.
//   7. previousFixes memory across iterations.
//   8. TASK_STATUS assessment: COMPLETE / INCOMPLETE / BLOCKED_NONCODE.
//
// Result delta:
//   lint_test     — final lint report with .iterations[], _fullLog, _taskStatus
//   test_generate — { code, _originalCode?, _fixSource? }
// ═══════════════════════════════════════════════════════════════════════════

import { callLLM, extractJSON } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { runCli, parseCLIOutput, CliBackendError } from "../../cli/index.js";
import { classifyDiagnostics } from "../classifiers.js";
import { promptTBLint, promptTBLintFix } from "../../prompts/index.js";
import { createLogger } from "../log.js";
import { tagFixes } from "../fixLoopHelpers.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
// Per-stage K-to-X reflow: when lint_test's internal fix-loop decides the TB
// needs regenerating, the chain runs test_generate → test_review → lint_test
// instead of the inline callLLM(promptTBLintFix) patch.
import { planStageReflow } from "../reflowPlanner.js";
import { runReflowChain, resolveReflowMode } from "../reflowRunner.js";
import { getReflowTail } from "../../constants/stages.js";

export async function lintTestNode(st) {
  const originalRTL = (st.rtl_generate && st.rtl_generate.code) || "";
  const originalTB  = (st.test_generate && st.test_generate.code) || "";
  const moduleName  = (st.elicit && st.elicit.modName) || "module";
  const rtlFileName = moduleName + ".sv";
  const tbFileName  = moduleName + "_tb.sv";

  const allLlms = [];
  const iterations = [];
  let finalLint = null;
  let finalTB = originalTB;
  let bestTB = originalTB;
  let bestIssueCount = Infinity;
  let previousFixes = [];
  let baselineIssues = null;
  let lastOutcomeSig = null;
  let stagnationCount = 0;
  // Most recent classifyDiagnostics result (full object) — fed into the next
  // iteration's fix prompt as the patch-outcome section. Same pattern as
  // lint.js: the model must see what its last patch achieved.
  let lastClassification = null;

  // CLI robustness — same plumbing as lint.js
  const _cliOpts = {
    retries:   (st._config.cliRetryCount == null ? 1 : st._config.cliRetryCount),
    timeoutMs: ((st._config.backendTimeoutSec || 600) * 1000),
    logger:    st._logger || null,   // captures CLI events for the Log panel
  };
  const _strictCli = (st._config.strictCli === true) && !!st._config.backendUrl;

  const appendLog = createLogger(st._onLog, "thick");
  // Lint Test reuses maxLintIters by default — same fix loop semantics.
  // Chain-eligibility check: as in lint.js, when lint_test decides the TB needs
  // regenerating, prefer the K-to-X chain (test_generate → test_review →
  // lint_test). Inner lint_test inside its own chain takes the legacy inline
  // path so recursion terminates.
  const _hasServices = !!(st._services && typeof st._services.invokeNode === "function");
  const _loggerCtx   = (st._logger && st._logger.context) || {};
  const _alreadyInOwnChain = _loggerCtx.parentStageKey === "lint_test";
  const _canChain = _hasServices && !_alreadyInOwnChain;
  const lintTestChainHistory = [];

  const _maxLintIters = st._config.maxLintIters || 3;

  // Verilator command for linting the TB. Default lints the TB only;
  // a more thorough invocation could compile both (RTL+TB) — but for the
  // TB-lint stage the goal is to catch testbench-side issues without the
  // RTL needing to be fully valid yet.
  const _tbLintCmd = (st._config.tbLintCmd ||
    "verilator --lint-only -Wall {TB}").replace("{TB}", tbFileName);

  for (let iter = 1; iter <= _maxLintIters; iter++) {
    appendLog("Lint Test — iteration " + iter + "/" + _maxLintIters, "Running TB lint analysis…");
    if (st._logger) st._logger.state({
      iter: iter, message: "Lint Test iteration " + iter + "/" + _maxLintIters,
    });

    // ─── Step A: Try real CLI first ───
    let cliResult = await runCli(st._config.backendUrl, {
      command: _tbLintCmd,
      files: { [rtlFileName]: originalRTL, [tbFileName]: finalTB },
    }, st._signal, _cliOpts);

    let lintData;
    let _cliErrorMsg = null;
    if (cliResult && cliResult._error) {
      console.warn("[RTL Forge] Lint Test CLI backend error:", cliResult._msg, "(after " + (cliResult._attempts || 1) + " attempts)");
      _cliErrorMsg = cliResult._msg + " — after " + (cliResult._attempts || 1) + " attempt(s)";
      if (_strictCli) {
        appendLog("⛔ STRICT CLI MODE — failing", _cliErrorMsg + "\n\nDisable Strict CLI mode in Settings → CLI to allow LLM fallback.");
        throw new CliBackendError(_cliErrorMsg, cliResult._attempts || 1);
      }
      cliResult = null;
    }
    if (cliResult && cliResult.exitCode !== undefined) {
      const parsed = parseCLIOutput(cliResult.stderr);
      lintData = {
        tool: "Verilator-TB (CLI — real)",
        status: cliResult.exitCode === 0 && parsed.errors.length === 0 ? "PASS" : "FAIL",
        warnings: parsed.warnings,
        errors: parsed.errors,
        summary: parsed.errors.length + " errors, " + parsed.warnings.length + " warnings",
        log: (cliResult.stdout || "") + "\n" + (cliResult.stderr || ""),
        cli: true,
      };
      appendLog("CLI result (iter " + iter + ")", lintData.summary + "\n" + lintData.log);
    } else {
      appendLog("LLM TB Lint (iter " + iter + ")", "No CLI available, using LLM estimation…");
      let lp = promptTBLint(finalTB, originalRTL, st.spec, st.elicit);
      // Skills targeting "lint_test" overlay on the TB-lint check.
      lp = await applySkillsToPrompt(lp, st, "lint_test");
      const _sc = getStageConfig(st._config, "lint_test");
      lp.config = _sc;
      lp.maxTokens = _sc._maxTokens;
      lp.onChunk = function(t, m) { appendLog.stream("LLM TB Lint output", t); if (st._onLog) st._onLog(appendLog.buf, m); };
      const lr = await callLLM(lp);
      allLlms.push(Object.assign({ stage: "lint_test-iter" + iter }, lr));
      lintData = extractJSON(lr.text);
      if (_cliErrorMsg) lintData._cliError = _cliErrorMsg;
    }

    lintData.iteration = iter;
    const currentIssues = (lintData.errors || []).concat(lintData.warnings || []);
    if (iter === 1) baselineIssues = currentIssues.slice();
    if (currentIssues.length < bestIssueCount) {
      bestIssueCount = currentIssues.length;
      bestTB = finalTB;
    }
    iterations.push({
      iter,
      status: lintData.status,
      errors: (lintData.errors || []).length,
      warnings: (lintData.warnings || []).length,
      errorList: (lintData.errors || []).slice(),
      warningList: (lintData.warnings || []).slice(),
    });

    // ─── Step B: Done if clean or max iters reached ───
    let hasErrors = (lintData.errors || []).length > 0 || lintData.status === "FAIL";
    const hasWarnings = (lintData.warnings || []).length > 0;
    const treatWarningsAsErrors = !!st._config.lintWarningsAsErrors;
    if (treatWarningsAsErrors && hasWarnings) hasErrors = true;
    if (!hasErrors || iter >= _maxLintIters) {
      finalLint = lintData;
      break;
    }

    // ─── Step C: Fix TB — via K-to-X chain (preferred) or inline callLLM (legacy) ───
    //
    // When chaining is available, lint_test re-runs test_generate →
    // test_review → lint_test as a chain instead of emitting a targeted patch
    // via promptTBLintFix. The chain produces a freshly regenerated TB; we then
    // continue with the CLI re-lint regression check below.
    let candidateTB;
    let fd            = null;
    let frTextForUi   = "";
    let chainEntryUsed = false;

    if (_canChain) {
      const activeStages = (st._services.allStages || []).slice();
      const tail = getReflowTail("lint_test", activeStages);
      const mode = resolveReflowMode("lint_test", st._config);
      // Informed loopback: the chain's triage entry (test_generate) gets the
      // lint result so it can call promptTBLintFix(tb, rtl, lintResult, spec,
      // el, previousFixes) instead of cold-regenerating the TB from spec.
      const fixContext = {
        source:        "lint_test",
        ownerIter:     iter,
        previousCode:  finalTB,
        previousFixes: previousFixes,
        lintResult:    lintData,
      };
      const chain = planStageReflow({
        ownerKey:   "lint_test",
        tail:       tail,
        state:      Object.assign({}, st, { test_generate: { code: finalTB } }),
        mode:       mode,
        fixContext: fixContext,
      });
      if (chain.length > 0) {
        appendLog("Reflow chain (lint_test, " + mode + ", " + chain.length + " entries)",
          chain.map(function(c) { return c.stageKey + "[" + c.reason + "]"; }).join(" → "));
        const parentDepth = (_loggerCtx.depth != null) ? _loggerCtx.depth : 0;
        const walk = await runReflowChain({
          chain:        chain,
          st:           st,
          ownerKey:     "lint_test",
          ownerIter:    iter,
          parentDepth:  parentDepth,
          currentState: Object.assign({}, st, { test_generate: { code: finalTB } }),
          allLlms:      allLlms,
          appendLog:    appendLog,
          strictOnError: false,
        });
        if (!walk.fallbackToLegacy) {
          chainEntryUsed = true;
          lintTestChainHistory.push({
            iter: iter,
            mode: mode,
            entries: walk.chainHistory,
          });
          const tbAfter = (walk.currentState && walk.currentState.test_generate
                            && walk.currentState.test_generate.code) || finalTB;
          candidateTB = tbAfter;
          iterations[iterations.length - 1]._structured = {
            rawText: "",
            parsed:  null,
            parseOk: true,
            beforeCode: finalTB,
            afterCode:  candidateTB,
            kind:      "tb_fix_via_chain",
            chain:     walk.chainHistory,
            chainMode: mode,
          };
        }
      }
    }

    if (!chainEntryUsed) {
      // ── Legacy inline path — unchanged ──
      appendLog("TB Fix — iteration " + iter, "Applying fixes for " + (lintData.errors || []).length + " errors, " + (lintData.warnings || []).length + " warnings…");
      let fp = promptTBLintFix(finalTB, originalRTL, lintData, st.spec, st.elicit, previousFixes, lastClassification);
      // This sub-call regenerates testbench code, so apply test_generate skills
      // (the user's SV testbench style rules) rather than lint_test skills.
      fp = await applySkillsToPrompt(fp, st, "test_generate");
      const _sc2 = getStageConfig(st._config, "tb_fix");
      fp.config = _sc2;
      fp.maxTokens = _sc2._maxTokens;
      fp.onChunk = function(t, m) { appendLog.stream("TB Fix output (iter " + iter + ")", t); if (st._onLog) st._onLog(appendLog.buf, m); };
      const fr = await callLLM(fp);
      allLlms.push(Object.assign({ stage: "tb-fix-iter" + iter }, fr));
      fd = extractJSON(fr.text);
      frTextForUi = fr.text || "";
      candidateTB = fd.code || finalTB;

      iterations[iterations.length - 1]._structured = {
        rawText: frTextForUi,
        parsed: fd && typeof fd === "object" ? fd : null,
        parseOk: !!(fd && typeof fd === "object" && fd.code),
        beforeCode: finalTB,
        afterCode: candidateTB,
        kind: "tb_fix",
      };
    }

    // Patch integrity
    let patchIntegrityOk = true;
    if (candidateTB === finalTB) {
      patchIntegrityOk = false;
      appendLog("⚠ REJECT_INVALID_PATCH (iter " + iter + ")", "LLM returned identical TB despite claiming fixes. Patch integrity failed.");
      iterations[iterations.length - 1].patchInvalid = true;
    }

    if (!patchIntegrityOk) {
      stagnationCount++;
      if (stagnationCount >= 2) {
        appendLog("⛔ STAGNATION DETECTED (iter " + iter + ")", "Same ineffective fix strategy repeated " + stagnationCount + "× with no net progress. Stopping TB lint fix loop.");
        finalLint = lintData;
        break;
      }
      // Tag each fix with its iter for UI annotation (fd is null on the chain
      // path, so tagFixes returns []).
      previousFixes = previousFixes.concat(tagFixes(fd && fd.fixes, iter));
      continue;
    }

    // ── CLI re-lint to validate the patch ──
    const recheck = await runCli(st._config.backendUrl, {
      command: _tbLintCmd,
      files: { [rtlFileName]: originalRTL, [tbFileName]: candidateTB },
    }, st._signal, _cliOpts);

    if (recheck && recheck._error && _strictCli) {
      appendLog("⛔ STRICT CLI MODE — recheck failed", recheck._msg);
      throw new CliBackendError(recheck._msg, recheck._attempts || 1);
    }
    if (recheck && recheck.exitCode !== undefined) {
      const recheckParsed = parseCLIOutput(recheck.stderr);
      const allCandidate = recheckParsed.errors.concat(recheckParsed.warnings);
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
      // Full object (with diagnostic arrays) for the next fix prompt's
      // patch-outcome section — the counts above are UI-only.
      lastClassification = classification;

      // Forward the candidate so iter N+1 sees the actual current TB. Best-known
      // restore at the end recovers the best state if no later iter improves.
      // The branches below differ only in their log messages.
      finalTB = candidateTB;
      if (classification.patchDecision === "REJECT_REGRESSION" || classification.patchDecision === "REJECT_INVALID_PATCH") {
        appendLog("⚠ " + classification.patchDecision + " (iter " + iter + ")",
          classification.patchDecision === "REJECT_REGRESSION"
            ? "Fix introduced " + classification.introduced.length + " new unrelated issues (score=" + classification.score + "). Forwarding candidate (best-known restore at end)."
            : "Patch integrity check failed. Forwarding candidate (best-known restore at end).");
        iterations[iterations.length - 1].regression = true;
      } else if (classification.patchDecision === "REJECT_NO_IMPROVEMENT") {
        appendLog("○ REJECT_NO_IMPROVEMENT (iter " + iter + ")", "No baseline issues resolved and no regression. Forwarding candidate so the next fix call sees fresh diagnostics.");
      } else if (classification.patchDecision === "ACCEPT_PROGRESS") {
        appendLog("✓ ACCEPT_PROGRESS (iter " + iter + ")", "Resolved " + classification.resolved.length + " baseline issues" +
          (classification.revealed.length > 0 ? ", " + classification.revealed.length + " newly uncovered issues to address in next iteration" : "") +
          ". Score: " + classification.score);
      } else {
        // ACCEPT_EQUIVALENT
        appendLog("≈ ACCEPT_EQUIVALENT (iter " + iter + ")", "No net improvement but no regression. Keeping candidate.");
      }
    } else {
      finalTB = candidateTB;
    }

    // Tag each fix with its iter (fd is null on the chain path → []).
    previousFixes = previousFixes.concat(tagFixes(fd && fd.fixes, iter));

    // ── Stagnation detection by outcome signature ──
    const iterClass = iterations[iterations.length - 1].classification;
    const currentSig = iterClass
      ? (iterClass.patchDecision + "|" + iterClass.persisting + "|" + iterClass.introduced + "|" + iterClass.revealed)
      : ("no-cli|" + ((lintData.errors || []).length + (lintData.warnings || []).length));
    if (currentSig === lastOutcomeSig) {
      stagnationCount++;
      if (stagnationCount >= 2) {
        appendLog("⛔ STAGNATION DETECTED (iter " + iter + ")", "Same outcome signature repeated " + stagnationCount + "× with no net progress. Stopping TB lint fix loop.");
        finalLint = lintData;
        break;
      }
    } else {
      stagnationCount = 0;
    }
    lastOutcomeSig = currentSig;
  }

  // Fallback if the loop never set finalLint. Defensive: the iter ≥
  // _maxLintIters break path always sets it (and `_maxLintIters || 3` prevents
  // 0/negative values), so this is unreachable today — kept as a safety net.
  // Note iter entries store errors/warnings as NUMBERS (counts) while the rest
  // of the file expects ARRAYS, so we build a properly-shaped report from the
  // last iter's lists rather than cloning the iter entry.
  if (!finalLint) {
    if (iterations.length > 0) {
      const last = iterations[iterations.length - 1];
      finalLint = {
        tool: "Verilator-TB",
        status: last.status,
        errors:   Array.isArray(last.errorList)   ? last.errorList.slice()   : [],
        warnings: Array.isArray(last.warningList) ? last.warningList.slice() : [],
        summary:  (last.errors || 0) + " errors, " + (last.warnings || 0) + " warnings",
        log: "",
        cli: false,
      };
    } else {
      finalLint = { tool: "Verilator-TB", status: "PASS", errors: [], warnings: [], summary: "no-op", log: "", cli: false };
    }
  }
  finalLint.iterations = iterations;
  finalLint._fullLog = appendLog.buf;

  // Restore best-known TB if final iter regressed
  const finalIssueCount = (finalLint.errors || []).length + (finalLint.warnings || []).length;
  if (bestIssueCount < finalIssueCount && bestTB !== finalTB) {
    appendLog("Best-known TB restored", "Final iteration had " + finalIssueCount + " issues but best-known had " + bestIssueCount + ". Using best-known TB.");
    finalTB = bestTB;
  }

  // ── TASK_STATUS assessment ──
  const remainingIssues = (finalLint.errors || []).length + (finalLint.warnings || []).length;
  if (remainingIssues === 0) {
    finalLint._taskStatus = "COMPLETE";
  } else if (stagnationCount >= 2) {
    const hasContractIssues = (finalLint.errors || []).concat(finalLint.warnings || []).some(function(d) {
      const code = d.code || "";
      // PORT_TYPO / PORT_MISSING / WIDTH on TB→DUT connections require RTL
      // changes, not TB changes — flag as blocked.
      return code === "PORT_TYPO" || code === "PORT_MISSING" || code === "REQ_NOT_TESTED";
    });
    if (hasContractIssues || !finalLint.cli) {
      finalLint._taskStatus = "BLOCKED_NONCODE";
      appendLog("TASK_STATUS: BLOCKED_NONCODE", hasContractIssues
        ? "Remaining issues involve DUT contract or requirement coverage that the TB alone cannot fix — these need RTL or spec changes."
        : "No CLI backend available — LLM TB lint estimation has stagnated. Connect a real Verilator backend for accurate diagnostics.");
    } else {
      finalLint._taskStatus = "INCOMPLETE";
    }
  } else {
    finalLint._taskStatus = "INCOMPLETE";
  }

  // Surface the accumulated fix descriptions so the Test Gen split-view fix
  // panel can show them (mirrors lint.js). Each entry preserves its iter as
  // { text, iter }.
  finalLint._fixes = previousFixes.map(function(f) {
    if (typeof f === "string") return { text: f, iter: null };
    if (f && typeof f === "object") {
      const id = f.id ? "[" + f.id + "] " : "";
      const text = id + (f.desc || f.description || f._text || JSON.stringify(f));
      return { text: text, iter: typeof f._iter === "number" ? f._iter : null };
    }
    return { text: String(f), iter: null };
  });
  const tbChanged = finalTB !== originalTB;
  const tbResult = { code: finalTB };
  if (tbChanged) {
    tbResult._originalCode = originalTB;
    tbResult._fixSource = "fixed post lint_test";
    tbResult._fixes = finalLint._fixes;   // mirror onto test_generate
  }
  finalLint._llms = allLlms.slice();
  // Expose chain history if the chain ran.
  if (lintTestChainHistory.length > 0) {
    finalLint._chain = lintTestChainHistory;
  }
  return {
    lint_test: finalLint,
    test_generate: tbResult,
    // Full per-call LLM ledger for the Duration/Tokens tabs.
    _llms: allLlms.slice(),
    _llm: allLlms.length > 0
      ? allLlms[allLlms.length - 1]
      : { stage: "lint_test", tokensIn: 0, tokensOut: 0, latencyMs: 0, model: "cli", provider: "cli" },
  };
}
