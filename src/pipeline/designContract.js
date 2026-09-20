// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { sourceConventionLedger } from "./sourceConventions.js";
import { djb2 } from "../utils/hash.js";
import { inspectCitation, interfaceCitation, interfaceFact } from "./sourceAttribution.js";
import { conflictQualificationIssues } from "./specReconciliation.js";
import { resolveAttributionPolicy, policyLedger, generationBlockingIssues } from "./attributionPolicy.js";

const VERSION = "completed-spec-v3";
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => djb2(JSON.stringify(value));
const norm = value => String(value || "").replace(/\s+/g, " ").trim();

// Only specification inputs belong in this snapshot: no RTL, testbench,
// measurements, model-written qualification metadata, or repair feedback.
export function specificationSnapshot(spec = {}) {
  return clone({ modName: spec.modName || "", iface: spec.iface || [], params: spec.params || [],
    requirements: (spec.requirements || []).map(r => Object.fromEntries(
      Object.entries(r || {}).filter(([k]) => !k.startsWith("_")).sort(([a], [b]) => a.localeCompare(b)))),
    conflicts: spec.conflicts || [],
    ...(spec.sourceConventions != null ? { sourceConventions: spec.sourceConventions } : {}) });
}

export function elicitationSnapshot(elicit = {}) {
  return clone({ questions: elicit.questions || [], answers: elicit.answers || {},
    customAnswers: elicit.customAnswers || {}, assumptions: elicit.assumptions || [] });
}

function provenance(source, snapshot, elicitation, imported, configuration = {}) {
  const entries = [], issues = [];
  for (const req of snapshot.requirements) {
    if (!req.id || !norm(req.desc)) {
      issues.push({ id: req.id || "REQUIREMENT", reason: "Requirement needs an identifier and behavior description" }); continue;
    }
    const base = { id: req.id, description: req.desc || "", rationale: req.rat || "",
      reasoning: req.provenance?.reasoning || req.rat || "",
      alternatives: Array.isArray(req.provenance?.alternatives) ? req.provenance.alternatives : [],
      environment: req.environment === true };
    const rat = String(req.rat || "");
    const ref = req.provenance?.ref || rat.match(/\b[A-Z]+-\d+\b/)?.[0];
    const assumption = elicitation.assumptions.find(a => a.id === ref);
    const question = elicitation.questions.find(q => q.id === ref);
    const answer = question && elicitation.answers[ref];
    if (imported) { entries.push({ ...base, kind: "user_specification" }); continue; }
    if (req.provenance?.kind === "configuration") {
      const fact = interfaceFact(req);
      if (fact?.kind !== "module" || fact.name !== snapshot.modName
          || fact.name !== configuration.requiredModuleName || norm(req.src) || req.sources?.length) {
        issues.push({ id: req.id, reason: "Configuration attribution does not match the recorded external interface" });
      } else entries.push({ ...base, kind: "configuration", key: "requiredModuleName", value: fact.name,
        origin: "run-configuration" });
      continue;
    }
    const citation = inspectCitation(source, req, snapshot);
    if (citation.interpretation && ref && !assumption && !question) {
      issues.push({ id: req.id, reason: "Interpretation names an unknown elicitation reference", ref }); continue;
    }
    if (citation.valid) {
      if (citation.provisional && assumption?.confirmed === false) {
        issues.push({ id: req.id, reason: "Requirement uses a deselected elicitation assumption", ref }); continue;
      }
      entries.push(citation.interpretation
        ? { ...base, kind: "interpretation", ref: ref || "AUTO-" + req.id, text: req.desc,
          origin: "llm-interpretation", sources: citation.spans }
        : citation.provisional
        ? { ...base, kind: "auto_assumption", ref: "AUTO-" + req.id, text: req.desc,
          origin: "retained-interface-declaration", sources: citation.spans }
        : { ...base, kind: req.provenance?.kind === "derived" || /derived/i.test(rat) ? "derived" : "source",
          quote: req.src, sources: citation.spans });
      continue;
    }
    // A nonliteral quotation must be corrected, not laundered into an
    // automatically accepted assumption merely because its citation failed.
    if (citation.claimed) {
      issues.push({ id: req.id, reason: "Correct attribution before freezing the contract: " + citation.reason });
      continue;
    }
    if (answer) {
      const text = answer === "Other (specify)" ? elicitation.customAnswers[ref] : answer;
      if (norm(text)) { entries.push({ ...base, kind: "user_answer", ref, text }); continue; }
    }
    if (assumption?.confirmed === false) {
      issues.push({ id: req.id, reason: "Requirement uses a deselected elicitation assumption", ref }); continue;
    }
    if (assumption?.confirmed === true && norm(assumption.revised)) {
      entries.push({ ...base, kind: "user_revision", ref, text: assumption.revised }); continue;
    }
    const selected = assumption?.confirmed === true && norm(assumption.text);
    const recommended = question && !answer && norm(question.recommended);
    const declared = /default|question skipped|assum/i.test(rat) || req.provenance?.kind === "assumption";
    if (norm(req.desc) && (selected || recommended || declared && !ref)) {
      entries.push({ ...base, kind: "auto_assumption", ref: ref || "AUTO-" + req.id,
        text: selected ? assumption.text : recommended || req.desc,
        origin: selected ? "elicitation-assumption" : recommended ? "skipped-question" : "specification-default" });
      continue;
    }
    // An interface label alone grants no exception. A simple declaration can
    // instead be traced mechanically to the matching source/interface fact.
    const declaration = interfaceCitation(source, req, snapshot);
    if (declaration) {
      entries.push(declaration.provisional
        ? { ...base, kind: "auto_assumption", ref: "AUTO-" + req.id, text: req.desc,
          origin: "retained-interface-declaration", sources: declaration.spans }
        : { ...base, kind: "derived", sources: declaration.spans });
      continue;
    }
    issues.push({ id: req.id, reason: "Requirement has no source, explicit answer, or recorded implementation assumption" });
  }
  issues.push(...conflictQualificationIssues(source, snapshot, elicitation));
  const conventions = sourceConventionLedger(source, snapshot);
  return { entries: entries.concat(conventions.entries), issues: issues.concat(conventions.issues) };
}

