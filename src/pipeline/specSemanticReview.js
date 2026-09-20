// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { callLLMJson } from "../llm/index.js";
import { inspectCitation } from "./sourceAttribution.js";
import { promptSpecSemantics } from "../prompts/specSemantics.js";
import { djb2 } from "../utils/hash.js";

const copy = value => JSON.parse(JSON.stringify(value));
const text = value => typeof value === "string" && value.trim().length > 0;
const refOf = req => req.provenance?.ref || String(req.rat || "").match(/\b[A-Z]+-\d+\b/)?.[0];
const automatic = a => a?.confirmed === true && a.confirmationOrigin === "automatic";
const hash = value => djb2(JSON.stringify(value));
const only = (obj, keys) => obj && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).every(k => keys.includes(k));
const unique = xs => new Set(xs).size === xs.length;
const norm = value => String(value || "").replace(/\s+/g, " ").trim();
const sourceCorrectionKinds = ["scope", "mapping", "transcription"];
const sourceExtraction = req => req?.provenance?.kind === "source"
  || req && !req.provenance?.kind && (text(req.src) || req.sources?.length);

function passages(source, sources) {
  if (!Array.isArray(sources) || !sources.length || sources.length > 16) return null;
  const evidence = inspectCitation(source, { desc: "Semantic review evidence", sources });
  return evidence.valid && !evidence.provisional ? evidence.spans : null;
}

export function semanticEditability(spec, elicit = {}, source = "") {
  return (spec.requirements || []).map(req => {
    const ref = refOf(req), assumption = elicit.assumptions?.find(a => a.id === ref);
    const question = elicit.questions?.find(q => q.id === ref);
    const references = new Set([ref, ...String(req.rat || "").split(/[^\w-]+/),
      ...String(req.provenance?.reasoning || "").split(/[^\w-]+/)]);
    const protectedChoice = Object.keys(elicit.answers || {}).some(id => references.has(id) && elicit.answers[id])
      || (elicit.assumptions || []).some(a => references.has(a.id) && !automatic(a));
    // Source text is authority; a generated provenance label is only a claim.
    // Literal source statements and actual user decisions remain immutable.
    const literalStatement = norm(req.desc) && norm(source).includes(norm(req.desc));
    const eligible = !spec._designContract?.imported && !literalStatement
      && ["Functionality", "Timing", "Error", "Verification"].includes(req.cat)
      && !["user_answer", "user_revision", "user_specification", "configuration"].includes(req.provenance?.kind)
      && !protectedChoice;
    const inferred = ["interpretation", "assumption"].includes(req.provenance?.kind)
      || automatic(assumption) || question && !elicit.answers?.[ref]
      || !req.src && /default|assum/i.test(req.rat || "");
    const derived = req.provenance?.kind === "derived" || /derived/i.test(req.rat || "");
    return { id: req.id, mode: !eligible ? "protected" : req.cat === "Verification" ? "dependent"
      : sourceExtraction(req) ? "extraction" : inferred ? "inference" : derived ? "dependent" : "protected" };
  });
}

