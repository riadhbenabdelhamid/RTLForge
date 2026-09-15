// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { callLLMJson } from "../llm/index.js";
import { djb2 } from "../utils/hash.js";
import { nonNormativeContext } from "../utils/interfaceContract.js";
import { promptSpecCitationRepair } from "../prompts/specCitationRepair.js";

// Match exactly except for line wrapping/whitespace, as sourceContract does.
// This checks attribution, not logical entailment or functional correctness.
function sourceMatches(source, quote) {
  const pattern = String(quote).trim().split(/\s+/)
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return pattern ? [...source.matchAll(new RegExp(pattern, "g"))] : [];
}

export function invalidSpecCitations(source, spec) {
  if (!String(source || "").trim()) return [];
  return (spec?.requirements || []).filter(r => r && typeof r.src === "string"
    && r.src.trim() && !sourceMatches(String(source), r.src).length);
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
    const decision = { id: req.id, originalSrc: req.src, adopted: false };
    audit.decisions.push(decision);
    if (!entry || Object.keys(entry).some(k => !["id", "requirement", "kind", "src", "reason"].includes(k))
        || entry.requirement !== req.desc || typeof entry.reason !== "string" || !entry.reason.trim()) {
      decision.reason = "missing decision or attempted requirement edit";
      continue;
    }
    decision.reviewKind = entry.kind;
    decision.reviewReason = entry.reason;
    if (!["direct", "derived"].includes(entry.kind) || typeof entry.src !== "string" || entry.src.trim().length < 8) {
      decision.reason = "review did not establish a supported source quotation";
      continue;
    }
    const matches = sourceMatches(source, entry.src);
    const normative = matches.find(m => !nonNormativeContext(source, m.index, { defectsOnly: true }));
    if (!normative) {
      decision.reason = "replacement quote is absent or supported only by defective code";
      continue;
    }
    // Only src can be adopted. Keep the source's actual whitespace too. No
    // requirement, priority, rationale, interface, parameter, or RTL is edited.
    replacements.set(req.id, normative[0]);
    Object.assign(decision, { adopted: true, src: normative[0], sourceOffset: normative.index,
      reason: "citation repaired; behavioral fields preserved" });
  }
  const requirements = replacements.size
    ? spec.requirements.map(r => replacements.has(r.id) ? { ...r, src: replacements.get(r.id) } : r)
    : spec.requirements;
  audit.remaining = invalidSpecCitations(source, { ...spec, requirements }).length;
  audit.status = audit.remaining === 0 ? "REPAIRED" : replacements.size ? "PARTIAL" : "UNRESOLVED";
  return finish(requirements);
}

// Runs only for generated specs with invalid nonempty quotations and the
// existing corrective-review option enabled. Honest empty/legacy citations,
// imported specs and correctly cited specs require no additional call.
export async function repairSpecCitations(st, spec, stageConfig) {
  const source = String(st._userDesc || "");
  if (!st._config?.specReask || st._specImport) return { spec, llms: [] };
  const targets = invalidSpecCitations(source, spec).slice(0, 40);
  if (!targets.length) return { spec, llms: [] };
  const ids = (spec.requirements || []).map(r => r?.id);
  if (ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) return { spec, llms: [] };
  const prompt = promptSpecCitationRepair(source, targets);
  Object.assign(prompt, { config: stageConfig, maxTokens: stageConfig._maxTokens,
    onChunk: st._onLog, signal: st._signal });
  st._onLog?.("↻ SPEC CITATION REPAIR\nReviewing " + targets.length + " invalid quotation(s); behavioral fields are frozen.");
  let result;
  try { result = await callLLMJson(prompt, { parseRetries: 0 }); }
  catch (error) {
    if (st._signal?.aborted) throw error;
    st._onLog?.("⚠ SPEC CITATION REPAIR failed — retaining the original specification and unresolved evidence.");
    return { spec: { ...spec, _citationRepair: { status: "UNRESOLVED", reason: String(error?.message || error) } },
      llms: error?.llms || [] };
  }
  const next = applyCitationRepairs(source, spec, targets, result?.data);
  st._onLog?.("SPEC CITATION REPAIR: " + next._citationRepair.status + " — "
    + next._citationRepair.decisions.filter(d => d.adopted).length + "/" + targets.length + " citation(s) repaired.");
  return { spec: next, llms: (result?.llms || []).map(r => ({ ...r, purpose: "spec_citation_repair" })) };
}
