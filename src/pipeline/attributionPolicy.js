// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { interfaceFact } from "./sourceAttribution.js";
import { widthEquivalent } from "../utils/interfaceContract.js";

export const ATTRIBUTION_POLICIES = ["auto", "strict", "relaxed"];

export function resolveAttributionPolicy(config = {}, mode = config._executionMode) {
  const requested = config.attributionPolicy ?? "auto";
  if (!ATTRIBUTION_POLICIES.includes(requested)) {
    throw new Error("attributionPolicy must be auto, strict, or relaxed");
  }
  const executionMode = mode === "full-auto" ? "full-auto" : "semi-auto";
  return { version: 1, requested, executionMode,
    effective: requested === "auto" ? executionMode === "full-auto" ? "relaxed" : "strict" : requested };
}

// Only these attribution gaps permit provisional generation. Every unrecognized
// issue, conflict, interface violation, and integrity failure remains blocking.
const deferredCodes = new Set(["CITATION_UNRESOLVED", "ATTRIBUTION_MISSING"]);
export function generationBlockingIssues(contract) {
  const issues = contract?.issues || [];
  return contract?.attributionPolicy?.effective === "relaxed"
    ? issues.filter(i => !deferredCodes.has(i.code)) : issues;
}

export function policyLedger(ledger, snapshot, elicitation, policy) {
  const entries = ledger.entries.map(entry => entry.kind === "user_revision"
    && elicitation.assumptions.find(a => a.id === entry.ref)?.confirmationOrigin !== "user"
    ? { ...entry, kind: "auto_assumption", origin: "unconfirmed-revision" } : entry);
  const issues = ledger.issues.map(issue => ({ ...issue, code:
    issue.reason.startsWith("Correct attribution before freezing the contract:")
      && !/disagrees with the specified interface/.test(issue.reason) ? "CITATION_UNRESOLVED"
      : issue.reason === "Requirement has no source, explicit answer, or recorded implementation assumption"
      ? "ATTRIBUTION_MISSING" : "CONTRACT_INVALID" }));
  const ids = new Set();
  for (const req of snapshot.requirements) {
    if (ids.has(req.id)) issues.push({ id: req.id, code: "REQUIREMENT_INVALID", reason: "Duplicate requirement identifier" });
    ids.add(req.id);
    const fact = interfaceFact(req);
    const port = fact?.kind === "port" && snapshot.iface.find(p => p.name === fact.name);
    if (fact && (fact.kind === "module" ? fact.name !== snapshot.modName
      : !port || port.dir !== fact.dir || fact.width != null && !widthEquivalent(port.width, fact.width))) {
      issues.push({ id: req.id, code: "INTERFACE_MISMATCH", reason: "Declaration requirement disagrees with the specified interface" });
    }
    const legacyRef = String(req.rat || "").match(/\b[A-Z]+-\d+\b/)?.[0];
    const ref = req.provenance?.ref || legacyRef;
    const assumption = elicitation.assumptions.find(a => a.id === ref);
    const question = elicitation.questions.find(q => q.id === ref);
    // Legacy rationales can mention other requirement IDs. Only explicit
    // elicitation references establish an unknown-reference error here;
    // recognized rejected choices remain blocking with either representation.
    if (req.provenance?.ref && !assumption && !question) issues.push({ id: req.id, code: "UNKNOWN_REFERENCE",
      reason: "Requirement names an unknown elicitation reference", ref });
    if (assumption?.confirmed === false) issues.push({ id: req.id, code: "REJECTED_CHOICE",
      reason: "Requirement uses a deselected elicitation assumption", ref });
    const gaps = issues.filter(i => i.id === req.id && deferredCodes.has(i.code));
    if (gaps.length && !entries.some(e => e.id === req.id)) entries.push({
      id: req.id, description: req.desc, kind: "unresolved", origin: "unresolved-model-attribution",
      reasoning: req.provenance?.reasoning || req.rat || "No reasoning recorded",
      sources: [], userConfirmed: false, issues: gaps.map(i => i.reason),
      rejectedAttribution: { src: req.src || "", sources: req.sources || [], provenance: req.provenance || null },
    });
  }
  if (policy.effective === "strict") {
    for (const entry of entries.filter(e => e.kind === "auto_assumption")) {
      const choice = elicitation.assumptions.find(a => a.id === entry.ref);
      if (choice?.confirmationOrigin === "user" && choice.confirmed === true) continue;
      issues.push({ id: entry.id, code: "CONFIRMATION_REQUIRED",
        reason: "Selected implementation choice requires user confirmation under strict attribution", ref: entry.ref });
    }
  }
  return { entries, issues };
}
