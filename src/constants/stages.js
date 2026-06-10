// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Stages — pipeline stage registry, optional stage defs, ordering helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ALL_STAGES includes optional review and lint stages.
 * `order` determines pipeline sequence.
 * `optional` stages can be toggled via config.optionalStages.
 * `afterStage` links back to the stage whose output is reviewed (for fix loops).
 *
 * Stage rename note: the original "Lint" stage is now labelled "Lint RTL".
 * A new optional "Lint Test" stage runs the same lint+fix loop on the
 * generated testbench, between Test Gen / Test Review and Verify. The
 * underlying config keys stay as `lint` / `lint_test` to avoid breaking
 * existing checkpoints.
 */
export const ALL_STAGES = [
  { id: 1,  key: "elicit",        order: 10, label: "Elicit",       desc: "Requirements Gathering" },
  { id: 2,  key: "spec",          order: 20, label: "Spec",         desc: "Formal Specification" },
  { id: 3,  key: "architect",     order: 30, label: "Architect",    desc: "Micro-Architecture" },
  { id: 4,  key: "rtl_generate",  order: 40, label: "RTL Gen",      desc: "SystemVerilog Generation" },
  { id: 10, key: "rtl_review",    order: 45, label: "RTL Review",   desc: "LLM Code Review + Fix Loop", optional: true, optionKey: "rtl_review",  afterStage: 4 },
  { id: 6,  key: "lint",          order: 60, label: "Lint RTL",     desc: "Static Analysis + Fix Loop on RTL", optional: true, optionKey: "lint" },
  // formal_props runs AFTER lint (order 65) so SVA property generation targets
  // the canonical, post-lint RTL. Running it before lint would risk asserting
  // on un-linted RTL with width/signal mismatches the linter would later flag.
  { id: 5,  key: "formal_props",  order: 65, label: "SVA Props",    desc: "Formal Property Generation",  optional: true, optionKey: "formal_props" },
  { id: 7,  key: "test_generate", order: 70, label: "Test Gen",     desc: "Testbench Generation" },
  { id: 11, key: "test_review",   order: 75, label: "Test Review",  desc: "LLM Test Review + Fix Loop", optional: true, optionKey: "test_review", afterStage: 7 },
  { id: 12, key: "lint_test",     order: 78, label: "Lint Test",    desc: "Static Analysis + Fix Loop on Testbench", optional: true, optionKey: "lint_test", afterStage: 7 },
  { id: 8,  key: "verify",        order: 80, label: "Verify",       desc: "Simulation & Coverage" },
  { id: 9,  key: "judge",         order: 90, label: "Judge",        desc: "Final Verdict & Export" },
];

export const OPTIONAL_STAGE_DEFS = {
  formal_props: { label: "SVA Formal Props",  desc: "Generate SVA assertions and cover statements (can skip for faster iteration)" },
  lint:         { label: "Lint RTL + Fix",     desc: "Static analysis with auto-fix loop on the generated RTL (recommended; uses Verilator CLI when configured)" },
  lint_test:    { label: "Lint Test + Fix",    desc: "Static analysis with auto-fix loop on the generated testbench, between Test Gen/Review and Verify" },
  rtl_review:   { label: "RTL Review",         desc: "LLM-powered RTL code review after generation" },
  test_review:  { label: "Test Review",        desc: "LLM-powered testbench review after generation" },
};

export const STAGE_KEY = ALL_STAGES.reduce((acc, s) => {
  acc[s.id] = s.key;
  return acc;
}, {});

/** Compute the active ordered stages given a config. */
export function getActiveStages(cfg) {
  const enabled = (cfg && cfg.optionalStages) || {};
  return ALL_STAGES
    .filter((s) => !s.optional || enabled[s.optionKey])
    .slice()
    .sort((a, b) => a.order - b.order);
}

