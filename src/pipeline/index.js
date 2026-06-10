// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// pipeline — public barrel: StateGraph engine, classifiers, nodes, the
// buildPipeline()/runStages() executor, and the fix-loop helpers.

export { StateGraph } from "./StateGraph.js";
export {
  matchDiagnostic,
  classifyDiagnostics,
  classifyTestResults,
} from "./classifiers.js";
export * from "./nodes/index.js";
export { buildPipeline } from "./buildPipeline.js";
export { runStages, stageKeysFromActive } from "./runStages.js";
export { createStagnationDetector, createBestKnownTracker, tagFixes } from "./fixLoopHelpers.js";
