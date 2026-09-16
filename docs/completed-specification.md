# Verification against a completed specification

A short description often leaves implementation decisions open. New Spec
stage results record those decisions in a versioned `_designContract` before
RTL generation. This record distinguishes original-source requirements,
derivations, explicit elicitation answers/revisions, and auto-selected
implementation assumptions. Imported specifications are recorded as user
specifications. Automatically selected choices are not user quotations.

For a default, use an empty requirement `src` and a `rat` naming the selected
assumption (`A-01`), recommended skipped question (`TIME-01`), or a justified
domain default. Explicitly rejected assumptions, unknown references,
nonliteral citations and declared source conflicts remain blocking issues.
Attribution review may explicitly reclassify a paraphrase as an unconfirmed
interpretation with reasoning and valid triggering passages. It never silently
turns a failed quotation into a user fact or changes requirement behavior.
Original interface fidelity checks and executable source examples still apply.

Requirements supported by separate passages may carry
`sources: [{"quote": "..."}, {"quote": "..."}]`, with `src` retaining the
first passage for existing consumers. Each quotation is checked separately;
the provenance ledger records its exact source offsets. A supplied offset
must match the text. User-stated defaults and exception rules are source facts.
They are distinct from implementation defaults selected by the model.

Citation repair and contract qualification share the same validator. Simple
declaration requirements can be reconciled mechanically against the source
and specified interface; other invalid citations receive at most two model
repair calls. Only provenance fields change. A matching declaration retained
from defective code is recorded as an automatic interface choice, not as
normative behavioral evidence. Interface category labels alone grant no
exception. Defective code cannot establish normative behavior, but may be cited
as the trigger for a documented interpretation. Port direction can be supported
independently of width, so a direction-only requirement does not inherit a
defective width.

Unresolved attribution stops at Spec, preserving the specification and repair
diagnostics for inspection. It does not mark Spec complete and defer the
failure to Architecture. Waveform notation may be completed as described below.

The contract includes the specification, elicitation decisions, source hash,
provenance ledger, revision number and previous contract hash. Source quotation
containment and structural validation are not a proof of semantic entailment;
the specification and its documented choices remain reviewable artifacts.

## Interpretation provenance

The Spec view, verification summary, terminal output and exported report present
the following five fields for recorded requirement provenance.

The pipeline behavior is:

- **Explicit requirements:** implement and check them.
- **Derived interpretations:** record the reasoning and supporting passages,
  then proceed.
- **Open choices:** record the selected assumption and alternatives; proceed
  automatically in full-auto mode.
- **Contradictions:** flag them explicitly rather than silently overriding an
  explicit requirement.

Consider an illustrative prompt: "Implement a 4-bit unsigned saturating event
counter." The model interprets behavior at the maximum count as follows:

| Field | Recorded value |
|---|---|
| Requirement | An increment when `count` is 15 leaves `count` at 15 |
| Origin | LLM interpretation |
| Triggering source | “4-bit unsigned” and “saturating event counter” |
| Reasoning | The maximum unsigned 4-bit value is 15; saturation means further increments hold that value instead of wrapping |
| User confirmation | Unconfirmed |

Each triggering passage records its exact text and location in the
original prompt. The reasoning is model-authored provenance, not a quotation
from the user. This interpretation supplies a valid basis for proceeding in
full-auto mode while keeping its unconfirmed status visible. It does not settle
separate ambiguities, such as reset behavior or whether an event is detected by
an edge or a signal level.

Selected interpretations become part of the frozen specification. Repairs must
respect them; changing one requires an explicit, recorded specification revision
and new verification evidence. An interpretation must not silently override an explicit
user requirement or a rejected choice.

Generated requirements use `provenance.kind: "interpretation"`,
`provenance.reasoning`, and `provenance.sources: [{"quote": "..."}]`;
runtime records exact source offsets. Their top-level `src` is empty and
`sources` is an empty array because the inferred behavior is not a quotation.
Open choices use `provenance.kind: "assumption"`, with reasoning and
`provenance.alternatives`. Model-authored confirmation claims never establish
user confirmation. Explicit answers and revisions retain their separate origins.

Formal checking may establish properties of that interpreted specification;
the result remains conditional on the recorded interpretations, and user-intent
confirmation remains separate. If formal checking is unavailable or its harness
fails, preserve the useful RTL candidate and report **Verification incomplete**,
alongside actual simulation results and recorded assumptions and interpretations.
A harness failure alone does not justify changing RTL behavior. A separately
established RTL failure must still be reported as a failure.