/** Get next stage ID in the active sequence after a given ID. */
export function nextStageId(activeStages, currentId) {
  for (let i = 0; i < activeStages.length; i++) {
    if (activeStages[i].id === currentId && i + 1 < activeStages.length) {
      return activeStages[i + 1].id;
    }
  }
  return null;
}

/** Get previous stage ID in the active sequence. */
export function prevStageId(activeStages, currentId) {
  for (let i = 0; i < activeStages.length; i++) {
    if (activeStages[i].id === currentId && i > 0) {
      return activeStages[i - 1].id;
    }
  }
  return null;
}

/** Get ordered list of active stage IDs from `fromId` to end. */
export function stageIdsFrom(activeStages, fromId) {
  const ids = [];
  let found = false;
  for (let i = 0; i < activeStages.length; i++) {
    if (activeStages[i].id === fromId) found = true;
    if (found) ids.push(activeStages[i].id);
  }
  return ids;
}

/** True if the given stage id appears in the current active stage list. */
export function isStageActive(activeStages, id) {
  return activeStages.some(function(s) { return s.id === id; });
}

export const Q_CATS = [
  { id: "interface",       label: "Interface",      tag: "INTF"  },
  { id: "parameterization", label: "Params",         tag: "PARAM" },
  { id: "functionality",   label: "Functionality",  tag: "FUNC"  },
  { id: "error_handling",  label: "Error Handling", tag: "ERR"   },
  { id: "timing",          label: "Timing",         tag: "TIME"  },
  { id: "verification",    label: "Verification",   tag: "VERIF" },
  { id: "integration",     label: "Integration",    tag: "INTG"  },
];

/** Integration pipeline stages (Step 10 — multi-module systems only). */
export const INT_STAGES = [
  { id: "int_lint",  label: "Integration Lint",  desc: "Cross-module wiring check" },
  { id: "int_test",  label: "System TB",         desc: "Top-level testbench" },
  { id: "int_judge", label: "Integration Judge", desc: "System-level verdict" },
];

export const MAX_LINT_ITERS = 3;
export const MAX_VERIFY_ITERS = 3;
export const MAX_JUDGE_ITERS = 3;

/**
 * The full list of pipeline stages that have configurable per-stage settings
 * in the Settings panel. Includes the optional review stages and the
 * "fix" sub-stages spawned by the loop helpers (rtl_fix, rtl_review_fix,
 * test_review_fix). Items marked `optional: <key>` are only surfaced when
 * the corresponding `config.optionalStages[key]` is enabled.
 */
export const STAGE_SETTING_KEYS_BASE = [
  { key: "elicit",          label: "1. Elicit" },
  { key: "spec",            label: "2. Spec" },
  { key: "architect",       label: "3. Architect" },
  { key: "rtl_generate",    label: "4. RTL Gen" },
  { key: "rtl_review",      label: "4b. RTL Review",      optional: "rtl_review" },
  { key: "rtl_review_fix",  label: "4c. RTL Review Fix",  optional: "rtl_review" },
  // SVA props follow lint (see ALL_STAGES ordering), so the numbering below
  // reads as a post-lint property-generation step.
  { key: "lint",            label: "5. Lint RTL (AI)",    optional: "lint" },
  { key: "rtl_fix",         label: "5b. RTL Fix",         optional: "lint" },
  { key: "formal_props",    label: "6. SVA Props" },
  { key: "test_generate",   label: "7. Test Gen" },
  { key: "test_review",     label: "7b. Test Review",     optional: "test_review" },
  { key: "test_review_fix", label: "7c. Test Review Fix", optional: "test_review" },
  { key: "lint_test",       label: "7d. Lint Test (AI)",  optional: "lint_test" },
  { key: "tb_fix",          label: "7e. TB Fix",          optional: "lint_test" },
  { key: "verify",          label: "8. Verify (AI)" },
  { key: "judge",           label: "9. Judge" },
];

