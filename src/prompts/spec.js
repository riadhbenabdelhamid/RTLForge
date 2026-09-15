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
//   - Keep the clock/reset port shape conditional on sequential state and
//     preserve explicitly named clock/reset ports instead of normalizing them.
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
//   - Self-containment (run 58): a requirement CARRIES its values. Nothing
//     after this stage sees the description, so "as specified in the table"
//     leaves the RTL and the testbench to each guess the table. Tables are
//     transcribed row by row into the requirement and cited by their rows.
//   - The judge-feedback refinement loop now requires the model to mark
//     each REVISED requirement with `_revisedFrom` so downstream stages can
//     see which spec items the judge caused to change.
// ═══════════════════════════════════════════════════════════════════════════

import { sys, j, childView} from "./base.js";
import { extractUserInterfaceContract } from "../utils/interfaceContract.js";
import { behaviorFidelity } from "./behaviorContract.js";

function interfaceRules(contract) {
  const explicitPorts = !!(contract && contract.explicit && contract.explicit.ports);
  const exhaustivePorts = !!(contract && contract.explicit && contract.explicit.portsExhaustive);
  let clockReset;
  if (exhaustivePorts) {
    clockReset = `• The explicit port list is exhaustive. Preserve its names, directions,
  widths, and presence exactly; an omitted clock or reset is intentionally absent,
  even when the behaviour has state. Do not add ports from a sequential-design
  default or from domain convention.`;
  } else if (explicitPorts) {
    clockReset = `• Preserve every explicitly declared port name, direction, and width.
  The declared subset is not exhaustive, so omission does not authorize renaming
  or deletion; add a clock/reset only when the description or resolved contract
  requires one. Do not invent a reset or treat a missing name as an explicit absence.`;
  } else {
    clockReset = `• CLOCK/RESET ARE FOR SEQUENTIAL DESIGNS ONLY. If the design holds STATE
  (registers, counters, FIFOs, FSMs, memories), include the clock required by
  the description or resolved assumptions. A silent clock may use \`clk\` as a
  domain default. A reset is OPTIONAL: include one only when the description,
  an answered question, or a confirmed assumption requires it. If present,
  preserve its stated name, direction, width, kind, and polarity exactly; do
  not infer any reset fact from a name such as \`rst_n\`. If the design is purely COMBINATIONAL
  (no state — a decoder, mux, adder, comparator, priority encoder, …), do NOT
  add a clock or reset; the interface is only its data ports. When the design
  is multi-clock (CDC), include each clock/reset domain the description or
  resolved contract requires; do not collapse them to one.`;
  }
  return `INTERFACE RULES:
${clockReset}
• Every functional port from answers/assumptions appears here, with a
  clear one-sentence \`desc\`.
• \`dir\` is exactly "input", "output", or "inout".
• \`width\` is "1", a parameter name or expression, or an explicit numeric
  width/range copied from the description. Preserve explicit width spelling;
  do not invent literal widths for unspecified ports.
• RESET CONTRACT — add a \`reset\` field only when the source specifies that
  output's reset behavior. Its value is copied faithfully (a post-reset value
  or retention such as "retains last value; updates only on an accepted read").
  An output with no stated reset behavior remains unspecified: omit the field
  and do not invent a value or retention rule. If reset is absent from an
  exhaustive explicit interface, do not add it to satisfy a convention.`;
}

// ---------------------------------------------------------------------------
// Stage 2 — Formal Specification (from elicit answers)
// ---------------------------------------------------------------------------