// This validator controls edit scope, not semantic entailment. A second source
// review must authorize the proposal before it can replace any requirement.
export function semanticProposal(source, spec, elicit, response) {
  const findings = [];
  const fail = reason => ({ valid: false, reason, findings });
  if (!only(response, ["findings", "repairs", "decisions"])
      || ![response.findings, response.repairs, response.decisions].every(Array.isArray)
      || response.findings.length > 16 || response.repairs.length > 32 || response.decisions.length > 16) return fail("Invalid review schema");
  const reqs = spec.requirements || [], ids = reqs.map(r => r.id);
  if (!unique(ids) || !unique(response.findings.map(f => f?.id))
      || !unique(response.repairs.map(r => r?.id))
      || !unique(response.decisions.map(d => d?.kind + ":" + d?.id))) return fail("Duplicate identifiers");
  for (const f of response.findings) {
    const sources = passages(source, f?.sources);
    if (!only(f, ["id", "kind", "requirementIds", "reason", "sources", "witness"])
        || !text(f.id) || !["label_mapping", "source_scope", "default_scope", "contradiction", "attribution"].includes(f.kind)
        || !text(f.reason) || !sources || !Array.isArray(f.requirementIds) || !f.requirementIds.length
        || !unique(f.requirementIds) || f.requirementIds.some(id => !ids.includes(id))
        || !only(f.witness, ["situation", "required", "inferred"])
        || ![f.witness.situation, f.witness.required, f.witness.inferred].every(text)) return fail("Finding lacks a known requirement, source evidence, or concrete witness");
    findings.push({ ...f, sources });
  }
  const modes = new Map(semanticEditability(spec, elicit, source).map(e => [e.id, e.mode]));
  const changedIds = response.repairs.map(r => r.id);
  // Omitted dependencies mean a root correction. Dependent requirements still
  // require explicit links below; never invent a verification dependency.
  const repairRows = response.repairs.map(r => r.dependsOn === undefined ? { ...r, dependsOn: [] } : r);
  const sourceCorrections = [];
  const candidate = copy(spec), decisions = copy(elicit), affected = new Set(findings.flatMap(f => f.requirementIds));
  for (const r of repairRows) {
    const original = reqs.find(req => req.id === r?.id), sources = passages(source, r?.sources);
    const sourceCorrection = sourceExtraction(original);
    if (!only(r, ["id", "previousDescription", "description", "dependsOn", "reasoning", "sources", "sourceCorrection"])
        || !original || !affected.has(r.id) || original.desc !== r.previousDescription
        || !text(r.description) || r.description === original.desc || !text(r.reasoning) || !sources
        || !Array.isArray(r.dependsOn) || !unique(r.dependsOn)
        || modes.get(r.id) === "protected" || modes.get(r.id) === "dependent" && !r.dependsOn.length
        || r.dependsOn.some(id => id === r.id || !changedIds.includes(id))
        || sourceCorrection && !sourceCorrectionKinds.includes(r.sourceCorrection)
        || r.sourceCorrection != null && !sourceCorrectionKinds.includes(r.sourceCorrection)) return fail("Repair changes protected behavior or lacks a checked source correction or dependency");
    if (sourceCorrection) sourceCorrections.push({ id: r.id, kind: r.sourceCorrection });
    const replacement = { ...original, desc: r.description, src: "", sources: [],
      rat: "[LLM interpretation — source-based semantic revision] " + r.reasoning,
      provenance: { kind: "interpretation", reasoning: r.reasoning, sources,
        ...(original.provenance?.alternatives ? { alternatives: original.provenance.alternatives } : {}),
        ...(refOf(original) && (elicit.assumptions?.some(a => a.id === refOf(original))
          || elicit.questions?.some(q => q.id === refOf(original))) ? { ref: refOf(original) } : {}) },
      _revisedFrom: { description: original.desc, src: original.src, sources: original.sources,
        provenance: original.provenance, reason: r.reasoning, supportingSources: sources,
        ...(sourceCorrection ? { sourceCorrection: r.sourceCorrection } : {}) } };
    if (!inspectCitation(source, replacement, spec).valid) return fail("Replacement attribution is invalid");
    candidate.requirements = candidate.requirements.map(req => req.id === r.id ? replacement : req);
  }
  // All changed derivations (including verification plans) must lead back to
  // a changed behavioral requirement. Reject cycles and disconnected plans.
  const repairs = new Map(repairRows.map(r => [r.id, r]));
  const rooted = new Map();
  function behavioralRoot(id, visiting = new Set()) {
    if (visiting.has(id)) return false;
    if (rooted.has(id)) return rooted.get(id);
    const r = repairs.get(id);
    if (!r) return false;
    const valid = r.dependsOn.length
      ? r.dependsOn.every(parent => behavioralRoot(parent, new Set([...visiting, id])))
      : ["inference", "extraction"].includes(modes.get(id));
    rooted.set(id, valid);
    return valid;
  }
  if (repairRows.some(r => !behavioralRoot(r.id))) return fail("Repair dependencies lack an acyclic behavioral root");
  for (const d of response.decisions) {
    const sources = passages(source, d?.sources);
    const assumption = decisions.assumptions?.find(a => a.id === d?.id);
    const question = decisions.questions?.find(q => q.id === d?.id);
    const current = d?.kind === "assumption" ? assumption?.revised || assumption?.text : question?.recommended;
    const linked = reqs.some(req => changedIds.includes(req.id) && (refOf(req) === d?.id
      || String(req.provenance?.reasoning || "").split(/[^\w-]+/).includes(d?.id)));
    if (!only(d, ["kind", "id", "previousText", "replacementText", "reason", "sources"])
        || !["assumption", "recommendation"].includes(d.kind) || !text(d.replacementText)
        || current !== d.previousText || current === d.replacementText || !text(d.reason) || !sources
        || d.kind === "assumption" && !automatic(assumption)
        || d.kind === "recommendation" && (!question || decisions.answers?.[d.id])
        || !linked) return fail("Cannot revise an explicit, unrelated, or unknown elicitation decision");
    const item = d.kind === "assumption" ? assumption : question;
    item._semanticRevisions = [...(item._semanticRevisions || []), { previousText: current,
      replacementText: d.replacementText, reason: d.reason, sources }];
    if (d.kind === "assumption") item.revised = d.replacementText;
    else item.recommended = d.replacementText;
  }
  // An independent check must see both the changed requirements AND the
  // still-selected decisions, so stale assumptions cannot hide behind a patch.
  return { valid: true, findings, spec: candidate, elicit: decisions, changedIds,
    sourceCorrections, decisionChanges: response.decisions, changed: changedIds.length > 0 };
}

