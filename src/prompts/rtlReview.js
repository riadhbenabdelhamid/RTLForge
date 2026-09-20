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
import { behaviorFidelity } from "./behaviorContract.js";
import { semanticRules } from "./specSemantics.js";

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
      "target":      "rtl | spec",
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
${behaviorFidelity}
${semanticRules}

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
• Compare inferred requirements with the original source and explicit exceptions,
  not only the RTL with the frozen specification. If an interpretation itself
  is wrong or conflicts with another requirement, report target="spec", category
  "spec_gap", affected requirement IDs, and a concrete conflicting case. Request
  a Spec revision; do not silently change frozen behavior in an RTL repair.
  Missing implementation of a consistent requirement remains target="rtl".
• Every Must requirement must be visibly implemented somewhere in the code.
  If you cannot point to lines that implement it, it goes in \`must_missing\`
  AND produces a "critical" issue with category "spec_gap".
• CAPACITY REPRESENTABILITY: when the spec states an N-entry capacity,
  verify the occupancy state can represent all N+1 values 0..N. Same-width
  read/write pointers with no extra wrap bit — including occupancy derived
  from their subtraction — cannot distinguish full from empty and make
  \`full\` unreachable: a "critical" issue, cite the declaration line.
  Status flags registered FROM a combinational occupancy (lagging it by one
  cycle) are a "major" issue. (Measured: two independent models shipped
  this exact bug on the same FIFO spec — capacity DEPTH-1 and a wrap write
  that corrupts the FIFO into reading back zero words.)

PASS C — SYNTHESISABILITY
• Combinational loops, inferred latches, multi-driven nets, blocking inside
  always_ff, missing case defaults, real types, force/release, dynamic arrays,
  hierarchical references, X/Z propagation hazards.

PASS D — CODING STANDARD (IEEE 1800-2017)
• always_ff for sequential, always_comb for combinational.
• Explicit \`logic\` declarations; no implicit nets.
• Reset values for every flop only when the spec defines reset behavior for
  that state. State without a reset contract must retain its ordinary update
  behavior. Single-driver per net. Width-correct literals.

PASS E — TIMING & RESET
• Reset/clear polarity and timing come from the corresponding spec descriptor
  or requirement; a signal name supplies no reset semantics.
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

MUST REQUIREMENTS (for correctness reference):
${j((spec.requirements || []).filter(function(r) { return r.pri === "Must"; }).map(function(r) { return { id: r.id, desc: r.desc }; }))}

CURRENT RTL:
${rtlCode}

${reviewResult._repairRejection ? "PREVIOUS REPAIR REJECTED (adoption evidence, not a new requirement):\n" + j(reviewResult._repairRejection) + "\nCorrect the rejected defect; preserve the frozen specification and current working code. Do not repeat the rejected candidate.\n" : ""}ISSUES TO FIX (${issues.length} critical/major):
${j(issues)}

Return {"code":"<complete fixed module>","fixes":[{"id":"RR-NNN","desc":"<minimal change>"}]}.`,
  };
}
