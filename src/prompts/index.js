// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// prompts — barrel for all LLM prompt builders.

export { BASE_SYS, sys, j } from "./base.js";
export { promptElicit } from "./elicit.js";
export { promptSpec, promptSpecFromDescription } from "./spec.js";
export { promptArch } from "./architect.js";
export { promptRTL } from "./rtl.js";
export { promptRTLReview, promptRTLReviewFix } from "./rtlReview.js";
export { promptFormalProps } from "./formalProps.js";
export { promptLint, promptRTLFix, promptTBLint, promptTBLintFix } from "./lint.js";
export { promptTB } from "./testGen.js";
export { promptTestReview, promptTestReviewFix } from "./testReview.js";
export {
  promptVerify,
  promptVerifyTriage,
  promptRTLFromVerifyFail,
  promptTBFromVerifyFail,
} from "./verify.js";
export { promptJudge, promptJudgeTriage } from "./judge.js";

// System-mode + propagation prompts
export { promptDecompose } from "./decompose.js";
export { promptSharedPackage } from "./sharedPackage.js";
export {
  promptIntegrationLint,
  promptSystemTB,
  promptIntegrationJudge,
} from "./integration.js";
export { promptPropagateSpec } from "./propagate.js";
