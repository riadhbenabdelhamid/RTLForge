// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/store — Headless project store
//
// The CLI counterpart of useProject.jsx. Wraps the same reducer and same
// runStage/runAllPipelines functions with a simple synchronous store
// abstraction (no React useState — just a plain mutable holder + listeners).
// All pipeline node code runs UNCHANGED because every dependency was
// already React-free.
//
// Public surface:
//   const store = createStore({ config, projectId, storage });
//   store.getState();                   // current reducer state
//   store.dispatch(action);             // synchronous reducer update
//   store.subscribe(listener);          // returns unsubscribe()
//   store.activeMod();                  // shorthand for state.modules[activeModId]
//   store.runStage({ stageId, modId, overrideDesc, services }); // async
//   await store.saveCheckpoint();       // persist to storage (if configured)
//   await store.loadCheckpoint();       // resume from storage
// ═══════════════════════════════════════════════════════════════════════════

import {
  createInitialProjectState,
  projectReducer,
  blankModule,
  computeContentHash,
  computeIfaceHash,
  buildChildInterfaces,
  runStage as runStageCore,
  runAllPipelines as runAllPipelinesCore,
  serializeCheckpoint,
  deserializeCheckpoint,
  createCheckpointManager,
  generateProjectId,
  MODULE_UPSERT,
  SET_ACTIVE_MOD,
} from "../projectState/index.js";
import { buildPipeline, createFileTriageMemory } from "../pipeline/index.js";
import { ALL_STAGES, getActiveStages, OPTIONAL_STAGE_DEFS } from "../constants/stages.js";
import { callLLM, extractJSON } from "../llm/index.js";
import { createSkillBridge } from "./skills.js";
import { rtlforgeHome } from "./config.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Build a skill bridge object that pipeline nodes' applySkillsToPrompt()
 * helper can call. The bridge is stateless aside from the closed-over
 * config + cwd; instantiating per-stage costs nothing and avoids a stale
 * bridge if config changes mid-run.
 *
 * If config.skillsDisabled is true, returns null so the runStage
 * orchestrator doesn't even allocate the field — keeps the headless
 * smoke tests fast.
 */
/**
 * Estimate cost from a callLLM result. Mirrors what the GUI does.
 */
function defaultEstimateCost(tIn, tOut /*, model*/) {
  // Keep this in sync with the GUI's ledger estimator. Numbers are
  // deliberately conservative — the user can override via services if
  // they want exact pricing.
  return ((tIn || 0) + (tOut || 0)) * 0.000003;
}

/**
 * Create a headless project store.
 *
 * @param {object} opts
 * @param {object} opts.config       - effective config (loadConfig output)
 * @param {string} [opts.projectId]  - stable id for checkpoint key (default
 *                                     auto-generated; same one is reused
 *                                     across save/load if you keep it)
 * @param {object} [opts.storage]    - storage adapter (createFsStorage / memory / ...)
 * @param {function} [opts.callLLM]  - injectable for tests; default = real callLLM
 * @param {function} [opts.estimateCost] - injectable for tests
 * @returns {object} store
 */
