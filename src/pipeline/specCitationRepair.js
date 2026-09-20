// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { callLLMJson } from "../llm/index.js";
import { djb2 } from "../utils/hash.js";
import { promptSpecCitationRepair } from "../prompts/specCitationRepair.js";
import { inspectCitation, interfaceCitation, interfaceFact } from "./sourceAttribution.js";

// This narrow repair uses an actual execution input, never model-authored
// metadata as authority. Behavioral requirements cannot use this exception.
export function attributeConfiguredInterface(st, spec) {
  const name = st._config?.requiredModuleName;
  if (!name || st._specImport || spec.modName !== name) return spec;
  const decisions = [];
  const requirements = (spec.requirements || []).map(req => {
    const fact = interfaceFact(req);
    if (fact?.kind !== "module" || fact.name !== name || inspectCitation(st._userDesc, req, spec).valid) return req;
    decisions.push({ id: req.id, originalSrc: req.src, originalSources: req.sources,
      origin: "run-configuration", key: "requiredModuleName", value: name });
    return { ...req, src: "", sources: [], provenance: { kind: "configuration", key: "requiredModuleName",
      reasoning: "The exported module name is required by the run configuration; it is not a quotation from the description." } };
  });
  return decisions.length ? { ...spec, requirements, _configurationAttribution: decisions } : spec;
}

export function invalidSpecCitations(source, spec) {
  if (!String(source || "").trim()) return [];
  return (spec?.requirements || []).filter(r => {
    const citation = inspectCitation(String(source), r, spec);
    return citation.claimed && !citation.valid;
  });
}

// Separate, valid passages already carry all the source text. Canonicalizing
// the redundant legacy field cannot change behavior or fabricate evidence.
export function normalizeCitationPassages(source, spec) {
  const decisions = [];
  const requirements = (spec.requirements || []).map(req => {
    const before = inspectCitation(source, req, spec);
    if (before.reason !== "legacy src must match one source passage, not concatenate separate quotations") return req;
    const candidate = { ...req, src: req.sources[0]?.quote };
    const after = inspectCitation(source, candidate, spec);
    if (!after.valid) return req;
    decisions.push({ id: req.id, originalSrc: req.src, sources: after.spans, reason: "Canonicalized legacy src to the first validated passage; behavior unchanged" });
    return { ...candidate, src: after.spans[0].quote, sources: after.spans };
  });
  return decisions.length ? { ...spec, requirements,
    _citationNormalization: [...(spec._citationNormalization || []), ...decisions] } : spec;
}

export function applyCitationRepairs(source, spec, targets, response) {
  const audit = { sourceHash: djb2(source), requirementsHash: djb2(JSON.stringify(spec.requirements)),
    status: "UNRESOLVED", decisions: [] };
  const finish = requirements => ({ ...spec, requirements, _citationRepair: audit });
  if (!response || typeof response !== "object" || Array.isArray(response)
      || Object.keys(response).some(k => k !== "citations") || !Array.isArray(response.citations)) {
    audit.reason = "invalid citation-only response";
    return finish(spec.requirements);
  }
  const targetIds = new Set(targets.map(r => r.id));
  const ids = response.citations.map(r => r?.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !targetIds.has(id))) {
    audit.reason = "duplicate or non-target requirement id";
    return finish(spec.requirements);
  }
  const byId = new Map(response.citations.map(r => [r.id, r]));
  const replacements = new Map();
  for (const req of targets) {
    const entry = byId.get(req.id);
    const decision = { id: req.id, originalSrc: req.src, ...(req.sources ? { originalSources: req.sources } : {}), adopted: false };
    audit.decisions.push(decision);
    if (!entry || Object.keys(entry).some(k => !["id", "requirement", "kind", "src", "sources", "reason"].includes(k))
        || entry.requirement !== req.desc || typeof entry.reason !== "string" || !entry.reason.trim()) {
      decision.reason = "missing decision or attempted requirement edit";
      continue;
    }
    decision.reviewKind = entry.kind;
    decision.reviewReason = entry.reason;
    if (!["direct", "derived", "interpretation"].includes(entry.kind) || typeof entry.src !== "string"
        || !entry.sources?.length && entry.src.trim().length < 8) {
      decision.reason = "review did not establish a supported source quotation";
      continue;
    }
    const interpretation = entry.kind === "interpretation";
    const candidate = interpretation
      ? { ...req, src: "", sources: [], provenance: { ...req.provenance, kind: "interpretation", reasoning: entry.reason, sources: entry.sources } }
      : { ...req, src: entry.src, sources: entry.sources,
        ...(req.provenance?.kind === "interpretation" ? { provenance: { ...req.provenance, kind: entry.kind === "direct" ? "source" : "derived" } } : {}) };
    const citation = inspectCitation(source, candidate, spec);
    if (!citation.valid) {
      decision.reason = "replacement " + (citation.reason || "citation is invalid");
      continue;
    }
    // Only provenance fields can be adopted. Keep actual source locations. No
    // requirement, priority, rationale, interface, parameter, or RTL is edited.
    const fields = interpretation
      ? { src: "", sources: [], provenance: { ...candidate.provenance, sources: citation.spans } }
      : { src: citation.spans[0].quote, ...(entry.sources || req.sources ? { sources: citation.spans } : {}),
        ...(req.provenance?.kind === "interpretation" ? { provenance: candidate.provenance } : {}) };
    replacements.set(req.id, fields);
    Object.assign(decision, { adopted: true, ...fields, sourceOffset: citation.spans[0].start,
      sourceSpans: citation.spans, provisional: citation.provisional,
      reason: "citation repaired; behavioral fields preserved" });
  }
  const requirements = replacements.size
    ? spec.requirements.map(r => replacements.has(r.id) ? { ...r, ...replacements.get(r.id) } : r)
    : spec.requirements;
  audit.remaining = invalidSpecCitations(source, { ...spec, requirements }).length;
  audit.status = audit.remaining === 0 ? "REPAIRED" : replacements.size ? "PARTIAL" : "UNRESOLVED";
  return finish(requirements);
}

