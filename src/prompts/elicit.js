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

export function promptElicit(desc, childSummary) {
  const schema = `{
  "domain":      "<e.g. FIFO buffer | UART TX | AXI4-Lite crossbar>",
  "modName":     "<snake_case, no spaces, no leading digit>",
  "questions": [
    {
      "id":   "INTF-01",
      "cat":  "interface | parameterization | functionality | error_handling | timing | verification | integration",
      "text": "<one sentence; ends with a question mark>",
      "opts": ["<concrete behavior A>", "<concrete behavior B>", "<concrete behavior C>", "Other (specify)"]
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
${childSection}

INPUT ASSUMPTIONS — what the model MAY rely on:
• The DESCRIPTION above is the ONLY source of user intent. Do not draw on
  domain stereotypes that contradict it.
• If the description specifies a value (data width, reset polarity, clock
  edge, depth, protocol family), treat that value as fixed — do not ask
  about it.

THINKING STEPS (mental, before emitting JSON):
1. Read the description twice. List every detail the user has SPECIFIED
   (data width, polarity, depth, protocol, etc.). These are forbidden
   question targets.
2. List every detail the description LEAVES OPEN that materially affects
   the RTL (interface boundary, parameter ranges, error semantics, timing).
   These are candidate question targets.
3. For each candidate, decide: can the user pick from a short list, or
   do they need engineering investigation? Drop the latter.
4. Group candidates by category. Limit to 1–3 per category, 10–20 total.
5. Pick safe defaults for everything you are NOT asking about and emit
   them as assumptions.
6. Emit JSON.

QUESTION REQUIREMENTS:
• MINIMALISM RULE: only ask about details the description leaves
  GENUINELY ambiguous. If the description says "8-bit data", do NOT ask
  "what data width?" If the description says "active-low reset", do NOT
  ask about reset polarity.
• Generate 10–20 questions total. Fewer is better when the description
  is clear. A description with one ambiguous decision should produce
  one question, not ten.
• Distribute across the seven categories (INTF, PARAM, FUNC, ERR, TIME,
  VERIF, INTG). Aim for ≥1 per applicable category, but skip categories
  the description fully resolves.
• ANSWERABILITY: every question must be answerable by selecting one of
  its options. Forbidden options:
    "depends on the application", "implementation-specific",
    "to be determined", "as appropriate", "see specification".
• OPTION DISTINCTNESS: the 3–5 options must differ in at least one
  user-visible behavior, not just wording. "8 bits" / "16 bits" / "32 bits"
  is good. "configurable width" / "parameterised width" is bad.
• Last option of every question MUST be "Other (specify)".
• ID STABILITY: ids follow \`<CAT>-NN\` (e.g. INTF-01, INTF-02, FUNC-01).
  Number per-category, zero-padded to 2 digits. Same description should
  produce the same id sequence on re-run.

ASSUMPTION REQUIREMENTS:
• Generate 5–8 assumptions covering decisions you ARE making (so the user
  can see them and override).
• Each assumption is a single sentence that an engineer could implement.
  Bad: "the module uses standard reset". Good: "the module uses
  asynchronous active-low reset on the rst_n input, deasserted
  synchronously to clk".
• \`confirmed\` is JSON boolean true (default — user can flip in UI later);
  never a string.
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
