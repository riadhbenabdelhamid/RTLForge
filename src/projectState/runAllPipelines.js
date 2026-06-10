// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// projectState/runAllPipelines — Multi-module pipeline orchestrator
//
// Drives multiple modules through the stage pipeline in topological order.
//
// What it does:
//   1. Computes topological order via getModuleOrder (leaves → top)
//   2. Dispatches PIPELINE_PROGRESS_SET with initial progress
//   3. Optionally generates a shared SV package if decomposition has
//      sharedTypes and none has been generated yet (non-fatal on failure)
//   4. Full-auto mode: iterates modules in order, checking child readiness
//      and skipping imported-complete modules. For each module, runs every
//      active stage starting from spec (stage 2), updating progress after
//      each. Halts on first stage error.
//   5. After all modules complete in full-auto multi-module mode, invokes
//      the integration pipeline (caller supplies it as a service).
//   6. Semi-auto mode: runs stage 1 (elicit) on the first non-imported
//      module only, then stops.
//   7. On successful full-auto completion, dispatches PROJECT_PHASE_SET "done"
//      and calls services.deleteCheckpoint (best-effort).
//
// What it does NOT do (caller's responsibility):
//   - Create or manage AbortController (services.signal is passed through)
//   - Manage React navigation state (setActiveStage, setViewingStage, etc)
//   - Mutate uiState.userDesc (the old code did this for UI display — we
//     pass overrideDesc to runStage instead, cleanly)
//
// Return shape:
//   { ok: true, modulesCompleted, modulesTotal }
//   { ok: false, error: string, modulesCompleted, modulesTotal }
// ═══════════════════════════════════════════════════════════════════════════

import { blankModule } from "./moduleRegistry.js";
import { getModuleOrder } from "./dependencyGraph.js";
import { buildChildInterfaces } from "./childInterfaces.js";
import {
  PIPELINE_PROGRESS_SET,
  SET_ACTIVE_MOD,
  SHARED_PACKAGE_SET,
  LEDGER_APPEND,
  PROJECT_PHASE_SET,
} from "./actions.js";
import { runStage as defaultRunStage } from "./runStage.js";

/**
 * Orchestrate stage pipeline execution across all modules.
 *
 * @param {object} args
 * @param {"full-auto"|"semi-auto"} args.execMode
 * @param {object} args.reducerState  - Current snapshot at call time
 * @param {object} args.uiState       - { userDesc, config, lintWarningsAsErrors,
 *                                        verifyWarningsAsErrors, activeStages }
 * @param {object} args.services
 * @param {function} args.services.getState            - () => latest reducerState (post-dispatch)
 * @param {object}   args.services.pipeline            - From buildPipeline()
 * @param {Array}    args.services.allStages           - ALL_STAGES
 * @param {function} [args.services.runStage]          - Injectable for tests
 * @param {function} [args.services.runIntegrationPipeline] - Called at end in multi-module
 * @param {function} [args.services.callLLM]           - For shared package gen
 * @param {function} [args.services.extractJSON]       - For shared package gen
 * @param {function} [args.services.promptSharedPackage] - Prompt builder
 * @param {function} args.services.computeContentHash
 * @param {function} args.services.computeIfaceHash
 * @param {function} [args.services.estimateCost]
 * @param {function} [args.services.saveCheckpoint]
 * @param {function} [args.services.deleteCheckpoint]  - Called on successful completion
 * @param {AbortSignal} [args.services.signal]
 * @param {object}   [args.services.logger]
 * @param {function} args.dispatch
 * @returns {Promise<{ok, modulesCompleted, modulesTotal, error?}>}
 */
