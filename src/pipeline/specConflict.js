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
    source: "verify",
    reason,
    requirementIds: ids,
    specHash,
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
