// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// fixLoopHelpers — Small reusable primitives for the iterative fix loops
// in lint/verify/judge nodes.
//
// The fix loops share structural patterns but their bodies diverge enough that
// a fully generic loop would be more complex than the code it replaces. These
// are the pieces that are genuinely reusable with no parameterization cost:
//
//   createStagnationDetector(maxRepeats)
//     → tracks consecutive identical outcome signatures and signals
//       when to break the loop.
//
//   createBestKnownTracker(compareFn)
//     → records state snapshots with a comparable score; at the end of
//       the loop, callers can ask for the best-known entry to restore
//       from if the final iteration wasn't the best.
//
//   tagFixes(fixes, iter)
//     → normalises an LLM `fixes` array into { ..., _iter } objects so the
//       UI fix-list can show which iteration produced each fix.
//
//   createCodeChurnTracker(opts)
//     → remembers every candidate a fix loop has already tried and flags
//       new candidates that exactly repeat (oscillation, A→B→A) or
//       near-repeat (cosmetic churn) an earlier attempt — the outcome of
//       such a candidate is already known, so re-validating it wastes a
//       CLI run and the loop cannot progress.
//
// These are plain factories/functions with no shared state and no global side
// effects. Safe to instantiate inside each node call.
// ═══════════════════════════════════════════════════════════════════════════

import { levenshtein } from "../utils/levenshtein.js";

/**
 * Stagnation detector: tracks consecutive identical outcome signatures and
 * signals when to break out of a fix loop that isn't making progress.
 *
 * Usage:
 *   const stag = createStagnationDetector(2);
 *   for (let iter = 1; iter <= maxIters; iter++) {
 *     // ... do work ...
 *     const sig = "score=" + score + "|errors=" + errs;
 *     if (stag.check(sig)) {
 *       // Same sig repeated N times in a row — break out.
 *       break;
 *     }
 *   }
 *   if (stag.stagnated()) console.log("stopped due to stagnation");
 *
 * @param {number} [maxRepeats=2]  How many consecutive identical signatures
 *                                 trigger stagnation. The default of 2 means
 *                                 "after the signature repeats twice in a row,
 *                                 stop".
 */
export function createStagnationDetector(maxRepeats) {
  const limit = maxRepeats == null ? 2 : maxRepeats;
  let lastSig = null;
  let count = 0;
  let stagnatedFlag = false;

  return {
    /**
     * Record a new outcome signature and return true if stagnation is detected.
     * Resets the counter if the signature changed since last call.
     */
    check(sig) {
      if (sig === lastSig) {
        count++;
        if (count >= limit) {
          stagnatedFlag = true;
          return true;
        }
      } else {
        count = 0;
      }
      lastSig = sig;
      return false;
    },

    /** Whether stagnation was ever triggered during this session. */
    stagnated() {
      return stagnatedFlag;
    },

    /** Current consecutive-repeat count (useful for logging). */
    count() {
      return count;
    },

    /** Reset state so the detector can be reused. */
    reset() {
      lastSig = null;
      count = 0;
      stagnatedFlag = false;
    },
  };
}

/**
 * Code-churn tracker: remembers every candidate a fix loop has tried and
 * flags candidates whose outcome is already known.
 *
 * Why the plain `candidate === base` integrity check isn't enough:
 *   - OSCILLATION: the model produces A, then B, then A again. Each step
 *     differs from the current base, so identity checks pass — but A was
 *     already validated and found wanting. Re-validating burns a CLI run
 *     per cycle and the loop can ping-pong until maxIters.
 *   - COSMETIC CHURN: the model re-emits an earlier attempt with shuffled
 *     whitespace or a new comment. Behaviourally the same candidate, same
 *     wasted validation.
 *
 * What this deliberately does NOT flag: a SMALL DIFF against the current
 * base. The fix prompts demand minimal diffs, so a 1-character change is
 * often a correct fix — smallness is a virtue, not churn. Only similarity
 * to a PREVIOUSLY TRIED candidate is suspicious, because that candidate's
 * outcome is already on record.
 *
 * Comparison is whitespace-insensitive (candidates are normalised by
 * collapsing runs of whitespace). In principle two candidates could differ
 * only inside a string literal's spacing and be wrongly flagged — accepted:
 * the harm is bounded (an early stagnation break after two hits) and such
 * candidates are practically always genuine churn.
 *
 * Usage (inside a fix loop):
 *   const churn = createCodeChurnTracker();
 *   churn.record(originalCode, 0);                  // seed with the baseline
 *   ...
 *   const verdict = churn.assess(candidateCode);
 *   if (verdict.verdict !== "new") { count it as stagnation; skip recheck; }
 *   else churn.record(candidateCode, iter);
 *
 * @param {object} [opts]
 * @param {number} [opts.nearThreshold=0.02]    flag as near-repeat when the
 *        normalised levenshtein distance is ≤ 2% of the longer string
 * @param {number} [opts.maxCompareLength=20000] skip the O(n·m) levenshtein
 *        for very large sources (exact-repeat detection still applies)
 */
