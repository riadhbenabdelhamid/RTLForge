// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { callLLMJson } from "../llm/index.js";
import { inspectCitation } from "./sourceAttribution.js";
import { djb2 } from "../utils/hash.js";

const norm = value => String(value || "").replace(/\s+/g, " ").trim();
const refOf = req => req.provenance?.ref || String(req.rat || "").match(/\b[A-Z]+-\d+\b/)?.[0];
function requirementHash(reqs) {
  const normalized = reqs.map(req => Object.fromEntries(Object.entries(req)
    .filter(([key]) => !key.startsWith("_")).sort(([a], [b]) => a.localeCompare(b))));
  return djb2(JSON.stringify(normalized));
}
const autoSelected = a => a?.confirmationOrigin === "automatic" && a.confirmed === true && !norm(a.revised);

function resolutionEvidence(source, spec, elicit, conflict) {
  const r = conflict?.resolution;
  if (conflict?.status !== "resolved" || r?.kind !== "supersede_assumption" || !norm(r.reason)
      || !Array.isArray(r.requirementIds) || !r.requirementIds.length) return false;
  const assumption = elicit?.assumptions?.find(a => a.id === r.assumptionId);
  if (!assumption || assumption.confirmationOrigin !== "automatic" || assumption.confirmed !== false
      || norm(assumption.revised) || assumption.text !== r.previousText
      || assumption.supersededBy?.conflictId !== conflict.id) return false;
  const reqs = r.requirementIds.map(id => spec.requirements?.find(req => req.id === id));
  if (reqs.some(req => !req) || new Set(r.requirementIds).size !== reqs.length
      || requirementHash(reqs) !== r.requirementsHash
      || (spec.requirements || []).some(req => refOf(req) === r.assumptionId)) return false;
  if (JSON.stringify(assumption.supersededBy.requirementIds) !== JSON.stringify(r.requirementIds)) return false;
  // An automatic hypothesis can yield to supported requirements. Another
  // unsupported hypothesis is not authority for silently replacing it.
  if (reqs.some(req => { const c = inspectCitation(source, req, spec); return !c.valid || c.provisional; })) return false;
  const evidence = inspectCitation(source, { sources: r.sources, desc: "Conflict resolution evidence" }, spec);
  return evidence.valid && !evidence.provisional;
}

export function conflictQualificationIssues(source, spec, elicit) {
  return (spec.conflicts || []).filter(c => !resolutionEvidence(source, spec, elicit, c)).map(c => ({
    id: "SPEC-CONFLICT", reason: typeof c === "string" ? c : String(c?.reason || c?.description || "Unresolved specification conflict"),
    ...(c?.id ? { conflictId: c.id } : {}),
  }));
}

// Apply only reviewed supersessions of untouched automatic assumptions. No
// requirement, explicit answer, interface, or user revision can be edited.
export function applyConflictResolutions(source, spec, elicit, response) {
  const audit = { decisions: [] };
  const unchanged = () => ({ spec: { ...spec, _conflictReconciliation: audit }, elicit });
  if (!response || Object.keys(response).some(k => k !== "resolutions") || !Array.isArray(response.resolutions)) return unchanged();
  const ids = response.resolutions.map(r => r?.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !spec.conflicts?.some(c => c.id === id))) return unchanged();
  let nextSpec = spec, nextElicit = elicit;
  for (const r of response.resolutions) {
    const decision = { id: r.id, adopted: false, reason: r.reason || "No supported resolution" };
    audit.decisions.push(decision);
    if (Object.keys(r).some(k => !["id", "kind", "assumptionId", "previousText", "requirementIds", "sources", "reason"].includes(k))
        || r.kind !== "supersede_assumption") continue;
    const assumption = nextElicit?.assumptions?.find(a => a.id === r.assumptionId);
    if (!autoSelected(assumption) || assumption.text !== r.previousText || !Array.isArray(r.requirementIds)) continue;
    const reqs = r.requirementIds.map(id => spec.requirements?.find(req => req.id === id));
    if (reqs.some(req => !req)) continue;
    const evidence = inspectCitation(source, { sources: r.sources, desc: "Conflict resolution evidence" }, spec);
    const resolved = { ...spec.conflicts.find(c => c.id === r.id), status: "resolved",
      resolution: { ...r, sources: evidence.spans, requirementsHash: requirementHash(reqs) } };
    const candidateElicit = { ...nextElicit, assumptions: nextElicit.assumptions.map(a => a !== assumption ? a : {
      ...a, confirmed: false, supersededBy: { conflictId: r.id, requirementIds: r.requirementIds, reason: r.reason },
    }) };
    if (!resolutionEvidence(source, spec, candidateElicit, resolved)) continue;
    nextSpec = { ...nextSpec, conflicts: nextSpec.conflicts.map(c => c.id === r.id ? resolved : c) };
    nextElicit = candidateElicit;
    decision.adopted = true;
  }
  return { spec: { ...nextSpec, _conflictReconciliation: audit }, elicit: nextElicit };
}

export async function reconcileSpecConflicts(st, spec, config) {
  if (!st._config?.specReask || st._specImport || !spec.conflicts?.length
      || !(st.elicit?.assumptions || []).some(autoSelected)) return { spec, elicit: st.elicit, llms: [] };
  const prompt = {
    systemPrompt: "Review a specification conflict using only the original description and recorded decisions. Return one JSON object.",
    userMessage: "Reconcile conflicts BEFORE freezing this specification. No RTL or test outcomes are available.\n"
      + JSON.stringify({ description: st._userDesc, elicitation: { assumptions: st.elicit.assumptions,
        questions: st.elicit.questions, answers: st.elicit.answers, customAnswers: st.elicit.customAnswers },
        specification: { requirements: spec.requirements, iface: spec.iface, conflicts: spec.conflicts } })
      + '\nAn untouched automatic assumption may be superseded when the existing source-supported requirements already correct it. '
      + 'Identify the old assumption and the existing replacement requirement ids; explain the contradiction with exact source passages. '
      + 'Do not edit requirements, replace one unsupported guess with another, override explicit answers or user revisions, or resolve incompatible explicit requirements. '
      + 'Only assumptions with confirmationOrigin="automatic" are eligible. Otherwise return kind="unresolved". '
      + 'Return {"resolutions":[{"id":"existing conflict id","kind":"supersede_assumption | unresolved",'
      + '"assumptionId":"existing assumption id or empty","previousText":"exact existing text or empty",'
      + '"requirementIds":["existing replacement requirement id"],"sources":[{"quote":"exact source passage"}],"reason":"explanation"}]}',
    config, maxTokens: config._maxTokens, onChunk: st._onLog, signal: st._signal,
  };
  try {
    const result = await callLLMJson(prompt, { parseRetries: 0 });
    return { ...applyConflictResolutions(st._userDesc, spec, st.elicit, result.data),
      llms: (result.llms || []).map(r => ({ ...r, purpose: "spec_conflict_reconciliation" })) };
  } catch (error) {
    if (st._signal?.aborted || error?.name === "AbortError") throw error;
    return { spec: { ...spec, _conflictReconciliation: { error: String(error.message || error), decisions: [] } },
      elicit: st.elicit, llms: error.llms || [] };
  }
}
