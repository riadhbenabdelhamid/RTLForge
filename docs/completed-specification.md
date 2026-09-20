# Verification against a completed specification

A short description often leaves implementation decisions open. New Spec
stage results record those decisions in a versioned `_designContract` before
RTL generation. This record distinguishes original-source requirements,
derivations, explicit elicitation answers/revisions, and auto-selected
implementation assumptions. Imported specifications are recorded as user
specifications. Automatically selected choices are not user quotations.

## Attribution policy

Set `attributionPolicy` in **Settings → Workflow → Attribution policy**, or use
`rtlforge config set attributionPolicy auto` in the CLI. The supported values
are `auto` (default), `strict`, and `relaxed`. The CLI also accepts
`RTLFORGE_ATTRIBUTION_POLICY` and `--attributionPolicy <value>`.

| Setting | Behavior |
|---|---|
| `auto` | Strict in semi-auto mode; relaxed in full-auto mode |
| `strict` | Require resolved attribution and user confirmation of open choices before generation |
| `relaxed` | Allow provisional generation after bounded citation repair, retaining unresolved attribution |

Supported interpretations with reasoning and valid triggering passages can
proceed under either policy; they remain unconfirmed interpretations. Unknown
execution contexts default to semi-auto. Explicit policy settings override the
mode default. CLI `run` uses full-auto unless `--semi` is supplied.

New `completed-spec-v4` records freeze the requested policy, effective policy,
and execution mode alongside the specification. Checkpoints preserve the
setting and mode; verification summaries show the frozen policy. Changing the
requested or effective policy requires rerunning Spec to record a revision.

Relaxed admission permits **generation**, not a verification claim. An invalid
quotation remains rejected attribution in the audit record; it never becomes
user evidence. Missing attribution is recorded as unresolved model attribution.
The useful candidate remains available with **Verification incomplete**, actual
simulation results, and unresolved entries. Source qualification, formal
eligibility, and independent repair acceptance still require valid evidence.
Qualified interpretations may support conditional formal checking. Unresolved
citations cannot authorize formal-driven RTL repair or unmeasured replacements.

Both policies block declared contradictions, rejected choices, unknown
elicitation references, interface violations, malformed requirements, and
frozen-contract integrity failures. Verification-plan requirements cannot
override behavioral requirements. This gate does not prove semantic entailment
or guarantee correctness of model-generated RTL.

The externally configured module name is recorded as `configuration` evidence
with the `requiredModuleName` key and its value. It need not occur in the
original description. This exception covers only the exact module-name
declaration, never behavior attached to an interface requirement.

Interface guards use a shared parser. Declarations in another module's example
do not become ports or parameters of the requested module, and words in prose
outside an explicit interface do not create mandatory ports.

For a default, use an empty requirement `src` and a `rat` naming the selected
assumption (`A-01`), recommended skipped question (`TIME-01`), or a justified
domain default. Explicitly rejected assumptions, unknown references and declared
source conflicts remain blocking issues. Unresolved nonliteral citations block
strict admission; relaxed admission retains them as unresolved evidence.
Attribution review may explicitly reclassify a paraphrase as an unconfirmed
interpretation with reasoning and valid triggering passages. It never silently
turns a failed quotation into a user fact or changes requirement behavior.
Original interface fidelity checks and executable source examples still apply.

Citation review receives recorded elicitation choices and requirement provenance
as well as the original description. A requirement combining a source fact with
a selected open choice can be recorded as an interpretation with exact triggering
passages; the choice is not promoted to explicit user intent.
Selected elicitation assumptions remain inputs even when no clarification
questions were needed.

Before sealing, a bounded conflict review can supersede an untouched automatic
assumption when existing source-supported requirements already correct it.
The record retains the old assumption, source passages, replacement requirement
ids, and reason. User-confirmed assumptions, explicit answers, and user revisions
are protected. A model-written `resolved` label alone is insufficient. The
reconciled decisions are frozen together; later changes require a new revision.

New elicitation choices record `confirmationOrigin: "automatic"`; explicit GUI
selections and edits record `"user"`. Older decisions without this origin are
not automatically superseded.

Coverage review merges amendments by requirement identifier. Unchanged
requirements retain omitted provenance, alternatives, and formal environment
roles. Changed behavioral fields require fresh attribution; they cannot inherit
an earlier interpretation simply by reusing its identifier. A coverage update
that loses existing qualification or changes a requirement's formal environment
role is rejected and recorded, keeping the original specification and its
remaining coverage gaps visible.

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

