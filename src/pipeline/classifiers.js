// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// classifiers — Patch decision and task status classification
// PATCH_DECISION: ACCEPT_PROGRESS, ACCEPT_EQUIVALENT, REJECT_NO_IMPROVEMENT,
//   REJECT_INVALID_PATCH, REJECT_REGRESSION, REJECT_COMPILE_FAIL
//   (the last overrides the others when the candidate does not compile)
// 3-tier TASK_STATUS:    COMPLETE, INCOMPLETE, BLOCKED_NONCODE
// ═══════════════════════════════════════════════════════════════════════════

/** Match diagnostics by code+message similarity (NOT line number). */
export function matchDiagnostic(a, b) {
  if (a.code !== b.code) return false;
  // Normalise messages: strip line refs, whitespace
  const na = (a.msg || "").replace(/\d+/g, "N").replace(/\s+/g, " ").trim().toLowerCase();
  const nb = (b.msg || "").replace(/\d+/g, "N").replace(/\s+/g, " ").trim().toLowerCase();
  if (na === nb) return true;
  // Fuzzy: >70% character overlap
  const longer  = na.length > nb.length ? na : nb;
  const shorter = na.length > nb.length ? nb : na;
  if (longer.length === 0) return false;
  let overlap = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.indexOf(shorter[i]) >= 0) overlap++;
  }
  return (overlap / longer.length) > 0.7;
}

/**
 * Classify lint/synthesis diagnostics between baseline and candidate.
 * @param {Array} baselineIssues
 * @param {Array} candidateIssues
 * @param {object} [opts]  { patchInvalid: boolean }
 * @returns {object} resolved/persisting/introduced/revealed arrays + score + decisions
 */
export function classifyDiagnostics(baselineIssues, candidateIssues, opts) {
  opts = opts || {};
  const resolved = [];
  const persisting = [];
  const introduced = [];
  const revealed = [];

  // Track which candidate issues matched a baseline issue
  const candidateMatched = new Array(candidateIssues.length).fill(false);

  // For each baseline issue, find if it persists in candidate
  baselineIssues.forEach((bIssue) => {
    let found = false;
    for (let j = 0; j < candidateIssues.length; j++) {
      if (!candidateMatched[j] && matchDiagnostic(bIssue, candidateIssues[j])) {
        candidateMatched[j] = true;
        persisting.push(bIssue);
        found = true;
        break;
      }
    }
    if (!found) resolved.push(bIssue);
  });

  // Unmatched candidate issues are either introduced or revealed
  candidateIssues.forEach((cIssue, idx) => {
    if (candidateMatched[idx]) return;
    const sameCodeFamily = baselineIssues.some((b) => b.code === cIssue.code);
    const relatedToFix   = resolved.some((r) => r.code === cIssue.code);
    if (sameCodeFamily || relatedToFix) {
      revealed.push(cIssue);
    } else {
      introduced.push(cIssue);
    }
  });

  // Score heuristic: +3 resolved, -1 revealed, -5 introduced
  const score = (3 * resolved.length) - (1 * revealed.length) - (5 * introduced.length);

  // ── PATCH_DECISION (5-tier) ──
  let patchDecision;
  if (opts.patchInvalid) {
    patchDecision = "REJECT_INVALID_PATCH";
  } else if (
    introduced.some((i) => i.code === "SYNTAX" || i.sev === "error") &&
    resolved.length === 0
  ) {
    patchDecision = "REJECT_REGRESSION";
  } else if (resolved.length > 0 && introduced.length === 0) {
    patchDecision = "ACCEPT_PROGRESS";
  } else if (resolved.length > 0 && score > 0) {
    patchDecision = "ACCEPT_PROGRESS";
  } else if (resolved.length > 0 && score >= -2) {
    patchDecision = "ACCEPT_PROGRESS"; // marginal — still net forward
  } else if (resolved.length === 0 && introduced.length === 0) {
    patchDecision = "ACCEPT_EQUIVALENT";
  } else if (resolved.length === 0 && introduced.length > 0) {
    patchDecision = "REJECT_REGRESSION";
  } else {
    patchDecision = score >= 0 ? "ACCEPT_EQUIVALENT" : "REJECT_NO_IMPROVEMENT";
  }

  // A candidate that INTRODUCES SYNTAX errors onto a baseline that had none
  // cannot compile — and no amount of warning cleanup pays for that. This
  // overrides the score tiers (measured, run 29: a fix resolved 25 width
  // warnings while adding 14 dangling-part-select SYNTAX errors; +75-70
  // scored ACCEPT_PROGRESS and a broken TB shipped over a compiling one,
  // zeroing the whole verify stage). When the baseline itself has SYNTAX
  // errors the normal tiers keep governing — that's a repair in progress.
  if (introduced.some((i) => i.code === "SYNTAX")
      && !baselineIssues.some((b) => b && b.code === "SYNTAX")) {
    patchDecision = "REJECT_REGRESSION";
  }

  // ── TASK_STATUS ──
  let taskStatus;
  if (candidateIssues.length === 0) {
    taskStatus = "COMPLETE";
  } else {
    taskStatus = "INCOMPLETE";
  }

  return {
    resolved, persisting, introduced, revealed,
    score, patchDecision, taskStatus,
    // Legacy compat
    decision: patchDecision.indexOf("ACCEPT") === 0 ? "accept" : "reject",
  };
}