// Runs only for generated specs with invalid nonempty quotations and the
// attribution policy or corrective-review option enabled. Empty citations,
// imported specs and correctly cited specs require no additional call.
export async function repairSpecCitations(st, spec, stageConfig) {
  const source = String(st._userDesc || "");
  if (st._specImport) return { spec, llms: [] };
  spec = normalizeCitationPassages(source, spec);
  if (!st._config?.specReask && st._config?.attributionPolicy == null) return { spec, llms: [] };
  // First repair mechanically provable declaration citations. This never
  // changes a declaration's meaning or turns buggy-code behavior into a fact.
  const declarations = invalidSpecCitations(source, spec).map(req => ({ req, evidence: interfaceCitation(source, req, spec) }))
    .filter(({ evidence }) => evidence);
  if (declarations.length) spec = applyCitationRepairs(source, spec, declarations.map(d => d.req), {
    citations: declarations.map(({ req, evidence }) => ({ id: req.id, requirement: req.desc,
      kind: "derived", src: evidence.spans[0].quote, sources: evidence.spans,
      reason: "Declaration agrees with the requirement and interface; explicit source width rules are source facts." })),
  });
  let targets = invalidSpecCitations(source, spec).slice(0, 40);
  if (!targets.length) return { spec, llms: [] };
  const ids = (spec.requirements || []).map(r => r?.id);
  if (ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) return { spec, llms: [] };
  let next = spec;
  const llms = [], attempts = spec._citationRepair ? [spec._citationRepair] : [];
  for (let attempt = 0; attempt < 2 && targets.length; attempt++) {
    const prompt = promptSpecCitationRepair(source, targets, st.elicit);
    if (attempt) prompt.userMessage += "\nPREVIOUS CITATION VALIDATION ERRORS:\n" + JSON.stringify(next._citationRepair.decisions)
      + "\nCorrect only source passages. Use separate sources entries for non-adjacent text; no ellipses or stitched quotes.";
    Object.assign(prompt, { config: stageConfig, maxTokens: stageConfig._maxTokens,
      onChunk: st._onLog, signal: st._signal });
    st._onLog?.("↻ SPEC CITATION REPAIR\nReviewing " + targets.length + " invalid quotation(s); behavioral fields are frozen.");
    let result;
    try { result = await callLLMJson(prompt, { parseRetries: 0 }); }
    catch (error) {
      if (st._signal?.aborted) throw error;
      st._onLog?.("⚠ SPEC CITATION REPAIR failed — retaining the original specification and unresolved evidence.");
      return { spec: { ...next, _citationRepair: { ...next._citationRepair, status: "UNRESOLVED", reason: String(error?.message || error), attempts } },
        llms: llms.concat(error?.llms || []) };
    }
    next = applyCitationRepairs(source, next, targets, result?.data);
    llms.push(...(result?.llms || []).map(r => ({ ...r, purpose: "spec_citation_repair" })));
    attempts.push(next._citationRepair);
    st._onLog?.("SPEC CITATION REPAIR: " + next._citationRepair.status + " — "
      + next._citationRepair.decisions.filter(d => d.adopted).length + "/" + targets.length + " citation(s) repaired.");
    const retry = new Set(next._citationRepair.decisions.filter(d => !d.adopted && ["direct", "derived", "interpretation"].includes(d.reviewKind)).map(d => d.id));
    targets = invalidSpecCitations(source, next).filter(r => retry.has(r.id)).slice(0, 40);
  }
  if (attempts.length > 1) next = { ...next, _citationRepair: { ...next._citationRepair, attempts } };
  return { spec: next, llms };
}
