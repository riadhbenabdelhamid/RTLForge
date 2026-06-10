// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/rtlReview — Stage 4b: Optional RTL Code Review  (REVISED)
//
// promptRTLReview     — LLM reviews generated RTL for correctness/standards
// promptRTLReviewFix  — LLM fixes critical/major issues from the review
//
// REVISION GOALS:
//   - Cut the false-positive rate by demanding evidence (line, signal name)
//     for every issue — same pattern as the lint prompt.
//   - Add an explicit "spec compliance" pass: every Must requirement must
//     be cross-referenced to a code region; gaps become critical issues.
//   - Score rubric tightened so "PASS" actually correlates with what we'd
//     hand to a colleague — drop sub-70 from PASS bin.
//   - Fix prompt: minimal-diff guarantee, single-driver preservation, and
//     explicit reset-value preservation.
// ═══════════════════════════════════════════════════════════════════════════

import { sys, j, resolveModName } from "./base.js";

export function promptRTLReview(rtlCode, spec, arch, el) {
  const modName = resolveModName(el, spec);
  const schema = `{
  "verdict": "PASS | NEEDS_FIX",
  "score": 0-100,
  "spec_compliance": {
    "must_total":    <int>,
    "must_traced":   <int>,
    "must_missing":  ["<REQ-ID with no clear implementation>"],
    "interface_ok":  true | false,
    "interface_diffs": ["<port name + reason>"]
  },
  "issues": [
    {
      "id":          "RR-001",
      "severity":    "critical | major | minor | suggestion",
      "category":    "correctness | synthesisability | coding_standard | timing | reset | naming | documentation | redundancy | spec_gap",
      "line":        <int or null>,
      "signal":      "<signal/block name or empty>",
      "description": "<one-sentence statement of the issue, no fix>",
      "fix":         "<one-sentence suggestion>"
    }
  ],
  "strengths": ["<short positive observations>"],
  "summary":   "<2-3 sentence executive summary>"
}`;

  return {
    systemPrompt: sys(
      'You are a senior RTL design reviewer with 15+ years of ASIC/FPGA experience. ' +
      'Be precise. Every issue must point to concrete code (line + signal). ' +
      'Do NOT invent issues — if you cannot localise a problem in the source, ' +
      'do not report it.'
    ),
    maxTokens: 6000,
    userMessage: `\
TASK: Review the "${modName}" SystemVerilog module against the spec and
produce a structured issue list.

RTL SOURCE:
${rtlCode}

SPECIFICATION (cross-check):
${j({ iface: spec.iface, params: spec.params, requirements: (spec.requirements || []).filter(function(r) { return r.pri === "Must"; }).map(function(r) { return { id: r.id, desc: r.desc }; }) })}

ARCHITECTURE:
${j({ strategy: (arch || {}).strategy, blocks: (arch || {}).blocks })}

REVIEW PASSES — perform every pass, in order:

PASS A — INTERFACE COMPLIANCE
• Every spec port must appear in the module header with the same name,
  direction, and width expression. Mismatches go in \`interface_diffs\` AND
  produce a "critical" issue with category "spec_gap".

PASS B — REQUIREMENT TRACEABILITY
• Every Must requirement must be visibly implemented somewhere in the code.
  If you cannot point to lines that implement it, it goes in \`must_missing\`
  AND produces a "critical" issue with category "spec_gap".

PASS C — SYNTHESISABILITY
• Combinational loops, inferred latches, multi-driven nets, blocking inside
  always_ff, missing case defaults, real types, force/release, dynamic arrays,
  hierarchical references, X/Z propagation hazards.

PASS D — CODING STANDARD (IEEE 1800-2017)
• always_ff for sequential, always_comb for combinational.
• Explicit \`logic\` declarations; no implicit nets.
• Reset values for every flop. Single-driver per net. Width-correct literals.

PASS E — TIMING & RESET
• Reset polarity matches port name (\`rst_n\` ⇒ active-low, \`rst\` ⇒ active-high).
• Sync vs async reset consistent across all flops.
• CDC: any signal crossing clock domains has explicit synchroniser or note.

PASS F — STYLE & DOC
• Meaningful names. Comment above every \`always\` block. Magic numbers replaced
  by parameters or localparams.

EVIDENCE RULES:
• \`line\` is an integer ≥ 1 referring to a real line in RTL SOURCE, or null
  only if the issue is whole-module (e.g. missing timescale).
• \`signal\` names a real identifier from that line, or "" for whole-module.
• \`description\` states ONLY the problem, not the fix.
• \`fix\` is a single sentence — implementation detail can wait for the fix step.

SCORING RUBRIC (apply mechanically):
  100 − 25*(criticals) − 8*(majors) − 2*(minors), clamped to [0,100].

VERDICT RULE: "PASS" iff score ≥ 75 AND criticals == 0 AND interface_ok.
              Otherwise "NEEDS_FIX".

OUTPUT SCHEMA (produce exactly this shape):
${schema}`,
  };
}

export function promptRTLReviewFix(rtlCode, reviewResult, spec, el) {
  const modName = resolveModName(el, spec);
  const issues = (reviewResult.issues || []).filter(function(i) {
    return i.severity === "critical" || i.severity === "major";
  });
  return {
    systemPrompt:
      'You are RTL Forge. Respond ONLY with JSON: ' +
      '{"code":"<fixed SystemVerilog source>","fixes":[{"id":"<RR id>","desc":"<minimal change>"}]}',
    maxTokens: 10000,
    userMessage: `\
TASK: Apply minimal fixes to "${modName}" addressing every critical and
major issue listed below — without altering observable behaviour.

CURRENT RTL:
${rtlCode}

ISSUES TO FIX (${issues.length} critical/major):
${j(issues)}

MUST REQUIREMENTS (for correctness reference):
${j((spec.requirements || []).filter(function(r) { return r.pri === "Must"; }).map(function(r) { return { id: r.id, desc: r.desc }; }))}

FIX RULES:
1. EVERY entry in \`fixes\` references an issue \`id\` (RR-NNN). No invented fixes.
2. EXTERNAL CONTRACT PRESERVATION (hard constraint): module name, port list,
   port directions, widths, parameter names/types/defaults all unchanged.
3. SINGLE-DRIVER PRESERVATION: do not introduce a second driver for any net.
4. RESET-VALUE PRESERVATION: every existing flop keeps the same reset value
   unless the issue explicitly cites that reset value as wrong.
5. MINIMAL-DIFF: change only the lines required. Do NOT reformat untouched
   regions, rename signals, or restructure unaffected blocks.
6. NO NEW FUNCTIONALITY: don't add features the spec did not request, even
   if "obvious" or "useful".

VERIFICATION CHECKLIST:
[ ] Every issue id is referenced in \`fixes\`.
[ ] No port/parameter changed.
[ ] No new latches, no new drivers.
[ ] Reset behaviour identical (or explicitly fixed per issue).

Return {"code":"<complete fixed module>","fixes":[{"id":"RR-NNN","desc":"<minimal change>"}]}.`,
  };
}
