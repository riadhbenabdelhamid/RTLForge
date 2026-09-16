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
Citation repair does not silently turn a failed quotation into an assumption.
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
repair calls. Only citation fields change. A matching declaration retained
from defective code is recorded as an automatic interface choice, not as
normative behavioral evidence. Interface category labels alone grant no
exception, and behavioral quotations from defective code remain blocked.

Unresolved attribution stops at Spec, preserving the specification and repair
diagnostics for inspection. It does not mark Spec complete and defer the
failure to Architecture. Existing waveform parsing restrictions are unchanged.

The contract includes the specification, elicitation decisions, source hash,
provenance ledger, revision number and previous contract hash. Source quotation
containment and structural validation are not a proof of semantic entailment;
the specification and its documented choices remain reviewable artifacts.

## Repair and formal checking

Independent checker generation/review receives the description, completed
specification and module header. It receives neither candidate implementation
bodies nor official benchmark results. Its qualification is bound to these
inputs. Repairs use the same frozen checker for both candidates and must retain
previously passing checks while improving measured behavior. Source-example
failures remain failures even if generated tests improve.
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
`completed-spec-v2` contract with the shared attribution rules. No benchmark-specific
rules or official evaluation feedback participate in this policy.
