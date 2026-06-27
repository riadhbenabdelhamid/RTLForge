// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// bestOfN — Best-of-N cold generation with deterministic, compile-ranked
// selection (#17). Pure core + injected adapters (mirrors triageMemory /
// errorsToAvoid): nothing here calls an LLM or a CLI. The generate/lint
// side-effects are passed in, so the whole selection policy is unit-testable.
//
// See docs/best-of-n.md for the design and the two historical bugs this fixes
// by construction (no diversity under greedy decoding; uncounted generation
// cost via the StateGraph shallow-merge clobbering rtl_generate._llms).
// ═══════════════════════════════════════════════════════════════════════════

// Ordered ranking criteria. First discriminating criterion wins; ties break by
// lower candidate index (the greedy baseline / earliest draw). `compiles` means
// "elaborates" for RTL (module alone) and "integrates" for TB (TB+RTL together)
// — the difference is in WHAT the node lints, not in the ranking keys.
export const RANK_CRITERIA = ["compiles", "errors", "warnings"];

// Hard caps so a misconfigured value can never explode cost / sampling.
const MAX_N = 8;
const MAX_TEMP = 2;
const DEFAULT_TEMP = 0.7;

/** Resolve the candidate count from config. Default 1 (feature off). */
export function resolveBestOfN(config) {
  const raw = config && config.bestOfN;
  if (raw == null) return 1;
  const k = Math.floor(Number(raw));
  if (!Number.isFinite(k) || k < 1) return 1;
  return Math.min(k, MAX_N);
}

/** Resolve the exploration temperature for candidates 1..N-1. Default 0.7. */
export function resolveBestOfNTemp(config) {
  const raw = config && config.bestOfNTemp;
  if (raw == null) return DEFAULT_TEMP;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return DEFAULT_TEMP;
  return Math.min(v, MAX_TEMP);
}

/**
 * Per-candidate sampling config. Candidate 0 is the GREEDY BASELINE — returns
 * baseCfg unchanged, so the deterministic draw is always in the pool and
 * selection can never do worse than best-of-1. Candidates 1..N-1 explore at
 * `temp`, with a per-candidate seed offset on seeded backends (only when the
 * base config already pins a seed — we don't inject a seed where the user
 * deliberately left provider-default sampling).
 */
export function diversityConfig(baseCfg, i, temp) {
  const base = baseCfg || {};
  if (!(i >= 1)) return base;
  const c = Object.assign({}, base);
  c.temperature = (temp == null) ? DEFAULT_TEMP : temp;
  if (base.seed != null) c.seed = base.seed + i;
  return c;
}

/**
 * Summarise a parsed Verilator result into the comparable shape rankCandidates
 * consumes. Pure — the node pre-parses CLI stderr into error/warning arrays.
 * @param {{exitCode:number, errors:Array, warnings:Array}|null} r
 * @returns {{compiles:boolean, errors:number, warnings:number}|null}
 */
export function summarizeLint(r) {
  if (!r || r.exitCode === undefined || r.exitCode === null) return null;
  const errors = Array.isArray(r.errors) ? r.errors.length : (r.errors | 0);
  const warnings = Array.isArray(r.warnings) ? r.warnings.length : (r.warnings | 0);
  return { compiles: r.exitCode === 0 && errors === 0, errors: errors, warnings: warnings };
}

// Extract a comparable scalar for one criterion. A candidate with no lint
// (couldn't be evaluated) ranks worst on every axis.
function critValue(cand, key) {
  const l = cand && cand.lint;
  if (!l) return key === "compiles" ? 0 : Infinity;
  if (key === "compiles") return l.compiles ? 1 : 0;
  if (key === "errors") return l.errors;
  if (key === "warnings") return l.warnings;
  return 0;
}

// Negative ⇒ a is better, positive ⇒ b is better, 0 ⇒ tie on this criterion.
function critCompare(a, b, key) {
  const va = critValue(a, key);
  const vb = critValue(b, key);
  if (key === "compiles") return vb - va; // higher (compiles) is better
  return va - vb;                          // fewer errors/warnings is better
}

