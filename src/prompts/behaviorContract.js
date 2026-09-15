// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

export const behaviorFidelity = `BEHAVIOR CONTRACT — preserve the source's distinctions:
• Separate normative requirements from illustrative or explicitly defective
  implementations, including defects described AFTER a code block. A buggy
  snippet is not an immutable interface; independently stated interface facts
  still apply. Do not promote generated defaults into source requirements.
• Transcribe tables by their row/column LABELS and bit significance, never by
  visual position. Expand the specified rows into input/state/output tuples
  before choosing an encoding. Supplied state bits may be external inputs.
• Trace pre-edge inputs and state to post-edge updates. Settling after NBA
  adds no cycle. A waveform drawn at an edge does not alone specify an extra
  register. Include added stages only when source timing/history requires
  them, including an unambiguous trace.
• For a sampled waveform, separate the input drive event, the sampling edge,
  and the output observation. Input and clock first shown changing in one row
  do not establish their event order. Compare plausible orderings before
  inferring storage depth; do not turn a skipped phase question into proven
  latency. If unresolved, a simplest matching implementation is provisional,
  and explicit latency/history requirements always take precedence.
  An output register can capture an input and update after NBA at the SAME
  edge. An additional sample register delays that update by another edge.
  Define latency from input availability to output visibility, naming both
  edges; avoid the unqualified phrase "one-cycle delay".
• Distinguish initialization, reset, and input history. Reset only the state
  the contract resets; derive history updates separately. Do not invent a
  power-up value, X/Z suppression, or an invalid-input policy. Unspecified
  cases stay unspecified; a checker cannot make them requirements.
  For each logical state item, identify its ordinary update event, reset
  scope, and first update after reset. A reset of a result/accumulator does
  not automatically reset, freeze, or invalidate the observations it uses.
  If history means the previous sampled input, preserve that meaning across
  other state resets unless the source explicitly suspends/restarts sampling.
  Derive separate next-state relations before grouping registers into reset
  branches. Test changing inputs during reset and at the first eligible edge;
  a test that holds all inputs at reset values cannot distinguish these rules.
• For stateful behavior, enumerate specified transitions, simultaneous-event
  priority, hold behavior, and history that affects outputs. For protocols,
  separate acceptance, successful completion, rejection, and recovery. Trace
  back-to-back activity and recovery followed by a fresh transaction; recovery
  alone must not imply success unless the source says so. Use defaults only
  where the source defines them, not to hide a missing specified transition.
  Write the success predicate with all prerequisites: accepted transaction,
  required payload, validation event at the required position, and no
  invalidation. The same marker in an error/recovery context need not satisfy
  that predicate. Preserve qualifications such as "correctly received" when
  interpreting a later shorthand such as "each completion marker". Explicit
  late-validation or recovery-completion behavior still takes precedence;
  conflicting clauses require clarification, not a silent protocol default.
  Trace a valid transaction, a rejected transaction, recovery alone, then a
  fresh valid transaction. Check both required success and its required
  absence; reproduce these boundary cases independently in the checker and
  formal model without treating a chosen interpretation as new source text.
• Audit operand widths and signedness before simplifying Boolean arithmetic.
  A scalar bitwise control is not a vector-wide mask. Check upper as well as
  lower bits and every specified selector value against the source tuples.
• Cite source text for observable behavior. Generated assumptions and skipped
  question recommendations remain defaults, even if automatically marked
  confirmed. Record material ambiguities instead of treating convenient
  checker expectations or existing RTL behavior as authoritative. A behavioral
  citation found only inside explicitly defective code does not establish its
  intended polarity, priority or timing; identify the unresolved choice.
• Keep source examples in a separate acceptance ledger: source row, input
  values, pre/post-edge phase, defined output bits and don't-care mask. Check
  RTL, testbench reference state and formal auxiliary state against the SAME
  rows. Include completion coincident with a new accepted input whenever the
  source permits it; do not assume completion consumes an idle cycle.
  A review PASS and a proof of generated properties do not replace this audit.`;
