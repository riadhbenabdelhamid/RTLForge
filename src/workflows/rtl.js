// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// workflows/rtl — The RTL/SystemVerilog workflow
//
// Wraps the existing ALL_STAGES + OPTIONAL_STAGE_DEFS so the workflow
// abstraction is real today even though there's only one workflow. When
// `fpga` and others arrive, this file stays unchanged and they slot in
// as siblings.
//
// The agent (chat-mode) "stage" is a synthetic id that lets users drop
// skills targeting `rtlforge ask` itself — e.g. "always read_module
// before suggesting changes". It's not part of the pipeline DAG; the
// skill loader recognizes it as a special key.
// ═══════════════════════════════════════════════════════════════════════════

import { ALL_STAGES, OPTIONAL_STAGE_DEFS } from "../constants/stages.js";

export const rtlWorkflow = {
  name: "rtl",
  label: "Spec-based RTL flow",
  stages: ALL_STAGES.slice(),
  optionalStageDefs: Object.assign({}, OPTIONAL_STAGE_DEFS),
  // Skills can target any pipeline stage by `key`, plus the synthetic
  // "agent" key for chat-mode (rtlforge ask) skills.
  skillStageIds: ALL_STAGES.map(function(s) { return s.key; }).concat(["agent"]),
};
