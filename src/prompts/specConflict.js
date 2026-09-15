// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

export function promptSpecConflictReview(state, request) {
  return {
    systemPrompt: "You review an extracted RTL specification against its source. Return JSON only.",
    maxTokens: 2000,
    userMessage: `Review the alleged specification conflict below before any artifact is changed.
The diagnosis is a hypothesis. Compare the cited requirements with the original
user description and confirmed elicitation answers. Explicit source requirements
take precedence. Never weaken a requirement just to make existing RTL or tests pass.

ORIGINAL USER DESCRIPTION:
${state._userDesc || "(not available)"}

ELICITATION:
${JSON.stringify(state.elicit || {})}

CURRENT EXTRACTED SPECIFICATION:
${JSON.stringify(state.spec || {})}

CONFLICT REPORT:
${JSON.stringify(request)}

Return {"decision":"revise|reject|needs_clarification","reason":"explanation citing requirement IDs and source evidence"}.
- revise: the extracted spec contradicts a clear source requirement. Explain the
  minimal correction, preserving all other requirements and the interface.
- reject: the alleged contradiction is unsupported; retain the specification.
- needs_clarification: the source itself conflicts, is ambiguous, or is unavailable
  to resolve this issue. State the question the user needs to answer.
Do not return a replacement specification or any RTL/testbench code.`,
  };
}
