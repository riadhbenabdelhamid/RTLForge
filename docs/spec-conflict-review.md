# Specification conflicts found during verification

Verification triage can return `spec` when extracted requirements appear to
contradict each other. Previously, both the reflow and inline paths treated
that response as an RTL repair. The specification stayed unchanged, and the
judge's verification-failure candidates did not guarantee a later spec visit.

## Routing and review

1. Verification records the diagnosis, referenced requirement IDs, and a hash
   of the specification in `verify._specConflict`. It returns
   `NEEDS_SPEC_REVIEW` before target-flipping or local RTL/testbench repair.
   Nested verification propagates the same request to its owner.
2. The deterministic gate adds a required `spec_conflict_review` failure.
   The judge selects `spec` without another triage-model call. Disabling
   ordinary evaluation criteria does not clear this pending request.
3. The spec stage asks a model to review the alleged conflict against the
   original description and confirmed elicitation answers. The response must
   contain a recognized decision and a nonempty explanation:
   - `revise`: generate a corrected specification using the diagnosis and
     source evidence, subject to the existing schema and interface guards.
   - `reject`: retain the specification when the diagnosis is unsupported.
   - `needs_clarification`: retain the artifacts and report the source question
     for the user to resolve. Imported specifications require explicit source
     correction; the review does not rewrite them automatically.
4. Resolved review invalidates the earlier verification evidence and champion.
   The normal judge reflow reruns enabled downstream stages. The legacy
   fallback regenerates RTL/testbench and re-verifies. An interrupted reflow
   cannot restore acceptance evidence from before the review.

An unresolved request remains visible in the judge result and cannot produce
`PASS`, including after checkpoint reload, exhausted repair iterations, or a
failed spec-stage invocation. Existing checker-evidence and budget gates still
apply. If they prevent review, the result retains the pending request.

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
