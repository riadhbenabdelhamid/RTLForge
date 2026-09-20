// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

export const semanticRules = `SEMANTIC CONSISTENCY:
Source quotation containment does not establish that a derived requirement is correct.
The original source and explicit user decisions are authoritative. Requirement
descriptions and provenance labels are model-written extractions: even a row
labelled source can miscopy a value or apply a component's rule to the wrong
module. Preserve the actual statement and its scope, not an erroneous paraphrase.
For a labelled table, derive behavior by the labels, not by display position.
Distinguish numeric addresses, bit significance, selector encodings, and table
ordering. Enumerate the mapping before simplifying expressions. Honor explicitly
specified custom encodings; never assume every table uses binary indexing.
Explicit exceptions and boundary conditions constrain inferred general rules.
State the domain of a default, including where it does NOT apply. Check overlaps
between rules using a concrete input/state/transition example. Do not invent
new exceptions, initialization, latency, or input restrictions.
An open choice already selected in elicitation or a skipped-question default
completes the specification. Lack of an explicit source value is not a behavioral
contradiction. Keep the recorded choice unless it violates an actual source rule;
do not test it against an alternative cadence or mode that was never selected.
An automatic interpretation cannot override an explicit requirement or confirmed
user choice. If the source itself conflicts, record the conflict. If an inference
is wrong, correct the inference and all requirements derived from it together,
including verification plans and mislabelled source transcriptions. A genuine
conflict between user statements requires clarification; an extraction error
requires a checked correction that restores the source's meaning.
Changes after freezing require a recorded Spec revision and fresh evidence.`;

export function promptSpecSemantics(inputs, proposal) {
  const checking = proposal !== undefined;
  return {
    systemPrompt: "Independently review specification semantics against the original source. Return JSON only. No RTL or test results are available.",
    userMessage: semanticRules + "\n\nSOURCE AND RECORDED DECISIONS:\n" + JSON.stringify(inputs)
      + (checking ? "\n\nPROPOSED CORRECTION (a hypothesis, not authority):\n" + JSON.stringify(proposal)
        + `\nCheck every affected requirement, its dependent verification requirements,
and every actual user statement against the source. Independently recompute
mappings and overlapping conditions. Check that module-specific statements
remain in the correct module scope. Reject unnecessary changes, weakened source
obligations, and altered user decisions. A valid quotation or a source provenance
label does not make an incorrect model transcription immutable.
If the original interpretation was valid, reject the alleged defect. A new
interpretation need not match a familiar circuit; the supplied source governs.
Return {"reason":"source-based overall explanation",
"checkedRequirementIds":["every changed requirement id"],
"explicitRequirementsPreserved":true,
"findings":[{"id":"existing finding id","status":"resolved|rejected|unresolved","reason":"explanation"}],
"sourceCorrections":[{"id":"changed source-extraction requirement id","kind":"scope|mapping|transcription",
"reason":"why the original model extraction was wrong and the correction preserves the actual source",
"sources":[{"quote":"exact source passage establishing the intended scope or mapping"}]}]}.
Return exactly one outcome for EVERY finding. resolved means a real defect was
corrected in the proposed specification, including all dependencies; rejected
means the alleged defect is unsupported (including a valid recorded open choice);
unresolved means a real source violation or conflict remains. Mixed resolved and
rejected outcomes are valid: do not demand that a false diagnosis be confirmed.
No edit may rely only on a rejected finding. For every proposed sourceCorrection,
provide its own sourceCorrections entry and independently checked source passages;
otherwise use an empty array. explicitRequirementsPreserved refers to actual user
statements and choices, not erroneous model paraphrases. Attribution-only gaps
are not behavioral conflicts; do not claim unsupported source obligations.`
        : `\nReview behavior inferred by the model, including its dependent derivations.
Do not propose stylistic rewrites or report a defect solely because attribution
is incomplete. Compare the actual behavior, not the number of citations.
For each real defect, give a concrete witness and exact triggering source passages.
A witness must violate an actual source obligation, not merely use an unselected
alternative to a recorded open choice. If only attribution needs clarification,
use kind="attribution" and preserve the selected behavior.
Propose only minimal changes to the listed editable requirements. Requirements
with mode="extraction" may be corrected only for a source scope, mapping, or
transcription error: set sourceCorrection="scope|mapping|transcription" on that
repair and cite the source context that proves the error. The original source
text never changes. A model-written source label alone is not authority.
Dependent derivations and verification plans may change only with the behavioral
requirement on which they depend; include every affected requirement in the
finding and repair all dependencies together. Even an already source-labelled
dependent row requires sourceCorrection if its extraction must be corrected.
Use dependsOn=[] for a root behavioral correction (omission also means root).
Dependent derivations and verification requirements must explicitly list their
changed dependencies; never omit or invent these links.
Preserve
all IDs, priorities, categories, environment roles, interface, and explicit facts.
Never alter an explicit answer, user revision, or user-confirmed assumption.
If an automatic elicitation assumption or skipped recommendation would conflict
with the corrected requirements, revise that decision in the same transaction.
Return {"findings":[{"id":"F1","kind":"label_mapping|source_scope|default_scope|contradiction|attribution",
"requirementIds":["affected IDs"],"reason":"explanation","sources":[{"quote":"exact passage"}],
"witness":{"situation":"input/state/transition","required":"source behavior","inferred":"conflicting inferred behavior"}}],
"repairs":[{"id":"requirement id","previousDescription":"exact current description",
"description":"corrected behavior","dependsOn":["changed behavioral/dependent IDs for a dependent derivation"],
"reasoning":"derivation from source","sources":[{"quote":"exact passage"}]}],
"decisions":[{"kind":"assumption|recommendation","id":"existing decision id",
"previousText":"exact current selected text","replacementText":"corrected selection",
"reason":"source-based explanation","sources":[{"quote":"exact passage"}]}]}.
Return empty arrays when no concrete semantic error is found. If the source
conflicts or a necessary correction is protected, report the finding without
inventing a repair. Add the sourceCorrection field only for a source extraction
correction. A positive review is not formal verification.`),
  };
}
