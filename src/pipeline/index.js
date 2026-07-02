// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// pipeline — public barrel: StateGraph engine, classifiers, nodes, the
// buildPipeline()/runStages() executor, and the fix-loop helpers.

export { StateGraph } from "./StateGraph.js";
export {
  matchDiagnostic,
  classifyDiagnostics,
  classifyTestResults,
  classifyTestResultsByReq,
  reqKeyOf,
} from "./classifiers.js";
export * from "./nodes/index.js";
export { buildPipeline } from "./buildPipeline.js";
export { runStages, stageKeysFromActive } from "./runStages.js";
export { createStagnationDetector, createBestKnownTracker, tagFixes, createCodeChurnTracker, lintConverged } from "./fixLoopHelpers.js";
export { applyEdits } from "./applyEdits.js";
export { buildSvaChecker, injectVerilatorFlag, svaCompileFailed } from "./svaBind.js";
export { createBudgetGuard } from "./budget.js";
export { generateMutants, runMutationGate, maskNonCode } from "./mutation.js";
export {
  runCoverageStrengthening, findCoverageGaps, acceptStrengthening,
  withCoverageCmds, coveredReqIds,
} from "./coverageStrengthen.js";
export {
  normalizeMessage, errorSignature, aggregateErrors, formatErrorsToAvoid,
  mergeErrorCatalogs, createInMemoryErrorMemory, createFileErrorMemory,
  distillRule, rulesNeedingReview, isProseLeak, resolveAvoidSection, migrateCatalog,
} from "./errorsToAvoid.js";
export {
  trainingBoundaryStage, truncateStagesForTraining,
  distinctSignatureCount, isSaturated, budgetState,
  selectCurriculumTarget, ARCHETYPE_TABLE,
  buildSynthSpecPrompt, parseSynthSpec,
  buildRuleRewritePrompt, isValidRewrite, applyRuleRewrite, trainCommand,
} from "./training.js";
export {
  KNOWLEDGE_PACKS, knowledgePacksForModel, shippedRuleRecords,
} from "./knowledgePacks.js";
export { repairSV, maybeRepair, maybeRepairWithLog } from "./syntaxRepair.js";
export { sftPairs, repairPairs } from "./trainingExport.js";
export {
  deriveLedger, buildLedgerForState, formatLedgerProgress, isReqInGate,
  unmetMustRequirements, attributeMutationKills,
} from "./acceptanceLedger.js";
export { planReflow, planStageReflow, resolveNestedIterLimit } from "./reflowPlanner.js";
export { runReflowChain, resolveReflowMode } from "./reflowRunner.js";
export {
  failureSignature, aggregateTriageStats, recommendFromStats, formatTriageEvidence,
  createInMemoryTriageMemory, createFileTriageMemory,
} from "./triageMemory.js";
