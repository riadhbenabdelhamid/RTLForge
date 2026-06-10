// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// projectState/actions — Action type constants for the project reducer
//
// Grouped by concern. Each constant is a string that serves as the `type`
// discriminator in reducer actions. Use the constants (not bare strings)
// in both dispatch sites and reducer cases so typos are caught by linters.
// ═══════════════════════════════════════════════════════════════════════════

// ── Module registry actions ────────────────────────────────────────────────
/** Create or completely replace a module entry. Payload: { modId, module } */
export const MODULE_UPSERT = "MODULE_UPSERT";

/** Shallow-merge fields onto an existing module. Payload: { modId, patch } */
export const MODULE_PATCH = "MODULE_PATCH";

/** Set stageData[stageId] for a module. Payload: { modId, stageId, data } */
export const MODULE_STAGE_DATA_SET = "MODULE_STAGE_DATA_SET";

/** Shallow-merge `data` INTO existing stageData[stageId]. Used by cross-
 *  stage propagation in runStage.js when a downstream pipeline node
 *  updates an upstream stage's code (verify fixing RTL Gen, judge regen,
 *  etc.) — replacing would wipe accumulated metadata like
 *  _manualEditHistory, mirrored _fixes, and _originalCode chains.
 *  Payload: { modId, stageId, data } */
export const MODULE_STAGE_DATA_MERGE = "MODULE_STAGE_DATA_MERGE";

/** Mark a stage as complete (adds to the Set). Payload: { modId, stageId } */
export const MODULE_STAGE_COMPLETE = "MODULE_STAGE_COMPLETE";

/** Unmark a completed stage (removes from the Set). Payload: { modId, stageId } */
export const MODULE_STAGE_UNCOMPLETE = "MODULE_STAGE_UNCOMPLETE";

/** Record a stage-level error message. Payload: { modId, stageId, message } */
export const MODULE_STAGE_ERROR_SET = "MODULE_STAGE_ERROR_SET";

/** Clear a stage-level error. Payload: { modId, stageId } */
export const MODULE_STAGE_ERROR_CLEAR = "MODULE_STAGE_ERROR_CLEAR";

/** Set the content hash for a module. Payload: { modId, contentHash } */
export const MODULE_CONTENT_HASH_SET = "MODULE_CONTENT_HASH_SET";

/** Replace a parent module's childHashes map. Payload: { modId, childHashes } */
export const MODULE_CHILD_HASHES_SET = "MODULE_CHILD_HASHES_SET";

/** Delete a module entry entirely. Payload: { modId } */
export const MODULE_REMOVE = "MODULE_REMOVE";

// ── Per-stage run lifecycle ────────────────────────────────────────────────
/** Start a new run for a stage. Atomically pushes the run record onto
 *  stageRuns[stageId], sets activeRunTab[stageId] = run.runId, sets
 *  showDebug[stageId] = true, and appends to executionPath.
 *  Payload: { modId, stageId, stageKey, run: { runId, trigger, ts, text?, metrics?, status? } } */
export const MODULE_STAGE_RUN_START = "MODULE_STAGE_RUN_START";

/** Update an in-progress run's text/metrics from streaming output.
 *  Payload: { modId, stageId, runId, patch: { text?, metrics? } } */
export const MODULE_STAGE_RUN_UPDATE = "MODULE_STAGE_RUN_UPDATE";

/** Finish a run with a final status and close its debug panel.
 *  Payload: { modId, stageId, runId, status: "complete"|"error"|"aborted" } */
export const MODULE_STAGE_RUN_FINISH = "MODULE_STAGE_RUN_FINISH";

// ── Navigation ─────────────────────────────────────────────────────────────
/** Switch the active module. Payload: { modId } */
export const SET_ACTIVE_MOD = "SET_ACTIVE_MOD";

// ── Instance registry actions ──────────────────────────────────────────────
/** Replace the entire instance registry. Payload: { instances } */
export const INSTANCES_SET = "INSTANCES_SET";

/** Create or replace a single instance. Payload: { instId, instance } */
export const INSTANCE_UPSERT = "INSTANCE_UPSERT";

/** Delete a single instance. Payload: { instId } */
export const INSTANCE_REMOVE = "INSTANCE_REMOVE";

// ── Decomposition + shared package ─────────────────────────────────────────
/** Set the decomposition result. Payload: { decomposition } */
export const DECOMPOSITION_SET = "DECOMPOSITION_SET";

/** Set a decomposition error message. Payload: { message } */
export const DECOMPOSITION_ERROR_SET = "DECOMPOSITION_ERROR_SET";

/** Set the shared SV package. Payload: { sharedPackage } */
export const SHARED_PACKAGE_SET = "SHARED_PACKAGE_SET";

// ── Ledger + progress + phase ──────────────────────────────────────────────
/** Append an entry to the token ledger. Payload: { entry } */
export const LEDGER_APPEND = "LEDGER_APPEND";

/** Clear the token ledger. No payload. */
export const LEDGER_CLEAR = "LEDGER_CLEAR";

/** Set the pipeline progress tracker. Payload: { progress } */
export const PIPELINE_PROGRESS_SET = "PIPELINE_PROGRESS_SET";

/** Transition the project phase. Payload: { phase } */
export const PROJECT_PHASE_SET = "PROJECT_PHASE_SET";

// ── Integration pipeline actions ───────────────────────────────────────────
/** Set integration stage data. Payload: { stageId, data } */
export const INTEGRATION_STAGE_DATA_SET = "INTEGRATION_STAGE_DATA_SET";

/** Mark integration stage complete. Payload: { stageId } */
export const INTEGRATION_STAGE_COMPLETE = "INTEGRATION_STAGE_COMPLETE";

/** Record integration stage error. Payload: { stageId, message } */
export const INTEGRATION_STAGE_ERROR_SET = "INTEGRATION_STAGE_ERROR_SET";

/** Reset integration state to empty. No payload. */
export const INTEGRATION_RESET = "INTEGRATION_RESET";

// ── Bulk / lifecycle ───────────────────────────────────────────────────────
/** Reset everything to initial state. No payload. */
export const RESET_PROJECT = "RESET_PROJECT";

/** Replace the entire project state (for checkpoint restore). Payload: { state } */
export const LOAD_STATE = "LOAD_STATE";
