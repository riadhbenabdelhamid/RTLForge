// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { sys, j } from "./base.js";

export function promptSpecCitationRepair(source, requirements) {
  return {
    systemPrompt: sys("Review source attribution only. No RTL or testbench is available or needed."),
    userMessage: `Repair invalid source quotations for the frozen requirements below.

ORIGINAL USER DESCRIPTION — the only permitted source of replacement quotes:
${j(String(source || ""))}

REQUIREMENTS WITH INVALID QUOTATIONS:
${j(requirements.map(r => ({ id: r.id, desc: r.desc, src: r.src, rat: r.rat })))}

For each requirement, determine whether the original description supports its
ENTIRE observable behavior. Its current src and rat may contain generated
assumptions or paraphrases; neither is source evidence. Do not change the
requirement to make it easier to cite.

Return kind "direct" for an explicit source statement, "derived" for a
faithful derivation requiring no additional behavioral assumption, or
"unresolved" when any part depends on a default, an unanswered question,
conflicting clauses, or a new guarantee. Explain the decision in reason.
For direct/derived, copy a supporting contiguous source passage into src
verbatim, preserving case, punctuation, identifiers, and table rows. Cite
enough context to support every clause; an unrelated literal match is invalid.
For unresolved, use src ""; the original requirement and its unresolved
evidence will be retained for review. Do not convert a default into a fact.

Defective code is evidence to inspect, not authority for intended behavior.
Quotes from illustrative examples must not be generalized beyond their scope.
Explicit answers or revisions may justify a requirement, but are not quotes
from this description. Leave such cases unresolved here if this description
does not supply the required support.

Output only this shape; do not output a new specification or any behavioral
edits. Echo each desc EXACTLY as requirement to bind the decision to it:
{"citations":[{"id":"<existing id>","requirement":"<unchanged desc>",
"kind":"direct | derived | unresolved","src":"<verbatim source passage or empty>",
"reason":"<why this passage supports all clauses, or what remains unresolved>"}]}`,
  };
}
