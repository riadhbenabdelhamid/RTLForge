// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/elicit — Stage 1: Requirements Elicitation  (REVISED)
//
// Generates clarifying questions and initial assumptions from a free-text
// module description.
//
// REVISION GOALS (vs. previous version):
//   - Tighten the "don't ask what's already specified" rule so the model
//     stops re-asking about reset polarity / clock edge when the user has
//     given them. Old prompt stated this once; new prompt makes it the first
//     thinking step and gives concrete examples of redundant questions.
//   - Add an answerability rule: every question must be answerable from one
//     of the provided options without engineering investigation. Options like
//     "depends on requirements" or "implementation-specific" are forbidden.
//   - Add option-distinctness rule: the 3-5 options per question must differ
//     in at least one user-visible behavior, not just wording.
//   - Add ID stability rule: ids follow `<CAT>-NN` deterministically (CAT
//     prefix + zero-padded 2-digit index within the category) so the
//     downstream spec stage can stably reference them across regenerations.
//   - Make the assumption confirmation contract explicit: `confirmed` is
//     the model's *initial* default, the user changes it later in the UI;
//     `revised` stays null at this stage.
// ═══════════════════════════════════════════════════════════════════════════

import { sys, j } from "./base.js";
import { extractUserInterfaceContract } from "../utils/interfaceContract.js";
import { behaviorFidelity } from "./behaviorContract.js";