/**
 * Group key for a test marker. Requirement-directed markers (REQ-<CAT>-<NNN>,
 * optionally with a `.<subtestid>` suffix) collapse to their REQUIREMENT id, so
 * the convergence classifier is stable across TB regenerations that renumber or
 * reword subtests. Infrastructure markers (GEN…) group under "GEN". Anything
 * else — a legacy free-text marker — is its own key, preserving the original
 * per-test behaviour for testbenches that don't use the req-prefixed convention.
 */
export function reqKeyOf(name) {
  const n = String(name == null ? "" : name);
  const m = n.match(/REQ-[A-Z]+-\d+/i);
  if (m) return m[0].toUpperCase();
  if (/^gen([._]|\b)/i.test(n)) return "GEN";
  return n;
}

/** Aggregate per-subtest results into per-key pseudo-tests (FAIL wins). */
function aggregateByReq(tests) {
  const byKey = {};
  (tests || []).forEach(function(t) {
    if (!t || t.name == null) return;
    const key = reqKeyOf(t.name);
    if (!byKey[key]) byKey[key] = { name: key, st: "PASS" };
    if (t.st === "FAIL") byKey[key].st = "FAIL";
  });
  return Object.keys(byKey).map(function(k) { return byKey[k]; });
}

/**
 * Requirement-level test classification: collapse `REQ-X.<n>` subtests to their
 * requirement before comparing, so renumbering/rewording a TB's checks across a
 * regeneration no longer reads as resolved+revealed churn (which would wrongly
 * look like progress and dodge stagnation). A requirement is FAIL if ANY of its
 * subtests fail. Reuses classifyTestResults on the aggregated pseudo-tests, so
 * the 5-tier decision semantics are identical. For legacy free-text-named TBs
 * each marker is its own key → behaviour is unchanged.
 */
export function classifyTestResultsByReq(baselineTests, candidateTests) {
  return classifyTestResults(aggregateByReq(baselineTests), aggregateByReq(candidateTests));
}

/**
 * A non-compiling candidate surfaces as a single synthetic FAIL test named
 * "compilation" (verify.js's compile-failure path) — or any FAIL marker whose
 * name reads as a syntax/compile error. Such a candidate has no trustworthy
 * test signal and must never be "kept".
 */
export function hasCompileFailure(tests) {
  return (tests || []).some(function(t) {
    return t && t.st === "FAIL" && /compil|syntax/i.test(String(t.name == null ? "" : t.name));
  });
}

/**
 * Classify simulation test results between baseline and candidate.
 * Same PATCH_DECISION semantics as classifyDiagnostics, plus a
 * REJECT_COMPILE_FAIL override when the candidate does not compile, plus a
 * `dropped` category: baseline tests ABSENT from the candidate (deleted or
 * renamed away). Dropping is scored as damage (-3 each), never as
 * resolution — use classifyTestResultsByReq where TB regenerations
 * legitimately renumber subtests (REQ-keyed aggregation keeps continuity).
 */
