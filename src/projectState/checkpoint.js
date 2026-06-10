// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// projectState/checkpoint — Pure serialize/deserialize for checkpoints
//
// Two pure functions that convert between in-memory project state and
// JSON-safe payload objects:
//
//   serializeCheckpoint(reducerState, uiState) → payload
//     Converts Sets to arrays, strips functions, and merges the reducer
//     state with the UI-side state (userDesc, mode, designMode, etc) that
//     lives outside the reducer in the React layer.
//
//   deserializeCheckpoint(json) → { reducerState, uiState } | null
//     Round-trips back to a {reducerState, uiState} pair. The reducerState
//     is shaped so it can be loaded with `LOAD_STATE` directly. Returns
//     null on version mismatch or malformed input.
//
// What is NOT in the checkpoint:
//   - apiKey (security — never persist credentials)
//   - showDebug, processing, propagating (transient UI state)
//   - pipelineProgress (live progress tracker, only relevant during a run)
//
// Size guard: payloads larger than 4MB get RTL/TB code truncated to the
// last 500 lines, marked with `_truncatedForCheckpoint: true`.
// ═══════════════════════════════════════════════════════════════════════════

import { djb2 } from "../utils/hash.js";

/** Version 3: apiKey/showDebug are intentionally omitted from the persisted
 *  shape, and ledger/phase live in reducer state. */
export const CHECKPOINT_VERSION = 3;

/** Hard cap on stored payload size; oversized checkpoints get RTL/TB
 *  trimmed to the last 500 lines per stage. */
export const CHECKPOINT_MAX_BYTES = 4 * 1024 * 1024;

/** Generate a stable-ish project id from a description + mode + timestamp. */
export function generateProjectId(userDesc, designMode) {
  return djb2((userDesc || "") + "|" + (designMode || "") + "|" + Date.now());
}

/**
 * Serialize a project state into a JSON-safe payload.
 *
 * @param {object} reducerState - State from createInitialProjectState() / projectReducer
 * @param {object} uiState      - UI-side state held outside the reducer:
 *                                { userDesc, designMode, mode, activeStage,
 *                                  config, lintWarningsAsErrors,
 *                                  verifyWarningsAsErrors, projectId? }
 * @returns {object} payload — JSON-safe object with no Sets/functions
 */
export function serializeCheckpoint(reducerState, uiState) {
  reducerState = reducerState || {};
  uiState = uiState || {};

  // ── Modules: Set → array, drop showDebug ──
  const modulesOut = {};
  const mods = reducerState.modules || {};
  Object.keys(mods).forEach(function(modId) {
    const mod = mods[modId];
    modulesOut[modId] = {
      stageData:     mod.stageData     || {},
      completed:     Array.from(mod.completed || []),
      stageErrors:   mod.stageErrors   || {},
      stageRuns:     mod.stageRuns     || {},
      executionPath: mod.executionPath || [],
      activeRunTab:  mod.activeRunTab  || {},
      // Drop showDebug — purely transient UI state
      // Preserve module metadata
      name:        mod.name,
      description: mod.description,
      level:       mod.level,
      params:      mod.params,
      imported:    mod.imported,
      _manualImport: mod._manualImport,
      contentHash: mod.contentHash || null,
      childHashes: mod.childHashes || {},
    };
  });

  // ── Integration state: Set → array ──
  const intState = reducerState.integrationState || { stageData: {}, completed: new Set(), errors: {} };

  // ── Config sanitization: NEVER serialize apiKey ──
  const cfg = uiState.config || {};
  const configOut = {
    provider:        cfg.provider,
    model:           cfg.model,
    temperature:     cfg.temperature,
    backendUrl:      cfg.backendUrl,
    simPath:         cfg.simPath,
    lintCmd:         cfg.lintCmd,
    simCmds:         cfg.simCmds,
    stageSettings:   cfg.stageSettings || {},
    useGlobalLLM:    cfg.useGlobalLLM !== false,
    maxLintIters:    cfg.maxLintIters    || 3,
    maxVerifyIters:  cfg.maxVerifyIters  || 3,
    maxJudgeIters:   cfg.maxJudgeIters   || 3,
    maxRtlReviewIters:  cfg.maxRtlReviewIters  || 2,
    maxTestReviewIters: cfg.maxTestReviewIters || 2,
    simTimeoutCycles: cfg.simTimeoutCycles || 100000,
    optionalStages:   cfg.optionalStages || {},
    // Persist CLI robustness + Paths-tab settings (previously lost on restore)
    strictCli:         cfg.strictCli === true,
    // Judge-specific strict mode (default OFF)
    strictJudgeCli:    !!cfg.strictJudgeCli,
    cliRetryCount:     cfg.cliRetryCount == null ? 1 : cfg.cliRetryCount,
    backendTimeoutSec: cfg.backendTimeoutSec || 600,
    enableCoverage:    !!cfg.enableCoverage,
    libraryPath:       cfg.libraryPath || "",
    settingsDir:       cfg.settingsDir || "",
    // Judge K-to-X reflow settings
    judgeReflowMode:   (cfg.judgeReflowMode === "strict") ? "strict" : "smart",
    nestedLintIters:   (typeof cfg.nestedLintIters   === "number") ? cfg.nestedLintIters   : null,
    nestedVerifyIters: (typeof cfg.nestedVerifyIters === "number") ? cfg.nestedVerifyIters : null,
    // Per-stage reflow mode settings
    lintReflowMode:        (cfg.lintReflowMode        === "strict") ? "strict" : "smart",
    lintTestReflowMode:    (cfg.lintTestReflowMode    === "strict") ? "strict" : "smart",
    rtlReviewReflowMode:   (cfg.rtlReviewReflowMode   === "strict") ? "strict" : "smart",
    testReviewReflowMode:  (cfg.testReviewReflowMode  === "strict") ? "strict" : "smart",
    verifyReflowMode:      (cfg.verifyReflowMode      === "strict") ? "strict" : "smart",
    // CRITICAL: apiKey deliberately omitted
  };

  const payload = {
    version:   CHECKPOINT_VERSION,
    timestamp: new Date().toISOString(),
    projectId: uiState.projectId || generateProjectId(uiState.userDesc, uiState.designMode),

    // ── UI-side state ──
    userDesc:    uiState.userDesc    || "",
    designMode:  uiState.designMode  || "module",
    mode:        uiState.mode        || "semi-auto",
    activeStage: uiState.activeStage || 0,
    config:      configOut,
    lintWarningsAsErrors:   !!uiState.lintWarningsAsErrors,
    verifyWarningsAsErrors: !!uiState.verifyWarningsAsErrors,

    // ── Reducer state ──
    modules:        modulesOut,
    activeModId:    reducerState.activeModId    || null,
    instances:      reducerState.instances      || {},
    decomposition:  reducerState.decomposition  || null,
    decompError:    reducerState.decompError    || null,
    sharedPackage:  reducerState.sharedPackage  || null,
    ledger:         reducerState.ledger         || [],
    projectPhase:   reducerState.projectPhase   || "idle",
    integrationState: {
      stageData: intState.stageData || {},
      completed: Array.from(intState.completed || []),
      errors:    intState.errors    || {},
    },
  };

  // Size guard: warn and trim oversized payloads
  let json = JSON.stringify(payload);
  payload._sizeKB = Math.round(json.length / 1024);
  if (json.length > CHECKPOINT_MAX_BYTES) {
    payload._oversized = true;
    Object.keys(payload.modules).forEach(function(modId) {
      const sd = payload.modules[modId].stageData || {};
      [4, 7].forEach(function(stageId) {
        if (sd[stageId] && sd[stageId].code && sd[stageId].code.split("\n").length > 500) {
          sd[stageId] = Object.assign({}, sd[stageId], {
            code: sd[stageId].code.split("\n").slice(-500).join("\n"),
            _truncatedForCheckpoint: true,
          });
        }
      });
    });
    // Recompute size after trim
    json = JSON.stringify(payload);
    payload._sizeKB = Math.round(json.length / 1024);
  }

  return payload;
}

