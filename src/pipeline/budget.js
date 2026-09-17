// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// budget — per-run token/cost ceiling for the LLM pipeline
//
// WHY THIS EXISTS:
//
// The ledger faithfully RECORDS spend, but nothing ENFORCED a limit. Cost in
// this pipeline is multiplicative by design: judge iterations × per-stage fix
// iterations × K-to-X reflow chains (whose per-stage limits RESET on each
// judge re-entry). A pathological run could spend an order of magnitude more
// than the user expected, and the first they'd hear of it is the bill.
//
// HOW IT WORKS:
//
// createBudgetGuard(config, ledger) snapshots the project's cumulative spend
// from the reducer ledger and exposes two checks:
//
//   exceeded()        — is the project already over the ceiling?
//                       (runStage calls this BEFORE invoking a stage node —
//                       the stage-boundary gate)
//   overWith(llms)    — would the ceiling be crossed counting the calls a
//                       node has made so far in its own loop? (fix loops call
//                       this at iteration boundaries — the in-stage gate that
//                       catches runaway nested reflow within a single stage)
//
// Both return null when within budget, or a small report object describing
// which limit tripped — callers turn that into a graceful halt: keep the
// best-known state, log clearly, and stop instead of erroring mid-flight.
//
// LIMITS (all optional, null/undefined/0 = unlimited):
//   config.maxRunTokens    — total tokens (in + out) across the whole project
//   config.maxRunCostUsd   — estimated USD across the whole project
//   config.maxStageMinutes — wall-clock minutes since THIS stage started
//                            (docs/reliability.md R3). The guard is created
//                            per stage-run and inherited by every nested
//                            reflow chain, so one clock bounds the whole
//                            tree — the measured runaway (140 regens in one
//                            judge stage over 3+ hours) is exactly what this
//                            brakes. Default ON (20 min) in the GUI/CLI
//                            configs; time is the resource local runs
//                            actually spend, where token/cost ceilings never
//                            trip. Tripping is graceful: loops stop and keep
//                            the best-known state — never an error.
//
// Cost estimation reuses llm/cost.js rates. Local providers (ollama,
// lmstudio) cost $0, so a cost ceiling never trips for them — the time
// ceiling is the local brake.
// ═══════════════════════════════════════════════════════════════════════════

import { estimateCost } from "../llm/cost.js";

function numOrNull(v) {
  return (typeof v === "number" && isFinite(v) && v > 0) ? v : null;
}

/**
 * @param {object} config  needs maxRunTokens / maxRunCostUsd /
 *                         maxStageMinutes (all optional)
 * @param {Array}  ledger  reducer ledger entries ({tIn, tOut, cost, …});
 *                         the project's spend BEFORE the current stage
 * @param {object} [opts]  { now, signal } — injectable clock/signal for tests
 * @returns {{enabled: boolean, exceeded: function, overWith: function,
 *            limits: {tokens: number|null, costUsd: number|null,
 *                     stageMinutes: number|null, calls: number|null}}}
 */
