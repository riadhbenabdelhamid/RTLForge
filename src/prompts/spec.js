// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/spec — Stage 2: Formal Specification  (REVISED)
//
// promptSpec              — converts answered elicit questions into a spec
// promptSpecFromDescription — full-auto: derives spec directly from raw user desc
//
// Both produce the same output schema. The spec node picks one based on
// whether elicit data is available.
//
// REVISION GOALS (vs. previous version):
//   - The single biggest risk in this stage is INVENTION — the model adding
//     features/protocols/error modes the user did not request. The original
//     prompt had a FIDELITY RULE paragraph; the new prompt makes it a hard
//     test the model must apply per requirement: "Does this come from an
//     answer, an assumption, or did you invent it? If invented, omit."
//   - Lock the clock/reset port shape: every spec gets exactly one clk and
//     one reset port (unless multi-domain), with deterministic naming.
//     This eliminates a class of downstream RTL/TB inconsistencies where
//     stages disagreed about port names.
//   - Width-derivation rule: every parameter that appears in an iface width
//     expression must be declared in `params`. Conversely, every param
//     declared must be USED somewhere — orphan parameters are forbidden.
//   - Requirement ID stability: REQ-<CAT>-NNN where CAT comes from the
//     requirement category, NNN is zero-padded sequential within category.
//     Same set of inputs should produce the same id sequence on re-run.
//   - Traceability: `rat` field must cite either a question id, an
//     assumption id, or "[default — question skipped]" / "[derived from
//     description: <quoted snippet>]". No hand-waving.
//   - The judge-feedback refinement loop now requires the model to mark
//     each REVISED requirement with `_revisedFrom` so downstream stages can
//     see which spec items the judge caused to change.
// ═══════════════════════════════════════════════════════════════════════════

import { sys, j } from "./base.js";

// ---------------------------------------------------------------------------
// Stage 2 — Formal Specification (from elicit answers)
// ---------------------------------------------------------------------------

