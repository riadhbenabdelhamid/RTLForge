// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// telemetryCarry — append-only semantics for per-stage telemetry ledgers
//
// `_llms` (LLM call records) and `_iterations` (review/fix iteration ledgers)
// are HISTORY, not values: replacing them erases the evidence a later audit
// needs. Run 37 lost RTL Review's timing to a judge-driven re-entry (fixed at
// the StateGraph layer, 84d8579); run 39 then lost the top-level Test
// Review's ENTIRE 59-minute record — _llms and _iterations both — to an
// inner-chain re-entry that reached the store through a different path, which
// made the first autopsy of that run wrong. The static hunt for that writer
// came up empty, which is itself the argument for enforcing the invariant at
// the one funnel every write passes through (the reducer) rather than at
// whichever callers we know about today.
//
// Carried entries are SLIMMED (timing/token/identity fields only — never
// prompts, completions, or code bodies, which is what would balloon a
// checkpoint), tagged `_prior`, DEDUPED against the incoming array so the
// StateGraph-layer carry and the reducer-layer carry compose without
// duplication, and capped. The incoming (current) entries are never touched.
// ═══════════════════════════════════════════════════════════════════════════

export const PRIOR_LLM_CAP = 24;
export const PRIOR_ITER_CAP = 12;

// Identity for dedup: a record carried through BOTH layers (StateGraph then
// reducer) matches on all three fields; two genuinely different calls do not.
const llmKey = (c) => (c && (String(c.stage || "") + "|" + String(c.startedAtMs || "") + "|" + String(c.latencyMs || ""))) || "";

/** Slim an LLM call record to its audit fields. Idempotent on _prior entries. */
export function slimLlm(c) {
  if (!c || typeof c !== "object" || c._prior) return c;
  return {
    stage: c.stage, model: c.model, provider: c.provider,
    tokensIn: c.tokensIn, tokensOut: c.tokensOut,
    latencyMs: c.latencyMs, ttft: c.ttft,
    startedAtMs: c.startedAtMs, endedAtMs: c.endedAtMs,
    stopReason: c.stopReason, maxTokensRequested: c.maxTokensRequested,
    _prior: true,
  };
}

/** Prior _llms carried ahead of the incoming ones: slimmed, deduped, capped. */
export function carryLlms(prior, next) {
  if (!Array.isArray(prior) || prior.length === 0) return next;
  const seen = new Set((Array.isArray(next) ? next : []).map(llmKey));
  const carried = prior
    .filter((c) => !seen.has(llmKey(c)))
    .map(slimLlm);
  return carried.slice(-PRIOR_LLM_CAP).concat(Array.isArray(next) ? next : []);
}

/** Slim an iteration ledger entry: keep the verdict trail, drop code bodies. */
export function slimIteration(it) {
  if (!it || typeof it !== "object" || it._prior) return it;
  const st = it._structured;
  return Object.assign({}, it, {
    _prior: true,
    _structured: st && typeof st === "object"
      ? {
          kind: st.kind, fixOutcome: st.fixOutcome, parseOk: st.parseOk,
          chainMode: st.chainMode,
          // Code bodies dropped; lengths kept so a size-delta audit survives.
          beforeCodeLen: typeof st.beforeCode === "string" ? st.beforeCode.length : undefined,
          afterCodeLen: typeof st.afterCode === "string" ? st.afterCode.length : undefined,
        }
      : st,
  });
}

const iterKey = (it) => it && typeof it === "object"
  ? [it.iter, it.score, it.issueCount, (it._structured || {}).kind].join("|")
  : "";

/** Prior _iterations carried ahead of the incoming ones. */
export function carryIterations(prior, next) {
  if (!Array.isArray(prior) || prior.length === 0) return next;
  const seen = new Set((Array.isArray(next) ? next : []).map(iterKey));
  const carried = prior
    .filter((it) => !seen.has(iterKey(it)))
    .map(slimIteration);
  return carried.slice(-PRIOR_ITER_CAP).concat(Array.isArray(next) ? next : []);
}

/**
 * Apply carry semantics to a slot replacement/merge: whenever BOTH the
 * previous slot value and the incoming data carry one of the ledger arrays,
 * the result keeps the prior entries ahead of the new ones. Returns the
 * (possibly patched) incoming data; never mutates its input.
 */
export function withCarriedTelemetry(prev, data) {
  if (!prev || typeof prev !== "object" || !data || typeof data !== "object") return data;
  let out = data;
  if (Array.isArray(prev._llms) && Array.isArray(data._llms)) {
    out = Object.assign({}, out, { _llms: carryLlms(prev._llms, data._llms) });
  }
  if (Array.isArray(prev._iterations) && Array.isArray(data._iterations)) {
    out = Object.assign({}, out, { _iterations: carryIterations(prev._iterations, data._iterations) });
  }
  return out;
}
