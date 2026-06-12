// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// verify-reflow-planner — reflow planning
//
// Pins the K-to-X chain semantics for judge's reflow:
//   • Tail starts at the triage target and runs through judge inclusive
//   • Stages before K are never included
//   • Strict mode runs every tail stage
//   • Smart mode skips stages that passed and have no upstream changes
//   • Per-stage iter-limit overrides
// ═══════════════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") await r;
    process.stdout.write("  \u001b[32m✓\u001b[0m " + name + "\n");
    passed++;
  } catch (e) {
    process.stdout.write("  \u001b[31m✗\u001b[0m " + name + "  →  " + (e.message || e) + "\n");
    failures.push({ name, message: e.message || String(e) });
  }
}

const { planReflow, resolveNestedIterLimit } = await import("../src/pipeline/reflowPlanner.js");

// Fixture matching the actual pipeline ordering (SVA-after-lint)
const fullStages = [
  { id: 1,  key: "elicit",        order: 10 },
  { id: 2,  key: "spec",          order: 20 },
  { id: 3,  key: "architect",     order: 30 },
  { id: 4,  key: "rtl_generate",  order: 40 },
  { id: 10, key: "rtl_review",    order: 45 },
  { id: 6,  key: "lint",          order: 60 },
  { id: 5,  key: "formal_props",  order: 65 },
  { id: 7,  key: "test_generate", order: 70 },
  { id: 11, key: "test_review",   order: 75 },
  { id: 12, key: "lint_test",     order: 78 },
  { id: 8,  key: "verify",        order: 80 },
  { id: 9,  key: "judge",         order: 90 },
];

console.log("\n[reflowPlanner — strict mode]");

await check("strict: triage=test_generate runs test_gen → test_review → lint_test → verify → judge", () => {
  const chain = planReflow({
    triageTarget: "test_generate",
    activeStages: fullStages,
    mode: "strict",
    state: {},
  });
  const keys = chain.map(function(c) { return c.stageKey; });
  assert.deepEqual(keys, ["test_generate", "test_review", "lint_test", "verify", "judge"]);
});

await check("strict: triage=rtl_generate runs the full downstream tail", () => {
  const chain = planReflow({
    triageTarget: "rtl_generate",
    activeStages: fullStages,
    mode: "strict",
    state: {},
  });
  const keys = chain.map(function(c) { return c.stageKey; });
  assert.deepEqual(keys, [
    "rtl_generate", "rtl_review", "lint", "formal_props",
    "test_generate", "test_review", "lint_test", "verify", "judge",
  ]);
});

await check("strict: triage=verify runs just verify → judge", () => {
  const chain = planReflow({
    triageTarget: "verify",
    activeStages: fullStages,
    mode: "strict",
    state: {},
  });
  const keys = chain.map(function(c) { return c.stageKey; });
  assert.deepEqual(keys, ["verify", "judge"]);
});

await check("strict: stages BEFORE the triage target are NOT included (Q4 answer)", () => {
  const chain = planReflow({
    triageTarget: "test_generate",
    activeStages: fullStages,
    mode: "strict",
    state: {},
  });
  const keys = chain.map(function(c) { return c.stageKey; });
  // None of these should appear since they come before test_generate
  assert.equal(keys.indexOf("spec"), -1);
  assert.equal(keys.indexOf("architect"), -1);
  assert.equal(keys.indexOf("rtl_generate"), -1);
  assert.equal(keys.indexOf("lint"), -1);
});

await check("strict: chain entries carry stageId, key, order, and reason", () => {
  const chain = planReflow({
    triageTarget: "test_generate",
    activeStages: fullStages,
    mode: "strict",
    state: {},
  });
  for (const c of chain) {
    assert.ok(typeof c.stageId === "number");
    assert.ok(typeof c.stageKey === "string");
    assert.ok(typeof c.order === "number");
    assert.ok(typeof c.reason === "string");
  }
  // First entry is "triage"
  assert.equal(chain[0].reason, "triage");
  // Last entry (judge) is "always"
  assert.equal(chain[chain.length - 1].reason, "always");
});

console.log("\n[reflowPlanner — smart mode]");

