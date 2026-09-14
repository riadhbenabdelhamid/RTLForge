// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// candidateGuard — conservative comparison of RTL candidates measured by one
// checker.  This module deliberately knows nothing about benchmark fixtures,
// reference RTL, or official testbenches.  A candidate is comparable only
// when the caller records the checker version, seed, and source fingerprint.

import { hasCompileFailure } from "./classifiers.js";
import { djb2 } from "../utils/hash.js";

/**
 * Return the checker metadata carried by a candidate or measurement.
 * `checker` is the preferred shape; the scalar fields are accepted for old
 * callers and make the guard convenient to use in serialized checkpoints.
 */
export function checkerOf(value) {
  const v = value || {};
  const c = v.checker || (v.verify && v.verify.checker) || {};
  return {
    version: c.version != null ? String(c.version) : (v.checkerVersion != null ? String(v.checkerVersion) : ""),
    seed: c.seed != null ? String(c.seed) : (v.checkerSeed != null ? String(v.checkerSeed) : ""),
    hash: c.hash != null ? String(c.hash) : (v.checkerHash != null ? String(v.checkerHash) : ""),
  };
}

/** A common checker requires every identity component, including the seed. */
export function sameChecker(a, b) {
  const x = checkerOf(a), y = checkerOf(b);
  return !!(x.version && x.seed && x.hash
    && x.version === y.version && x.seed === y.seed && x.hash === y.hash);
}

export function hasCheckerIdentity(value) {
  const c = checkerOf(value);
  return !!(c.version && c.seed && c.hash);
}

/**
 * Read the qualification record attached to an independently generated
 * checker.  Legacy measurements have no record and remain comparable for
 * checkpoint/backward compatibility; newly generated checkers are required
 * to carry an explicit READY review before they can be used as evidence.
 */
export function checkerQualification(value, context) {
  const v = value || {};
  const candidate = v.checkerCandidate || v._standaloneCheckerCandidate
    || (v.verify && v.verify.checkerCandidate);
  if (!candidate) return { status: "LEGACY", trustworthy: true, explicit: false };
  const q = candidate.qualification || candidate.review || {};
  const status = String(candidate.status || q.status || "UNREVIEWED").toUpperCase();
  const reviewStatus = String(q && q.status || "").toUpperCase();
  const reviewed = reviewStatus === "PASS" || reviewStatus === "READY";
  const codeHash = candidate && candidate.code ? djb2(String(candidate.code)) : "";
  const expectedInputHash = context && context.inputHash ? String(context.inputHash) : "";
  const sourceBound = !!q.sourceHash && String(q.sourceHash) === codeHash;
  const inputBound = !expectedInputHash
    ? !!q.inputHash
    : !!q.inputHash && String(q.inputHash) === expectedInputHash;
  const trustworthy = status === "READY" && !!reviewed && sourceBound && inputBound;
  const staleReason = !sourceBound ? "checker source changed after review"
    : (!inputBound ? "checker review inputs changed" : null);
  return {
    status: trustworthy ? "READY" : (staleReason ? "STALE" : (reviewStatus || "UNREVIEWED")),
    trustworthy,
    explicit: true,
    method: q.method || null,
    reason: candidate.error || q.reason || staleReason || null,
  };
}

export function checkerEvidenceTrustworthy(value) {
  return checkerQualification(value).trustworthy;
}

function measurementOf(candidate) {
  const c = candidate || {};
  return c.verify && typeof c.verify === "object" ? c.verify : c;
}

function testId(test) {
  if (!test || typeof test !== "object") return "";
  return String(test.id || test.name || "").trim();
}

function isPass(test) {
  return !!(test && (test.st === "PASS" || test.status === "PASS" || test.pass === true));
}

/**
 * IDs for checks that passed in an incumbent measurement.
 * Duplicate IDs are retained only when *all* occurrences passed.  That keeps
 * a malformed or ambiguous checker from turning one green duplicate into a
 * preserved check.
 */
export function passedCheckIds(measurement) {
  const groups = new Map();
  for (const test of ((measurementOf(measurement).tests) || [])) {
    const id = testId(test);
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(isPass(test));
  }
  return Array.from(groups.entries())
    .filter(function(entry) { return entry[1].length > 0 && entry[1].every(Boolean); })
    .map(function(entry) { return entry[0]; });
}

function checkUniverse(measurement) {
  const tests = measurementOf(measurement).tests;
  if (!Array.isArray(tests) || tests.length === 0) return null;
  const ids = [];
  const seen = new Set();
  for (const test of tests) {
    const id = testId(test);
    if (!id) return null; // unnamed observations cannot be aligned safely
    if (seen.has(id)) return null; // duplicate IDs are ambiguous observations
    seen.add(id);
    ids.push(id);
  }
  return ids.sort();
}

/** Candidate retains every incumbent check that passed, conservatively. */
export function retainsPassedChecks(candidate, incumbent) {
  const candidateMeasurement = measurementOf(candidate);
  const byId = new Map();
  for (const test of (candidateMeasurement.tests || [])) {
    const id = testId(test);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(isPass(test));
  }
  return passedCheckIds(incumbent).every(function(id) {
    const occurrences = byId.get(id);
    return !!(occurrences && occurrences.length > 0 && occurrences.every(Boolean));
  });
}