export function promptSpec(el, childInterfaces, userDesc, interfaceContract, requiredModuleName) {
  const contract = interfaceContract || (userDesc ? extractUserInterfaceContract(userDesc) : null);
  // Ground-truth block (run 43: four Spec halts traced to this prompt never
  // CONTAINING the description — the model re-derived the interface from the
  // Q&A summary alone, and the corrective re-ask then demanded names the
  // model had no source text to anchor).
  const descSection = userDesc ? `
ORIGINAL USER DESCRIPTION — the ground truth. Every port and parameter it
NAMES appears in the spec with EXACTLY that name and stated default; every
literal constant it quotes appears verbatim. The elicited answers below
refine this description; they never override its explicit facts.
"""
${userDesc}
"""
` : "";
  const requestedNameSection = requiredModuleName ? `
REQUESTED EXPORTED RTL MODULE NAME — use exactly \`${requiredModuleName}\` in
\`modName\`; this is the external RTL name and is distinct from any internal
decomposition/module id:
\`${requiredModuleName}\`
This configured name is canonical: preserve its spelling, case, underscores,
and every other character. Do not invent an alias or normalize it.
` : `
CANONICAL MODULE NAME — the configured/source module name is the exported RTL
name. If the ORIGINAL USER DESCRIPTION or its explicit interface facts name the
module, that source declaration wins over the elicitation value \`${el.modName}\`.
Otherwise copy \`${el.modName}\` exactly into \`modName\`. Preserve spelling,
case, underscores, and every other character. Do not invent an alias, rename
it, or use an internal decomposition/module id in its place.
`;
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

  // Unanswered questions that carry a recommended default (run 44): a
  // non-interactive run answers NOTHING, so every question — including the
  // one that would have settled a real ambiguity — used to vanish between
  // elicit and spec, leaving the assumptions to carry the whole contract.
  // The recommendation is the elicit model's own safe default, not user
  // intent, so it is labelled as such and still cites the skipped-question
  // rationale.
  const recommendedDefaults = allQuestions
    .filter(function(q) { return !allAnswers[q.id] && q && typeof q.recommended === "string" && q.recommended.trim(); })
    .map(function(q) { return { id: q.id, cat: q.cat, text: q.text, recommended: q.recommended }; });

  const recommendedNote = recommendedDefaults.length > 0 ? `

RECOMMENDED DEFAULTS — nobody answered these questions, and each carries the
elicitation model's own safe default. Treat them as the resolution for those
details unless the ORIGINAL USER DESCRIPTION says otherwise (it always wins),
and cite "[default — question skipped]" for anything derived from one — they
are defaults, not user decisions:
${j(recommendedDefaults)}` : '';

  const skippedNote = skippedCount > 0 ? `

NOTE: ${skippedCount} elicitation question(s) were deliberately left unanswered.
The user considers those details unimportant or wants safe defaults. For each
unanswered question, pick the simplest valid default and cite
"[default — question skipped]" in the rationale. Do NOT fill the gap with
new features or extended functionality.` : '';

  const childSection = (childInterfaces && childInterfaces.length > 0) ? `

CHILD MODULE INSTANCES (this module instantiates these):
${j(childView(childInterfaces))}

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

  // The citation rule below rewards requirements shaped like sentences, and a
  // table is not a sentence. Measured on run 58: a 5-state FSM given as a
  // transition table came out as "next-state values exactly as specified in
  // the state transition table", citing the sentence that introduces the
  // table. Nothing after this stage sees the description, so RTL Gen invented
  // the table (7 of 10 next-state arms wrong), the testbench invented its own,
  // and verify looped for an hour and a half between two guesses. Hence the
  // two rules that follow: a table is cited by its rows, and a requirement
  // carries its values instead of pointing at them.
  const schema = `{
  "modName": "<configured/source module name copied exactly>",
  "requirements": [
    {
      "id":   "REQ-<CAT>-NNN",
      "cat":  "Interface | Functionality | Timing | Error | Verification",
      "pri":  "Must | Should | May",
      "desc": "The module shall ...",
      "src":  "<verbatim quote from the DESCRIPTION this requirement derives from, or empty string if none>",
      "rat":  "[source: answer to <Q-ID> / assumption <A-ID> / default — question skipped / domain default]"
    }
  ],
  "iface": [
    { "name": "clk",    "dir": "input",  "width": "1",      "desc": "System clock, rising-edge active" },
    { "name": "rst",    "dir": "input",  "width": "1",      "desc": "Synchronous active-high reset" },
    { "name": "data_i", "dir": "input",  "width": "DATA_W", "desc": "Write data bus" },
    { "name": "data_o", "dir": "output", "width": "DATA_W", "desc": "Read data bus",
      "reset": "retains last value; updates only on an accepted read" }
  ],
  "params": [
    { "name": "DATA_W", "type": "parameter", "def": 8, "range": "[1:1024]", "desc": "Data-path width in bits" }
  ]
}

CITE THE DESCRIPTION.

Every requirement carries "src": the exact words from the DESCRIPTION it derives
from, copied verbatim — not paraphrased, not reformatted. It is checked by
string search, so an approximation fails.

${behaviorFidelity}

SOURCE PROVENANCE:
• A required top-level declaration (module name, parameter declaration, or
  explicitly enumerated port list) is authoritative and required. A declaration
  inside a block or sentence explicitly marked as an example or buggy code is
  evidence only; do not promote it to the contract.
• Text marked "for example", "e.g.", illustrative, sample, or hypothetical
  is an example, not a requirement, unless the same sentence explicitly says
  the value is required. A code block labelled buggy, incorrect, or
  non-compliant is evidence of a defect, not normative behavior to reproduce.
• Never turn an example or buggy snippet into a requirement, but never omit a
  literal or declaration that the description presents as required.

When nothing in the description supports the requirement — you are filling a gap
from a default, a domain convention, or your own reading of an ambiguous
sentence — set "src" to an empty string and say so in "rat". That is a normal and
useful answer. An invented quote is not: one requirement drives the RTL, the
testbench and any formal property from the same sentence, so a reading nobody
can trace is invisible to every check that follows.

A TABLE IS CITED ROW BY ROW. When a requirement derives from a state table, a
truth table, an encoding list or a waveform, "src" is the rows themselves,
copied exactly as the description prints them — adjacent rows may be quoted
together. The sentence that introduces a table announces content it does not
carry, so it cites nothing: the content is in the rows.

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
${descSection}${requestedNameSection}
${(contract && (contract.explicit.moduleName || contract.explicit.ports || contract.explicit.params)) ? `
EXPLICIT USER INTERFACE FACTS — copied from the user's explicit declaration.
These facts are immutable. Preserve each identifier, direction, width, and
parameter name/default exactly; do not snake_case, suffix, or otherwise
normalize them:
${j(contract)}
` : ""}
INPUT DATA (only answered questions included; unanswered ones were skipped):
${j(inputData)}
${recommendedNote}
${skippedNote}

INPUT ASSUMPTIONS — what the model MAY rely on:
• The INPUT DATA above is the ONLY source of user intent.
• Domain knowledge may inform standard practice (e.g. how an APB bus
  works) but must NOT add features the user did not request.
• For a SEQUENTIAL design, reset is present only when the description,
  answered questions, or confirmed assumptions require it. Its KIND and
  POLARITY come from that source; never infer them from a reset name. A silent
  clock may use rising-edge \`clk\` as a domain default. A purely combinational
  design has no clock or reset at all.

ANTI-INVENTION TEST — apply per requirement before adding it:
  For each candidate requirement, ask:
    (a) Does its substance trace to the description or an explicit user answer
        or revision? → keep and cite that source.
    (b) Is it a generated assumption or domain default? → retain only as a
        labelled implementation choice consistent with the source. Automatic
        confirmation does not authorize new observable guarantees, reset
        semantics, power-up values, or restrictions on unspecified inputs.
    (c) Did I make it up because it "would be nice"? → DROP IT.
  When in doubt, DROP. The judge stage checks every requirement; padding
  the spec with unsourced items causes downstream FAILs.

THINKING STEPS (mental):
1. Copy the canonical module name from the configured/source contract exactly;
   never invent an alias or normalize its spelling. Copy every explicit module,
   port, direction, width, and parameter name or default from the ORIGINAL USER
   DESCRIPTION exactly. These facts outrank
   answers, assumptions, and defaults.
2. Group answers by category and list every interface signal — explicit
   and implied.
3. Choose the clk/reset shape from the sourced interface facts above. Do not
   add a reset when no source requires one.
4. Derive Must requirements first; then Should; then May (if any).
5. List every parameter that appears in an iface width expression — these
   MUST be in \`params\`.
6. Validate each requirement's \`rat\` cites a real source.
7. Apply the anti-invention test; drop any requirements that fail.
8. Emit JSON.

REQUIREMENT RULES:
• Generate 8–15 requirements. At least 3 Must, at least 2 Should. Counts are
  guidelines — fewer is acceptable for a simple module; do not pad.
• \`desc\` starts with "The module shall" (Must), "The module should"
  (Should), or "The module may" (May). One sentence each.
• A requirement CARRIES the values the description GIVES; it never points at
  them. The stages that implement and test this spec see the requirements and
  nothing else — not the description, not its tables. "As specified in the
  state table" or "according to the diagram" is an empty contract: the RTL and
  the testbench will each guess the table, and any disagreement is an
  irreducible test failure. When the description gives a table, an encoding
  list or a constant, transcribe every row the requirement covers into
  \`desc\` as a list inside the one sentence (a table with several output
  columns may take one requirement per column).
• The converse holds just as strictly: when the description gives PROSE, keep
  its words. Do not turn prose behaviour into a state table, do not name
  states the description does not name, and do not add a structural or
  cycle-exact reading it does not make: which kind of machine it is, whether
  an output is combinational or registered, on which clock edge or after how
  many cycles something happens. A timing phrase stays as loose as the
  description wrote it. A cycle-exact reading the description never stated is
  an invention, and one that drives the RTL and the testbench alike.
• Keep the description's REPRESENTATION of a value as well as its words: a
  value it gives by name, by index or by list stays in that form, and a
  literal appears in \`desc\` only where the description writes one.
  Re-encoding (a list of bits into a vector literal, a name into a code, a
  count into a width) adds a guess about order or size that nothing in the
  description checks, and the RTL and the testbench inherit it together.
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

${interfaceRules(contract)}

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
[ ] Clock present when state requires it; reset present only when a source requires it.
[ ] Output \`reset\` fields copy stated behavior; unspecified outputs have no invented field.
[ ] Every iface-width parameter appears in params; no orphan params.
[ ] No duplicate ids.
[ ] No requirement points at a table, figure or list instead of carrying its rows.
${childSection}${judgeSection}

OUTPUT SCHEMA (produce exactly this shape):
${schema}`,
  };
}

