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
export { createStagnationDetector, createBestKnownTracker, tagFixes, createCodeChurnTracker } from "./fixLoopHelpers.js";
export { buildSvaChecker, injectVerilatorFlag, svaCompileFailed } from "./svaBind.js";
export { createBudgetGuard } from "./budget.js";
export { generateMutants, runMutationGate, maskNonCode } from "./mutation.js";
export { planReflow, planStageReflow, resolveNestedIterLimit } from "./reflowPlanner.js";
export { runReflowChain, resolveReflowMode } from "./reflowRunner.js";
export {
  failureSignature, aggregateTriageStats, recommendFromStats, formatTriageEvidence,
  createInMemoryTriageMemory, createFileTriageMemory,
} from "./triageMemory.js";