function reviewInputs(st, spec, elicit) {
  return { description: st._userDesc || "", elicitation: {
    assumptions: elicit.assumptions || [], questions: elicit.questions || [],
    answers: elicit.answers || {}, customAnswers: elicit.customAnswers || {} },
  specification: { modName: spec.modName, iface: spec.iface, params: spec.params,
    requirements: spec.requirements, conflicts: spec.conflicts || [] },
  editability: semanticEditability(spec, elicit, st._userDesc) };
}

// Interpret each finding separately. A rejected diagnosis must not prevent a
// different, independently checked correction, or become a source conflict.
function confirmProposal(source, spec, proposal, confirmation) {
  const fail = reason => ({ valid: false, reason });
  const ids = proposal.findings.map(f => f.id), reqIds = (spec.requirements || []).map(r => r.id);
  const legacy = confirmation?.findings === undefined;
  const keys = legacy ? ["decision", "reason", "checkedRequirementIds", "explicitRequirementsPreserved", "confirmedFindingIds"]
    : ["reason", "checkedRequirementIds", "explicitRequirementsPreserved", "findings", "sourceCorrections"];
  if (!only(confirmation, keys) || !text(confirmation.reason)
      || !Array.isArray(confirmation.checkedRequirementIds) || !unique(confirmation.checkedRequirementIds)
      || confirmation.checkedRequirementIds.some(id => !reqIds.includes(id))
      || typeof confirmation.explicitRequirementsPreserved !== "boolean") return fail("Invalid independent semantic confirmation");
  let outcomes;
  if (legacy) {
    // Preserve unambiguous older responses, but never infer mixed dispositions
    // from prose or equate an omitted finding with an unresolved contradiction.
    const confirmed = confirmation.confirmedFindingIds;
    if (!["accept", "reject", "needs_clarification"].includes(confirmation.decision)
        || !Array.isArray(confirmed) || !unique(confirmed) || confirmed.some(id => !ids.includes(id))
        || confirmation.decision === "accept" && confirmed.length !== ids.length
        || confirmation.decision === "reject" && confirmed.length) return fail("Legacy mixed confirmation requires explicit finding outcomes");
    outcomes = ids.map(id => ({ id, status: confirmation.decision === "reject" ? "rejected"
      : confirmation.decision === "accept" ? "resolved" : "unresolved", reason: confirmation.reason,
    confirmed: confirmed.includes(id) }));
  } else {
    if (!Array.isArray(confirmation.findings) || confirmation.findings.length !== ids.length
        || !unique(confirmation.findings.map(f => f?.id))) return fail("Confirmation must address every finding exactly once");
    outcomes = [];
    for (const f of confirmation.findings) {
      if (!only(f, ["id", "status", "reason"]) || !ids.includes(f.id)
          || !["resolved", "rejected", "unresolved"].includes(f.status) || !text(f.reason)) return fail("Invalid finding outcome");
      outcomes.push({ ...f, confirmed: f.status !== "rejected" });
    }
  }
  const sourceChecks = confirmation.sourceCorrections || [];
  if (!Array.isArray(sourceChecks) || sourceChecks.length > proposal.sourceCorrections.length
      || !unique(sourceChecks.map(c => c?.id))) return fail("Invalid source correction confirmation");
  for (const c of sourceChecks) {
    const expected = proposal.sourceCorrections.find(e => e.id === c?.id);
    if (!only(c, ["id", "kind", "reason", "sources"]) || !expected || c.kind !== expected.kind
        || !text(c.reason) || !passages(source, c.sources)) return fail("Source correction lacks independent source evidence");
  }
  const resolved = proposal.findings.filter(f => outcomes.find(o => o.id === f.id)?.status === "resolved");
  const supportedIds = new Set(resolved.flatMap(f => f.requirementIds));
  const complete = confirmation.explicitRequirementsPreserved
    && proposal.changedIds.every(id => confirmation.checkedRequirementIds.includes(id) && supportedIds.has(id))
    && resolved.every(f => f.requirementIds.some(id => proposal.changedIds.includes(id)))
    && sourceChecks.length === proposal.sourceCorrections.length;
  const behavioralConflict = outcomes.some(o => o.status === "unresolved"
    && proposal.findings.find(f => f.id === o.id).kind !== "attribution");
  const adopt = proposal.changed && complete && !behavioralConflict;
  const discarded = outcomes.every(f => f.status === "rejected");
  // A resolved diagnosis describes the proposed spec. If its correction could
  // not be adopted atomically, the confirmed defect remains in the original.
  const findingOutcomes = outcomes.map(o => ({ id: o.id,
    status: o.status === "resolved" && !adopt ? "unresolved" : o.status,
    reason: o.reason, ...(o.status === "resolved" && !adopt ? { adoptionBlocked: true } : {}) }));
  const blocking = proposal.findings.filter(f => f.kind !== "attribution"
    && outcomes.some(o => o.id === f.id && o.confirmed && o.status !== "rejected")
    && findingOutcomes.some(o => o.id === f.id && o.status === "unresolved"));
  return { valid: true, adopt, discarded, findingOutcomes, blocking };
}

