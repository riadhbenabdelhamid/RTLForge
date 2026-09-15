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
  register. Include pipeline stages only for a source-stated latency.
• Distinguish initialization, reset, and input history. Reset only the state
  the contract resets; derive history updates separately. Do not invent a
  power-up value, X/Z suppression, or an invalid-input policy. Unspecified
  cases stay unspecified; a checker cannot make them requirements.
• For stateful behavior, enumerate specified transitions, simultaneous-event
  priority, hold behavior, and history that affects outputs. For protocols,
  separate acceptance, successful completion, rejection, and recovery. Trace
  back-to-back activity and recovery followed by a fresh transaction; recovery
  alone must not imply success unless the source says so. Use defaults only
  where the source defines them, not to hide a missing specified transition.
• Audit operand widths and signedness before simplifying Boolean arithmetic.
  A scalar bitwise control is not a vector-wide mask. Check upper as well as
  lower bits and every specified selector value against the source tuples.
• Cite source text for observable behavior. Generated assumptions and skipped
  question recommendations remain defaults, even if automatically marked
  confirmed. Record material ambiguities instead of treating convenient
  checker expectations or existing RTL behavior as authoritative.`;
