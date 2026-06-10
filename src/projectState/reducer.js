// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// projectState/reducer — Pure reducer for the RTL Forge project state
//
// A single reducer that owns the core project state: module registry,
// instance registry, decomposition, shared package, ledger, pipeline
// progress, phase, and integration state. Everything React-free and
// fully unit-testable.
//
// Design principles:
// - PURE: no side effects, no async, no DOM access, no React.
// - IMMUTABLE: never mutate input state or payloads; always return a
//   fresh object. For Sets, construct new Set instances rather than
//   calling .add()/.delete() on existing references, so React detects
//   the change.
// - TOLERANT: dispatches for missing modIds or unknown action types
//   return the state unchanged rather than throwing — the pipeline
//   layer may race with module deletion, and we want the reducer to
//   be the stable bedrock.
// - NARROW: only state that needs to be updated transactionally
//   (module registry, instances, ledger, phase, integration) lives
//   here. UI state (panel visibility, viewingStage, mode) stays in
//   the React component's useState because it doesn't need reducer
//   semantics.
// ═══════════════════════════════════════════════════════════════════════════

import { blankModule } from "./moduleRegistry.js";
import {
  MODULE_UPSERT,
  MODULE_PATCH,
  MODULE_STAGE_DATA_SET,
  MODULE_STAGE_DATA_MERGE,
  MODULE_STAGE_COMPLETE,
  MODULE_STAGE_UNCOMPLETE,
  MODULE_STAGE_ERROR_SET,
  MODULE_STAGE_ERROR_CLEAR,
  MODULE_CONTENT_HASH_SET,
  MODULE_CHILD_HASHES_SET,
  MODULE_REMOVE,
  MODULE_STAGE_RUN_START,
  MODULE_STAGE_RUN_UPDATE,
  MODULE_STAGE_RUN_FINISH,
  SET_ACTIVE_MOD,
  INSTANCES_SET,
  INSTANCE_UPSERT,
  INSTANCE_REMOVE,
  DECOMPOSITION_SET,
  DECOMPOSITION_ERROR_SET,
  SHARED_PACKAGE_SET,
  LEDGER_APPEND,
  LEDGER_CLEAR,
  PIPELINE_PROGRESS_SET,
  PROJECT_PHASE_SET,
  INTEGRATION_STAGE_DATA_SET,
  INTEGRATION_STAGE_COMPLETE,
  INTEGRATION_STAGE_ERROR_SET,
  INTEGRATION_RESET,
  RESET_PROJECT,
  LOAD_STATE,
} from "./actions.js";

// ─── Initial state ──────────────────────────────────────────────────────────

/**
 * Factory returning a fresh initial state. Call this (not a frozen
 * constant) so each consumer gets an independent state tree —
 * particularly important for the nested Set/Map instances.
 */
export function createInitialProjectState() {
  return {
    // Module registry — keyed by modId, values from blankModule()
    modules: {},
    // Currently focused module
    activeModId: null,
    // Instance registry — keyed by instId, values have { parentModuleId, moduleId, ... }
    instances: {},
    // Decomposition result from promptDecompose
    decomposition: null,
    // Last decomposition error message (null when clean)
    decompError: null,
    // Token ledger entries
    ledger: [],
    // "idle" | "decomposing" | "review_decomp" | "running" | "done"
    projectPhase: "idle",
    // { currentModId, currentStageId, modulesCompleted, modulesTotal, error } or null
    pipelineProgress: null,
    // { packageName, code, types, constants } or null
    sharedPackage: null,
    // Integration pipeline state
    integrationState: {
      stageData: {},         // keyed by "int_lint" | "int_test" | "int_judge"
      completed: new Set(),  // Set of stageIds
      errors: {},            // keyed by stageId
    },
  };
}

// ─── Reducer helpers ────────────────────────────────────────────────────────

