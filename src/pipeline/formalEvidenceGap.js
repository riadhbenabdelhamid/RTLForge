// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { measurementFreshness, codesOf } from "../utils/measurement.js";

// Missing proof or a broken harness is not a measured RTL counterexample.
export function formalEvidenceGap(state) {
  const formal = state.formal_verify, cfg = state._config || {};
  if (cfg.optionalStages?.formal_verify === false) return null;
  if (!formal && cfg.optionalStages?.formal_verify !== true) return null;
  if (!formal) return "Formal verification was requested but no result is available.";
  if (formal.status !== "PASS" && formal.status !== "FAIL") return formal.reason || "Formal verification is unavailable (" + formal.status + ").";
  if (measurementFreshness("formal_verify", formal, codesOf(state)) === "stale"
      || state.spec?._designContract && formal.designContractHash !== state.spec._designContract.hash) {
    return "Formal evidence is not current for the RTL and completed specification.";
  }
  if (formal.status === "FAIL") return null;
  if (formal.proven !== true && (cfg.formalProve !== false || cfg.evalCriteria?.formal_proven?.enabled !== false)) {
    return "Bounded formal checks passed, but an unbounded proof is incomplete.";
  }
  const obligations = (state.formal_props?.properties || []).map((p, i) => ({ ...p, id: p.id || "SVA-" + (i + 1) }))
    .filter(p => p.type === "assert" || /^\s*assert\b/.test(p.code || ""));
  const unchecked = Array.isArray(formal.assertionIds)
    ? obligations.some(p => !formal.assertionIds.includes(p.id)) : formal.formalSkipped?.length;
  if (unchecked) return "Some generated formal properties were not checked; property qualification is incomplete.";
  return null;
}