// Called only at the Spec stage boundary, after fidelity/coverage/citation
// checks. Other stages validate this record; they cannot silently reseal it.
export function sealDesignContract(source, spec, elicit, previous, { imported = false, configuration, attributionPolicy } = {}) {
  const snapshot = specificationSnapshot(spec), elicitation = elicitationSnapshot(elicit);
  const configured = configuration?.requiredModuleName ? { requiredModuleName: configuration.requiredModuleName } : null;
  const rawLedger = provenance(source, snapshot, elicitation, imported, configured || {});
  const ledger = attributionPolicy ? policyLedger(rawLedger, snapshot, elicitation, attributionPolicy) : rawLedger;
  const body = { version: attributionPolicy ? "completed-spec-v4" : VERSION, sourceHash: hash(String(source || "")), snapshot, elicitation, imported,
    ...(attributionPolicy ? { attributionPolicy } : {}),
    ...(configured ? { configuration: configured } : {}), ...ledger };
  const fingerprint = hash(body);
  return { ...body, hash: fingerprint,
    revision: previous?.hash === fingerprint ? previous.revision : (Number(previous?.revision) || 0) + 1,
    previousHash: previous && previous.hash !== fingerprint ? previous.hash : previous?.previousHash || null };
}

export function assessDesignContract(source, spec, elicit, configuration) {
  const record = spec?._designContract;
  if (!record) return null; // Legacy checkpoints are never silently adopted.
  const issues = [];
  if (![VERSION, "completed-spec-v4"].includes(record.version) || !record.snapshot || !record.elicitation
      || record.version === "completed-spec-v4" && !record.attributionPolicy) {
    return { hash: record.hash, issues: [{ id: "CONTRACT", reason: "Unsupported completed-specification record; rerun Spec" }], assumptions: [] };
  }
  const rawLedger = provenance(source, record.snapshot, record.elicitation, record.imported, record.configuration);
  const policy = record.version === "completed-spec-v4" ? record.attributionPolicy : null;
  const ledger = policy ? policyLedger(rawLedger, record.snapshot, record.elicitation, policy) : rawLedger;
  const body = { version: record.version, sourceHash: hash(String(source || "")), snapshot: record.snapshot,
    elicitation: record.elicitation, imported: record.imported,
    ...(policy ? { attributionPolicy: policy } : {}),
    ...(record.configuration ? { configuration: record.configuration } : {}), ...ledger };
  if (configuration && record.configuration && configuration.requiredModuleName !== record.configuration.requiredModuleName) {
    issues.push({ id: "CONFIGURATION", reason: "External module-name configuration changed after contract freeze; rerun Spec" });
  }
  if (policy && configuration) {
    const current = resolveAttributionPolicy(configuration);
    if (current.requested !== policy.requested || current.effective !== policy.effective) {
      issues.push({ id: "ATTRIBUTION_POLICY", code: "POLICY_CHANGED",
        reason: "Attribution policy changed after contract freeze; rerun Spec to record a revision" });
    }
  }
  if (hash(body) !== record.hash || hash(specificationSnapshot(spec)) !== hash(record.snapshot)
      || elicit && hash(elicitationSnapshot(elicit)) !== hash(record.elicitation)) {
    issues.push({ id: "CONTRACT", reason: "Specification or elicitation changed after contract freeze; rerun Spec and downstream verification" });
  }
  return { hash: record.hash, revision: record.revision, issues: issues.concat(ledger.issues),
    ...(policy ? { attributionPolicy: policy } : {}),
    entries: ledger.entries, assumptions: ledger.entries.filter(e => ["auto_assumption", "interpretation"].includes(e.kind)),
    scope: "completed-specification" };
}