/**
 * Deserialize a checkpoint payload back into reducer state + UI state.
 *
 * @param {object} json - The parsed checkpoint payload (from JSON.parse)
 * @returns {object|null} { reducerState, uiState } or null on version mismatch
 */
export function deserializeCheckpoint(json) {
  if (!json || typeof json !== "object") return null;
  if (json.version !== CHECKPOINT_VERSION) return null;

  // ── Modules: array → Set ──
  const modulesOut = {};
  const mods = json.modules || {};
  Object.keys(mods).forEach(function(modId) {
    const mod = mods[modId];
    modulesOut[modId] = {
      stageData:     mod.stageData     || {},
      completed:     new Set(mod.completed || []),
      stageErrors:   mod.stageErrors   || {},
      stageRuns:     mod.stageRuns     || {},
      executionPath: mod.executionPath || [],
      activeRunTab:  mod.activeRunTab  || {},
      showDebug:     {}, // always start with debug panels closed
      name:        mod.name,
      description: mod.description,
      level:       mod.level,
      params:      mod.params,
      imported:    mod.imported,
      _manualImport: mod._manualImport,
      contentHash: mod.contentHash || null,
      childHashes: mod.childHashes || {},
    };
  });

  // ── Integration state: array → Set ──
  const intCompletedArr = (json.integrationState && json.integrationState.completed) || [];

  const reducerState = {
    modules:        modulesOut,
    activeModId:    json.activeModId    || null,
    instances:      json.instances      || {},
    decomposition:  json.decomposition  || null,
    decompError:    json.decompError    || null,
    ledger:         json.ledger         || [],
    projectPhase:   json.projectPhase   || "running",
    pipelineProgress: null, // never restored — live state only
    sharedPackage:  json.sharedPackage  || null,
    integrationState: {
      stageData: (json.integrationState || {}).stageData || {},
      completed: new Set(intCompletedArr),
      errors:    (json.integrationState || {}).errors    || {},
    },
  };

  const uiState = {
    projectId:    json.projectId,
    userDesc:     json.userDesc    || "",
    designMode:   json.designMode  || "module",
    mode:         json.mode        || "semi-auto",
    activeStage:  json.activeStage || 0,
    config:       json.config      || {},
    lintWarningsAsErrors:   !!json.lintWarningsAsErrors,
    verifyWarningsAsErrors: !!json.verifyWarningsAsErrors,
    timestamp:    json.timestamp,
  };

  return { reducerState, uiState };
}
