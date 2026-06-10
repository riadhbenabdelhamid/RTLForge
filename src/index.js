// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// rtl-forge — top-level barrel
// Re-exports everything from the modular core:
//   - pure-function modules (constants, utils, llm, cli, pipeline engine)
//   - prompt builders (core + decompose/sharedPackage/integration/propagate)
//   - pipeline nodes + buildPipeline + runStages
//   - fixLoopHelpers
//   - projectState pure helpers + reducer
// ═══════════════════════════════════════════════════════════════════════════

export * from "./constants/index.js";
export * from "./utils/index.js";
export * from "./llm/index.js";
export * from "./cli/index.js";
export * from "./pipeline/index.js";
export * from "./prompts/index.js";
export * from "./projectState/index.js";