export async function runAllPipelines(args) {
  const execMode     = args.execMode || "semi-auto";
  const uiState      = args.uiState || {};
  const services     = args.services || {};
  const dispatch     = args.dispatch;
  const getState     = services.getState;
  const runStage     = services.runStage || defaultRunStage;
  const runIntegration = services.runIntegrationPipeline || null;
  const activeStages = uiState.activeStages || [];

  if (typeof dispatch !== "function") {
    throw new Error("runAllPipelines: dispatch must be a function");
  }
  if (typeof getState !== "function") {
    throw new Error("runAllPipelines: services.getState must be a function");
  }

  function snap() { return getState(); }
  function log(level, msg, detail) {
    if (services.logger && typeof services.logger[level] === "function") {
      services.logger[level](msg, detail);
    }
  }

  // ── 1. Compute topological order from the initial snapshot ──
  const initialState = args.reducerState || snap();
  const modules0     = initialState.modules || {};
  const instances0   = initialState.instances || {};
  const decomposition = initialState.decomposition || null;
  const topId = decomposition ? decomposition.topModule : null;

  let order;
  try {
    order = getModuleOrder(modules0, instances0, topId);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log("error", "[runAllPipelines] Dependency order failed:", msg);
    dispatch({
      type: PIPELINE_PROGRESS_SET,
      progress: {
        currentModId: null,
        currentStageId: 0,
        modulesCompleted: 0,
        modulesTotal: 0,
        error: msg,
      },
    });
    return { ok: false, error: msg, modulesCompleted: 0, modulesTotal: 0 };
  }

  const total = order.length;
  if (total === 0) {
    dispatch({
      type: PIPELINE_PROGRESS_SET,
      progress: { currentModId: null, currentStageId: 0, modulesCompleted: 0, modulesTotal: 0, error: "no modules to run" },
    });
    return { ok: false, error: "no modules to run", modulesCompleted: 0, modulesTotal: 0 };
  }

  dispatch({
    type: PIPELINE_PROGRESS_SET,
    progress: { currentModId: order[0], currentStageId: 1, modulesCompleted: 0, modulesTotal: total, error: null },
  });

  // ── 2. Optional: generate shared SV package ──
  // Only if: decomposition has sharedTypes AND none has been generated yet
  //          AND the caller injected callLLM + extractJSON + promptSharedPackage
  if (
    decomposition &&
    Array.isArray(decomposition.sharedTypes) &&
    decomposition.sharedTypes.length > 0 &&
    !initialState.sharedPackage &&
    typeof services.callLLM === "function" &&
    typeof services.extractJSON === "function" &&
    typeof services.promptSharedPackage === "function"
  ) {
    try {
      const pkgP = services.promptSharedPackage(decomposition);
      pkgP.config = Object.assign({}, uiState.config || {});
      const pkgR = await services.callLLM(pkgP);
      const pkgData = services.extractJSON(pkgR.text);
      dispatch({ type: SHARED_PACKAGE_SET, sharedPackage: pkgData });
      if (pkgR && (pkgR.tokensIn || pkgR.tokensOut || pkgR.latencyMs)) {
        const cost = services.estimateCost
          ? services.estimateCost(pkgR.tokensIn, pkgR.tokensOut, pkgR.provider || (uiState.config && uiState.config.provider))
          : 0;
        dispatch({
          type: LEDGER_APPEND,
          entry: {
            stage: "shared_pkg",
            model: pkgR.model,
            provider: pkgR.provider || (uiState.config && uiState.config.provider),
            tIn: pkgR.tokensIn,
            tOut: pkgR.tokensOut,
            cost,
            ms: pkgR.latencyMs,
          },
        });
      }
      log("info", "[runAllPipelines] Shared package generated: " + (pkgData.packageName || "?"));
    } catch (e) {
      log("warn", "[runAllPipelines] Shared package generation failed (non-fatal):", (e && e.message) || String(e));
    }
  }

  // ═══════════════════ SEMI-AUTO ═══════════════════
  if (execMode !== "full-auto") {
    // Find the first non-imported module
    let firstMod = null;
    const st = snap();
    for (let fi = 0; fi < order.length; fi++) {
      const fMod = st.modules[order[fi]];
      if (
        !fMod ||
        !fMod.imported ||
        !fMod.completed ||
        fMod.completed.size < activeStages.length
      ) {
        firstMod = order[fi];
        break;
      }
    }
    if (!firstMod) firstMod = order[0];

    const firstDesc = (st.modules[firstMod] && st.modules[firstMod].description) || uiState.userDesc || "";
    dispatch({ type: SET_ACTIVE_MOD, modId: firstMod });

    const stageMeta = (activeStages[0] || {});
    const firstStageId = stageMeta.id || 1;
    const firstStageKey = stageMeta.key || "elicit";

    const freshState = snap();
    const childInterfaces = buildChildInterfaces(firstMod, freshState.modules, freshState.instances);

    await runStage({
      stageId: firstStageId,
      stageKey: firstStageKey,
      trigger: "auto",
      overrideDesc: firstDesc,
      targetModId: firstMod,
      reducerState: snap(),
      uiState: Object.assign({}, uiState, {
        sharedPackage: snap().sharedPackage,
        instances:     snap().instances,
      }),
      services: Object.assign({}, services, { childInterfaces }),
      dispatch,
    });

    dispatch({ type: PIPELINE_PROGRESS_SET, progress: null });
    return { ok: true, modulesCompleted: 0, modulesTotal: total };
  }

  // ═══════════════════ FULL-AUTO ═══════════════════
  // Run spec (2) → end for each module in dependency order.
  // Skip imported-and-complete modules.
  // Halt on first stage error; halt on unmet child dependency.

  // Filter by stage key (not `id >= 2`), which is invariant to id renumbering:
  // keying off the id would assume "elicit" is always id=1 and break if a stage
  // with id<1 were ever added.
  const fullAutoStageIds = activeStages
    .filter(function(s) { return s.key !== "elicit"; })
    .map(function(s) { return s.id; });

  let modulesCompleted = 0;
  for (let mi = 0; mi < order.length; mi++) {
    const mId = order[mi];

    // Snapshot the current state for this module's iteration
    const curState = snap();
    const curMod = curState.modules[mId] || blankModule();

    // Skip imported modules with all stages complete
    if (curMod.imported && curMod.completed && curMod.completed.size >= activeStages.length) {
      log("info", "[runAllPipelines] Skipping imported module: " + mId);
      modulesCompleted++;
      continue;
    }

    // Check that required children have completed spec (stage 2)
    const childInsts = Object.values(curState.instances).filter(function(inst) {
      return inst.parentModuleId === mId;
    });
    let blockedBy = null;
    for (let ci = 0; ci < childInsts.length; ci++) {
      const childId = childInsts[ci].moduleId;
      const childMod = curState.modules[childId];
      if (!childMod || !childMod.completed || !childMod.completed.has(2)) {
        blockedBy = childId;
        break;
      }
    }
    if (blockedBy) {
      const msg = "Cannot run " + mId + ": child module " + blockedBy + " has not completed specification.";
      dispatch({
        type: PIPELINE_PROGRESS_SET,
        progress: {
          currentModId: mId,
          currentStageId: 2,
          modulesCompleted,
          modulesTotal: total,
          error: msg,
        },
      });
      return { ok: false, error: msg, modulesCompleted, modulesTotal: total };
    }

    dispatch({
      type: PIPELINE_PROGRESS_SET,
      progress: { currentModId: mId, currentStageId: 2, modulesCompleted: mi, modulesTotal: total, error: null },
    });
    dispatch({ type: SET_ACTIVE_MOD, modId: mId });

    // Use the module's description if available, otherwise fall back to uiState.userDesc
    const modDesc = curMod.description || uiState.userDesc || "";

    // Precompute child interfaces for this module from fresh state
    const childInterfaces = buildChildInterfaces(mId, snap().modules, snap().instances);

    // Iterate through all active stages from spec (2) to end
    for (let psi = 0; psi < fullAutoStageIds.length; psi++) {
      const sid = fullAutoStageIds[psi];
      const stageMeta = activeStages.find(function(s) { return s.id === sid; }) || {};
      const skey = stageMeta.key;

      dispatch({
        type: PIPELINE_PROGRESS_SET,
        progress: { currentModId: mId, currentStageId: sid, modulesCompleted: mi, modulesTotal: total, error: null },
      });

      const result = await runStage({
        stageId: sid,
        stageKey: skey,
        trigger: "auto",
        overrideDesc: modDesc,
        targetModId: mId,
        reducerState: snap(),
        uiState: Object.assign({}, uiState, {
          sharedPackage: snap().sharedPackage,
          instances:     snap().instances,
        }),
        services: Object.assign({}, services, { childInterfaces }),
        dispatch,
      });

      // Halt on error
      if (result && result.ok === false) {
        // runStage already dispatched the error state
        const latest = snap();
        const latestMod = latest.modules[mId] || blankModule();
        const errMsg = (latestMod.stageErrors && latestMod.stageErrors[sid]) || "Stage " + sid + " failed for " + mId + ".";
        dispatch({
          type: PIPELINE_PROGRESS_SET,
          progress: {
            currentModId: mId,
            currentStageId: sid,
            modulesCompleted: mi,
            modulesTotal: total,
            error: "Stage " + sid + " failed for " + mId + ". Pipeline halted.",
          },
        });
        return { ok: false, error: errMsg, modulesCompleted: mi, modulesTotal: total };
      }
    }

    modulesCompleted++;
  }

  dispatch({
    type: PIPELINE_PROGRESS_SET,
    progress: { currentModId: null, currentStageId: 0, modulesCompleted: total, modulesTotal: total, error: null },
  });

  // Run integration pipeline for multi-module systems (if injected)
  const isMulti = Object.keys(snap().modules).length > 1;
  if (isMulti && typeof runIntegration === "function") {
    try {
      await runIntegration();
    } catch (e) {
      log("warn", "[runAllPipelines] Integration pipeline threw (non-fatal):", (e && e.message) || String(e));
    }
  }

  dispatch({ type: PROJECT_PHASE_SET, phase: "done" });

  // Auto-delete checkpoint on successful completion (non-fatal)
  if (typeof services.deleteCheckpoint === "function") {
    try { await services.deleteCheckpoint(); }
    catch (_ckErr) { /* non-fatal */ }
  }

  return { ok: true, modulesCompleted: total, modulesTotal: total };
}