export function createBudgetGuard(config, ledger, opts) {
  const maxTokens = numOrNull(config && config.maxRunTokens);
  const maxCost = numOrNull(config && config.maxRunCostUsd);
  const maxMinutes = numOrNull(config && config.maxStageMinutes);
  // This is a per-stage ceiling shared by all nested reflows. It bounds the
  // complete repair tree instead of resetting at every nested node.
  const maxCalls = numOrNull(config && config.maxStageCalls);
  const now = (opts && opts.now) || Date.now;
  const startMs = now();   // guard is created at stage start (runStage)
  const parentSignal = opts && opts.signal;
  let callCount = 0;
  let controller = null;
  let deadlineTimer = null;
  let parentAbortListener = null;
  if (typeof AbortController !== "undefined") {
    controller = new AbortController();
    if (parentSignal) {
      const forwardAbort = function() {
        try { controller.abort(parentSignal.reason); } catch (_) { controller.abort(); }
      };
      parentAbortListener = forwardAbort;
      if (parentSignal.aborted) forwardAbort();
      else if (typeof parentSignal.addEventListener === "function") {
        parentSignal.addEventListener("abort", forwardAbort, { once: true });
      }
    }
    if (maxMinutes != null) {
      const delay = Math.max(0, maxMinutes * 60000 - (now() - startMs));
      deadlineTimer = setTimeout(function() {
        try { controller.abort(new Error("stage time budget exhausted")); } catch (_) { controller.abort(); }
      }, delay);
      if (deadlineTimer && typeof deadlineTimer.unref === "function") deadlineTimer.unref();
    }
  }

  // Snapshot the cumulative project spend once. Ledger entries are appended
  // per stage by runStage, so this is "everything before the current stage".
  let baseTokens = 0;
  let baseCost = 0;
  for (const e of (ledger || [])) {
    if (!e) continue;
    baseTokens += (e.tIn || 0) + (e.tOut || 0);
    baseCost += (e.cost || 0);
  }

  /**
   * @param {Array} extraLlms  a node's own _llms-style call records
   *                           ({tokensIn, tokensOut, provider}) made since
   *                           the ledger snapshot
   * @returns {null | {reason, spentTokens, spentCostUsd,
   *                   limitTokens, limitCostUsd, message}}
   */
  function evaluate(extraLlms, checkTime) {
    if (maxTokens == null && maxCost == null && maxMinutes == null && maxCalls == null) return null; // unlimited
    let tokens = baseTokens;
    let cost = baseCost;
    for (const r of (extraLlms || [])) {
      if (!r) continue;
      tokens += (r.tokensIn || 0) + (r.tokensOut || 0);
      cost += estimateCost(r.tokensIn || 0, r.tokensOut || 0, r.provider);
    }
    const elapsedMin = (now() - startMs) / 60000;
    const observedCalls = Math.max(callCount, (extraLlms || []).filter(Boolean).length);
    const report = function(reason) {
      return {
        reason: reason,
        spentTokens: tokens,
        spentCostUsd: Math.round(cost * 10000) / 10000,
        spentMinutes: Math.round(elapsedMin * 10) / 10,
        limitTokens: maxTokens,
        limitCostUsd: maxCost,
        limitStageMinutes: maxMinutes,
        calls: observedCalls,
        limitCalls: maxCalls,
        message: reason === "tokens"
          ? "Run token budget exhausted: " + tokens.toLocaleString()
            + " of " + maxTokens.toLocaleString() + " tokens used. "
            + "Raise maxRunTokens (Settings → LLM / `rtlforge config set maxRunTokens N`) "
            + "or resume the project to continue."
          : reason === "cost"
          ? "Run cost budget exhausted: $" + (Math.round(cost * 100) / 100)
            + " of $" + maxCost + " estimated. "
            + "Raise maxRunCostUsd or resume the project to continue."
          : reason === "calls"
          ? "Stage model-call budget exhausted: " + observedCalls
            + " of " + maxCalls + " calls used across this stage and its nested reflows. "
            + "Raise maxStageCalls or resume the project to continue."
          : "Stage time budget exhausted: " + (Math.round(elapsedMin * 10) / 10)
            + " of " + maxMinutes + " minutes on this stage. "
            + "The best-known result so far is kept. Raise maxStageMinutes "
            + "(Settings → Workflow / `rtlforge config set maxStageMinutes N`, 0 = unlimited) "
            + "to allow longer convergence.",
      };
    };
    if (maxTokens != null && tokens >= maxTokens) return report("tokens");
    if (maxCost != null && cost >= maxCost) return report("cost");
    if (maxCalls != null && observedCalls >= maxCalls) return report("calls");
    // Time is an IN-STAGE brake only (checkTime): the stage-boundary gate must
    // not refuse to START a fresh stage over the previous stage's clock — each
    // guard is created at its own stage's start, so exceeded() sees ~0 elapsed
    // anyway; the flag makes the contract explicit.
    if (checkTime && maxMinutes != null && elapsedMin >= maxMinutes) return report("time");
    return null;
  }

  return {
    /** False when no limit is configured — callers can skip checks cheaply. */
    enabled: maxTokens != null || maxCost != null || maxMinutes != null || maxCalls != null,
    limits: { tokens: maxTokens, costUsd: maxCost, stageMinutes: maxMinutes, calls: maxCalls },
    signal: controller ? controller.signal : (parentSignal || null),
    remainingMs() {
      return maxMinutes == null ? Infinity : Math.max(0, maxMinutes * 60000 - (now() - startMs));
    },
    deadlineExceeded() {
      return maxMinutes != null && (now() - startMs) / 60000 >= maxMinutes;
    },
    /** Reserve one actual provider request, including retries. */
    beforeCall() {
      const over = evaluate([], true);
      if (over) {
        const e = new Error(over.message);
        e.name = "BudgetExceededError";
        e.budgetExceeded = true;
        e.budget = over;
        throw e;
      }
      callCount++;
      return callCount;
    },
    /** Release a provisional reservation when a replay hook declines. */
    releaseCall() {
      if (callCount > 0) callCount--;
    },
    calls() { return callCount; },
    dispose() {
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
      if (parentSignal && parentAbortListener
          && typeof parentSignal.removeEventListener === "function") {
        parentSignal.removeEventListener("abort", parentAbortListener);
      }
      parentAbortListener = null;
    },
    /** Stage-boundary gate: project spend alone (never time — see evaluate). */
    exceeded() {
      return evaluate([], false);
    },
    /** In-stage gate: project spend + the node's own calls + stage wall-clock. */
    overWith(extraLlms) {
      return evaluate(extraLlms, true);
    },
  };
}

/**
 * Which fix-chain entries a stage skipped for budget, without calling the model.
 *
 * A stage whose fix chain was budget-halted looks IDENTICAL, in every
 * user-facing surface, to a stage whose model reviewed its own code and
 * declined to change it. The difference is the whole difference between a
 * model that cannot repair and a pipeline that never asked.
 *
 * Measured (run 52): rtl_review spent 49 minutes finding one critical and two
 * major issues — more than the 20-minute maxStageMinutes the stage had — so
 * every fix entry was recorded `budget-halted` with `llmCount: 0`. The CLI
 * printed "func-fail (needs fix) (49m 8s)" and nothing else, and the run was
 * read, by a careful reader, as the model refusing to fix its own bugs.
 *
 * The reflow runner does log this, but into the stage's own log object, which
 * no CLI user ever opens. This exposes it as data so a caller can say so.
 *
 * @param {object} stageData  one stage's result object (may carry _chain)
 * @returns {string[]} unique stage keys skipped, in first-seen order
 */
export function budgetHaltedStages(stageData) {
  const out = [];
  const seen = new Set();
  for (const it of (stageData && stageData._chain) || []) {
    for (const e of (it && it.entries) || []) {
      if (e && e.status === "budget-halted" && e.stageKey && !seen.has(e.stageKey)) {
        seen.add(e.stageKey);
        out.push(e.stageKey);
      }
    }
  }
  return out;
}