export function classifyTestResults(baselineTests, candidateTests) {
  const resolved = [];
  const persisting = [];
  const introduced = [];
  const revealed = [];
  const dropped = [];

  const baseMap = {};
  (baselineTests || []).forEach((t) => { baseMap[t.name] = t; });
  const candMap = {};
  (candidateTests || []).forEach((t) => { candMap[t.name] = t; });

  Object.keys(baseMap).forEach((name) => {
    const b = baseMap[name];
    const c = candMap[name];
    if (!c) {
      // The synthetic compile-failure marker (see hasCompileFailure)
      // vanishing means the TB compiles again — that IS resolution.
      if (b.st === "FAIL" && /compil|syntax/i.test(String(name))) {
        resolved.push(b);
        return;
      }
      // Any other baseline test ABSENT from the candidate is oracle
      // weakening, not resolution: "fix the TB by deleting the failing
      // check" must never score as progress, and a passing check that
      // silently vanishes is lost coverage. (Previously a deleted FAIL
      // counted as resolved — a rewrite could earn ACCEPT_PROGRESS by
      // removing its failing tests.)
      dropped.push(b);
      return;
    }
    if (b.st === "FAIL" && c.st === "PASS") resolved.push(b);
    else if (b.st === "FAIL" && c.st === "FAIL") persisting.push(b);
    else if (b.st === "PASS" && c.st === "FAIL") introduced.push(c);
  });

  Object.keys(candMap).forEach((name) => {
    if (!baseMap[name] && candMap[name].st === "FAIL") {
      revealed.push(candMap[name]);
    }
  });

  const score = (3 * resolved.length) - (1 * revealed.length) - (5 * introduced.length) - (3 * dropped.length);

  let patchDecision;
  if (introduced.length > 0 && resolved.length === 0) {
    patchDecision = "REJECT_REGRESSION";
  } else if (dropped.length > 0 && resolved.length === 0) {
    // Checks removed and nothing genuinely fixed — the oracle got weaker.
    patchDecision = "REJECT_REGRESSION";
  } else if (resolved.length > 0 && introduced.length === 0 && dropped.length === 0) {
    patchDecision = "ACCEPT_PROGRESS";
  } else if (resolved.length > 0 && score > 0) {
    patchDecision = "ACCEPT_PROGRESS";
  } else if (resolved.length === 0 && introduced.length === 0) {
    patchDecision = (resolved.length === 0 && revealed.length === 0)
      ? "ACCEPT_EQUIVALENT"
      : "REJECT_NO_IMPROVEMENT";
  } else {
    patchDecision = score >= 0 ? "ACCEPT_EQUIVALENT" : "REJECT_REGRESSION";
  }

  // A candidate that does not COMPILE is categorically unacceptable, and it
  // overrides every tier above: a non-compiling run emits a single synthetic
  // "compilation" FAIL (verify.js) and NO real test results, so the
  // resolved/introduced math is meaningless — two broken candidates read as
  // ACCEPT_EQUIVALENT ("keep it") and the fix loop burns its whole budget on a
  // TB that can't run (observed: fifo_sync, 9 wasted iters). Force a distinct
  // reject so the loop reverts to the last compiling candidate (best-known
  // restore already scores compile-fail at -2) and re-targets the SYNTAX error.
  if (hasCompileFailure(candidateTests)) {
    patchDecision = "REJECT_COMPILE_FAIL";
  }

  const allPass = (candidateTests || []).every((t) => t.st === "PASS");
  const taskStatus = allPass && (candidateTests || []).length > 0 ? "COMPLETE" : "INCOMPLETE";

  return {
    resolved, persisting, introduced, revealed, dropped,
    score, patchDecision, taskStatus,
    decision: patchDecision.indexOf("ACCEPT") === 0 ? "accept" : "reject",
  };
}
