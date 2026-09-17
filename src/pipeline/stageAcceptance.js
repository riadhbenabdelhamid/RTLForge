// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { createReviewAcceptance } from "./reviewAcceptance.js";
import { assessDesignContract, specificationSnapshot, elicitationSnapshot } from "./designContract.js";
import { djb2 } from "../utils/hash.js";
import { validateRTLInterface } from "../utils/interfaceContract.js";

const slots = ["elicit", "spec", "architect", "rtl_generate", "rtl_review", "lint", "formal_props",
  "formal_verify", "test_generate", "test_review", "lint_test", "verify", "judge"];
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const snapshot = state => ({ ...state, ...Object.fromEntries(slots.map(k => [k, copy(state[k])])) });
const measured = value => value && Object.fromEntries(["status", "cli", "total", "pass", "fail", "tests", "checker"]
  .filter(k => value[k] !== undefined).map(k => [k, value[k]]));
const frozenCandidates = rtl => Object.fromEntries(["_initialCandidate", "_initialComparison", "_standaloneCandidate", "_standaloneCheckerCandidate"]
  .filter(k => rtl?.[k] !== undefined).map(k => [k, rtl[k]]));

// All production invocations, including nested reflows, pass this boundary.
// Proposals never replace an incumbent because a different checker or a higher
// criteria score prefers them. Measurements use the pre-stage frozen checker.
export function guardStageReplacement(name, node) {
  return async state => {
    if (!state.spec?._designContract || ["spec", "elicit"].includes(name)) return node(state);
    const before = snapshot(state);
    const incumbent = before.rtl_generate?.code;
    const guard = incumbent ? createReviewAcceptance(before, incumbent, { allowCompileRecovery: true }) : null;
    const delta = await node(state);
    const next = { ...state, ...delta };
    const proposal = next.rtl_generate?.code;
    const contract = before.spec._designContract;
    const changedSpec = next._userDesc !== before._userDesc || next.spec?._designContract?.hash !== contract.hash
      || JSON.stringify(specificationSnapshot(next.spec)) !== JSON.stringify(specificationSnapshot(before.spec))
      || JSON.stringify(elicitationSnapshot(next.elicit)) !== JSON.stringify(elicitationSnapshot(before.elicit));
    const nextContract = next.spec?._designContract;
    const revision = changedSpec && next._userDesc === before._userDesc
      && nextContract?.previousHash === contract.hash && nextContract.revision > contract.revision
      && assessDesignContract(before._userDesc, next.spec, next.elicit)?.issues.length === 0;
    let decision;
    if (changedSpec && !revision) decision = { adopted: false, reason: "FROZEN_SPECIFICATION_CHANGED" };
    else if (!incumbent || revision || before.rtl_generate?._contractHash && before.rtl_generate._contractHash !== contract.hash) {
      if (!proposal) return delta;
      return { ...delta, rtl_generate: { ...next.rtl_generate, _contractHash: nextContract.hash,
        _initialCandidate: before.rtl_generate?._initialCandidate || next.rtl_generate?._initialCandidate
          || { code: proposal, contractHash: nextContract.hash } } };
    } else if (proposal === incumbent) return delta?.rtl_generate
      ? { ...delta, rtl_generate: { ...delta.rtl_generate, ...frozenCandidates(before.rtl_generate) } } : delta;
    else if (!proposal) decision = { adopted: false, reason: "EMPTY_PROPOSAL" };
    else if (validateRTLInterface(proposal, before.spec, { exactPorts: true }).length) decision = { adopted: false, reason: "INTERFACE_CONTRACT_CHANGED" };
    else decision = await guard.compare(proposal, incumbent);

    const record = { stage: name, adopted: decision.adopted, reason: decision.reason,
      incumbentHash: djb2(incumbent || ""), proposalHash: djb2(proposal || ""), contractHash: contract.hash,
      proposal: proposal || "", baseline: measured(decision.baseline), proposed: measured(decision.proposed) };
    const history = [...(next.rtl_generate?._candidateAcceptance || before.rtl_generate?._candidateAcceptance || []), record];
    state._onLog?.("RTL candidate " + (decision.adopted ? "accepted" : "retained") + " at " + name + ": " + decision.reason + "\n");
    if (decision.adopted) return { ...delta, rtl_generate: { ...before.rtl_generate, ...next.rtl_generate,
      ...frozenCandidates(before.rtl_generate), _contractHash: contract.hash, _candidateAcceptance: history } };

    // Roll back dependent artifacts with the RTL. In particular, a candidate's
    // simulation/formal PASS must never be stamped onto the retained incumbent.
    const restored = Object.fromEntries(slots.filter(k => k in before).map(k => [k,
      before[k] && typeof before[k] === "object" ? { ...before[k], _replaceSlot: true } : before[k]]));
    const reason = "RTL candidate retained: proposed repair rejected (" + decision.reason + ").";
    const owner = before[name] || { status: "UNVERIFIED", reason };
    restored[name] = { ...owner, _replaceSlot: true, _repairRejected: record };
    if (name === "judge") restored.judge = { ...restored.judge,
      overall: before.judge?.overall === "FAIL" ? "FAIL" : "UNVERIFIED", verified: false,
      stopReason: "repair-rejected", unverifiedReason: reason };
    restored.rtl_generate = { ...before.rtl_generate, _replaceSlot: true, _candidateAcceptance: history };
    return { ...delta, ...restored, _userDesc: before._userDesc };
  };
}