/**
 * Deterministically rank candidates by the ordered criteria, ties broken by
 * lower index. Returns the winner plus the full ranked order (for the trace).
 * @param {Array<{index:number, lint:object|null}>} candidates
 * @param {string[]} [criteria]
 */
export function rankCandidates(candidates, criteria) {
  const crit = criteria && criteria.length ? criteria : RANK_CRITERIA;
  const list = (candidates || []).slice();
  list.sort(function (a, b) {
    for (let k = 0; k < crit.length; k++) {
      const c = critCompare(a, b, crit[k]);
      if (c !== 0) return c;
    }
    // Stable tiebreak: earliest candidate (the greedy baseline) wins.
    return (a.index | 0) - (b.index | 0);
  });
  return { winner: list[0] || null, ranked: list };
}

/**
 * Orchestrate N candidate generations + lints and pick the winner. Pure of LLM
 * and CLI — the effects are injected:
 *
 * @param {object} args
 * @param {number} args.n                          candidate count (>=1)
 * @param {(i:number)=>object} args.makeConfig     per-candidate sampling config
 * @param {(cfg:object,i:number)=>Promise<{code:string, llms:Array}>} args.generate
 * @param {(code:string,i:number)=>Promise<object|null>} args.lintCode  lint summary
 * @param {string[]} [args.criteria]
 * @param {(rec:object)=>void} [args.onCandidate]  per-candidate observer (logging)
 * @param {(i:number)=>boolean} [args.shouldContinue]  budget gate before draw i>=1
 * @returns {Promise<{winner:object, ranked:Array, candidates:Array}>}
 */
export async function runBestOfN(args) {
  const n = Math.max(1, args.n | 0);
  const candidates = [];
  let lastErr = null;

  for (let i = 0; i < n; i++) {
    // Budget gate: only blocks ADDITIONAL candidates; the baseline always runs.
    if (i >= 1 && typeof args.shouldContinue === "function" && !args.shouldContinue(i)) {
      break;
    }
    let gen;
    try {
      gen = await args.generate(args.makeConfig(i), i);
    } catch (e) {
      lastErr = e;
      // The baseline failing means the stage genuinely could not generate.
      if (i === 0) throw e;
      // A later candidate failing is non-fatal — skip this draw.
      if (typeof args.onCandidate === "function") {
        args.onCandidate({ index: i, error: String((e && e.message) || e), lint: null });
      }
      continue;
    }
    let lint = null;
    try {
      lint = await args.lintCode(gen.code, i);
    } catch (e) {
      // A lint adapter that throws (e.g. strict-CLI backend error) must not be
      // swallowed — it is a real infrastructure failure the node surfaces.
      throw e;
    }
    const rec = { index: i, code: gen.code, llms: gen.llms || [], lint: lint };
    candidates.push(rec);
    if (typeof args.onCandidate === "function") args.onCandidate(rec);
  }

  if (candidates.length === 0) {
    // Every candidate threw (only reachable when n>=2 and even the baseline
    // was retried away — defensive). Rethrow the last error.
    throw lastErr || new Error("runBestOfN: no candidate generated");
  }

  const ranked = rankCandidates(candidates, args.criteria);
  return { winner: ranked.winner, ranked: ranked.ranked, candidates: candidates };
}

/**
 * Build the compact `_bestOfN` trace metadata attached to the stage result.
 * @param {object} result  the runBestOfN return value
 */
export function bestOfNMeta(result) {
  const ranked = (result && result.ranked) || [];
  return {
    n: (result && result.candidates && result.candidates.length) || 0,
    winner: (result && result.winner && result.winner.index) || 0,
    ranking: ranked.map(function (c) {
      const l = c.lint || {};
      return {
        index: c.index,
        compiles: l.compiles === undefined ? null : !!l.compiles,
        errors: l.errors == null ? null : l.errors,
        warnings: l.warnings == null ? null : l.warnings,
      };
    }),
  };
}
