// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/propagate — Spec Section Propagation
//
// When the user manually edits one section of a spec (requirements / iface /
// params), this prompt asks the LLM to update the OTHER two sections so they
// remain consistent with the edited one. The edited section is treated as
// the authoritative source of truth and is not modified.
//
// Triggered from SpecStage.onPropagate(source) where source is one of:
//   "reqs"  — requirements section was edited
//   "iface" — interface ports section was edited
//   "params" — parameters section was edited
// ═══════════════════════════════════════════════════════════════════════════

import { sys, j } from "./base.js";

export function promptPropagateSpec(source, specData) {
  var sourceLabel = source === "reqs" ? "requirements" : source === "iface" ? "interface ports" : "parameters";
  var targetLabels = source === "reqs" ? "interface ports and parameters" : source === "iface" ? "requirements and parameters" : "requirements and interface ports";
  return {
    systemPrompt: sys(),
    maxTokens: 5000,
    userMessage: `\
TASK: The user has manually edited the ${sourceLabel} of a hardware module spec. \
Update the other sections (${targetLabels}) to be consistent with the changes.

CURRENT SPEC (the "${sourceLabel}" section is the authoritative source of truth):
${j(specData)}

RULES:
• The ${sourceLabel} section is FIXED — do NOT modify it.
• Update ONLY the other sections to be consistent.
• If a new port was added to the interface, ensure a matching requirement exists.
• If a requirement references a port or parameter that doesn't exist, add it.
• If a parameter was removed, remove references to it from interface widths and requirements.
• Keep IDs consistent — do not renumber existing items.
• Preserve any items marked with "[User-added]" or "[default — question skipped]" rationale.

Return the COMPLETE updated spec as JSON with this shape:
{"requirements": [...], "iface": [...], "params": [...]}

Return ALL items (not just changed ones). Do not omit the ${sourceLabel} section.`,
  };
}
