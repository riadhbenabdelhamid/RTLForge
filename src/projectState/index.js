// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// projectState — Pure state helpers for the RTL Forge module registry
//
// React-free functions that operate on the (modules, instances) registry pair,
// the reducer + action types, checkpoint serialization/storage, and the
// multi-module orchestration drivers. No React, no hooks, no DOM.
//
// Note: pure stage-list navigation helpers (nextStageId, prevStageId,
// stageIdsFrom, isStageActive) live in constants/stages.js alongside the
// stage definitions, because they depend only on the stage-list shape. The
// helpers here DO touch the module/instance registry and the per-module
// `completed` Set.
// ═══════════════════════════════════════════════════════════════════════════

// Module registry scaffolding + hashing
export {
  blankModule,
  computeContentHash,
  computeIfaceHash,
} from "./moduleRegistry.js";

// Dependency graph traversal
export {
  getModuleOrder,
  computeEffectiveLevels,
} from "./dependencyGraph.js";

// Child interface collection for prompts
export { buildChildInterfaces } from "./childInterfaces.js";

// Stage frontier (module-state aware — uses a completed Set)
export { computeStageFrontier } from "./stageFrontier.js";

// Pure reducer + action type constants
export * from "./actions.js";
export {
  createInitialProjectState,
  projectReducer,
} from "./reducer.js";

// Checkpoint serialization + storage adapters + manager factory
export {
  CHECKPOINT_VERSION,
  CHECKPOINT_MAX_BYTES,
  generateProjectId,
  serializeCheckpoint,
  deserializeCheckpoint,
} from "./checkpoint.js";
export {
  createMemoryStorage,
  createCloudStorage,
  createLocalStorageAdapter,
  createBrowserStorage,
} from "./storage.js";
export { createCheckpointManager } from "./checkpointManager.js";

// Pure async single-stage runner
export { runStage } from "./runStage.js";

// Multi-module orchestrator + integration pipeline driver
export { runAllPipelines } from "./runAllPipelines.js";
export { runIntegrationPipeline } from "./runIntegrationPipeline.js";
