// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// classifiers — Patch decision and task status classification
// 5-tier PATCH_DECISION: ACCEPT_PROGRESS, ACCEPT_EQUIVALENT,
//   REJECT_NO_IMPROVEMENT, REJECT_INVALID_PATCH, REJECT_REGRESSION
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
 * Classify simulation test results between baseline and candidate.
 * Same 5-tier PATCH_DECISION semantics as classifyDiagnostics.
 */
export function classifyTestResults(baselineTests, candidateTests) {
  const resolved = [];
  const persisting = [];
  const introduced = [];
  const revealed = [];

  const baseMap = {};
  (baselineTests || []).forEach((t) => { baseMap[t.name] = t; });
  const candMap = {};
  (candidateTests || []).forEach((t) => { candMap[t.name] = t; });

  Object.keys(baseMap).forEach((name) => {
    const b = baseMap[name];
    const c = candMap[name];
    if (!c) {
      if (b.st === "FAIL") resolved.push(b);
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

  const score = (3 * resolved.length) - (1 * revealed.length) - (5 * introduced.length);

  let patchDecision;
  if (introduced.length > 0 && resolved.length === 0) {
    patchDecision = "REJECT_REGRESSION";
  } else if (resolved.length > 0 && introduced.length === 0) {
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

  const allPass = (candidateTests || []).every((t) => t.st === "PASS");
  const taskStatus = allPass && (candidateTests || []).length > 0 ? "COMPLETE" : "INCOMPLETE";

  return {
    resolved, persisting, introduced, revealed,
    score, patchDecision, taskStatus,
    decision: patchDecision.indexOf("ACCEPT") === 0 ? "accept" : "reject",
  };
}
