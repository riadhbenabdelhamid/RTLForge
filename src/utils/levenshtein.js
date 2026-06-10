// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// levenshtein — string edit distance
// Two-row rolling implementation — O(min(a,b)) space, O(a×b) time.
// ═══════════════════════════════════════════════════════════════════════════

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  // Make `a` the shorter string for less memory
  if (a.length > b.length) {
    const tmp = a; a = b; b = tmp;
  }

  let prev = new Array(a.length + 1);
  let curr = new Array(a.length + 1);

  for (let i = 0; i <= a.length; i++) prev[i] = i;

  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1,        // deletion
        curr[i - 1] + 1,    // insertion
        prev[i - 1] + cost  // substitution
      );
    }
    const swap = prev; prev = curr; curr = swap;
  }

  return prev[a.length];
}