/**
 * Filter the full stage-settings list to only those active for a given
 * config. Optional stages are surfaced when the matching
 * `config.optionalStages[key]` flag is true.
 *
 * @param {object} cfg - Project config object (typically the React `config` state)
 * @returns {Array} filtered list of { key, label, optional? } items
 */
export function getStageSettingKeys(cfg) {
  const enabled = (cfg && cfg.optionalStages) || {};
  return STAGE_SETTING_KEYS_BASE.filter(function(item) {
    return !item.optional || enabled[item.optional];
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE_REFLOW_SCOPE
//
// For each loopback-capable stage, defines where its K-to-X tail
// STARTS. The tail itself runs from this start key through the stage's
// own key inclusive (e.g. lint's scope is rtl_generate→...→lint).
//
// "Self-only-ish" review stages (rtl_review, test_review) include the
// generation step ahead of them as the start so a review-triggered fix
// can regenerate the artifact before the review re-runs.
//
// Stages not in this map don't perform their own reflow chain when
// they loop back internally; they either don't loop back, or their
// loopback is point-fix only (covered by inline LLM calls).
//
// JUDGE is special — its scope is dynamic per-iteration based on the
// triage target picked by the eval gate. It is NOT in this map.
// ═══════════════════════════════════════════════════════════════════════════
export const STAGE_REFLOW_SCOPE = {
  // Lint operates on RTL → a lint-triggered fix regenerates RTL,
  // which (when rtl_review is enabled) re-runs the review pass.
  lint:         { startKey: "rtl_generate" },

  // Lint-test operates on TB → a lint-triggered TB fix regenerates the
  // testbench, which (when test_review is enabled) re-runs that review.
  lint_test:    { startKey: "test_generate" },

  // RTL review reads RTL and produces a fix → the fix regenerates RTL,
  // then comes back through rtl_review again.
  rtl_review:   { startKey: "rtl_generate" },

  // TB review same shape as RTL review, on the TB side.
  test_review:  { startKey: "test_generate" },

  // Verify is the broadest non-judge scope: a sim failure can be due to
  // a bug in RTL, in the TB, in either's lint state, or in the spec.
  // Its tail covers rtl_generate→rtl_review→lint→formal_props→
  // test_generate→test_review→lint_test→verify. Spec/architect/elicit
  // are NOT in the tail (verify can't fix a spec bug; that's judge's job).
  verify:       { startKey: "rtl_generate" },
};

/**
 * Return the K-to-X tail for a given owning stage. The tail is the
 * ordered list of active stages from STAGE_REFLOW_SCOPE[ownerKey].startKey
 * through the owner itself, in pipeline-execution order.
 *
 * If `ownerKey` isn't in STAGE_REFLOW_SCOPE, returns an empty array.
 * If the start stage isn't in the active list (e.g. user disabled
 * optional stages), this falls through to the first active stage with
 * order ≥ start's order — the closest equivalent.
 */
export function getReflowTail(ownerKey, activeStages) {
  const scope = STAGE_REFLOW_SCOPE[ownerKey];
  if (!scope || !Array.isArray(activeStages) || activeStages.length === 0) return [];

  const ordered = activeStages.slice().sort(function(a, b) {
    return (a.order || 0) - (b.order || 0);
  });

  // Find start index — exact match preferred
  let startIdx = ordered.findIndex(function(s) { return s.key === scope.startKey; });
  if (startIdx < 0) {
    // Fallback: find the start key in ALL_STAGES to get its canonical
    // order, then take the first active stage with order ≥ that.
    const startMeta = ALL_STAGES.find(function(s) { return s.key === scope.startKey; });
    if (!startMeta) return [];
    startIdx = ordered.findIndex(function(s) { return s.order >= startMeta.order; });
    if (startIdx < 0) return [];
  }

  // Find owner index. If the owner itself isn't in the active list,
  // we have nothing to do.
  const ownerIdx = ordered.findIndex(function(s) { return s.key === ownerKey; });
  if (ownerIdx < 0) return [];

  return ordered.slice(startIdx, ownerIdx + 1);
}