// ---------------------------------------------------------------------------
// Stage 2b — Spec from Description (full-auto, bypasses elicit)
// ---------------------------------------------------------------------------

export function promptSpecFromDescription(desc, childInterfaces, interfaceContract, requiredModuleName) {
  const contract = interfaceContract || extractUserInterfaceContract(desc);
  const contractSection = (contract && (contract.explicit.moduleName || contract.explicit.ports || contract.explicit.params)) ? `

EXPLICIT USER INTERFACE FACTS — copied from the user's explicit declaration.
These facts are immutable source facts. Preserve each identifier, direction,
width, and parameter name/default exactly; do not snake_case, suffix, or
otherwise normalize them:
${j(contract)}` : '';
  const requestedNameSection = requiredModuleName ? `

REQUESTED EXPORTED RTL MODULE NAME — use exactly \`${requiredModuleName}\` in
\`modName\`; this external RTL name is distinct from any internal module id.` : '';
  const childSection = (childInterfaces && childInterfaces.length > 0) ? `

CHILD MODULE INSTANCES (this module instantiates these):
${j(childView(childInterfaces))}

PARENT-MODULE SPECIFICATION RULES:
• The parent's iface must include any ports needed to connect to children.
• If two instances of the same module type exist with different paramOverrides,
  declare separate internal signals named {instanceName}_{portName}.
• Add at least one Must requirement per child instance:
  "The module shall instantiate {instanceName} with {paramOverrides}."
• Expose child parameters that the parent should be able to configure.` : '';

  const schema = `{
  "modName":      "<explicit module name copied exactly, or snake_case when unnamed>",
  "domain":       "<e.g. FIFO buffer | UART TX | AXI4-Lite crossbar>",
  "requirements": [
    {
      "id":   "REQ-<CAT>-NNN",
      "cat":  "Interface | Functionality | Timing | Error | Verification",
      "pri":  "Must | Should | May",
      "desc": "The module shall ...",
      "src":  "<verbatim quote from the DESCRIPTION this requirement derives from, or empty string if none>",
      "rat":  "[derived from description: <short quoted snippet>]"
    }
  ],
  "iface": [
    { "name": "clk",    "dir": "input",  "width": "1",      "desc": "System clock, rising-edge active" },
    { "name": "rst",    "dir": "input",  "width": "1",      "desc": "Synchronous active-high reset" },
    { "name": "data_i", "dir": "input",  "width": "DATA_W", "desc": "Write data bus" },
    { "name": "data_o", "dir": "output", "width": "DATA_W", "desc": "Read data bus",
      "reset": "retains last value; updates only on an accepted read" }
  ],
  "params": [
    { "name": "DATA_W", "type": "parameter", "def": 8, "range": "[1:1024]", "desc": "Data-path width in bits" }
  ]
}

CITE THE DESCRIPTION.

Every requirement carries "src": the exact words from the DESCRIPTION it derives
from, copied verbatim — not paraphrased, not reformatted. It is checked by
string search, so an approximation fails.

${behaviorFidelity}

SOURCE PROVENANCE:
• A required top-level declaration (module name, parameter declaration, or
  explicitly enumerated port list) is authoritative and required. A declaration
  inside a block or sentence explicitly marked as an example or buggy code is
  evidence only; do not promote it to the contract.
• Text marked "for example", "e.g.", illustrative, sample, or hypothetical
  is an example, not a requirement, unless the same sentence explicitly says
  the value is required. A code block labelled buggy, incorrect, or
  non-compliant is evidence of a defect, not normative behavior to reproduce.
• Never turn an example or buggy snippet into a requirement, but never omit a
  literal or declaration that the description presents as required.

When nothing in the description supports the requirement — you are filling a gap
from a default, a domain convention, or your own reading of an ambiguous
sentence — set "src" to an empty string and say so in "rat". That is a normal and
useful answer. An invented quote is not: one requirement drives the RTL, the
testbench and any formal property from the same sentence, so a reading nobody
can trace is invisible to every check that follows.

A TABLE IS CITED ROW BY ROW. When a requirement derives from a state table, a
truth table, an encoding list or a waveform, "src" is the rows themselves,
copied exactly as the description prints them — adjacent rows may be quoted
together. The sentence that introduces a table announces content it does not
carry, so it cites nothing: the content is in the rows.

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
${contractSection}${requestedNameSection}

INPUT ASSUMPTIONS — what the model MAY rely on:
• The DESCRIPTION above is the ONLY source of user intent.
• A reset is present only when the description explicitly requires one. Its
  KIND and POLARITY come from the description; never infer them from a name
  such as \`rst_n\`. A silent clock may use rising-edge \`clk\` as a domain
  default. A sequential design without a described reset has no reset port.
• Domain knowledge may inform standard practice but must NOT add features
  the user did not request.

ANTI-INVENTION TEST — apply per requirement before adding it:
  (a) Does its substance trace to a quoted snippet from the description? → keep.
  (b) Is it a domain-standard implementation default? → label it as such in
      \`rat\`, and retain only if it does not add observable guarantees, reset
      semantics, power-up values, or restrictions on unspecified inputs.
  (c) Did I make it up because it "would be nice"? → DROP IT.

THINKING STEPS (mental):
1. Copy an explicitly named module exactly; only when no name is explicit,
   choose a valid snake_case identifier. Copy explicit port and parameter
   names, directions, widths, and defaults exactly.
2. List every interface signal — explicit and implied by the domain.
3. List every parameterisable dimension.
4. Derive Must requirements for the core functionality stated.
5. Derive Should requirements for standard good practice in the domain
   (proper reset, parameterisability, standard handshaking).
6. Document inferred details as "[assumed]" in \`rat\`, and leave reset
   behavior absent when the description does not specify it.
7. Apply the anti-invention test.
8. Emit JSON.

REQUIREMENT RULES:
• Generate 8–15 requirements. At least 3 Must, at least 2 Should.
• \`desc\` starts with "The module shall" (Must), "should" (Should),
  or "may" (May). One sentence each.
• A requirement CARRIES the values the description GIVES; it never points at
  them. The stages that implement and test this spec see the requirements and
  nothing else — not the description, not its tables. "As specified in the
  state table" or "according to the diagram" is an empty contract: the RTL and
  the testbench will each guess the table, and any disagreement is an
  irreducible test failure. When the description gives a table, an encoding
  list or a constant, transcribe every row the requirement covers into
  \`desc\` as a list inside the one sentence (a table with several output
  columns may take one requirement per column).
• The converse holds just as strictly: when the description gives PROSE, keep
  its words. Do not turn prose behaviour into a state table, do not name
  states the description does not name, and do not add a structural or
  cycle-exact reading it does not make: which kind of machine it is, whether
  an output is combinational or registered, on which clock edge or after how
  many cycles something happens. A timing phrase stays as loose as the
  description wrote it. A cycle-exact reading the description never stated is
  an invention, and one that drives the RTL and the testbench alike.
• Keep the description's REPRESENTATION of a value as well as its words: a
  value it gives by name, by index or by list stays in that form, and a
  literal appears in \`desc\` only where the description writes one.
  Re-encoding (a list of bits into a vector literal, a name into a code, a
  count into a width) adds a guess about order or size that nothing in the
  description checks, and the RTL and the testbench inherit it together.
• ID format: \`REQ-<CAT>-NNN\`, zero-padded sequential within category.
• \`rat\` cites ONE of:
    "[derived from description: <short snippet>]"
    "[assumed]"
    "[domain default]"

${interfaceRules(contract)}

PARAMETER RULES:
• \`def\` is JSON number. \`range\` is Verilog "[min:max]".
• Every parameter in iface widths is declared. No orphan parameters.
${childSection}

OUTPUT SCHEMA (produce exactly this shape):
${schema}`,
  };
}