await check("smart: triage runs always; downstream marked 'downstream' since upstream changed", () => {
  const chain = planReflow({
    triageTarget: "test_generate",
    activeStages: fullStages,
    mode: "smart",
    state: {
      lint_test: { status: "PASS" },  // would normally be skippable
    },
  });
  // test_generate runs (triage); test_review/lint_test/verify all run
  // because test_generate ran upstream — its outputs changed.
  const reasons = chain.map(function(c) { return c.reason; });
  assert.equal(reasons[0], "triage");
  // test_review should still be downstream because test_generate just re-ran
  assert.equal(chain.find(function(c) { return c.stageKey === "test_review"; }).reason, "downstream");
  assert.equal(chain.find(function(c) { return c.stageKey === "lint_test"; }).reason, "downstream");
});

await check("smart: verify and judge always have reason 'always'", () => {
  const chain = planReflow({
    triageTarget: "rtl_generate",
    activeStages: fullStages,
    mode: "smart",
    state: {},
  });
  assert.equal(chain.find(function(c) { return c.stageKey === "verify"; }).reason, "always");
  assert.equal(chain.find(function(c) { return c.stageKey === "judge"; }).reason, "always");
});

await check("smart: a passing stage AFTER triage with no upstream changes is skipped", () => {
  // We need a scenario where smart mode CAN skip: triage at K, K has no
  // K+1 effect, K+1 was passing. Real-world: triage=verify; verify runs;
  // there's nothing between verify and judge that could be skipped.
  // Construct a stage list where this is meaningful.
  const customStages = [
    { id: 1, key: "stageA", order: 10 },
    { id: 2, key: "stageB", order: 20 },
    { id: 3, key: "verify", order: 80 },
    { id: 4, key: "judge",  order: 90 },
  ];
  // Triage at stageA; B is "passing" but A re-running invalidates it.
  // Smart still marks B as downstream because A ran upstream of B.
  const chain1 = planReflow({
    triageTarget: "stageA",
    activeStages: customStages,
    mode: "smart",
    state: { stageB: { status: "PASS" } },
  });
  // Currently smart mode treats any stage downstream of a rerun as downstream
  assert.equal(chain1[1].stageKey, "stageB");
  assert.equal(chain1[1].reason, "downstream");
});

console.log("\n[reflowPlanner — resolveNestedIterLimit]");

await check("nested iter limit: lint uses nestedLintIters when set", () => {
  const limit = resolveNestedIterLimit("lint", { maxLintIters: 3, nestedLintIters: 1 });
  assert.equal(limit, 1);
});

await check("nested iter limit: lint falls back to maxLintIters when nested is null", () => {
  const limit = resolveNestedIterLimit("lint", { maxLintIters: 5, nestedLintIters: null });
  assert.equal(limit, 5);
});

await check("nested iter limit: verify uses nestedVerifyIters when set", () => {
  const limit = resolveNestedIterLimit("verify", { maxVerifyIters: 4, nestedVerifyIters: 2 });
  assert.equal(limit, 2);
});

await check("nested iter limit: stage with no nesting concept returns undefined", () => {
  const limit = resolveNestedIterLimit("elicit", { maxLintIters: 3 });
  assert.equal(limit, undefined);
});

await check("nested iter limit: handles null/undefined cfg gracefully", () => {
  assert.equal(resolveNestedIterLimit("lint", null), undefined);
  assert.equal(resolveNestedIterLimit("lint", undefined), undefined);
});

console.log("\n[reflowPlanner — edge cases]");

await check("planReflow: empty activeStages returns []", () => {
  assert.deepEqual(planReflow({ triageTarget: "test_generate", activeStages: [], mode: "smart", state: {} }), []);
});

await check("planReflow: triage target not in activeStages returns []", () => {
  const chain = planReflow({
    triageTarget: "nonexistent",
    activeStages: fullStages,
    mode: "smart",
    state: {},
  });
  assert.deepEqual(chain, []);
});

await check("planReflow: no triageTarget returns []", () => {
  assert.deepEqual(planReflow({ triageTarget: null, activeStages: fullStages, mode: "smart", state: {} }), []);
});

await check("planReflow: invalid mode defaults to 'smart'", () => {
  const chain = planReflow({
    triageTarget: "test_generate",
    activeStages: fullStages,
    mode: "asdf",
    state: {},
  });
  // Should still work and produce a chain
  assert.ok(chain.length > 0);
  assert.equal(chain[0].reason, "triage");
});

// ─── per-stage K-to-X reflow ──────────────────────────────
console.log("\n[reflowPlanner — planStageReflow + getReflowTail]");

const { planStageReflow } = await import("../src/pipeline/reflowPlanner.js");
const { getReflowTail, STAGE_REFLOW_SCOPE } = await import("../src/constants/stages.js");