export function promptSpec(el, childInterfaces) {
  // Only include answered questions; resolve "Other (specify)" with custom text
  const allAnswers = el.answers || {};
  const customAnswers = el.customAnswers || {};
  const allQuestions = el.questions || [];
  const answeredQuestions = allQuestions.filter(function(q) { return allAnswers[q.id]; });
  const resolvedAnswers = {};
  answeredQuestions.forEach(function(q) {
    var ans = allAnswers[q.id];
    if (ans === "Other (specify)" && customAnswers[q.id]) {
      resolvedAnswers[q.id] = customAnswers[q.id];
    } else {
      resolvedAnswers[q.id] = ans;
    }
  });

  const skippedCount = allQuestions.length - answeredQuestions.length;

  const inputData = {
    domain:      el.domain,
    modName:     el.modName,
    answeredQuestions: answeredQuestions.map(function(q) {
      return { id: q.id, cat: q.cat, text: q.text, answer: resolvedAnswers[q.id] };
    }),
    assumptions: (el.assumptions || []).filter(function(a) { return a.confirmed; }),
  };

  const skippedNote = skippedCount > 0 ? `

NOTE: ${skippedCount} elicitation question(s) were deliberately left unanswered.
The user considers those details unimportant or wants safe defaults. For each
unanswered question, pick the simplest valid default and cite
"[default — question skipped]" in the rationale. Do NOT fill the gap with
new features or extended functionality.` : '';

  const childSection = (childInterfaces && childInterfaces.length > 0) ? `

CHILD MODULE INSTANCES (this module instantiates these):
${j(childInterfaces)}

PARENT-MODULE SPECIFICATION RULES:
• The parent's iface must include any ports needed to connect to children
  (unless purely internal).
• If two instances of the same module type exist with different paramOverrides,
  the parent declares separate internal signals named {instanceName}_{portName}.
• Add at least one Must requirement per child instance:
  "The module shall instantiate {instanceName} with {paramOverrides}."
• If a child has a configurable parameter that the parent should expose,
  add it to params with a default matching the most common case.` : '';

  // Judge-feedback refinement loop
  const judgeFailures = el._judgeFailures || [];
  const judgeRecs     = el._judgeRecs     || [];
  const judgeSection  = (judgeFailures.length > 0 || judgeRecs.length > 0) ? `

JUDGE FEEDBACK — THE PREVIOUS SPECIFICATION FAILED VALIDATION:
Unvalidated requirements:
${j(judgeFailures)}

Judge recommendations:
${j(judgeRecs)}

REFINEMENT INSTRUCTIONS:
• For each unvalidated requirement, decide: was it ambiguous, missing,
  under-specified, or contradicted by another requirement?
• Revise / split / add requirements to address the failures.
• When you REVISE an existing requirement, keep the original \`id\` and add
  \`_revisedFrom\` field with the previous \`desc\` text so downstream stages
  can see what changed.
• Any new requirements still cite the original answers/assumptions in
  INPUT DATA — do not invent new sources.
• Do NOT regenerate the entire spec — only modify what the failures
  indicate.` : '';

  const schema = `{
  "requirements": [
    {
      "id":   "REQ-<CAT>-NNN",
      "cat":  "Interface | Functionality | Timing | Error | Verification",
      "pri":  "Must | Should | May",
      "desc": "The module shall ...",
      "rat":  "[source: answer to <Q-ID> / assumption <A-ID> / default — question skipped / domain default]"
    }
  ],
  "iface": [
    { "name": "clk",    "dir": "input",  "width": "1",      "desc": "System clock, rising-edge active" },
    { "name": "rst_n",  "dir": "input",  "width": "1",      "desc": "Asynchronous active-low reset" },
    { "name": "data_i", "dir": "input",  "width": "DATA_W", "desc": "Write data bus" }
  ],
  "params": [
    { "name": "DATA_W", "type": "parameter", "def": 8, "range": "[1:1024]", "desc": "Data-path width in bits" }
  ]
}

CRITICAL: The ID prefix MUST match the category according to this table:
   REQ-INTF-NNN  ↔  cat: "Interface"
   REQ-FUNC-NNN  ↔  cat: "Functionality"
   REQ-TIME-NNN  ↔  cat: "Timing"
   REQ-ERR-NNN   ↔  cat: "Error"
   REQ-VERIF-NNN ↔  cat: "Verification"

A mismatch is a hard error. For example, REQ-FUNC-003 with cat="Interface" is INVALID.`;

  return {
    systemPrompt: sys(),
    maxTokens: 5000,
    userMessage: `\
TASK: Convert the elicited answers below into a formal, unambiguous
specification for the "${el.modName}" module. The output of this stage
is the source of truth for ALL downstream stages — be conservative.

INPUT DATA (only answered questions included; unanswered ones were skipped):
${j(inputData)}
${skippedNote}

INPUT ASSUMPTIONS — what the model MAY rely on:
• The INPUT DATA above is the ONLY source of user intent.
• Domain knowledge may inform standard practice (e.g. how an APB bus
  works) but must NOT add features the user did not request.
• For a SEQUENTIAL design, reset defaults to active-low async on \`rst_n\` and
  clock to rising-edge on \`clk\` unless an answer/assumption says otherwise. A
  purely combinational design has no clock or reset at all.

ANTI-INVENTION TEST — apply per requirement before adding it:
  For each candidate requirement, ask:
    (a) Does its substance trace to an answer or confirmed assumption? → keep.
    (b) Is it a domain-standard default the user did not contradict? → keep,
        cite "[domain default]" in \`rat\`.
    (c) Did I make it up because it "would be nice"? → DROP IT.
  When in doubt, DROP. The judge stage checks every requirement; padding
  the spec with unsourced items causes downstream FAILs.

THINKING STEPS (mental):
1. Group answers by category and list every interface signal — explicit
   and implied.
2. Choose the deterministic clk/reset shape from the INPUT ASSUMPTIONS
   above (or override if an answer specifies otherwise).
3. Derive Must requirements first; then Should; then May (if any).
4. List every parameter that appears in an iface width expression — these
   MUST be in \`params\`.
5. Validate each requirement's \`rat\` cites a real source.
6. Apply the anti-invention test; drop any requirements that fail.
7. Emit JSON.

REQUIREMENT RULES:
• Generate 8–15 requirements. At least 3 Must, at least 2 Should. Counts are
  guidelines — fewer is acceptable for a simple module; do not pad.
• \`desc\` starts with "The module shall" (Must), "The module should"
  (Should), or "The module may" (May). One sentence each.
• ID format: \`REQ-<CAT>-NNN\`, where CAT is INTF/FUNC/TIME/ERR/VERIF and
  NNN is zero-padded sequential within category. No duplicate ids.
• \`rat\` MUST cite ONE of:
    "[source: answer to <Q-ID>]"
    "[source: assumption <A-ID>]"
    "[default — question skipped]"
    "[domain default]"
  Anything else is a fidelity violation.
• If multiple sources support a requirement, list them comma-separated
  inside the brackets.

INTERFACE RULES:
• CLOCK/RESET ARE FOR SEQUENTIAL DESIGNS ONLY. If the design holds STATE
  (registers, counters, FIFOs, FSMs, memories), include exactly one \`clk\`
  (input, width "1") and exactly one reset port — default \`rst_n\` (active-low
  async) unless an answer overrides. If the design is purely COMBINATIONAL
  (no state — a decoder, mux, adder, comparator, priority encoder, …), do NOT
  add a clock or reset; the interface is only its data ports. When the design
  is multi-clock (CDC), include each clock/reset domain the spec requires —
  do not collapse them to one.
• Every functional port from answers/assumptions appears here, with a
  clear one-sentence \`desc\`.
• \`dir\` is exactly "input", "output", or "inout".
• \`width\` is "1", a parameter name (e.g. "DATA_W"), or a parameter
  expression (e.g. "DATA_W+1", "ADDR_W"). No literal magic numbers
  beyond width "1".

PARAMETER RULES:
• \`def\` is a JSON number, never a string.
• \`range\` uses Verilog bracket notation: "[1:65535]". \`min\` should be the
  smallest value the design tolerates; \`max\` should be the largest practical.
• Every parameter that appears in iface widths MUST be declared.
• Every declared parameter MUST be used somewhere (in iface or implied by a
  requirement). No orphans.

SELF-CHECK (mental, before emit):
[ ] Every requirement passes the anti-invention test.
[ ] Every \`rat\` cites a real source.
[ ] Clock + reset present IFF the design is sequential (combinational designs have neither; multi-clock designs have one pair per domain).
[ ] Every iface-width parameter appears in params; no orphan params.
[ ] No duplicate ids.
${childSection}${judgeSection}

OUTPUT SCHEMA (produce exactly this shape):
${schema}`,
  };
}