In strict mode, unresolved attribution stops at Spec, preserving the specification
and repair diagnostics for inspection. Relaxed mode permits provisional
generation with an explicit warning. Citation repair makes at most two model
calls; already-valid citations require none. When all separate source passages
are valid, a stitched legacy `src` field is normalized mechanically to the first
passage, retaining the original in an audit record and preserving behavior.
Waveform notation may be completed as described below.

The contract includes the specification, elicitation decisions, source hash,
provenance ledger, revision number and previous contract hash. Source quotation
containment and structural validation are not a proof of semantic entailment;
the specification and its documented choices remain reviewable artifacts.

## Semantic review before freezing

`specSemanticReview` defaults to `true` in GUI and CLI configuration. When a
generated specification includes editable interpretations or source extractions,
Spec reviews them against the original description and elicitation decisions before
freezing them. This uses the Spec stage's model settings and run budget, with
at most two JSON calls: a diagnosis/proposal and a fresh confirmation of any
proposed correction. Imported specifications are excluded.

The review checks labelled mappings independently of display order and scopes
inferred general rules around explicit exceptions. For example, a selector
label `110` can mean binary address six even when displayed first, while an
explicit custom encoding must remain unchanged. A demand-based control rule
must respect an explicit inhibit condition.

Corrections require a concrete conflicting case and validated source passages.
Inferred behavioral requirements and their dependent derivations, including
verification requirements, may change together. A model-written requirement
labelled `source` may also contain an extraction error: correcting its scope,
mapping, or transcription requires a separate source check in the confirmation.
The original source text, literal source statements, answers, user-confirmed
decisions, IDs, priorities, categories, interface, and environment roles remain
protected. Changed derivations must form an acyclic dependency chain rooted in
a changed behavioral requirement. Any related automatic decision correction is
recorded in the same transaction, retaining
its original text and automatic origin. The confirmation sees the original
source, original decisions, proposed requirements, and proposed decisions;
RTL, testbenches, and simulation results are excluded.

`spec._semanticReview` records the inputs' hash, original requirements,
diagnosis, proposed correction, confirmation, and per-finding outcomes:
`resolved`, `rejected`, or `unresolved`, each with a reason. Mixed resolved and
rejected findings can approve a fully checked correction; rejecting a false
diagnosis does not block a separate valid repair. An unresolved real conflict
prevents adoption of the transaction, so a proposed repair is not marked resolved
unless it was actually adopted. Selected automatic choices complete unspecified
behavior; missing attribution alone does not establish a behavioral conflict.
An unresolved attribution finding may remain alongside an adopted behavioral
correction; its qualification issues still follow the selected attribution policy.
A rejected, malformed, or unavailable review preserves the original requirements and does
not establish approval. Findings without a valid independent disposition remain
unresolved in the audit, without being promoted to confirmed conflicts. Only
independently confirmed unresolved behavioral conflicts add blocking conflict
entries. This is model-assisted semantic review, not proof
of equivalence with user intent; two reviews can still make the same mistake.

RTL/Test Review can also request Spec review after freezing. A confirmed
correction creates a linked contract revision, saves the previous RTL for
inspection, and invalidates prior verification evidence. Disabling the
pre-freeze review does not disable this conflict handling. See
[specification conflict routing](spec-conflict-review.md).

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

When standalone fallback is enabled and a qualified checker exists, RTL Gen
compares the generated candidates before review or formal checking. A strict
measured improvement that preserves existing passed checks can be selected at
this boundary. Both candidates and their measurements are retained in
`_initialComparison`, and the ordinary RTL Gen checkpoint saves the winner.
Formal and later stages then operate on that selected RTL. Incomplete evidence
never authorizes a replacement.

Verification and acceptance use the same simulator warning policy, including
`verifyWarningsAsErrors`. Their measurement identities include the effective
commands and dependencies. Optional waveform investigation has a five-minute
deadline, further limited to a quarter of the remaining stage budget, leaving
time for repair and measurement. Cancellation still stops the pipeline.

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
`completed-spec-v4` contract with a recorded attribution policy. Existing v3
contracts retain their original qualification rules. No benchmark-specific
rules or official evaluation feedback participate in this policy.