function passCount(candidate) {
  const m = measurementOf(candidate);
  return (m.tests || []).filter(isPass).length;
}

function outcomeStatus(candidate) {
  const m = measurementOf(candidate);
  if (m && (m._timeout || m.timeout || m.status === "TIMEOUT")) return "TIMEOUT";
  if (m && (m._error || m.error || m.status === "ERROR")) return "ERROR";
  if (m && (m._runtimeExit || m.status === "RUNTIME_EXIT" || m.status === "RUNTIME_ERROR"
      || m.status === "UNKNOWN_EXIT" || m.status === "UNVERIFIED")) return "UNVERIFIED";
  if (m && (m._missingMarkers || m.status === "MISSING_MARKERS")) return "UNVERIFIED";
  if (m && (m._compileFailure || m.status === "COMPILE_FAILURE")) return "COMPILE_FAIL";
  if (!m || m.cli !== true || !Array.isArray(m.tests) || m.tests.length === 0
      || m._noMarkers || m.total == null || m.total <= 0) return "UNVERIFIED";
  if (hasCompileFailure(m.tests)) return "COMPILE_FAIL";
  return "MEASURED";
}

/**
 * Select a candidate against an incumbent measured by the same checker.
 * The incumbent is retained for ties, errors, timeouts, checker mismatch,
 * regressions, and non-strict improvements.  The return object is safe to
 * persist as provenance alongside either artifact.
 */
export function selectCommonCheckerCandidate(candidate, incumbent) {
  const candStatus = outcomeStatus(candidate);
  const incStatus = outcomeStatus(incumbent);
  const candQualification = checkerQualification(candidate);
  const incQualification = checkerQualification(incumbent);
  const base = {
    selected: incumbent,
    decision: "FALLBACK",
    candidateStatus: candStatus,
    incumbentStatus: incStatus,
    candidatePass: passCount(candidate),
    incumbentPass: passCount(incumbent),
    retainedPassedChecks: false,
  };
  if (!candQualification.trustworthy || !incQualification.trustworthy) {
    return Object.assign(base, {
      reason: "CHECKER_UNREVIEWED",
      checkerCandidateStatus: candQualification.status,
      checkerIncumbentStatus: incQualification.status,
    });
  }
  if (!incumbent) {
    return Object.assign(base, { selected: candidate, decision: candStatus === "MEASURED" ? "ACCEPT_BASELINE" : "FALLBACK" });
  }
  if (!sameChecker(candidate, incumbent)) return Object.assign(base, { reason: "CHECKER_MISMATCH" });
  if (candStatus !== "MEASURED") return Object.assign(base, { reason: candStatus });
  if (incStatus !== "MEASURED") {
    // An unmeasured incumbent has no passed checks to preserve.  Accept only
    // a real, compiling candidate; this path is useful for a first baseline.
    return Object.assign(base, { selected: candidate, decision: "ACCEPT_IMPROVEMENT", retainedPassedChecks: true });
  }
  const incumbentUniverse = checkUniverse(incumbent);
  const candidateUniverse = checkUniverse(candidate);
  if (!incumbentUniverse || !candidateUniverse
      || incumbentUniverse.length !== candidateUniverse.length
      || incumbentUniverse.some(function(id, i) { return id !== candidateUniverse[i]; })) {
    return Object.assign(base, { reason: "CHECK_UNIVERSE_MISMATCH" });
  }
  const retained = retainsPassedChecks(candidate, incumbent);
  if (!retained) return Object.assign(base, { reason: "PASSED_CHECK_REGRESSION" });
  if (base.candidatePass <= base.incumbentPass) return Object.assign(base, {
    retainedPassedChecks: true,
    reason: base.candidatePass === base.incumbentPass ? "TIE" : "NO_STRICT_IMPROVEMENT",
  });
  return Object.assign(base, { selected: candidate, decision: "ACCEPT_IMPROVEMENT", retainedPassedChecks: true });
}

/** Compact, serializable provenance for a candidate measurement. */
export function candidateProvenance(candidate, source, calls) {
  const m = measurementOf(candidate);
  const checker = checkerOf(candidate);
  return {
    source: source || "unknown",
    status: outcomeStatus(candidate),
    checker: checker,
    checkerQualification: checkerQualification(candidate),
    pass: passCount(candidate),
    total: typeof m.total === "number" ? m.total : ((m.tests || []).length || 0),
    fail: typeof m.fail === "number" ? m.fail : ((m.tests || []).filter(function(t) { return !isPass(t); }).length || 0),
    passedCheckIds: passedCheckIds(m),
    calls: (calls || []).map(function(call) {
      return {
        stage: call && call.stage || source || "candidate",
        model: call && call.model || "",
        provider: call && call.provider || "",
        tokensIn: call && call.tokensIn || 0,
        tokensOut: call && call.tokensOut || 0,
        latencyMs: call && call.latencyMs || 0,
        stopReason: call && call.stopReason || null,
      };
    }),
  };
}
