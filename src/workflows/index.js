// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// workflows/index — Workflow registry
//
// A "workflow" describes a complete design target with its own pipeline,
// optional-stage defaults, and skill scope. Today the only workflow is
// `rtl` (12-stage NL → SystemVerilog pipeline). Future workflows will
// add entries here:
//
//   - fpga       : RTL pipeline + place-and-route + bitstream + vendor checks
//   - asic       : RTL pipeline + DRC/LVS + power analysis
//   - hls        : C/C++ → RTL via Vitis HLS or similar
//   - verif-only : verify-existing-RTL (skip generation)
//
// Each workflow declares:
//   - `name`               : id used in config and paths (e.g. "rtl", "fpga")
//   - `label`              : human-friendly display string
//   - `stages`             : the active stage list for this workflow
//   - `optionalStageDefs`  : map of optional-stage key → {label, default}
//   - `skillStageIds`      : the stage ids/keys for which skills are loadable
//                            (typically === stages plus the synthetic "agent"
//                            entry; declared explicitly to allow workflows
//                            with ephemeral or internal stages that should
//                            not accept user skills.)
//
// CONTINUOUS-DEVELOPMENT PRINCIPLE: when adding a new workflow, ONLY edit
// this file and the new workflow's module. No grep-and-replace across
// term/, prompts/, projectState/. If you find yourself editing a switch
// statement in another file when adding a workflow, that switch should
// have been a registry lookup — fix the switch first, then add the
// workflow.
// ═══════════════════════════════════════════════════════════════════════════

import { rtlWorkflow } from "./rtl.js";

const REGISTRY = new Map();

function register(workflow) {
  if (!workflow || !workflow.name) throw new Error("workflow registration: missing name");
  if (REGISTRY.has(workflow.name)) {
    throw new Error("workflow '" + workflow.name + "' already registered");
  }
  // Sanity-check shape so a bad future workflow declaration fails fast
  // here rather than confusingly later in the term layer.
  if (!Array.isArray(workflow.stages)) throw new Error("workflow '" + workflow.name + "' missing stages");
  if (!workflow.label) throw new Error("workflow '" + workflow.name + "' missing label");
  if (!workflow.optionalStageDefs) workflow.optionalStageDefs = {};
  if (!workflow.skillStageIds) {
    workflow.skillStageIds = workflow.stages.map(function(s) { return s.key; }).concat(["agent"]);
  }
  REGISTRY.set(workflow.name, Object.freeze(workflow));
}

// Built-in: the only workflow today.
register(rtlWorkflow);

/** Default workflow id when config doesn't specify one. */
export const DEFAULT_WORKFLOW = "rtl";

/**
 * Get a workflow by name. Throws on unknown — every call site has a
 * legitimate workflow id from config or CLI flag, so a typo should
 * surface immediately.
 */
export function getWorkflow(name) {
  const id = name || DEFAULT_WORKFLOW;
  const wf = REGISTRY.get(id);
  if (!wf) {
    throw new Error("unknown workflow '" + id + "' — known: " + Array.from(REGISTRY.keys()).join(", "));
  }
  return wf;
}

/** List all registered workflows (id, label) — used by `rtlforge workflows ls`. */
export function listWorkflows() {
  const out = [];
  for (const wf of REGISTRY.values()) out.push({ name: wf.name, label: wf.label });
  return out;
}

/** Test-only: register a workflow without assertion-failing on collisions. */
export function _testRegister(workflow) {
  REGISTRY.delete(workflow.name);
  register(workflow);
}