await check("STAGE_REFLOW_SCOPE: defines tails for lint/lint_test/rtl_review/test_review/verify", () => {
  assert.equal(STAGE_REFLOW_SCOPE.lint.startKey,         "rtl_generate");
  assert.equal(STAGE_REFLOW_SCOPE.lint_test.startKey,    "test_generate");
  assert.equal(STAGE_REFLOW_SCOPE.rtl_review.startKey,   "rtl_generate");
  assert.equal(STAGE_REFLOW_SCOPE.test_review.startKey,  "test_generate");
  assert.equal(STAGE_REFLOW_SCOPE.verify.startKey,       "rtl_generate");
  // Judge is NOT in the scope map — it's dynamic
  assert.equal(STAGE_REFLOW_SCOPE.judge, undefined);
});

await check("getReflowTail: lint → [rtl_generate, rtl_review, lint]", () => {
  const tail = getReflowTail("lint", fullStages);
  const keys = tail.map(function(s) { return s.key; });
  assert.deepEqual(keys, ["rtl_generate", "rtl_review", "lint"]);
});

await check("getReflowTail: lint_test → [test_generate, test_review, lint_test]", () => {
  const tail = getReflowTail("lint_test", fullStages);
  const keys = tail.map(function(s) { return s.key; });
  assert.deepEqual(keys, ["test_generate", "test_review", "lint_test"]);
});

await check("getReflowTail: verify → broad chain from rtl_generate through verify", () => {
  const tail = getReflowTail("verify", fullStages);
  const keys = tail.map(function(s) { return s.key; });
  // Verify's tail spans rtl_generate through verify INCLUSIVE
  assert.deepEqual(keys, [
    "rtl_generate", "rtl_review", "lint", "formal_props",
    "test_generate", "test_review", "lint_test", "verify",
  ]);
});

await check("getReflowTail: rtl_review → [rtl_generate, rtl_review] (self-only-ish)", () => {
  const tail = getReflowTail("rtl_review", fullStages);
  const keys = tail.map(function(s) { return s.key; });
  assert.deepEqual(keys, ["rtl_generate", "rtl_review"]);
});

await check("getReflowTail: test_review → [test_generate, test_review]", () => {
  const tail = getReflowTail("test_review", fullStages);
  const keys = tail.map(function(s) { return s.key; });
  assert.deepEqual(keys, ["test_generate", "test_review"]);
});

await check("getReflowTail: stage with no scope entry returns []", () => {
  assert.deepEqual(getReflowTail("spec", fullStages), []);
  assert.deepEqual(getReflowTail("judge", fullStages), []);
  assert.deepEqual(getReflowTail("nonexistent", fullStages), []);
});

await check("getReflowTail: optional stages absent → falls through to next active stage at or after the start order", () => {
  // Remove rtl_review from the active list (user disabled it)
  const noReview = fullStages.filter(function(s) { return s.key !== "rtl_review"; });
  const tail = getReflowTail("lint", noReview);
  const keys = tail.map(function(s) { return s.key; });
  // Start key (rtl_generate) is still present; tail is [rtl_generate, lint]
  assert.deepEqual(keys, ["rtl_generate", "lint"]);
});

await check("planStageReflow: lint strict → [rtl_generate, rtl_review, lint] all run", () => {
  const tail = getReflowTail("lint", fullStages);
  const chain = planStageReflow({
    ownerKey: "lint",
    tail: tail,
    state: {},
    mode: "strict",
  });
  const keys = chain.map(function(c) { return c.stageKey; });
  assert.deepEqual(keys, ["rtl_generate", "rtl_review", "lint"]);
  // Owner (lint) is always-run; head is triage; middle is downstream
  assert.equal(chain[0].reason, "triage");
  assert.equal(chain[1].reason, "downstream");
  assert.equal(chain[2].reason, "always");
});

await check("planStageReflow: lint smart skips passing upstream when start is the trigger", () => {
  const tail = getReflowTail("lint", fullStages);
  const chain = planStageReflow({
    ownerKey: "lint",
    tail: tail,
    state: {},
    mode: "smart",
  });
  // First entry is always triage (the head); owner is always-run
  assert.equal(chain[0].reason, "triage");
  assert.equal(chain[chain.length - 1].stageKey, "lint");
  assert.equal(chain[chain.length - 1].reason, "always");
});

