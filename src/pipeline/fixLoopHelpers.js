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
// These are plain factories/functions with no shared state and no global side
// effects. Safe to instantiate inside each node call.
// ═══════════════════════════════════════════════════════════════════════════

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