The presentation must distinguish three questions: **what the user stated**,
**what RTLForge inferred**, and **what the tools actually verified**.

## Repair and formal checking

Before freezing a generated specification, source tables with ambiguous notation
receive at most one completion call when `specReask` is enabled. This call sees
the source, interface, requirements and elicitation choices; it sees no RTL,
generated testbench or measurements. It can record per-table `sourceConventions`
for signal aliases, numeric bases (2, 10 or 16), and input/clock ordering.
Each choice needs triggering source passages, reasoning and alternatives. It is
an **unconfirmed LLM interpretation**, included in the contract hash and shown in
the provenance ledger. Explicit source conventions take precedence. Invalid
choices leave the source example unresolved; they cannot modify rows, expected
values, widths, latency requirements or don't-care masks.

At the model-response boundary, exact radix strings `"2"`, `"10"`, and `"16"`
are converted to their numeric equivalents before validation and freezing.
The raw response and each conversion remain in `_sourceConventionReview` for
audit. Other strings, fields and invalid values are not coerced. This does not
normalize or revise existing frozen contracts during verification.

Only sealed, unchanged choices can drive source replay or formal consistency
checks. Passing under an interpreted sampling order remains conditional evidence.
Repairs cannot select a different phase or radix to make an implementation pass;
changing a convention requires a specification revision and fresh evidence.
Timing analysis distinguishes input drive, active sampling, and post-NBA result
observation. The RTL prompt imposes no separate completion state or idle bubble:
the contract determines latency, throughput and transaction completion.

Independent checker generation/review receives the description, completed
specification and module header. It receives neither candidate implementation
bodies nor official benchmark results. Its qualification is bound to these
inputs. Repairs use the same frozen checker for both candidates and must retain
previously passing checks while improving measured behavior. Source-example
failures remain failures even if generated tests improve.
Every production stage boundary, including nested reflows, protects candidates
under a completed specification. Replacements must preserve the frozen interface
and improve measured behavior using the same qualified independent checker.
Ties, unavailable comparisons and lost passing checks retain the incumbent.
A syntactically broken incumbent may be replaced by a compiling, measured
candidate. Rejected RTL and the comparison are recorded for inspection; dependent
testbench and measurement artifacts are restored with the incumbent. A checker
generated during a repair cannot replace the frozen comparison checker.
Nested repair rejection returns its reason and proposal to the owning review;
it is not recorded as an identical model response. A blocked comparison stops
with its actual cause, without repeatedly reviewing the unchanged incumbent.
These checks preserve demonstrated behavior; they do not prove coverage of every
possible input or guarantee superiority over every independent model sample.
Completed contracts generate this checker even when standalone RTL fallback
is disabled; enabling a checker does not generate an extra standalone RTL
candidate in that mode.

Formal checking may run against recorded choices. Properties and results carry
the contract identity and the scope `completed-specification-properties`.
Absence of executable source examples is reported as unavailable consistency
evidence, not as a successful example check. Passing generated properties does
not establish that every requirement or every possible behavior was covered.

An assumed design behavior is an assertion obligation, not a solver assumption.
For completed contracts, an `assume` property must name a requirement marked
`environment: true` and may reference only input ports and parameters.
Output- or auxiliary-state-dependent restrictions are rejected. The existing
initial-reset treatment remains part of the formal harness.

## Results and revisions

Simulation and formal stages retain their measured results. When all enabled
criteria pass but material choices remain auto-selected, Judge records PASS for
`contractVerification` and keeps the overall status `UNVERIFIED`, with the
reason that user intent is conditional on those choices. GUI and terminal
summaries list the choices and use amber for the unconfirmed intent. A failing
implementation remains a failure; assumptions do not turn it into a pass.

Changing source text, requirement behavior, constraints or elicitation choices
invalidates the frozen contract. Rerun Spec to create a new revision, then
regenerate downstream artifacts and evidence. Project edits mark existing
downstream results stale and retain their artifacts for inspection. A checker
or property set from a different contract cannot authorize a repair or proof.
Telemetry-only changes do not revise the contract.

Older checkpoints are not automatically reclassified: rerun Spec to create a
`completed-spec-v3` contract with interpretation provenance. No benchmark-specific
rules or official evaluation feedback participate in this policy.
