// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { djb2 } from "../utils/hash.js";
import { nonNormativeContext } from "../utils/interfaceContract.js";

const VERSION = "completed-spec-v1";
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => djb2(JSON.stringify(value));
const norm = value => String(value || "").replace(/\s+/g, " ").trim();

// Only specification inputs belong in this snapshot: no RTL, testbench,
// measurements, model-written qualification metadata, or repair feedback.
export function specificationSnapshot(spec = {}) {
  return clone({ modName: spec.modName || "", iface: spec.iface || [], params: spec.params || [],
    requirements: (spec.requirements || []).map(r => Object.fromEntries(
      Object.entries(r || {}).filter(([k]) => !k.startsWith("_")).sort(([a], [b]) => a.localeCompare(b)))),
    conflicts: spec.conflicts || [] });
}

export function elicitationSnapshot(elicit = {}) {
  return clone({ questions: elicit.questions || [], answers: elicit.answers || {},
    customAnswers: elicit.customAnswers || {}, assumptions: elicit.assumptions || [] });
}

function quotedSource(source, quote) {
  if (!norm(quote)) return false;
  const pattern = norm(quote).split(" ").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return [...String(source || "").matchAll(new RegExp(pattern, "g"))]
    .some(m => !nonNormativeContext(source, m.index, { defectsOnly: true }));
}

function provenance(source, snapshot, elicitation, imported) {
  const entries = [], issues = [];
  for (const req of snapshot.requirements) {
    if (!req.id || !norm(req.desc)) {
      issues.push({ id: req.id || "REQUIREMENT", reason: "Requirement needs an identifier and behavior description" }); continue;
    }
    const base = { id: req.id, description: req.desc || "", rationale: req.rat || "",
      environment: req.environment === true };
    const rat = String(req.rat || "");
    const ref = req.provenance?.ref || rat.match(/\b[A-Z]+-\d+\b/)?.[0];
    const assumption = elicitation.assumptions.find(a => a.id === ref);
    const question = elicitation.questions.find(q => q.id === ref);
    const answer = question && elicitation.answers[ref];
    if (imported) { entries.push({ ...base, kind: "user_specification" }); continue; }
    if (quotedSource(source, req.src)) {
      entries.push({ ...base, kind: req.provenance?.kind === "derived" || /derived/i.test(rat) ? "derived" : "source",
        quote: req.src });
      continue;
    }
    // A nonliteral quotation must be corrected, not laundered into an
    // automatically accepted assumption merely because its citation failed.
    if (norm(req.src)) {
      issues.push({ id: req.id, reason: "Citation is absent from normative source text; correct attribution before freezing the contract" });
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
    // Interface fidelity is independently checked against the user's literal
    // interface. Do not force an extra quotation for each copied port.
    if (/^REQ-INTF-/.test(req.id || "") || req.cat === "Interface") {
      entries.push({ ...base, kind: "interface" }); continue;
    }
    issues.push({ id: req.id, reason: "Requirement has no source, explicit answer, or recorded implementation assumption" });
  }
  for (const conflict of snapshot.conflicts) issues.push({ id: "SPEC-CONFLICT", reason: String(conflict.reason || conflict) });
  return { entries, issues };
}

// Called only at the Spec stage boundary, after fidelity/coverage/citation
// checks. Other stages validate this record; they cannot silently reseal it.
export function sealDesignContract(source, spec, elicit, previous, { imported = false } = {}) {
  const snapshot = specificationSnapshot(spec), elicitation = elicitationSnapshot(elicit);
  const ledger = provenance(source, snapshot, elicitation, imported);
  const body = { version: VERSION, sourceHash: hash(String(source || "")), snapshot, elicitation, imported, ...ledger };
  const fingerprint = hash(body);
  return { ...body, hash: fingerprint,
    revision: previous?.hash === fingerprint ? previous.revision : (Number(previous?.revision) || 0) + 1,
    previousHash: previous && previous.hash !== fingerprint ? previous.hash : previous?.previousHash || null };
}

export function assessDesignContract(source, spec, elicit) {
  const record = spec?._designContract;
  if (!record) return null; // Legacy checkpoints are never silently adopted.
  const issues = [];
  if (record.version !== VERSION || !record.snapshot || !record.elicitation) {
    return { hash: record.hash, issues: [{ id: "CONTRACT", reason: "Unsupported completed-specification record; rerun Spec" }], assumptions: [] };
  }
  const ledger = provenance(source, record.snapshot, record.elicitation, record.imported);
  const body = { version: VERSION, sourceHash: hash(String(source || "")), snapshot: record.snapshot,
    elicitation: record.elicitation, imported: record.imported, ...ledger };
  if (hash(body) !== record.hash || hash(specificationSnapshot(spec)) !== hash(record.snapshot)
      || elicit && hash(elicitationSnapshot(elicit)) !== hash(record.elicitation)) {
    issues.push({ id: "CONTRACT", reason: "Specification or elicitation changed after contract freeze; rerun Spec and downstream verification" });
  }
  return { hash: record.hash, revision: record.revision, issues: issues.concat(ledger.issues),
    entries: ledger.entries, assumptions: ledger.entries.filter(e => e.kind === "auto_assumption"),
    scope: "completed-specification" };
}

export function designContractPrompt(source, spec, elicit) {
  const contract = assessDesignContract(source, spec, elicit);
  if (!contract) return "";
  if (contract.issues.length) return "\nCOMPLETED SPECIFICATION BLOCKED:\n" + JSON.stringify(contract.issues);
  return "\n\nFROZEN COMPLETED SPECIFICATION (" + contract.hash + ", revision " + contract.revision + ")\n"
    + JSON.stringify({ specification: specificationSnapshot(spec), provenance: contract.entries })
    + "\nThis contract includes explicit user facts and recorded implementation choices. Auto-selected assumptions are binding choices for this version, not quotations or confirmed user intent. "
    + "Derive independent checks from this contract, never from DUT behavior. Preserve original source examples. "
    + "Do not change the choices or expected results during RTL/checker repair. A changed choice requires a new Spec revision and fresh downstream evidence. "
    + "Assumed design behavior must be ASSERTED. Formal assume/restrict may constrain only separately recorded environmental inputs, never DUT outputs or desired outcomes.";
}

export function checkerDescription(st) {
  return String(st._userDesc || "") + designContractPrompt(st._userDesc, st.spec, st.elicit);
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