// Get a module from state or null. Does NOT fall back to blankModule —
// callers that need a default should handle missing modIds explicitly.
function getMod(state, modId) {
  return (state.modules && state.modules[modId]) || null;
}

// Produce a new state with one module replaced. If the module doesn't exist
// and `createIfMissing` is true, a blank module is created first. If it
// doesn't exist and the flag is false, the state is returned unchanged.
function withModulePatched(state, modId, patcher, createIfMissing) {
  if (!modId) return state;
  const existing = getMod(state, modId);
  if (!existing && !createIfMissing) return state;
  const base = existing || blankModule();
  const patched = patcher(base);
  if (patched === base) return state;
  return Object.assign({}, state, {
    modules: Object.assign({}, state.modules, { [modId]: patched }),
  });
}

// Produce a new state with the integration state patched.
function withIntegrationPatched(state, patcher) {
  const nextIntegration = patcher(state.integrationState);
  if (nextIntegration === state.integrationState) return state;
  return Object.assign({}, state, { integrationState: nextIntegration });
}

// ─── Reducer ────────────────────────────────────────────────────────────────

/**
 * Pure reducer for project state. See actions.js for the action type
 * catalogue. Returns the input state unchanged on unknown actions and
 * no-op patches.
 */
export function projectReducer(state, action) {
  if (!action || !action.type) return state;

  switch (action.type) {

    // ═════ Module registry ═════

    case MODULE_UPSERT: {
      if (!action.modId) return state;
      return Object.assign({}, state, {
        modules: Object.assign({}, state.modules, {
          [action.modId]: action.mod || action.module || blankModule(),
        }),
      });
    }

    case MODULE_PATCH: {
      return withModulePatched(state, action.modId, function(mod) {
        if (!action.patch) return mod;
        return Object.assign({}, mod, action.patch);
      }, false);
    }

    case MODULE_STAGE_DATA_SET: {
      return withModulePatched(state, action.modId, function(mod) {
        return Object.assign({}, mod, {
          stageData: Object.assign({}, mod.stageData, {
            [action.stageId]: action.data,
          }),
        });
      }, true);
    }

    // Merge instead of replace. Used by cross-stage propagation in runStage.js
    // so a downstream node's code updates don't wipe accumulated upstream
    // metadata (_manualEditHistory, mirrored _fixes from lint/rtl_review,
    // _manualImport, etc.).
    // If `data` is null/undefined, this is a no-op. If the slot doesn't
    // exist yet, behaves like SET. Otherwise: shallow merge.
    case MODULE_STAGE_DATA_MERGE: {
      if (action.data == null) return state;
      return withModulePatched(state, action.modId, function(mod) {
        const prev = (mod.stageData || {})[action.stageId];
        const merged = (prev && typeof prev === "object")
          ? Object.assign({}, prev, action.data)
          : action.data;
        return Object.assign({}, mod, {
          stageData: Object.assign({}, mod.stageData, {
            [action.stageId]: merged,
          }),
        });
      }, true);
    }

    case MODULE_STAGE_COMPLETE: {
      return withModulePatched(state, action.modId, function(mod) {
        if (mod.completed.has(action.stageId)) return mod;
        const nextCompleted = new Set(mod.completed);
        nextCompleted.add(action.stageId);
        return Object.assign({}, mod, { completed: nextCompleted });
      }, true);
    }

    case MODULE_STAGE_UNCOMPLETE: {
      return withModulePatched(state, action.modId, function(mod) {
        if (!mod.completed.has(action.stageId)) return mod;
        const nextCompleted = new Set(mod.completed);
        nextCompleted.delete(action.stageId);
        return Object.assign({}, mod, { completed: nextCompleted });
      }, false);
    }

    case MODULE_STAGE_ERROR_SET: {
      return withModulePatched(state, action.modId, function(mod) {
        return Object.assign({}, mod, {
          stageErrors: Object.assign({}, mod.stageErrors, {
            [action.stageId]: action.message,
          }),
        });
      }, true);
    }

    case MODULE_STAGE_ERROR_CLEAR: {
      return withModulePatched(state, action.modId, function(mod) {
        if (!(action.stageId in (mod.stageErrors || {}))) return mod;
        const nextErrors = Object.assign({}, mod.stageErrors);
        delete nextErrors[action.stageId];
        return Object.assign({}, mod, { stageErrors: nextErrors });
      }, false);
    }

    case MODULE_CONTENT_HASH_SET: {
      return withModulePatched(state, action.modId, function(mod) {
        if (mod.contentHash === action.contentHash) return mod;
        return Object.assign({}, mod, { contentHash: action.contentHash });
      }, true);
    }

    case MODULE_CHILD_HASHES_SET: {
      return withModulePatched(state, action.modId, function(mod) {
        return Object.assign({}, mod, { childHashes: action.childHashes || {} });
      }, true);
    }

    case MODULE_REMOVE: {
      if (!action.modId || !state.modules[action.modId]) return state;
      const nextModules = Object.assign({}, state.modules);
      delete nextModules[action.modId];
      const nextActive = state.activeModId === action.modId ? null : state.activeModId;
      return Object.assign({}, state, {
        modules: nextModules,
        activeModId: nextActive,
      });
    }

    // ═════ Per-stage run lifecycle ═════

    case MODULE_STAGE_RUN_START: {
      if (!action.run || action.run.runId == null) return state;
      return withModulePatched(state, action.modId, function(mod) {
        const stageId = action.stageId;
        const runs = (mod.stageRuns[stageId] || []).slice();
        runs.push(action.run);
        return Object.assign({}, mod, {
          stageRuns:    Object.assign({}, mod.stageRuns,    { [stageId]: runs }),
          activeRunTab: Object.assign({}, mod.activeRunTab, { [stageId]: action.run.runId }),
          showDebug:    Object.assign({}, mod.showDebug,    { [stageId]: true }),
          executionPath: mod.executionPath.concat([{
            stageId,
            stageKey: action.stageKey,
            runId:    action.run.runId,
            trigger:  action.run.trigger,
            ts:       action.run.ts,
          }]),
        });
      }, true);
    }

    case MODULE_STAGE_RUN_UPDATE: {
      return withModulePatched(state, action.modId, function(mod) {
        const stageId = action.stageId;
        const existing = mod.stageRuns[stageId] || [];
        let changed = false;
        const nextRuns = existing.map(function(r) {
          if (r.runId === action.runId) {
            changed = true;
            return Object.assign({}, r, action.patch || {});
          }
          return r;
        });
        if (!changed) return mod;
        return Object.assign({}, mod, {
          stageRuns: Object.assign({}, mod.stageRuns, { [stageId]: nextRuns }),
        });
      }, false);
    }

    case MODULE_STAGE_RUN_FINISH: {
      return withModulePatched(state, action.modId, function(mod) {
        const stageId = action.stageId;
        const existing = mod.stageRuns[stageId] || [];
        let changed = false;
        const nextRuns = existing.map(function(r) {
          if (r.runId === action.runId) {
            changed = true;
            // Capture the per-run result snapshot so the dropdown can switch
            // between runs without losing data.
            // `action.result` is the full stage output object at the
            // moment the run finished. We deep-snapshot via JSON for
            // safety if it's a plain data record; otherwise we store
            // the reference (callers MUST treat run.result as immutable).
            //
            // We also record the run's context (depth, parentStageKey,
            // parentIter) so the dropdown label can read like
            // "Re-run inside judge iter 1 (depth 1)".
            const patch = { status: action.status };
            if (action.result !== undefined) patch.result = action.result;
            if (action.context !== undefined) patch.context = action.context;
            if (action.ts != null) patch.finishedAt = action.ts;
            return Object.assign({}, r, patch);
          }
          return r;
        });
        const prevDebug = mod.showDebug[stageId];
        const debugAlreadyClosed = prevDebug === false;
        if (!changed && debugAlreadyClosed) return mod;
        return Object.assign({}, mod, {
          stageRuns: changed
            ? Object.assign({}, mod.stageRuns, { [stageId]: nextRuns })
            : mod.stageRuns,
          showDebug: Object.assign({}, mod.showDebug, { [stageId]: false }),
        });
      }, false);
    }

    // ═════ Navigation ═════

    case SET_ACTIVE_MOD: {
      if (state.activeModId === action.modId) return state;
      return Object.assign({}, state, { activeModId: action.modId });
    }

    // ═════ Instance registry ═════

    case INSTANCES_SET: {
      return Object.assign({}, state, { instances: action.instances || {} });
    }

    case INSTANCE_UPSERT: {
      if (!action.instId) return state;
      return Object.assign({}, state, {
        instances: Object.assign({}, state.instances, {
          [action.instId]: action.instance,
        }),
      });
    }

    case INSTANCE_REMOVE: {
      if (!action.instId || !state.instances[action.instId]) return state;
      const nextInstances = Object.assign({}, state.instances);
      delete nextInstances[action.instId];
      return Object.assign({}, state, { instances: nextInstances });
    }

    // ═════ Decomposition + shared package ═════

    case DECOMPOSITION_SET: {
      return Object.assign({}, state, {
        decomposition: action.decomposition,
        decompError: null, // setting a fresh decomposition clears prior error
      });
    }

    case DECOMPOSITION_ERROR_SET: {
      return Object.assign({}, state, { decompError: action.message || null });
    }

    case SHARED_PACKAGE_SET: {
      return Object.assign({}, state, { sharedPackage: action.sharedPackage });
    }

    // ═════ Ledger + progress + phase ═════

    case LEDGER_APPEND: {
      if (!action.entry) return state;
      return Object.assign({}, state, {
        ledger: state.ledger.concat([action.entry]),
      });
    }

    case LEDGER_CLEAR: {
      if (state.ledger.length === 0) return state;
      return Object.assign({}, state, { ledger: [] });
    }

    case PIPELINE_PROGRESS_SET: {
      return Object.assign({}, state, { pipelineProgress: action.progress });
    }

    case PROJECT_PHASE_SET: {
      if (state.projectPhase === action.phase) return state;
      return Object.assign({}, state, { projectPhase: action.phase });
    }

    // ═════ Integration pipeline ═════

    case INTEGRATION_STAGE_DATA_SET: {
      return withIntegrationPatched(state, function(integ) {
        return Object.assign({}, integ, {
          stageData: Object.assign({}, integ.stageData, {
            [action.stageId]: action.data,
          }),
        });
      });
    }

    case INTEGRATION_STAGE_COMPLETE: {
      return withIntegrationPatched(state, function(integ) {
        if (integ.completed.has(action.stageId)) return integ;
        const nextCompleted = new Set(integ.completed);
        nextCompleted.add(action.stageId);
        return Object.assign({}, integ, { completed: nextCompleted });
      });
    }

    case INTEGRATION_STAGE_ERROR_SET: {
      return withIntegrationPatched(state, function(integ) {
        return Object.assign({}, integ, {
          errors: Object.assign({}, integ.errors, {
            [action.stageId]: action.message,
          }),
        });
      });
    }

    case INTEGRATION_RESET: {
      return Object.assign({}, state, {
        integrationState: {
          stageData: {},
          completed: new Set(),
          errors: {},
        },
      });
    }

    // ═════ Bulk / lifecycle ═════

    case RESET_PROJECT: {
      return createInitialProjectState();
    }

    case LOAD_STATE: {
      if (!action.state) return state;
      // Shallow merge on top of the initial state shape so callers don't
      // have to supply every field. Important for checkpoint restores
      // that might predate new fields.
      return Object.assign(createInitialProjectState(), action.state);
    }

    // Unknown action — return unchanged
    default:
      return state;
  }
}