export function createCodeChurnTracker(opts) {
  const o = opts || {};
  const nearThreshold = o.nearThreshold == null ? 0.02 : o.nearThreshold;
  const maxCompareLength = o.maxCompareLength == null ? 20000 : o.maxCompareLength;
  const history = []; // [{ normalized, iter }] in record order

  function normalize(code) {
    return String(code || "").replace(/\s+/g, " ").trim();
  }

  return {
    /** Remember a candidate that is about to be (or was) validated. */
    record(code, iter) {
      history.push({ normalized: normalize(code), iter: iter });
    },

    /**
     * Compare a new candidate against everything tried so far.
     * @returns {{verdict: "new"|"repeat"|"near-repeat",
     *            matchedIter: number|null, similarity: number}}
     */
    assess(code) {
      const cand = normalize(code);
      // Exact (whitespace-insensitive) repeat — scan newest-first so the
      // reported matchedIter is the most recent occurrence.
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].normalized === cand) {
          return { verdict: "repeat", matchedIter: history[i].iter, similarity: 1 };
        }
      }
      // Near-repeat via levenshtein, guarded by two cheap pre-filters:
      // total size (cost cap) and length delta (a distance lower bound —
      // strings whose lengths differ by more than the threshold can't be
      // within it).
      if (cand.length > 0 && cand.length <= maxCompareLength) {
        for (let i = history.length - 1; i >= 0; i--) {
          const h = history[i].normalized;
          if (h.length === 0 || h.length > maxCompareLength) continue;
          const maxLen = Math.max(cand.length, h.length);
          if (Math.abs(cand.length - h.length) / maxLen > nearThreshold) continue;
          const d = levenshtein(cand, h);
          if (d / maxLen <= nearThreshold) {
            return {
              verdict: "near-repeat",
              matchedIter: history[i].iter,
              similarity: 1 - d / maxLen,
            };
          }
        }
      }
      return { verdict: "new", matchedIter: null, similarity: 0 };
    },

    /** Number of recorded candidates (useful for logging/tests). */
    size() {
      return history.length;
    },
  };
}

/**
 * Best-known state tracker: records (state, score) snapshots during a fix
 * loop and lets callers restore the best-known entry at the end if the
 * final iteration wasn't the best.
 *
 * The comparison function takes two scores and returns true if the LEFT
 * score is strictly better than the RIGHT score. Defaults to numeric
 * "higher is better" — pass `(a, b) => a < b` for "lower is better"
 * (e.g. lint's issue-count tracking).
 *
 * Usage:
 *   const tracker = createBestKnownTracker();                     // higher is better
 *   const tracker = createBestKnownTracker((a, b) => a < b);      // lower is better
 *
 *   for (let iter = 1; iter <= maxIters; iter++) {
 *     // ... compute currentScore ...
 *     tracker.record({ code: finalCode }, currentScore);
 *   }
 *   const best = tracker.best();   // { state, score } | null
 *   if (best && best.state !== finalState) finalState = best.state;
 *
 * @param {(a: number, b: number) => boolean} [isBetter]  Comparator; default numeric >
 */
export function createBestKnownTracker(isBetter) {
  const cmp = isBetter || function(a, b) { return a > b; };
  let bestState = null;
  let bestScore = null;

  return {
    /**
     * Record a new snapshot. Replaces the best-known entry if the new score
     * is strictly better per the comparator.
     */
    record(state, score) {
      if (bestState === null || cmp(score, bestScore)) {
        bestState = state;
        bestScore = score;
      }
    },

    /** Get the best-known entry, or null if nothing was recorded. */
    best() {
      if (bestState === null) return null;
      return { state: bestState, score: bestScore };
    },

    /** Reset state so the tracker can be reused. */
    reset() {
      bestState = null;
      bestScore = null;
    },
  };
}

/**
 * Normalise an LLM-returned `fixes` array into a list of objects tagged with
 * the iteration that produced them. String entries become { _text, _iter };
 * object entries are shallow-cloned with `_iter` attached. A non-array input
 * (including the null returned on the chain path) yields an empty array.
 *
 * @param {*}      fixes  The raw `fixes` value from an extracted fix payload.
 * @param {number} iter   The fix-loop iteration that produced these fixes.
 * @returns {Array<object>}
 */
export function tagFixes(fixes, iter) {
  if (!Array.isArray(fixes)) return [];
  return fixes.map(function(f) {
    if (typeof f === "string") return { _text: f, _iter: iter };
    if (f && typeof f === "object") return Object.assign({}, f, { _iter: iter });
    return { _text: String(f), _iter: iter };
  });
}
