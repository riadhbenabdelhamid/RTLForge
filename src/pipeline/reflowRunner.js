// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// reflowRunner
//
// Stage-agnostic K-to-X chain executor. Walks a planner-produced chain
// (from `planReflow` or `planStageReflow`), invoking each entry's node
// via the pipeline service, and merging results into a running state
// object.
//
// USAGE — judge (top-level K-to-X reflow):
//   const chain = planReflow({ triageTarget, activeStages, state, mode });
//   const walk = await runReflowChain({
//     chain, st, currentState, allLlms, appendLog,
//     ownerKey: "judge",      // the stage running the reflow
//     ownerIter: jIter,       // current iteration of the owning stage
//     parentDepth: 0,         // depth of the OWNER (chain entries run at parentDepth+1)
//     strictOnError: !!st._config.strictJudgeCli,
//   });
//
// USAGE — lint stage internal loopback (per-stage K-to-X reflow):
//   const tail = getReflowTail("lint", st._services.allStages);
//   const chain = planStageReflow({ ownerKey: "lint", tail, state, mode });
//   const walk = await runReflowChain({
//     chain, st, currentState, allLlms, appendLog,
//     ownerKey: "lint", ownerIter: lintIter,
//     parentDepth: st._logger.context.depth || 0,
//     strictOnError: false,
//   });
//
// RECURSION:
//   Each chain entry's sub-state carries `_services` so the sub-node
//   can itself trigger another reflow (e.g. judge → verify → lint →
//   rtl_generate). The parent's depth is propagated through
//   `parentDepth + 1` so events emitted by the sub-node carry their
//   nesting level correctly.
//
// RETURNS:
//   { currentState, chainHistory, fallbackToLegacy? }
//   - currentState: state with every successful sub-stage's outputs merged in
//   - chainHistory: per-entry record of { stageKey, reason, status, error,
//     durationMs, startedAtMs, endedAtMs, llmCount, events }
//   - fallbackToLegacy: true if services.invokeNode was unavailable
// ═══════════════════════════════════════════════════════════════════════════

import { createStageLogger } from "../projectState/stageLogger.js";
import { resolveNestedIterLimit } from "./reflowPlanner.js";

/**
 * Walk a reflow chain, invoking each stage's node in sequence.
 *
 * @param {object} opts
 * @param {Array}  opts.chain         — output of planReflow / planStageReflow
 * @param {object} opts.st            — current stage's accState (provides _services, _config, _signal, etc.)
 * @param {object} opts.currentState  — running pipeline state; this function
 *                                       returns an updated copy
 * @param {Array}  opts.allLlms       — accumulator for LLM events across the chain
 * @param {Function} opts.appendLog   — owner stage's logging helper (string title, string body)
 * @param {string} opts.ownerKey      — stage running the chain ("judge" / "lint" / "verify" / etc.)
 * @param {number} opts.ownerIter     — owner stage's current iteration (1-based)
 * @param {number} opts.parentDepth   — depth of the owner; sub-entries run at parentDepth+1
 * @param {boolean} opts.strictOnError — when true, bail out of remaining chain entries if one errors
 */
