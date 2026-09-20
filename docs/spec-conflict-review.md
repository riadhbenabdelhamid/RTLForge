# Specification conflicts found during review or verification

Verification triage and RTL/Test Review can request `spec` when an inferred
requirement appears wrong or requirements contradict each other. An RTL repair
cannot resolve a frozen specification conflict. The diagnosis is a hypothesis
to review against source evidence, not permission to rewrite requirements.

## Routing and review

1. The detecting stage records the diagnosis, referenced requirement IDs, and a hash
   of the specification in `verify._specConflict`. It returns
   `NEEDS_SPEC_REVIEW` before target-flipping or local RTL/testbench repair.
   Nested reviews and verification propagate the same request to their owner.
   Formal stages skip checking the disputed specification and preserve RTL.
   Review findings require a critical/major issue and known requirement IDs;
   ordinary missing implementation remains an RTL repair target.
2. The deterministic gate adds a required `spec_conflict_review` failure.
   The judge selects `spec` without another triage-model call. Disabling
   ordinary evaluation criteria does not clear this pending request.
3. The spec stage reviews the alleged conflict against the original description
   and recorded elicitation decisions. For a frozen specification, this uses the
   bounded [semantic review transaction](completed-specification.md#semantic-review-before-freezing):
   exact source passages, a concrete witness, restricted edits, and a second
   confirmation call. It does not freely regenerate the specification.
   - `revise`: accept a confirmed correction to inferred requirements, checked
     model extraction errors, and dependent verification requirements. Preserve
     actual source statements, user choices, interface,
     priorities, and environment roles. Record the previous contract hash and
     save the incumbent RTL in `_specRevision.preservedCandidate`.
   - `reject`: retain the specification when the diagnosis is unsupported.
   - `needs_clarification`: retain the artifacts and report the source question
     for the user to resolve. Imported specifications require explicit source
     correction; the review does not rewrite them automatically. An unavailable
     confirmation also preserves the frozen contract and keeps review pending.
   Legacy states without a frozen contract retain their existing source-review
   and guarded specification-generation path.
   Each semantic finding has its own resolved, rejected, or unresolved outcome.
   A rejected diagnosis can coexist with an accepted correction to another
   finding. Every changed requirement must be independently checked and supported
   by a resolved finding; a source extraction correction also requires separately
   checked source passages. A remaining real conflict retains the original
   transaction, while missing attribution alone is not a behavioral contradiction.
4. Resolved review invalidates the earlier verification evidence and champion.
   The normal judge reflow reruns enabled downstream stages. The legacy
   fallback regenerates RTL/testbench and re-verifies. An interrupted reflow
   cannot restore acceptance evidence from before the review.

An unresolved request remains visible in the judge result and cannot produce
`PASS`, including after checkpoint reload, exhausted repair iterations, or a
failed spec-stage invocation. A source-only review can proceed before a checker
exists, because it does not use simulation evidence to justify a correction.
Checker qualification still governs ordinary RTL repairs and acceptance;
fresh verification is required after review. Existing run budgets still apply.

The review is model-assisted: validating its output shape is not a proof of
semantic equivalence with the user's intent. The original requested behavior
remains authoritative; benchmark/reference tests must remain independent of
these generated-artifact repairs. After correcting an ambiguous source, rerun
specification and downstream stages; for a corrected imported specification,
start a fresh run with the corrected source.

## Regression coverage

`tests/specConflictEscalation.test.js` exercises both routing paths, nested
propagation, checkpoint reload, acceptance with criteria disabled, valid and
invalid review decisions, imported specifications, and interrupted reflow.
`tests/runStageCodeMirror.test.js` checks that review transitions replace old
verification evidence in persisted project state.
`tests/specSemanticReview.test.js` covers editable boundaries, component scope,
source extraction corrections, dependent verification plans, mixed finding
outcomes, selected timing defaults, unavailable calls, custom encodings,
recorded revisions, and guarded Judge
reflow. `tests/reviewSpecRouting.test.js` covers early review escalation,
artifact preservation, formal skips, and shared GUI/CLI checkpoint persistence.
