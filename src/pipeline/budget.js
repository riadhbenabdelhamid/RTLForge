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
// LIMITS (both optional, null/undefined = unlimited):
//   config.maxRunTokens   — total tokens (in + out) across the whole project
//   config.maxRunCostUsd  — estimated USD across the whole project
//
// Cost estimation reuses llm/cost.js rates. Local providers (ollama,
// lmstudio) cost $0, so a cost ceiling never trips for them — use the token
// ceiling to bound local runs (time, not money, is the resource there).
// ═══════════════════════════════════════════════════════════════════════════

import { estimateCost } from "../llm/cost.js";

function numOrNull(v) {
  return (typeof v === "number" && isFinite(v) && v > 0) ? v : null;
}

/**
 * @param {object} config  needs maxRunTokens / maxRunCostUsd (both optional)
 * @param {Array}  ledger  reducer ledger entries ({tIn, tOut, cost, …});
 *                         the project's spend BEFORE the current stage
 * @returns {{enabled: boolean, exceeded: function, overWith: function,
 *            limits: {tokens: number|null, costUsd: number|null}}}
 */
export function createBudgetGuard(config, ledger) {
  const maxTokens = numOrNull(config && config.maxRunTokens);
  const maxCost = numOrNull(config && config.maxRunCostUsd);

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
  function evaluate(extraLlms) {
    if (maxTokens == null && maxCost == null) return null; // unlimited
    let tokens = baseTokens;
    let cost = baseCost;
    for (const r of (extraLlms || [])) {
      if (!r) continue;
      tokens += (r.tokensIn || 0) + (r.tokensOut || 0);
      cost += estimateCost(r.tokensIn || 0, r.tokensOut || 0, r.provider);
    }
    const report = function(reason) {
      return {
        reason: reason,
        spentTokens: tokens,
        spentCostUsd: Math.round(cost * 10000) / 10000,
        limitTokens: maxTokens,
        limitCostUsd: maxCost,
        message: reason === "tokens"
          ? "Run token budget exhausted: " + tokens.toLocaleString()
            + " of " + maxTokens.toLocaleString() + " tokens used. "
            + "Raise maxRunTokens (Settings → LLM / `rtlforge config set maxRunTokens N`) "
            + "or resume the project to continue."
          : "Run cost budget exhausted: $" + (Math.round(cost * 100) / 100)
            + " of $" + maxCost + " estimated. "
            + "Raise maxRunCostUsd or resume the project to continue.",
      };
    };
    if (maxTokens != null && tokens >= maxTokens) return report("tokens");
    if (maxCost != null && cost >= maxCost) return report("cost");
    return null;
  }

  return {
    /** False when no limit is configured — callers can skip checks cheaply. */
    enabled: maxTokens != null || maxCost != null,
    limits: { tokens: maxTokens, costUsd: maxCost },
    /** Stage-boundary gate: project spend alone. */
    exceeded() {
      return evaluate([]);
    },
    /** In-stage gate: project spend + the node's own calls so far. */
    overWith(extraLlms) {
      return evaluate(extraLlms);
    },
  };
}