// ---------------------------------------------------------------------------
// Stage 2b — Spec from Description (full-auto, bypasses elicit)
// ---------------------------------------------------------------------------

export function promptSpecFromDescription(desc, childInterfaces) {
  const childSection = (childInterfaces && childInterfaces.length > 0) ? `

CHILD MODULE INSTANCES (this module instantiates these):
${j(childInterfaces)}

PARENT-MODULE SPECIFICATION RULES:
• The parent's iface must include any ports needed to connect to children.
• If two instances of the same module type exist with different paramOverrides,
  declare separate internal signals named {instanceName}_{portName}.
• Add at least one Must requirement per child instance:
  "The module shall instantiate {instanceName} with {paramOverrides}."
• Expose child parameters that the parent should be able to configure.` : '';

  const schema = `{
  "modName":      "<snake_case module name derived from description>",
  "domain":       "<e.g. FIFO buffer | UART TX | AXI4-Lite crossbar>",
  "requirements": [
    {
      "id":   "REQ-<CAT>-NNN",
      "cat":  "Interface | Functionality | Timing | Error | Verification",
      "pri":  "Must | Should | May",
      "desc": "The module shall ...",
      "rat":  "[derived from description: <short quoted snippet>]"
    }
  ],
  "iface": [
    { "name": "clk",    "dir": "input",  "width": "1",      "desc": "System clock, rising-edge active" },
    { "name": "rst_n",  "dir": "input",  "width": "1",      "desc": "Asynchronous active-low reset" },
    { "name": "data_i", "dir": "input",  "width": "DATA_W", "desc": "Write data bus" }
  ],
  "params": [
    { "name": "DATA_W", "type": "parameter", "def": 8, "range": "[1:1024]", "desc": "Data-path width in bits" }
  ]
}

CRITICAL: The ID prefix MUST match the category:
   REQ-INTF-NNN  ↔  cat: "Interface"
   REQ-FUNC-NNN  ↔  cat: "Functionality"
   REQ-TIME-NNN  ↔  cat: "Timing"
   REQ-ERR-NNN   ↔  cat: "Error"
   REQ-VERIF-NNN ↔  cat: "Verification"

A mismatch is a hard error. For example, REQ-FUNC-003 with cat="Interface" is INVALID.`;

  return {
    systemPrompt: sys(),
    maxTokens: 5000,
    userMessage: `\
TASK: Derive a complete formal specification directly from the hardware
module description below. There is no elicit step in full-auto mode — use
your best engineering judgement for unspecified details and document each
choice in the rationale.

DESCRIPTION:
"""
${desc}
"""

INPUT ASSUMPTIONS — what the model MAY rely on:
• The DESCRIPTION above is the ONLY source of user intent.
• Reset is active-low async on \`rst_n\` and clock is rising-edge on \`clk\`
  unless the description specifies otherwise.
• Domain knowledge may inform standard practice but must NOT add features
  the user did not request.

ANTI-INVENTION TEST — apply per requirement before adding it:
  (a) Does its substance trace to a quoted snippet from the description? → keep.
  (b) Is it a domain-standard default the description does not contradict? → keep,
      cite "[domain default]" in \`rat\`.
  (c) Did I make it up because it "would be nice"? → DROP IT.

THINKING STEPS (mental):
1. Identify modName (snake_case, no leading digit) and domain.
2. List every interface signal — explicit and implied by the domain.
3. List every parameterisable dimension.
4. Derive Must requirements for the core functionality stated.
5. Derive Should requirements for standard good practice in the domain
   (proper reset, parameterisability, standard handshaking).
6. Document inferred details as "[assumed]" in \`rat\`.
7. Apply the anti-invention test.
8. Emit JSON.

REQUIREMENT RULES:
• Generate 8–15 requirements. At least 3 Must, at least 2 Should.
• \`desc\` starts with "The module shall" (Must), "should" (Should),
  or "may" (May). One sentence each.
• ID format: \`REQ-<CAT>-NNN\`, zero-padded sequential within category.
• \`rat\` cites ONE of:
    "[derived from description: <short snippet>]"
    "[assumed]"
    "[domain default]"

INTERFACE RULES:
• Exactly one \`clk\`, exactly one reset port (\`rst_n\` unless description
  overrides). Every functional port present with one-sentence \`desc\`.
• \`dir\` is exactly "input", "output", or "inout".
• \`width\` is "1", a parameter name, or parameter expression. No literal
  magic numbers beyond "1".

PARAMETER RULES:
• \`def\` is JSON number. \`range\` is Verilog "[min:max]".
• Every parameter in iface widths is declared. No orphan parameters.
${childSection}

OUTPUT SCHEMA (produce exactly this shape):
${schema}`,
  };
}