// ---------------------------------------------------------------------------
// Stage 2c — Coverage self-review (run 59)
// ---------------------------------------------------------------------------
// The coverage check (specTraceability.uncoveredDescription) found table rows
// or directive sentences of the description that no requirement cites. A
// dropped row is a behaviour the design will not implement and the testbench
// will not check — on run 59 a one-hot FSM lost both of its self-loop rows and
// every downstream check passed against the incomplete contract. This asks the
// model, once, to cover each item in the description's own words or to say why
// it needs no requirement. Opt-in (config.specReask).

export function promptSpecCoverageReview(desc, specData, uncovered) {
  const reqs = ((specData && specData.requirements) || []).map(function(r) {
    return { id: r.id, cat: r.cat, pri: r.pri, desc: r.desc, src: r.src, rat: r.rat };
  });
  const items = (uncovered || []).map(function(u, i) {
    return "  " + (i + 1) + ". " + (u.kind === "row" ? "row" : "sentence") + ': "' + String(u.text) + '"';
  }).join("\n");
  return {
    systemPrompt: sys(),
    maxTokens: 5000,
    userMessage: `\
TASK: Coverage review of the specification you produced for "${(specData && specData.modName) || "this module"}".

ORIGINAL USER DESCRIPTION — the ground truth:
"""
${desc}
"""

CURRENT REQUIREMENTS:
${j(reqs)}

THE FOLLOWING PARTS OF THE DESCRIPTION ARE CITED BY NO REQUIREMENT:
${items}

For EACH item do exactly one of these:
  (a) COVER IT — add a requirement, or amend the requirement it belongs to, so
      the behaviour is carried in \`desc\` in the description's own words, with
      "src" set to that row or sentence copied verbatim. A transition row of a
      state table is one term of its state's next-state condition: a row that
      stays in the same state under some input is a self-loop, and a
      requirement built only from the other rows silently drops it.
  (b) NOT NEEDED — the item is a table header, an introduction, a restatement
      of something an existing requirement already carries, or not about this
      module's behaviour. Say which.

RULES:
• Keep every existing requirement and its id; amend \`desc\` and \`src\` in
  place when covering. Do not renumber. New requirements continue the id
  sequence of their category.
• Carry ONLY what the item says. No new states, timing or error handling the
  description does not state.
• Do not touch iface or params; return requirements only.

OUTPUT — exactly this JSON and nothing else:
{
  "requirements": [ ...the FULL updated list, every existing id included... ],
  "coverage": [
    { "item": "<first words of the item>", "action": "covered" | "not_needed",
      "by": "<REQ id, when covered>", "why": "<one short clause>" }
  ]
}`,
  };
}