export function designContractPrompt(source, spec, elicit) {
  const contract = assessDesignContract(source, spec, elicit);
  if (!contract) return "";
  if (generationBlockingIssues(contract).length) return "\nCOMPLETED SPECIFICATION BLOCKED:\n" + JSON.stringify(contract.issues);
  return "\n\nFROZEN COMPLETED SPECIFICATION (" + contract.hash + ", revision " + contract.revision + ")\n"
    + JSON.stringify({ specification: specificationSnapshot(spec), provenance: contract.entries })
    + (contract.issues.length ? "\nPROVISIONAL GENERATION ONLY: attribution remains unresolved. Rejected quotations are not user evidence. "
      + "Implement the frozen provisional behavior without claiming it is user-confirmed or verified. Verification-plan requirements describe checks; they cannot override behavioral requirements. "
      + JSON.stringify(contract.issues) : "")
    + "\nThis contract includes explicit user facts and recorded implementation choices. Auto-selected assumptions are binding choices for this version, not quotations or confirmed user intent. "
    + "Derive independent checks from this contract, never from DUT behavior. Preserve original source examples. "
    + "Do not change the choices or expected results during RTL/checker repair. A changed choice requires a new Spec revision and fresh downstream evidence. "
    + "Assumed design behavior must be ASSERTED. Formal assume/restrict may constrain only separately recorded environmental inputs, never DUT outputs or desired outcomes.";
}

export function checkerDescription(st) {
  return String(st._userDesc || "") + designContractPrompt(st._userDesc, st.spec, st.elicit);
}

export function specQualificationError(spec) {
  const issues = generationBlockingIssues(spec?._designContract);
  if (!issues.length) return null;
  return Object.assign(new Error("Specification attribution requires review: "
    + issues.map(i => i.id + ": " + i.reason).join("; ")), { code: "SPEC_ATTRIBUTION_UNRESOLVED", spec });
}

export function checkerInputHash(st, header) {
  return djb2(checkerDescription(st) + "\n" + independentCheckerHeader(st, header));
}

export function independentCheckerHeader(st, fallback = "") {
  if (!st.spec?._designContract) return String(fallback || "");
  const spec = st.spec;
  const params = (spec.params || []).map(p => "parameter " + p.name + " = " + (p.def ?? 0));
  const ports = (spec.iface || []).map(p => {
    const width = String(p.width || "1").trim();
    const range = width === "1" ? "" : width.startsWith("[") ? width : "[(" + width + ")-1:0]";
    return p.dir + " logic " + range + " " + p.name;
  });
  return "module " + spec.modName + (params.length ? " #(" + params.join(", ") + ")" : "") + " (" + ports.join(", ") + ");";
}
