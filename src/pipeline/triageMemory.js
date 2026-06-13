// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// triageMemory — cross-run learning for judge/verify triage
//
// WHY THIS EXISTS:
//
// The judge already emits a structured triage-outcome trail
// ({ failure signature → target → improved? }) and uses it for IN-RUN
// feedback (don't re-roll a lever that just failed). This module closes the
// loop ACROSS runs: persist each outcome, and before the next triage decision
// answer "in prior runs that failed THIS way, which target actually fixed
// it?" — injected into the triage prompt's evidence pack and used to bias the
// candidate order.
//
// ARCHITECTURE (consistent with the rest of the core): the logic here is
// PURE and the persistence is a pluggable ADAPTER (like storage / checkpoint
// / skillBridge). The judge consumes `st._services.triageMemory`; the runtime
// supplies an adapter (in-memory for a GUI session, a JSON file for the CLI).
// When no adapter is wired — headless runStages, the benchmark, unit tests —
// the feature simply no-ops. An adapter implements:
//
//   record({ signature, target, improved, scoreBefore, scoreAfter, ts })
//   lookup(signature) -> records[]            // matching signature only
//
// SIGNATURE: the SORTED set of failing criterion ids, score-independent on
// purpose — "verify failed + func-must failed" should match across runs even
// when the exact scores differ. Too-fine a key (including the score) would
// never match a second run and the memory would never pay off.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stable, score-independent failure key from an eval verdict.
 * @param {object} verdict  runEvalGate output ({ failingIds: [...] })
 * @returns {string} e.g. "req_func_must|verify_pass_rate", or "none"
 */
export function failureSignature(verdict) {
  const ids = (verdict && Array.isArray(verdict.failingIds)) ? verdict.failingIds : [];
  if (ids.length === 0) return "none";
  return ids.slice().sort().join("|");
}

/**
 * Per-target hit stats for one signature.
 * @param {Array} records  prior outcomes (already filtered to a signature, or
 *                        not — `signature` re-filters defensively)
 * @param {string} [signature]  when given, only records with this signature
 * @returns {Array<{target, attempts, improvements, successRate}>}
 *          sorted best-first (success rate desc, then attempts desc)
 */
export function aggregateTriageStats(records, signature) {
  const byTarget = new Map();
  for (const r of (records || [])) {
    if (!r || !r.target) continue;
    if (signature != null && r.signature !== signature) continue;
    const cur = byTarget.get(r.target) || { target: r.target, attempts: 0, improvements: 0 };
    cur.attempts += 1;
    if (r.improved) cur.improvements += 1;
    byTarget.set(r.target, cur);
  }
  const stats = Array.from(byTarget.values()).map(function(s) {
    return Object.assign({}, s, { successRate: s.attempts ? s.improvements / s.attempts : 0 });
  });
  stats.sort(function(a, b) {
    if (b.successRate !== a.successRate) return b.successRate - a.successRate;
    return b.attempts - a.attempts;
  });
  return stats;
}

/**
 * Turn stats into a triage steer.
 * @returns {{ prefer: string|null, avoid: string[] }}
 *   prefer — the target with the best POSITIVE success rate (the one history
 *            says works); null when nothing has worked.
 *   avoid  — targets tried >=2 times that NEVER improved (history says they
 *            don't fix this failure).
 */
export function recommendFromStats(stats) {
  const s = stats || [];
  const prefer = s.find(function(x) { return x.successRate > 0; });
  const avoid = s.filter(function(x) { return x.attempts >= 2 && x.improvements === 0; })
    .map(function(x) { return x.target; });
  return { prefer: prefer ? prefer.target : null, avoid: avoid };
}

/** One-line-per-target evidence string for the triage prompt. "" when empty. */
export function formatTriageEvidence(stats) {
  const s = stats || [];
  if (s.length === 0) return "";
  return s.map(function(x) {
    return "- " + x.target + ": fixed " + x.improvements + "/" + x.attempts
      + " prior run(s) with this failure (" + Math.round(x.successRate * 100) + "%)";
  }).join("\n");
}

// ─── adapters ────────────────────────────────────────────────────────────────

/** In-memory adapter — a GUI session, the benchmark, or tests. */
export function createInMemoryTriageMemory(seed) {
  const rows = Array.isArray(seed) ? seed.slice() : [];
  return {
    record(rec) { if (rec && rec.signature && rec.target) rows.push(Object.assign({ ts: Date.now() }, rec)); },
    lookup(signature) { return rows.filter(function(r) { return r.signature === signature; }); },
    all() { return rows.slice(); },
  };
}

/**
 * JSON-file adapter — real cross-run learning for the CLI. Loads on construct,
 * appends + rewrites on record, capped to the most recent `maxRows` (default
 * 2000) so the file can't grow without bound.
 *
 * `opts.fs` (node:fs or a mock) is REQUIRED and injected by the caller — this
 * module is in the pipeline barrel the browser bundles, so it must never
 * top-level-import a node builtin. The terminal passes node:fs; the browser
 * uses createInMemoryTriageMemory and never calls this.
 */
export function createFileTriageMemory(path, opts) {
  const o = opts || {};
  const fs = o.fs;
  if (!fs) throw new Error("createFileTriageMemory: opts.fs (node:fs) is required");
  const maxRows = o.maxRows || 2000;
  let rows = [];
  try {
    if (fs.existsSync(path)) {
      const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) rows = parsed;
    }
  } catch (_e) { rows = []; /* corrupt/missing → start fresh */ }

  function persist() {
    try { fs.writeFileSync(path, JSON.stringify(rows.slice(-maxRows))); }
    catch (_e) { /* best-effort; learning is advisory, never fatal */ }
  }
  return {
    record(rec) {
      if (!rec || !rec.signature || !rec.target) return;
      rows.push(Object.assign({ ts: Date.now() }, rec));
      if (rows.length > maxRows) rows = rows.slice(-maxRows);
      persist();
    },
    lookup(signature) { return rows.filter(function(r) { return r.signature === signature; }); },
    all() { return rows.slice(); },
  };
}