export async function runReflowChain(opts) {
  const chain         = opts.chain || [];
  const st            = opts.st;
  let   currentState  = opts.currentState;
  const allLlms       = opts.allLlms || [];
  const appendLog     = opts.appendLog || (function() {});
  const ownerKey      = opts.ownerKey || "unknown";
  const ownerIter     = opts.ownerIter != null ? opts.ownerIter : 1;
  const parentDepth   = opts.parentDepth || 0;
  const strictOnError = !!opts.strictOnError;

  const chainHistory = [];
  const services     = (st && st._services) || {};
  const invokeNode   = services.invokeNode;

  if (typeof invokeNode !== "function") {
    appendLog("⚠ Reflow chain unavailable",
      "services.invokeNode missing — caller should fall back to legacy point-fix path");
    return { currentState, chainHistory, fallbackToLegacy: true };
  }

  // Publish the set of stage IDs this chain will touch BEFORE invoking any
  // entries. The UI uses this to fast-blink every stage active in the reflow
  // (not just one target, the way _onLoopback does for the legacy point-fix
  // path). The owner stage is included (it's waiting on the chain to finish);
  // skipped entries are excluded. The publish uses st._onReflowStages, which
  // runStage plumbs through with module-scoping.
  const ownerStageId = (function() {
    const all = (services.allStages || []);
    const found = all.find(function(s) { return s.key === ownerKey; });
    return found ? found.id : null;
  })();
  const activeIds = [];
  for (const e of chain) {
    if (e.reason === "skipped") continue;
    if (typeof e.stageId === "number") activeIds.push(e.stageId);
  }
  if (ownerStageId != null && activeIds.indexOf(ownerStageId) < 0) {
    activeIds.push(ownerStageId);
  }
  if (typeof st._onReflowStages === "function") {
    st._onReflowStages(activeIds);
  }

  // try/finally guard around the chain walk so the reflow-active stage set
  // ALWAYS clears, even if a sub-stage throws an error that escapes the
  // per-entry try/catch (e.g. OOM or an aborted-promise surfacing here rather
  // than at invokeNode). Otherwise the UI could be stuck fast-blinking forever.
  try {
    for (const entry of chain) {
      const entryStart = Date.now();

      // Bail out of the chain early if the user has aborted. Without this check
      // the abort would only be caught INSIDE the next invokeNode call (via
      // runCli's signal honoring); checking on the entry boundary halts the
      // walk immediately.
      if (st._signal && st._signal.aborted) {
        appendLog("⛔ Reflow chain aborted by user",
          "Halting at entry " + entry.stageKey + " (" + entry.reason + ")");
        throw new DOMException("Aborted", "AbortError");
      }

    // Emit a state event when each entry STARTS so the trace panel / Log tab
    // can show progress as the chain walks (not only on entry COMPLETE, which
    // leaves a stage taking minutes — e.g. rtl_generate against a slow local
    // model — looking stuck because no state event fired until the very end).
    if (st._logger && typeof st._logger.state === "function") {
      st._logger.state({
        iter: ownerIter,
        message: "Reflow [" + entry.reason + "] " + entry.stageKey + ": starting…",
      });
    }

    // Skipped entries — record and move on
    if (entry.reason === "skipped") {
      chainHistory.push({
        stageKey: entry.stageKey,
        reason:   entry.reason,
        status:   "skipped",
        durationMs: 0,
        startedAtMs: entryStart,
        endedAtMs:   entryStart,
        llmCount: 0,
      });
      appendLog("Reflow [skip] " + entry.stageKey,
        "Previously passed and no upstream changes — skipping (smart mode)");
      continue;
    }

    appendLog("Reflow [" + entry.reason + "] " + entry.stageKey,
      "Running as part of " + ownerKey + " iter " + ownerIter + " K-to-X reflow (depth=" + (parentDepth + 1) + ")");

    // Build sub-accState for this stage invocation. Mirror what
    // runStage builds for a top-level run, but with nested logger
    // context so trace events carry hierarchy metadata.
    const subLogger = createStageLogger(entry.stageKey, {
      depth:          parentDepth + 1,
      parentStageKey: ownerKey,
      parentIter:     ownerIter,
    });

    // Iter-limit override for nested stages. We splice the config
    // shallowly so we don't mutate the parent's st._config.
    const subConfig = Object.assign({}, st._config);
    const nestedLimit = resolveNestedIterLimit(entry.stageKey, subConfig);
    if (nestedLimit != null) {
      if (entry.stageKey === "lint" || entry.stageKey === "lint_test") {
        subConfig.maxLintIters = nestedLimit;
      } else if (entry.stageKey === "verify") {
        subConfig.maxVerifyIters = nestedLimit;
      }
    }

    const subState = Object.assign({}, currentState, {
      _config: subConfig,
      _onLog:  st._onLog,
      _onLoopback: st._onLoopback,
      // Propagate the reflow-stages signal channel so a sub-stage that itself
      // triggers a nested reflow can publish its own active set. The UI receives
      // the deepest-most-recent call (each entry calls onReflowStages on
      // enter + exit).
      _onReflowStages: st._onReflowStages,
      _signal: st._signal,
      _lastError: null,
      _childInterfaces: services.childInterfaces || st._childInterfaces || null,
      _sharedPackageCode: st._sharedPackageCode || null,
      _skillBridge: services.skillBridge || st._skillBridge || null,
      _logger: subLogger,
      // Propagate services so the sub-node can itself trigger another
      // reflow (recursion). depth is carried via the sub-logger's
      // context; nested callers read it as logger.context.depth.
      _services: services,
      // Informed loopback.
      //
      // When the planner attached a fixContext to this entry (only true
      // for the chain's triage entry), forward it on subState as
      // _fixContext. Generation nodes (rtl_generate, test_generate)
      // detect this and switch to their fix-prompt variant
      // (promptRTLFix / promptRTLFromVerifyFail / promptRTLReviewFix /
      // promptTBLintFix / promptTBFromVerifyFail / promptTestReviewFix)
      // instead of cold regen from spec.
      //
      // This is the channel that finally carries failure context across
      // the chain boundary so the LLM knows WHAT to fix, not just to
      // regenerate from scratch. Without it, the reflow was just a
      // dice-reroll on the same prompt.
      _fixContext: entry.fixContext || null,
    });

    let subResult = null;
    let entryError = null;
    let entryStatus = "ran";
    try {
      subResult = await invokeNode(entry.stageKey, subState);
    } catch (e) {
      entryError = e && e.message ? e.message : String(e);
      entryStatus = "error";
      appendLog("⚠ Reflow entry error: " + entry.stageKey, entryError);
    }

    // Merge sub-result into currentState. Each node returns a small
    // object whose top-level keys map to stage outputs (e.g. {lint:...,
    // rtl_generate:...}); merge those keys into currentState so the
    // next entry sees them.
    //
    // Track this sub-stage's LLM count so the chainHistory entry below reports
    // the right number. Nodes push their LLM calls into result._llms (the
    // ledger), NOT via logger.llm(), so counting from subLogger.events would
    // always be 0 — we count from result._llms instead.
    let subLlmCount = 0;
    if (subResult && typeof subResult === "object") {
      for (const k of Object.keys(subResult)) {
        if (k.startsWith("_")) continue;  // skip private fields like _llm
        currentState = Object.assign({}, currentState, { [k]: subResult[k] });
      }
      // Capture LLM events from this sub-stage's _llms (singular or plural)
      // into the owner's accumulated ledger so the Duration/Tokens tabs
      // see every call across the whole chain.
      const subLlms = Array.isArray(subResult._llms)
        ? subResult._llms
        : (subResult._llm ? [subResult._llm] : []);
      subLlmCount = subLlms.length;
      for (const c of subLlms) {
        allLlms.push(Object.assign({}, c, {
          stage: (c.stage || entry.stageKey) + "@" + ownerKey + "-iter-" + ownerIter,
          _parentIter: ownerIter,
          _parentStageKey: ownerKey,
          _depth: parentDepth + 1,
        }));
      }
    }

    const entryEnd = Date.now();

    // Publish this chain entry as a per-stage run record so the dropdown / trace
    // panel can navigate to it later. We publish for EVERY non-skipped entry
    // (triage, downstream, always); skipped entries have no result to record.
    // The `context` field carries owner info so the dropdown label can read like
    // "Re-run inside lint iter 2 (depth 1)". Errors are published too
    // (status: "error") so failed re-runs are inspectable.
    //
    // Capture the runId assigned by the reducer so we can stamp it on
    // chainHistory below; the trace tab uses it to map run records to chain
    // entries for click-to-navigate.
    let publishedRunId = null;
    if (entry.reason !== "skipped"
        && typeof services.onSubRun === "function"
        && entry.stageId != null) {
      try {
        const ret = services.onSubRun({
          stageId:    entry.stageId,
          stageKey:   entry.stageKey,
          trigger:    "reflow:" + ownerKey,
          startedAt:  entryStart,
          finishedAt: entryEnd,
          status:     entryStatus === "ran" ? "complete" : entryStatus,
          // The sub-stage's full result snapshot. We take the value
          // from currentState (after the merge) keyed by stageKey;
          // that's the canonical "what this stage produced" payload.
          result:     currentState[entry.stageKey] || null,
          context: {
            depth:          parentDepth + 1,
            parentStageKey: ownerKey,
            parentIter:     ownerIter,
            reason:         entry.reason,
            error:          entryError,
          },
        });
        // onSubRun returns the assigned runId when wired by runStage;
        // older callers may not return anything (e.g. tests with custom
        // stubs). Guard against non-number returns.
        if (typeof ret === "number") publishedRunId = ret;
      } catch (e) {
        // Never let the publish path break the chain walk
        appendLog("⚠ onSubRun publish error",
          "Failed to record run for " + entry.stageKey + ": " +
          (e && e.message ? e.message : String(e)));
      }
    }

    chainHistory.push({
      stageKey:    entry.stageKey,
      stageId:     entry.stageId,
      reason:      entry.reason,
      status:      entryStatus,
      error:       entryError,
      durationMs:  entryEnd - entryStart,
      startedAtMs: entryStart,
      endedAtMs:   entryEnd,
      // Counted from result._llms (nodes don't push LLM events to the logger).
      llmCount:    subLlmCount,
      // The assigned runId from onSubRun, letting the trace tab's click handler
      // navigate to the exact run. null when skipped or onSubRun isn't wired.
      runId:       publishedRunId,
      events:      subLogger.events.slice(),
    });

    // Emit a state event into the owner's own logger so the top-level
    // Log panel (and trace panel) reflect chain progression without
    // having to recursively flatten sub-loggers.
    if (st._logger) {
      st._logger.state({
        iter: ownerIter,
        message: "Reflow [" + entry.reason + "] " + entry.stageKey +
          ": " + entryStatus + " (" + (entryEnd - entryStart) + "ms, " +
          (chainHistory[chainHistory.length - 1].llmCount) + " LLM call(s))",
      });
    }

    // If a chain entry errored AND strict-on-error is set, bail out
    // of the remainder of the chain. The owner's outer loop should
    // then re-evaluate.
    if (entryStatus === "error" && strictOnError) {
      appendLog("⛔ Reflow chain halted (strict mode)",
        "Stage " + entry.stageKey + " errored; remaining chain entries skipped");
      break;
    }
  }
  } finally {
    // Chain done — clear the reflow-active stage set so the UI stops
    // fast-blinking. In `finally` so even an unexpected throw inside the chain
    // walk clears the signal (otherwise the badges stay stuck pulsing yellow).
    if (typeof st._onReflowStages === "function") {
      st._onReflowStages([]);
    }
  }

  return { currentState, chainHistory };
}

/**
 * Convenience: resolve a stage's effective reflow mode from config.
 * Returns "smart" by default for unknown stages.
 */
export function resolveReflowMode(ownerKey, cfg) {
  if (!cfg) return "smart";
  const keyMap = {
    judge:       cfg.judgeReflowMode,
    lint:        cfg.lintReflowMode,
    lint_test:   cfg.lintTestReflowMode,
    rtl_review:  cfg.rtlReviewReflowMode,
    test_review: cfg.testReviewReflowMode,
    verify:      cfg.verifyReflowMode,
  };
  return keyMap[ownerKey] === "strict" ? "strict" : "smart";
}