export function createStore(opts) {
  const o = opts || {};
  const config = o.config || {};
  let projectId = o.projectId || generateProjectId();
  const storage = o.storage || null;

  let state = createInitialProjectState();
  const listeners = new Set();
  const pipeline = buildPipeline();
  const llmFn = o.callLLM || callLLM;
  const estCost = o.estimateCost || defaultEstimateCost;

  // Cross-run triage memory, persisted to ~/.rtlforge/triage-memory.json so
  // the CLI genuinely learns across separate `rtlforge run` invocations.
  // Best-effort: a creation failure (read-only home, etc.) leaves it null and
  // judge's cross-run learning simply no-ops. Tests/callers can override via
  // services.triageMemory.
  let triageMemory = null;
  try {
    triageMemory = createFileTriageMemory(path.join(rtlforgeHome(), "triage-memory.json"), { fs: fs });
  } catch (_e) { triageMemory = null; }

  const checkpointMgr = storage ? createCheckpointManager(storage, {
    allStages: ALL_STAGES,
  }) : null;

  function dispatch(action) {
    const before = state;
    state = projectReducer(state, action);
    if (state !== before) {
      listeners.forEach(function(l) {
        try { l(state, action); } catch (_) { /* listener errors do not break dispatch */ }
      });
    }
    return action;
  }

  function getState() { return state; }

  function subscribe(listener) {
    listeners.add(listener);
    return function unsubscribe() { listeners.delete(listener); };
  }

  function activeMod() {
    const mid = state.activeModId;
    if (!mid) return null;
    return state.modules[mid] || null;
  }

  /**
   * Ensure a module exists in the registry and is the active one. If the
   * id is null/missing, generates a default "_init" id matching the GUI.
   */
  function ensureModule(modId, modName) {
    const id = modId || state.activeModId || "_init";
    if (!state.modules[id]) {
      dispatch({ type: MODULE_UPSERT, modId: id, mod: blankModule() });
    }
    if (state.activeModId !== id) {
      dispatch({ type: SET_ACTIVE_MOD, modId: id });
    }
    return id;
  }

  /**
   * Run a single stage using the same runStage core that the GUI uses.
   * services is an optional overlay — defaults are wired here.
   */
  async function runStage(args) {
    const a = args || {};
    if (a.stageId == null) throw new Error("runStage: stageId is required");

    // Default activeStages if caller didn't pass them
    const activeStages = (a.uiState && a.uiState.activeStages) || getActiveStages(config);
    const stageMeta = ALL_STAGES.find(function(s) { return s.id === a.stageId; });
    if (!stageMeta) throw new Error("runStage: unknown stageId " + a.stageId);

    const targetModId = a.targetModId || ensureModule(a.modId);
    const childInterfaces = buildChildInterfaces(targetModId, state.modules, state.instances);

    const services = Object.assign({
      pipeline: pipeline,
      allStages: ALL_STAGES,
      callLLM: llmFn,
      computeContentHash: computeContentHash,
      computeIfaceHash: computeIfaceHash,
      estimateCost: estCost,
      childInterfaces: childInterfaces,
      triageMemory: triageMemory,
      // Skill bridge — built per-stage so workflow/cwd/policy come from
      // current store state. Pipeline nodes that opt in via
      // applySkillsToPrompt() will pick this up; nodes that don't are
      // unaffected.
      skillBridge: o.skillBridge != null
        ? o.skillBridge
        : (config && config.skillsDisabled
            ? null
            : createSkillBridge({
                config: config,
                workflow: (config && config.workflow) || "rtl",
                cwd: o.cwd,
                onWarning: function(msg) {
                  if (typeof console !== "undefined" && console.warn) console.warn("[skill] " + msg);
                },
              })),
      // Observer — fire-and-forget post-stage signal extractor.
      // Opt-in via config.observerEnabled. The function is bound here
      // with the live config + callLLM so it has what it needs to write
      // to the per-user KB at config.observerPath.
      observer: (config && config.observerEnabled === true && !o.observerDisabled)
        ? function(ctx) {
            // Lazy-import to keep the cost of observer code out of the
            // store-load hot path for users who don't enable it.
            import("../observer/index.js").then(function(m) {
              m.observeStage(ctx, { callLLM: llmFn, extractJSON: extractJSON, config: config });
            }).catch(function(_e) { /* best-effort */ });
          }
        : null,
    }, a.services || {});

    const uiState = Object.assign({
      userDesc: a.overrideDesc || "",
      config: config,
      activeStages: activeStages,
      lintWarningsAsErrors: !!config.lintWarningsAsErrors,
      verifyWarningsAsErrors: !!config.verifyWarningsAsErrors,
      sharedPackage: state.sharedPackage,
      instances: state.instances,
    }, a.uiState || {});

    return runStageCore({
      stageId:    a.stageId,
      stageKey:   a.stageKey || stageMeta.key,
      trigger:    a.trigger || "manual",
      overrideDesc: a.overrideDesc,
      targetModId: targetModId,
      reducerState: state,
      uiState:    uiState,
      services:   services,
      dispatch:   dispatch,
    });
  }

  /**
   * Run the full pipeline for the active module. Same call shape the GUI
   * uses — just with a synchronous-dispatch reducer.
   */
  async function runAllPipelines(execMode, services) {
    const activeStages = getActiveStages(config);
    const uiState = {
      userDesc: "",
      config: config,
      activeStages: activeStages,
      lintWarningsAsErrors: !!config.lintWarningsAsErrors,
      verifyWarningsAsErrors: !!config.verifyWarningsAsErrors,
    };
    const svc = Object.assign({
      pipeline: pipeline,
      allStages: ALL_STAGES,
      callLLM: llmFn,
      computeContentHash: computeContentHash,
      computeIfaceHash: computeIfaceHash,
      estimateCost: estCost,
      getState: getState,
      runStage: function(opts) { return runStageCore(opts); },
    }, services || {});

    return runAllPipelinesCore({
      execMode: execMode || "full-auto",
      reducerState: state,
      uiState: uiState,
      services: svc,
      dispatch: dispatch,
    });
  }

  async function saveCheckpoint() {
    if (!checkpointMgr) return false;
    // serializeCheckpoint signature is (reducerState, uiState) — uiState
    // carries projectId, config, and activeStage. We never persist the
    // apiKey because the serializer drops it explicitly anyway.
    const payload = serializeCheckpoint(state, {
      projectId: projectId,
      config:    config,
      userDesc:  state.userDesc || "",
      activeStage: 0,
    });
    return checkpointMgr.save(projectId, payload);
  }

  async function loadCheckpoint() {
    if (!checkpointMgr) return null;
    const payload = await checkpointMgr.load(projectId);
    if (!payload) return null;
    const restored = deserializeCheckpoint(payload);
    if (!restored || !restored.reducerState) return null;
    // Replace state wholesale — the deserialized reducerState already has
    // proper Set instances reconstructed.
    state = restored.reducerState;
    listeners.forEach(function(l) {
      try { l(state, { type: "@@CHECKPOINT_LOADED" }); } catch (_) { /* ignore */ }
    });
    // Return both halves so the caller can read uiState.config etc.
    return { state: state, uiState: restored.uiState };
  }

  async function deleteCheckpoint() {
    if (!checkpointMgr) return false;
    await checkpointMgr.remove(projectId);
    return true;
  }

  async function listCheckpoints() {
    if (!checkpointMgr) return [];
    return checkpointMgr.listIndex();
  }

  return {
    getState,
    dispatch,
    subscribe,
    activeMod,
    ensureModule,
    runStage,
    runAllPipelines,
    saveCheckpoint,
    loadCheckpoint,
    deleteCheckpoint,
    listCheckpoints,
    get projectId() { return projectId; },
    setProjectId: function(id) { projectId = id; },
    get config() { return config; },
    get pipeline() { return pipeline; },
    get optionalStageDefs() { return OPTIONAL_STAGE_DEFS; },
  };
}
