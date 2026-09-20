// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { djb2 } from "../utils/hash.js";

export const SPEC_CONFLICT_CRITERION = "spec_conflict_review";

// A pending diagnosis requests review; it is not proof the spec is wrong.
export function pendingSpecConflictOf(state) {
  const request = state && state.verify && state.verify._specConflict;
  return request && typeof request === "object" ? request : null;
}

export function makeSpecConflict(state, triage) {
  const reason = String(triage.reason || "Verification reported contradictory requirements.");
  const ids = ((state.spec && state.spec.requirements) || [])
    .map(r => r && r.id).filter(id => id && reason.includes(id));
  const specHash = djb2(JSON.stringify(state.spec || {}));
  return {
    id: djb2(specHash + "\n" + reason),
    source: triage.source || "verify",
    simulationStatus: state.verify?.status || "",
    reason,
    requirementIds: ids,
    specHash,
  };
}

// Reviews distinguish a missing implementation from a disputed specification.
// Legacy spec_gap reports need an explicit conflict diagnosis and a known
// requirement; ordinary missing-feature findings remain RTL repair targets.
export function reviewSpecConflict(state, review, source = "rtl_review") {
  const ids = (state.spec?.requirements || []).map(r => r.id).filter(Boolean);
  const findings = (review.issues || []).filter(i => {
    const description = String(i.description || ""), fix = String(i.fix || "");
    const references = ids.filter(id => description.includes(id));
    const legacyConflict = i.target == null && i.category === "spec_gap"
      && /conflict|contradict|inconsistent/i.test(description)
      && (references.length >= 2 || /recorded|selected|assumption|default|interpretation/i.test(description + " " + fix)
        && /resolve|clarif|revis/i.test(fix));
    return ["critical", "major"].includes(i.severity) && references.length > 0
      && (i.target === "spec" || legacyConflict);
  });
  if (!findings.length) return null;
  return makeSpecConflict(state, { source, reason: findings.map(i => i.description
    + (i.fix ? " Proposed review: " + i.fix : "")).join("\n") });
}

export function reviewConflictResult(state, review, source, code, llms, iterations = []) {
  const request = pendingSpecConflictOf(state) || reviewSpecConflict(state, review, source);
  if (!request) return null;
  state._onLog?.("Specification conflict reported by " + source + ". Preserving artifacts and routing to Spec review: " + request.reason);
  return {
    ...(source === "rtl_review" ? { rtl_generate: { ...state.rtl_generate, code } }
      : source === "test_review" ? { test_generate: { ...state.test_generate, code } } : {}),
    [source]: { ...review, verdict: "NEEDS_FIX", status: "NEEDS_SPEC_REVIEW",
      _specConflict: request, _repairUnresolved: true, _reviewedCode: code,
      _iterations: iterations, _llms: llms.slice() },
    verify: { ...state.verify, status: "NEEDS_SPEC_REVIEW", _specConflict: request },
    _llms: llms.slice(), _llm: llms.at(-1) || null,
  };
}

export function reviewedVerification(verify, review) {
  // Acceptance evidence from before specification review cannot certify the
  // regenerated artifacts. Invalidate it and require downstream verification.
  return {
    status: "UNVERIFIED", cli: false,
    total: 0, pass: 0, fail: 0, tests: [], cov: {},
    log: "Specification reviewed; downstream verification is required.",
    _specConflict: null,
    _specConflictReview: review,
    verifyHistory: (verify && verify.verifyHistory) || [],
  };
}
