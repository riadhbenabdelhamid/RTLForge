// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { createReviewAcceptance } from "./reviewAcceptance.js";
import { validateRTLInterface } from "../utils/interfaceContract.js";
import { djb2 } from "../utils/hash.js";

// Select while RTL Gen can still checkpoint the result, before reviews or
// formal checking spend time on it. Existing qualified checks are reused;
// this step never generates a checker or consults external test outcomes.
export async function selectInitialCandidate(st, output) {
  const enabled = st._config?.standaloneFallback;
  const rtl = output.rtl_generate, alternative = rtl?._standaloneCandidate?.code;
  if (!(enabled === true || enabled && typeof enabled === "object")
      || !st.spec?._designContract || !rtl?.code || !alternative) return output;
  const primary = rtl.code;
  const inputs = { ...st, ...output, rtl_generate: rtl };
  let decision;
  if (validateRTLInterface(alternative, st.spec, { exactPorts: true }).length) {
    decision = { adopted: false, reason: "INTERFACE_CONTRACT_CHANGED" };
  } else if (alternative === primary) {
    decision = { adopted: false, reason: "IDENTICAL_CANDIDATE" };
  } else {
    decision = await createReviewAcceptance(inputs, primary, { allowCompileRecovery: true }).compare(alternative, primary);
  }
  const measured = value => value && Object.fromEntries(["status", "cli", "total", "pass", "fail", "tests", "checker", "_sourceEvidence"]
    .filter(k => value[k] !== undefined).map(k => [k, value[k]]));
  const comparison = { phase: "before-rtl-review", adopted: decision.adopted,
    reason: decision.reason || (decision.adopted ? "ACCEPT_IMPROVEMENT" : "UNVERIFIED"),
    selectedSource: decision.adopted ? "original-description" : "pipeline",
    contractHash: st.spec._designContract.hash, primary: { code: primary, hash: djb2(primary), verify: measured(decision.baseline) },
    alternative: { hash: djb2(alternative), verify: measured(decision.proposed) } };
  st._onLog?.("Initial candidate selection: " + comparison.selectedSource + " — " + comparison.reason + "\n");
  return { ...output, rtl_generate: { ...rtl, code: decision.adopted ? alternative : primary,
    _initialCandidate: rtl._initialCandidate || { code: primary, contractHash: st.spec._designContract.hash },
    _initialComparison: comparison } };
}
