// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// embeddings — pure vector math for semantic lesson dedup (training mode)
//
// WHY: the training saturation stop counts DISTINCT ERROR SIGNATURES
// (training.js). Signatures are exact strings, so near-duplicate lessons —
// the same mistake phrased differently by the linter, or high-cardinality
// noise from a weak model — each count as "new" and the plateau detector
// never trips (measured: lfm2.5-1.2b `train --auto` ran to the budget
// backstop on pure noise). Clustering lesson texts by embedding similarity
// collapses paraphrases to one cluster, so the count the saturation stop
// watches reflects distinct MISTAKE CLASSES, not distinct strings.
//
// Everything here is PURE and browser-safe: vectors in, numbers out. The
// embedding HTTP call lives in llm/embed.js (adapter, injected by the CLI);
// this module never fetches.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cosine similarity of two vectors. Returns 0 for anything degenerate
 * (missing vectors, length mismatch, zero norm) so callers can treat
 * "can't compare" as "not similar" without special-casing.
 */
export function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = +a[i], y = +b[i];
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0 || !isFinite(dot)) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Greedy leader clustering: walk the vectors IN ORDER; each joins the first
 * earlier leader with similarity ≥ threshold, else becomes a new leader.
 *
 * Order matters and that is deliberate: called on an append-only catalog in
 * row order, the assignment of every existing item is stable when new rows
 * are appended — the cluster count is monotonic non-decreasing, which is what
 * makes a plateau a trustworthy convergence signal (mirrors the guarantee
 * distinctSignatureCount gets from a grow-only Set).
 *
 * A degenerate vector (null / wrong shape) can never match anything
 * (cosineSim → 0), so it becomes its own singleton cluster — the same
 * behavior the exact-signature count gives an unparseable lesson.
 *
 * @param {Array<Array<number>>} vectors
 * @param {number} threshold  similarity at/above which two texts are the same lesson
 * @returns {number[]} leader index per item (leaders point at themselves)
 */
export function clusterByThreshold(vectors, threshold) {
  const vecs = Array.isArray(vectors) ? vectors : [];
  const t = typeof threshold === "number" ? threshold : 0.9;
  const leaders = [];       // indices of cluster leaders, in first-seen order
  const assign = new Array(vecs.length);
  for (let i = 0; i < vecs.length; i++) {
    let home = -1;
    for (const L of leaders) {
      if (cosineSim(vecs[i], vecs[L]) >= t) { home = L; break; }
    }
    if (home === -1) { leaders.push(i); home = i; }
    assign[i] = home;
  }
  return assign;
}

/** Number of clusters clusterByThreshold forms — the semantic distinct count. */
export function semanticDistinctCount(vectors, threshold) {
  const assign = clusterByThreshold(vectors, threshold);
  const set = new Set(assign);
  return set.size;
}

/**
 * Indices of `vectors` whose similarity to `refVec` is ≥ threshold —
 * e.g. lessons that echo the run's spec prose (a harvest-quality signal:
 * a genuine lint lesson reads like a rule, not like the design description).
 */
export function indicesAboveSim(refVec, vectors, threshold) {
  const out = [];
  const vecs = Array.isArray(vectors) ? vectors : [];
  for (let i = 0; i < vecs.length; i++) {
    if (cosineSim(refVec, vecs[i]) >= threshold) out.push(i);
  }
  return out;
}

/**
 * Indices of `vectors` ordered by similarity to `refVec`, most similar first.
 * Ties keep input order (stable). Used to rank harvested rules by relevance
 * to the current spec at injection time.
 */
export function rankBySimilarity(refVec, vectors) {
  const vecs = Array.isArray(vectors) ? vectors : [];
  const scored = vecs.map(function(v, i) { return { i: i, s: cosineSim(refVec, v) }; });
  scored.sort(function(a, b) { return b.s - a.s || a.i - b.i; });
  return scored.map(function(e) { return e.i; });
}
