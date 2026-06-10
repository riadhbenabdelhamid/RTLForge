// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// utils/diff — Line-level LCS diff
//
// Produces vdiff-style segments suitable for a side-by-side or unified view.
// No external dependency: pulling a diff library (jsdiff, fast-myers-diff)
// would add ~10-30kb to the bundle for what is a focused, ~80-line LCS
// implementation.
//
// Output format:
//   [{type: "equal" | "del" | "add", left: number|null, right: number|null,
//     content: string }]
// where `left`/`right` are 1-based line numbers in the before/after files
// (null if the segment doesn't exist on that side).
//
// Algorithm: standard Longest Common Subsequence with backtrace. O(N*M)
// time and space — fine for files up to ~5000 lines, which is well above
// what RTL Forge produces in practice.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute the LCS length matrix for two arrays of lines.
 *
 * @param {string[]} a  Lines of the "before" file.
 * @param {string[]} b  Lines of the "after" file.
 * @returns {number[][]} (N+1) x (M+1) matrix of LCS lengths.
 */
function _lcsMatrix(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    dp[i] = new Array(m + 1).fill(0);
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

/**
 * Backtrace the LCS matrix to produce diff segments.
 *
 * @param {string[]} a   Before lines.
 * @param {string[]} b   After lines.
 * @param {number[][]} dp  LCS matrix from _lcsMatrix.
 * @returns {Array<{type: string, left: number|null, right: number|null, content: string}>}
 */
function _backtrace(a, b, dp) {
  const segments = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      segments.push({ type: "equal", left: i, right: j, content: a[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      segments.push({ type: "del", left: i, right: null, content: a[i - 1] });
      i--;
    } else {
      segments.push({ type: "add", left: null, right: j, content: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    segments.push({ type: "del", left: i, right: null, content: a[i - 1] });
    i--;
  }
  while (j > 0) {
    segments.push({ type: "add", left: null, right: j, content: b[j - 1] });
    j--;
  }
  return segments.reverse();
}

/**
 * Diff two text blobs as line sequences.
 *
 * @param {string} before  The "before" file content.
 * @param {string} after   The "after" file content.
 * @returns {Array<{type: string, left: number|null, right: number|null, content: string}>}
 *   A flat list of segments. `type` is "equal", "del", or "add". `left` is
 *   the 1-based line in `before` (null for "add"), `right` is the 1-based
 *   line in `after` (null for "del").
 *
 *   Empty inputs are handled cleanly:
 *     diffLines("", "")    → []
 *     diffLines("a", "")   → [{type:"del", left:1, right:null, content:"a"}]
 *     diffLines("", "a")   → [{type:"add", left:null, right:1, content:"a"}]
 *
 *   Trailing newlines are NOT collapsed — "a\n" produces ["a", ""] as lines.
 *   Callers that want to ignore trailing-newline differences should normalise
 *   the inputs first.
 */
export function diffLines(before, after) {
  const a = (before || "").split("\n");
  const b = (after || "").split("\n");
  // Empty-input fast paths
  if (a.length === 1 && a[0] === "" && b.length === 1 && b[0] === "") return [];
  if (a.length === 1 && a[0] === "") {
    return b.map(function(line, j) { return { type: "add", left: null, right: j + 1, content: line }; });
  }
  if (b.length === 1 && b[0] === "") {
    return a.map(function(line, i) { return { type: "del", left: i + 1, right: null, content: line }; });
  }
  const dp = _lcsMatrix(a, b);
  return _backtrace(a, b, dp);
}

/**
 * Convert flat diff segments into "aligned rows" suitable for a side-by-side
 * renderer. Each row is { left: {n, content} | null, right: {n, content} | null,
 * type: "equal" | "del" | "add" | "change" }.
 *
 * Adjacent del+add pairs are merged into a single "change" row so the
 * before-line and after-line render side by side. Pure del or pure add
 * stays as its own row with one side null.
 *
 * @param {Array} segments  Output of diffLines().
 * @returns {Array<{left: object|null, right: object|null, type: string}>}
 */
export function diffToSideBySide(segments) {
  const rows = [];
  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    if (seg.type === "equal") {
      rows.push({
        left:  { n: seg.left,  content: seg.content },
        right: { n: seg.right, content: seg.content },
        type:  "equal",
      });
      i++;
      continue;
    }
    // Collect a contiguous run of del/add segments (the "hunk")
    const dels = [];
    const adds = [];
    while (i < segments.length && segments[i].type !== "equal") {
      if (segments[i].type === "del") dels.push(segments[i]);
      else                            adds.push(segments[i]);
      i++;
    }
    // Pair dels with adds 1:1 as "change" rows; surplus stays as pure del/add
    const pairCount = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairCount; k++) {
      rows.push({
        left:  { n: dels[k].left,  content: dels[k].content },
        right: { n: adds[k].right, content: adds[k].content },
        type:  "change",
      });
    }
    for (let k = pairCount; k < dels.length; k++) {
      rows.push({
        left:  { n: dels[k].left,  content: dels[k].content },
        right: null,
        type:  "del",
      });
    }
    for (let k = pairCount; k < adds.length; k++) {
      rows.push({
        left:  null,
        right: { n: adds[k].right, content: adds[k].content },
        type:  "add",
      });
    }
  }
  return rows;
}

/**
 * Summary statistics for a diff. Useful for headline numbers like "12 added,
 * 3 removed" without re-iterating segments.
 *
 * @param {Array} segments  Output of diffLines().
 * @returns {{added: number, removed: number, equal: number, totalChanged: number}}
 */
export function diffStats(segments) {
  let added = 0;
  let removed = 0;
  let equal = 0;
  for (let i = 0; i < segments.length; i++) {
    const t = segments[i].type;
    if (t === "add") added++;
    else if (t === "del") removed++;
    else equal++;
  }
  return { added, removed, equal, totalChanged: added + removed };
}