export async function reviewSpecSemantics(st, spec, config, { force = false, diagnosis = null } = {}) {
  const elicit = st.elicit || {};
  if (st._specImport || spec._designContract?.imported || !force && (st._config?.specSemanticReview !== true
      || !semanticEditability(spec, elicit, st._userDesc).some(e => e.mode !== "protected"))) return { spec, elicit, llms: [] };
  const inputs = reviewInputs(st, spec, elicit), llms = [];
  const audit = { version: 2, inputHash: hash(inputs), status: "UNAVAILABLE", diagnosis,
    originalRequirements: copy(spec.requirements || []) };
  const retain = () => ({ spec: { ...spec, _semanticReview: audit }, elicit, llms });
  async function call(prompt, purpose) {
    const result = await callLLMJson({ ...prompt, config, maxTokens: config._maxTokens,
      onChunk: st._onLog, signal: st._signal }, { parseRetries: 0 });
    llms.push(...(result.llms || []).map(r => ({ ...r, purpose })));
    return result.data;
  }
  try {
    st._onLog?.("↻ SPEC SEMANTIC REVIEW — checking inferred behavior against the source before freezing.");
    const response = await call(promptSpecSemantics({ ...inputs, diagnosis }), "spec_semantic_review");
    audit.response = response;
    const proposal = semanticProposal(st._userDesc, spec, elicit, response);
    audit.findings = proposal.findings;
    audit.findingOutcomes = proposal.findings.map(f => ({ id: f.id, status: "unresolved",
      reason: "No valid independent disposition recorded; this is not a confirmed source conflict." }));
    if (!proposal.valid) { audit.reason = proposal.reason; return retain(); }
    if (!proposal.findings.length) {
      if (proposal.changed || proposal.decisionChanges.length) { audit.reason = "Unjustified changes without findings"; return retain(); }
      audit.status = "REVIEWED"; return retain();
    }
    const confirmation = await call(promptSpecSemantics(inputs, {
      findings: proposal.findings, specification: reviewInputs(st, proposal.spec, proposal.elicit).specification,
      elicitation: reviewInputs(st, proposal.spec, proposal.elicit).elicitation,
      changedRequirementIds: proposal.changedIds, sourceCorrections: proposal.sourceCorrections,
    }), "spec_semantic_confirmation");
    audit.confirmation = confirmation;
    const checked = confirmProposal(st._userDesc, spec, proposal, confirmation);
    if (!checked.valid) { audit.reason = checked.reason; return retain(); }
    audit.findingOutcomes = checked.findingOutcomes;
    if (checked.discarded) { audit.status = "REJECTED"; return retain(); }
    if (checked.adopt) {
      audit.status = "REPAIRED"; audit.changedRequirementIds = proposal.changedIds;
      audit.decisionChanges = proposal.decisionChanges;
      audit.resultHash = hash(reviewInputs(st, proposal.spec, proposal.elicit));
      st._onLog?.("SPEC SEMANTIC REVIEW — accepted a source-reviewed correction to " + proposal.changedIds.join(", ") + "; user decisions and interface preserved.");
      return { spec: { ...proposal.spec, _semanticReview: audit }, elicit: proposal.elicit, llms };
    }
    // Only independently confirmed conflicts become blocking. A failed call
    // or malformed response cannot manufacture a contradiction or erase RTL.
    audit.status = checked.blocking.length ? "UNRESOLVED" : "UNAVAILABLE";
    st._onLog?.("SPEC SEMANTIC REVIEW — " + audit.status + "; original requirements retained."
      + (checked.blocking.length ? " Confirmed conflicts require specification review." : " No semantic approval recorded."));
    const conflicts = checked.blocking.map(f => ({ id: "SEMANTIC-" + hash(f), status: "unresolved",
      description: f.reason, requirementIds: f.requirementIds, sources: f.sources, witness: f.witness }));
    return { spec: { ...spec, conflicts: [...(spec.conflicts || []), ...conflicts], _semanticReview: audit }, elicit, llms };
  } catch (error) {
    if (st._signal?.aborted || error?.name === "AbortError") throw error;
    audit.reason = String(error.message || error);
    llms.push(...(error.llms || []));
    st._onLog?.("⚠ SPEC SEMANTIC REVIEW unavailable — original requirements retained; no semantic approval recorded.");
    return retain();
  }
}