export function promptElicit(desc, childSummary, interfaceContract, requiredModuleName) {
  const contract = interfaceContract || extractUserInterfaceContract(desc);
  const contractSection = (contract && (contract.explicit.moduleName || contract.explicit.ports || contract.explicit.params)) ? `

EXPLICIT USER INTERFACE FACTS — copied from an explicit declaration in the
DESCRIPTION. Preserve spelling, direction, width, and parameter name/default
exactly. Do not normalize names to snake_case or add, remove, or decorate
listed ports:
${j(contract)}` : '';
  const requestedNameSection = requiredModuleName ? `

REQUESTED EXPORTED RTL MODULE NAME:
\`${requiredModuleName}\`
This is an external interface contract. Use this exact name in \`modName\`;
do not confuse it with an internal decomposition/module id.` : '';
  const schema = `{
  "domain":      "<e.g. FIFO buffer | UART TX | AXI4-Lite crossbar>",
  "modName":     "<copy an explicitly named module exactly; otherwise use a valid snake_case identifier>",
  "questions": [
    {
      "id":   "INTF-01",
      "cat":  "interface | parameterization | functionality | error_handling | timing | verification | integration",
      "text": "<one sentence; ends with a question mark>",
      "opts": ["<concrete behavior A>", "<concrete behavior B>", "<concrete behavior C>", "Other (specify)"],
      "recommended": "<the one option string above you would choose as the safe default>"
    }
  ],
  "assumptions": [
    {
      "id":        "A-01",
      "text":      "<one sentence; an actionable default the model is using>",
      "confirmed": true,
      "revised":   null
    }
  ]
}`;

  const childSection = (childSummary && childSummary.length > 0) ? `

THIS MODULE IS A PARENT that instantiates the following children:
${j(childSummary)}

Add 2–4 questions in the "integration" category covering:
• How child instances connect to the parent's external interface.
• Whether child parameters are exposed to the parent or hardcoded.
• Data-flow and handshaking between sibling instances.
• Reset and clock routing to children.` : '';

  return {
    systemPrompt: sys(),
    maxTokens: 5000,
    userMessage: `\
TASK: Analyse the hardware module description below and produce structured
elicitation data — questions for genuinely ambiguous details, plus
assumptions for safe defaults you are committing to.

DESCRIPTION:
"""
${desc}
"""
${contractSection}${requestedNameSection}
${childSection}

INPUT ASSUMPTIONS — what the model MAY rely on:
${behaviorFidelity}
• The DESCRIPTION above is the ONLY source of user intent. Do not draw on
  domain stereotypes that contradict it.
• If the description specifies a value (data width, reset polarity, clock
  edge, depth, protocol family), treat that value as fixed — do not ask
  about it.

THINKING STEPS (mental, before emitting JSON):
1. Read the description twice. List every detail the user has SPECIFIED
   (data width, polarity, depth, protocol, etc.). These are forbidden
   question targets.
2. Copy every explicit module, port, direction, width, and parameter name or
   default exactly. These source facts outrank elicited answers and defaults.
3. List every detail the description LEAVES OPEN that materially affects
   the RTL (interface boundary, parameter ranges, error semantics, timing).
   These are candidate question targets.
4. For each candidate, decide: can the user pick from a short list, or
   do they need engineering investigation? Drop the latter.
5. Group candidates by category. Ask only the unresolved material questions,
   up to 20 total; zero is valid for a complete description.
6. Emit only necessary implementation defaults as assumptions. Do not fill
   gaps in observable behavior with invented guarantees.
7. Emit JSON.

QUESTION REQUIREMENTS:
• MINIMALISM RULE: only ask about details the description leaves
  GENUINELY ambiguous. If the description says "8-bit data", do NOT ask
  "what data width?" If the description says "active-low reset", do NOT
  ask about reset polarity.
• Generate 0–20 questions total. Fewer is better when the description
  is clear. A description with one ambiguous decision should produce
  one question, not ten.
• For waveform-only inference, resolve coincident input/clock event ordering
  first. Ask one material sampling-convention question; do not create a set
  of latency, startup-X, filtering, or unknown-input requirements from the
  same unresolved phase. Show which input is available BEFORE the sampling
  edge and when the output is observed. Do not assume an extra register.
• Reset questions must name the affected state: clearing a result does not
  imply clearing its input history. If history is unspecified, consider
  retaining the ordinary sampling rule before proposing constants or a
  skipped first sample. Do not ask about behavior already determined by the
  source's definition of consecutive samples.
• Resolve completion criteria across the whole description before selecting
  an error-recovery default. Distinguish recovery from successful acceptance;
  a delimiter alone does not satisfy source-stated validity prerequisites.
  Ask one question only if those clauses remain materially inconsistent.
• Distribute across the seven categories (INTF, PARAM, FUNC, ERR, TIME,
  VERIF, INTG). Aim for ≥1 per applicable category, but skip categories
  the description fully resolves.
• ANSWERABILITY: every question must be answerable by selecting one of
  its options. Forbidden options:
    "depends on the application", "implementation-specific",
    "to be determined", "as appropriate", "see specification".
• CONSUMABILITY: every question's answer must be expressible in RTL and
  checkable by a testbench. Ask about CYCLE-LEVEL behavior — sampling edge,
  latency in clock cycles, throughput, what a signal does during and after
  reset. Physical-implementation quantities (setup/hold times in ns,
  propagation delay, target Fmax, area/power budgets) belong to synthesis
  and place-and-route, not to this design: no stage downstream can
  implement or verify them, so never ask about them.
• SCOPE: ask WHAT the design must do, never HOW a later stage should do
  its job — micro-architecture (which structures to use), verification
  mechanics (which assertions to write), and code organisation are decided
  downstream from the answers, not by the user here.
• OPTION DISTINCTNESS: the 3–5 options must differ in at least one
  user-visible behavior, not just wording. "8 bits" / "16 bits" / "32 bits"
  is good. "configurable width" / "parameterised width" is bad.
• Last option of every question MUST be "Other (specify)".
• RECOMMENDED DEFAULT: every question carries a \`recommended\` field holding
  a VERBATIM copy of the one option you would choose if nobody answers —
  the reading most faithful to the description, or the simplest safe
  behavior when the description is silent. A run that nobody answers
  interactively builds its spec from these, so a question whose recommended
  option is the faithful one settles the ambiguity instead of losing it
  (measured, run 44: a question about which register bits are storage went
  unasked and unanswered, and two independently generated designs then
  implemented opposite readings).
• ID STABILITY: ids follow \`<CAT>-NN\` (e.g. INTF-01, INTF-02, FUNC-01).
  Number per-category, zero-padded to 2 digits. Same description should
  produce the same id sequence on re-run.

ASSUMPTION REQUIREMENTS:
• Generate 0–8 assumptions covering only necessary decisions you ARE making
  (so the user can see them and override). There is no minimum quota.
  Do not restate explicit source facts as assumptions; those facts remain in
  the original description and must be cited there by later stages.
• Each assumption is a single sentence that an engineer could implement.
  Bad: "the module uses standard reset". Good: "the module uses
  asynchronous active-low reset on the rst_n input, deasserted
  synchronously to clk".
• \`confirmed\` is JSON boolean true (default — user can flip in UI later);
  never a string. This is a default UI selection, not evidence of an explicit
  user confirmation and not permission to present your wording as source text.
• \`revised\` is JSON null at this stage; the user fills it in if they
  override.
• ID format: \`A-NN\`, zero-padded.

ANTI-PATTERNS — do not produce questions like:
• "What features should the module have?" (too vague — split into specifics)
• "What is the desired performance?" (not answerable from a list)
• "Should the module be parameterised?" (always yes if widths vary)
• Questions whose answer is already in the description.

OUTPUT SCHEMA (produce exactly this shape):
${schema}`,
  };
}