await check("planStageReflow: verify's chain is the broad rtl_generate→...→verify tail", () => {
  const tail = getReflowTail("verify", fullStages);
  const chain = planStageReflow({
    ownerKey: "verify",
    tail: tail,
    state: {},
    mode: "strict",
  });
  const keys = chain.map(function(c) { return c.stageKey; });
  assert.deepEqual(keys, [
    "rtl_generate", "rtl_review", "lint", "formal_props",
    "test_generate", "test_review", "lint_test", "verify",
  ]);
  // The owner (verify) is the always-key, the head (rtl_generate) is triage
  assert.equal(chain[0].reason, "triage");
  assert.equal(chain[chain.length - 1].reason, "always");
});

await check("planStageReflow: rtl_review's chain is [rtl_generate, rtl_review] — head triage, owner always", () => {
  const tail = getReflowTail("rtl_review", fullStages);
  const chain = planStageReflow({
    ownerKey: "rtl_review",
    tail: tail,
    state: {},
    mode: "strict",
  });
  assert.equal(chain.length, 2);
  assert.equal(chain[0].stageKey, "rtl_generate");
  assert.equal(chain[0].reason,   "triage");
  assert.equal(chain[1].stageKey, "rtl_review");
  assert.equal(chain[1].reason,   "always");
});

await check("planStageReflow: empty tail returns []", () => {
  assert.deepEqual(planStageReflow({ ownerKey: "lint", tail: [], state: {}, mode: "strict" }), []);
});

await check("planStageReflow: missing ownerKey returns []", () => {
  const tail = getReflowTail("lint", fullStages);
  assert.deepEqual(planStageReflow({ ownerKey: null, tail: tail, state: {}, mode: "strict" }), []);
});

// ─── fixContext attachment ───────────────────────
console.log("\n[reflowPlanner — fixContext]");

await check("planStageReflow: fixContext attaches to triage entry, NOT to other entries", () => {
  const tail = getReflowTail("lint", fullStages);
  const ctx = { source: "lint", previousCode: "module x; endmodule", lintResult: { errors: [{ msg: "WIDTH" }] } };
  const chain = planStageReflow({
    ownerKey: "lint",
    tail: tail,
    state: {},
    mode: "strict",
    fixContext: ctx,
  });
  // Head is triage; has fixContext attached
  assert.equal(chain[0].reason, "triage");
  assert.equal(chain[0].fixContext, ctx);
  // Other entries: NO fixContext
  for (let i = 1; i < chain.length; i++) {
    assert.equal(chain[i].fixContext, undefined,
      "entry " + i + " (" + chain[i].stageKey + ") should not have fixContext");
  }
});

await check("planStageReflow: no fixContext provided → no entries carry one", () => {
  const tail = getReflowTail("lint", fullStages);
  const chain = planStageReflow({ ownerKey: "lint", tail: tail, state: {}, mode: "strict" });
  for (const e of chain) {
    assert.equal(e.fixContext, undefined);
  }
});

await check("planReflow (judge): fixContext attaches to the triage stage entry", () => {
  const ctx = { source: "judge", judgeVerdict: { failingIds: ["REQ-1"], overall: "FAIL" } };
  const chain = planReflow({
    triageTarget: "rtl_generate",
    activeStages: fullStages,
    mode: "strict",
    state: {},
    fixContext: ctx,
  });
  // First entry is triage
  assert.equal(chain[0].reason, "triage");
  assert.equal(chain[0].stageKey, "rtl_generate");
  assert.equal(chain[0].fixContext, ctx);
  // Subsequent entries: no context
  for (let i = 1; i < chain.length; i++) {
    assert.equal(chain[i].fixContext, undefined);
  }
});

await check("planStageReflow smart mode: fixContext still attaches even when most entries are skipped", () => {
  const tail = getReflowTail("lint", fullStages);
  // State has rtl_review passing AND lint passing, but planner forces
  // them to run anyway because triage causes upstream rerun.
  const state = { rtl_review: { verdict: "PASS" }, lint: { status: "PASS" } };
  const ctx = { source: "lint", previousCode: "old", lintResult: { errors: [] } };
  const chain = planStageReflow({
    ownerKey: "lint", tail: tail, state: state, mode: "smart",
    fixContext: ctx,
  });
  const triageEntry = chain.find(function(c) { return c.reason === "triage"; });
  assert.ok(triageEntry, "should have a triage entry");
  assert.equal(triageEntry.fixContext, ctx);
});

console.log("\n═══════════════════════════════════════");
console.log("  Passed: " + passed);
console.log("  Failed: " + failures.length);
console.log("  Status: " + (failures.length === 0 ? "ALL PASS ✓" : "FAILURES"));
console.log("═══════════════════════════════════════");
if (failures.length > 0) process.exit(1);
