// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// verify-reflow-runner — reflow chain execution
//
// Pins the stage-agnostic chain executor contract:
//   • Invokes each non-skipped entry via services.invokeNode in order
//   • Merges sub-results back into currentState between entries
//   • Stamps depth, parentStageKey, parentIter on sub-logger and LLM accumulator
//   • Returns chainHistory with per-entry stats
//   • Falls back to legacy path when services.invokeNode is missing
//   • Strict-on-error bails out of remaining chain entries
//   • Per-stage iter-limit overrides are applied to subConfig
//   • Works for any ownerKey (not just "judge")
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

const { runReflowChain, resolveReflowMode } = await import("./src/pipeline/reflowRunner.js");

// Minimal stub for st (the owner's accState)
function makeOwnerState(overrides) {
  const ev = [];
  return Object.assign({
    _config: { maxLintIters: 3, maxVerifyIters: 2 },
    _onLog: function() {}, _onLoopback: function() {}, _signal: null,
    _logger: {
      events: ev,
      state: function(p) { ev.push(Object.assign({ type: "state" }, p)); },
      llm: function() {}, cli: function() {}, skill: function() {},
      prompt: function() {}, result: function() {},
      context: { depth: 0, parentStageKey: null, parentIter: null },
    },
    _services: {
      invokeNode: null,
      allStages: [],
    },
  }, overrides || {});
}

console.log("\n[runReflowChain — happy path]");

await check("invokes each non-skipped entry in chain order", async () => {
  const calls = [];
  const st = makeOwnerState({
    _services: {
      invokeNode: async function(stageKey, subState) {
        calls.push(stageKey);
        return { [stageKey]: { code: "x" }, _llms: [] };
      },
    },
  });
  const chain = [
    { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
    { stageId: 6, stageKey: "lint",         order: 60, reason: "downstream" },
    { stageId: 8, stageKey: "verify",       order: 80, reason: "always" },
  ];
  const out = await runReflowChain({
    chain, st, currentState: {}, allLlms: [],
    ownerKey: "judge", ownerIter: 1, parentDepth: 0,
  });
  assert.deepEqual(calls, ["rtl_generate", "lint", "verify"]);
  assert.equal(out.chainHistory.length, 3);
});

await check("skipped entries are recorded but invokeNode is NOT called", async () => {
  const calls = [];
  const st = makeOwnerState({
    _services: {
      invokeNode: async function(stageKey, subState) {
        calls.push(stageKey);
        return { [stageKey]: { code: "x" }, _llms: [] };
      },
    },
  });
  const chain = [
    { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
    { stageId: 6, stageKey: "lint",         order: 60, reason: "skipped" },
    { stageId: 8, stageKey: "verify",       order: 80, reason: "always" },
  ];
  const out = await runReflowChain({
    chain, st, currentState: {}, allLlms: [],
    ownerKey: "judge", ownerIter: 1, parentDepth: 0,
  });
  assert.deepEqual(calls, ["rtl_generate", "verify"]);  // lint skipped
  // Skipped entry still recorded in history
  assert.equal(out.chainHistory.length, 3);
  assert.equal(out.chainHistory[1].stageKey, "lint");
  assert.equal(out.chainHistory[1].status, "skipped");
  assert.equal(out.chainHistory[1].durationMs, 0);
});

await check("sub-result merges into currentState across entries", async () => {
  let seenStateAtVerify = null;
  const st = makeOwnerState({
    _services: {
      invokeNode: async function(stageKey, subState) {
        if (stageKey === "verify") {
          // Capture what currentState looks like when verify sees it
          seenStateAtVerify = { rtl: subState.rtl_generate, lint: subState.lint };
        }
        if (stageKey === "rtl_generate") {
          return { rtl_generate: { code: "regen v2" }, _llms: [] };
        }
        if (stageKey === "lint") {
          return { lint: { status: "PASS", errors: [] }, _llms: [] };
        }
        return { [stageKey]: {}, _llms: [] };
      },
    },
  });
  const chain = [
    { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
    { stageId: 6, stageKey: "lint",         order: 60, reason: "downstream" },
    { stageId: 8, stageKey: "verify",       order: 80, reason: "always" },
  ];
  await runReflowChain({
    chain, st, currentState: { rtl_generate: { code: "old" } },
    allLlms: [], ownerKey: "judge", ownerIter: 1, parentDepth: 0,
  });
  // verify saw the merged-in rtl_generate output from the first entry
  assert.equal(seenStateAtVerify.rtl.code, "regen v2");
  // and the lint result from the second entry
  assert.equal(seenStateAtVerify.lint.status, "PASS");
});

await check("sub-logger context: depth = parentDepth+1, parentStageKey/parentIter set", async () => {
  let capturedContext = null;
  const st = makeOwnerState({
    _services: {
      invokeNode: async function(stageKey, subState) {
        capturedContext = subState._logger && subState._logger.context;
        return { [stageKey]: {}, _llms: [] };
      },
    },
  });
  const chain = [
    { stageId: 6, stageKey: "lint", order: 60, reason: "triage" },
  ];
  await runReflowChain({
    chain, st, currentState: {}, allLlms: [],
    ownerKey: "verify", ownerIter: 3, parentDepth: 2,
  });
  assert.equal(capturedContext.depth, 3);          // parentDepth(2) + 1
  assert.equal(capturedContext.parentStageKey, "verify");
  assert.equal(capturedContext.parentIter, 3);
});

await check("LLM ledger accumulates with @ownerKey-iter-N suffix", async () => {
  const allLlms = [];
  const st = makeOwnerState({
    _services: {
      invokeNode: async function(stageKey, subState) {
        return {
          [stageKey]: {},
          _llms: [
            { stage: stageKey, tokensIn: 100, tokensOut: 50, latencyMs: 10 },
          ],
        };
      },
    },
  });
  const chain = [
    { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
    { stageId: 6, stageKey: "lint",         order: 60, reason: "downstream" },
  ];
  await runReflowChain({
    chain, st, currentState: {}, allLlms,
    ownerKey: "verify", ownerIter: 2, parentDepth: 0,
  });
  assert.equal(allLlms.length, 2);
  // ownerKey="verify", ownerIter=2 → suffix
  assert.equal(allLlms[0].stage, "rtl_generate@verify-iter-2");
  assert.equal(allLlms[1].stage, "lint@verify-iter-2");
  // Each LLM event carries parent context
  assert.equal(allLlms[0]._parentIter, 2);
  assert.equal(allLlms[0]._parentStageKey, "verify");
  assert.equal(allLlms[0]._depth, 1);
});

console.log("\n[runReflowChain — error handling]");

await check("missing invokeNode → fallbackToLegacy=true returned", async () => {
  const st = makeOwnerState({
    _services: { invokeNode: null },
  });
  const out = await runReflowChain({
    chain: [{ stageKey: "lint", reason: "triage", stageId: 6, order: 60 }],
    st, currentState: {}, allLlms: [],
    ownerKey: "judge", ownerIter: 1, parentDepth: 0,
  });
  assert.equal(out.fallbackToLegacy, true);
  assert.equal(out.chainHistory.length, 0);
});

await check("invokeNode throw is captured into entry's error+status, chain continues by default", async () => {
  const calls = [];
  const st = makeOwnerState({
    _services: {
      invokeNode: async function(stageKey, subState) {
        calls.push(stageKey);
        if (stageKey === "lint") throw new Error("lint exploded");
        return { [stageKey]: {}, _llms: [] };
      },
    },
  });
  const chain = [
    { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
    { stageId: 6, stageKey: "lint",         order: 60, reason: "downstream" },
    { stageId: 8, stageKey: "verify",       order: 80, reason: "always" },
  ];
  const out = await runReflowChain({
    chain, st, currentState: {}, allLlms: [],
    ownerKey: "judge", ownerIter: 1, parentDepth: 0,
    strictOnError: false,
  });
  // All three invoked despite lint throwing
  assert.deepEqual(calls, ["rtl_generate", "lint", "verify"]);
  // lint entry's status is "error" with message
  const lintEntry = out.chainHistory[1];
  assert.equal(lintEntry.status, "error");
  assert.match(lintEntry.error, /lint exploded/);
});

await check("strictOnError=true: chain halts after first error", async () => {
  const calls = [];
  const st = makeOwnerState({
    _services: {
      invokeNode: async function(stageKey, subState) {
        calls.push(stageKey);
        if (stageKey === "lint") throw new Error("boom");
        return { [stageKey]: {}, _llms: [] };
      },
    },
  });
  const chain = [
    { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
    { stageId: 6, stageKey: "lint",         order: 60, reason: "downstream" },
    { stageId: 8, stageKey: "verify",       order: 80, reason: "always" },
  ];
  await runReflowChain({
    chain, st, currentState: {}, allLlms: [],
    ownerKey: "judge", ownerIter: 1, parentDepth: 0,
    strictOnError: true,
  });
  // verify NOT invoked because chain halted after lint threw
  assert.deepEqual(calls, ["rtl_generate", "lint"]);
});

console.log("\n[runReflowChain — nested iter limit overrides]");

await check("nestedLintIters override applied to subConfig.maxLintIters", async () => {
  let observedMaxLintIters = null;
  const st = makeOwnerState({
    _config: { maxLintIters: 5, nestedLintIters: 2 },
    _services: {
      invokeNode: async function(stageKey, subState) {
        if (stageKey === "lint") {
          observedMaxLintIters = subState._config.maxLintIters;
        }
        return { [stageKey]: {}, _llms: [] };
      },
    },
  });
  const chain = [{ stageKey: "lint", stageId: 6, order: 60, reason: "triage" }];
  await runReflowChain({
    chain, st, currentState: {}, allLlms: [],
    ownerKey: "judge", ownerIter: 1, parentDepth: 0,
  });
  // Sub-stage saw the OVERRIDE (2), not the base (5)
  assert.equal(observedMaxLintIters, 2);
});

await check("when no nested override, sub-stage sees the base maxIters (reset behavior)", async () => {
  let observedMaxLintIters = null;
  const st = makeOwnerState({
    _config: { maxLintIters: 5, nestedLintIters: null },
    _services: {
      invokeNode: async function(stageKey, subState) {
        if (stageKey === "lint") {
          observedMaxLintIters = subState._config.maxLintIters;
        }
        return { [stageKey]: {}, _llms: [] };
      },
    },
  });
  const chain = [{ stageKey: "lint", stageId: 6, order: 60, reason: "triage" }];
  await runReflowChain({
    chain, st, currentState: {}, allLlms: [],
    ownerKey: "verify", ownerIter: 1, parentDepth: 0,
  });
  // Sub-stage sees its FULL base limit — every entry resets the counter
  assert.equal(observedMaxLintIters, 5);
});

console.log("\n[runReflowChain — recursion support]");

await check("services propagated to subState so nested reflow can recurse", async () => {
  let nestedServicesAvailable = null;
  const st = makeOwnerState({
    _services: {
      invokeNode: async function(stageKey, subState) {
        // Pretend this sub-node wants to start its OWN reflow chain.
        // It needs access to services.invokeNode itself.
        if (stageKey === "lint") {
          nestedServicesAvailable = !!(subState._services && typeof subState._services.invokeNode === "function");
        }
        return { [stageKey]: {}, _llms: [] };
      },
      allStages: [{ id: 6, key: "lint", order: 60 }],
    },
  });
  await runReflowChain({
    chain: [{ stageKey: "lint", stageId: 6, order: 60, reason: "triage" }],
    st, currentState: {}, allLlms: [],
    ownerKey: "judge", ownerIter: 1, parentDepth: 0,
  });
  assert.equal(nestedServicesAvailable, true);
});

console.log("\n[runReflowChain — works for non-judge owners]");

await check("ownerKey='lint': chain runs and state events use lint's iter context", async () => {
  const stateEvents = [];
  const st = makeOwnerState({
    _logger: {
      events: stateEvents,
      state: function(p) { stateEvents.push(Object.assign({ type: "state" }, p)); },
      llm: function() {}, cli: function() {}, skill: function() {},
      prompt: function() {}, result: function() {},
      context: { depth: 1, parentStageKey: "judge", parentIter: 2 },
    },
    _services: {
      invokeNode: async function(stageKey, subState) {
        return { [stageKey]: {}, _llms: [] };
      },
    },
  });
  const chain = [
    { stageKey: "rtl_generate", stageId: 4, order: 40, reason: "triage" },
    { stageKey: "lint",         stageId: 6, order: 60, reason: "always" },
  ];
  await runReflowChain({
    chain, st, currentState: {}, allLlms: [],
    ownerKey: "lint", ownerIter: 3, parentDepth: 1,
  });
  // State events on owner logger report the ownerIter and reflow progress
  const reflowStates = stateEvents.filter(function(e) { return /Reflow/.test(e.message || ""); });
  assert.ok(reflowStates.length >= 2);
  for (const e of reflowStates) {
    assert.equal(e.iter, 3);
  }
});

console.log("\n[runReflowChain — fixContext forwarding]");

await check("fixContext on triage entry → subState._fixContext set when invoking that stage", async () => {
  let observedContext = null;
  const st = makeOwnerState({
    _services: {
      invokeNode: async function(stageKey, subState) {
        if (stageKey === "rtl_generate") {
          observedContext = subState._fixContext;
        }
        return { [stageKey]: {}, _llms: [] };
      },
    },
  });
  const ctx = { source: "lint", previousCode: "old", lintResult: { errors: [] } };
  const chain = [
    { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage", fixContext: ctx },
    { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
  ];
  await runReflowChain({
    chain: chain, st: st, currentState: {}, allLlms: [],
    ownerKey: "lint", ownerIter: 1, parentDepth: 0,
  });
  assert.equal(observedContext, ctx);
});

await check("entries without fixContext: subState._fixContext is null", async () => {
  let observedContextLint = null;
  const st = makeOwnerState({
    _services: {
      invokeNode: async function(stageKey, subState) {
        if (stageKey === "lint") {
          observedContextLint = subState._fixContext;
        }
        return { [stageKey]: {}, _llms: [] };
      },
    },
  });
  const chain = [
    { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage",
      fixContext: { source: "lint" } },
    { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },  // no fixContext
  ];
  await runReflowChain({
    chain: chain, st: st, currentState: {}, allLlms: [],
    ownerKey: "lint", ownerIter: 1, parentDepth: 0,
  });
  assert.equal(observedContextLint, null);
});

console.log("\n[resolveReflowMode]");

await check("returns smart by default", () => {
  assert.equal(resolveReflowMode("lint", {}), "smart");
  assert.equal(resolveReflowMode("unknown", {}), "smart");
});

await check("returns strict when stage-specific key is 'strict'", () => {
  assert.equal(resolveReflowMode("lint", { lintReflowMode: "strict" }), "strict");
  assert.equal(resolveReflowMode("verify", { verifyReflowMode: "strict" }), "strict");
  assert.equal(resolveReflowMode("judge", { judgeReflowMode: "strict" }), "strict");
});

await check("each stage's mode is independent (lint=strict ≠ verify=smart)", () => {
  const cfg = { lintReflowMode: "strict", verifyReflowMode: "smart" };
  assert.equal(resolveReflowMode("lint", cfg), "strict");
  assert.equal(resolveReflowMode("verify", cfg), "smart");
});

await check("null/undefined cfg → smart", () => {
  assert.equal(resolveReflowMode("lint", null), "smart");
  assert.equal(resolveReflowMode("lint", undefined), "smart");
});

// ═══════════════════════════════════════════════════════════════════════════
// llmCount accuracy in chainHistory entries
//
// llmCount must count from subResult._llms, not subLogger.events: nodes
// never push LLM events to their logger; they push to result._llms instead.
// Counting from the logger is structurally always 0, producing the
// "Reflow [triage] rtl_generate: ran (83874ms, 0 LLM call(s))" symptom even
// though rtl_generate definitely called the LLM.
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[runReflowChain — llmCount reflects subResult._llms]");

await check("llmCount = subResult._llms.length when the sub-stage made calls", async () => {
  function makeSt() {
    const ev = [];
    return {
      _config: {},
      _onLog: function() {}, _onLoopback: function() {}, _signal: null,
      _logger: { events: ev,
        state: function(p) { ev.push(Object.assign({ type: "state" }, p)); },
        llm: function() {}, cli: function() {}, skill: function() {},
        prompt: function() {}, result: function() {},
        context: { depth: 0, parentStageKey: null, parentIter: null },
      },
      _services: { invokeNode: null, allStages: [] },
    };
  }
  const st = makeSt();
  st._services.invokeNode = async function(stageKey) {
    if (stageKey === "rtl_generate") {
      // Realistic: rtl_generate returns _llms with one entry (its prompt call)
      return {
        rtl_generate: { code: "module fixed; endmodule" },
        _llms: [{ stage: "rtl_generate", tokensIn: 800, tokensOut: 1200, latencyMs: 5000 }],
      };
    }
    if (stageKey === "lint") {
      // Lint at chain tail may call LLM zero or more times in its fix loop
      return {
        lint: { status: "PASS", errors: [], warnings: [] },
        _llms: [],
      };
    }
    return { [stageKey]: {}, _llms: [] };
  };
  const chain = [
    { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
    { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
  ];
  const out = await runReflowChain({
    chain, st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
    currentState: {}, allLlms: [], appendLog: function() {},
  });
  // First entry: rtl_generate made 1 LLM call → llmCount = 1
  assert.equal(out.chainHistory[0].stageKey, "rtl_generate");
  assert.equal(out.chainHistory[0].llmCount, 1,
    "llmCount must reflect result._llms.length, not subLogger event count");
  // Second entry: lint made 0 calls → llmCount = 0
  assert.equal(out.chainHistory[1].stageKey, "lint");
  assert.equal(out.chainHistory[1].llmCount, 0);
});

await check("llmCount handles multiple LLM calls in one sub-stage", async () => {
  const st = {
    _config: {},
    _onLog: function() {}, _onLoopback: function() {}, _signal: null,
    _logger: { events: [],
      state: function() {}, llm: function() {}, cli: function() {},
      skill: function() {}, prompt: function() {}, result: function() {},
      context: { depth: 0, parentStageKey: null, parentIter: null },
    },
    _services: {
      invokeNode: async function(stageKey) {
        if (stageKey === "verify") {
          // Verify could make several calls in its internal loop
          return {
            verify: { sim: "mock", total: 1, pass: 1, fail: 0, tests: [], log: "" },
            _llms: [
              { stage: "verify-iter1", tokensIn: 500, tokensOut: 200, latencyMs: 3000 },
              { stage: "verify-iter2", tokensIn: 400, tokensOut: 150, latencyMs: 2500 },
              { stage: "verify-triage", tokensIn: 200, tokensOut: 50, latencyMs: 800 },
            ],
          };
        }
        return { [stageKey]: {}, _llms: [] };
      },
      allStages: [],
    },
  };
  const out = await runReflowChain({
    chain: [{ stageId: 8, stageKey: "verify", order: 80, reason: "always" }],
    st, ownerKey: "judge", ownerIter: 1, parentDepth: 0,
    currentState: {}, allLlms: [], appendLog: function() {},
  });
  assert.equal(out.chainHistory[0].llmCount, 3, "should count all 3 _llms entries");
});

await check("llmCount handles legacy _llm singular form", async () => {
  const st = {
    _config: {},
    _onLog: function() {}, _onLoopback: function() {}, _signal: null,
    _logger: { events: [],
      state: function() {}, llm: function() {}, cli: function() {},
      skill: function() {}, prompt: function() {}, result: function() {},
      context: { depth: 0, parentStageKey: null, parentIter: null },
    },
    _services: {
      invokeNode: async function() {
        // Some nodes return singular _llm rather than _llms array
        return { result: { ok: true }, _llm: { stage: "x", tokensIn: 100, tokensOut: 50 } };
      },
      allStages: [],
    },
  };
  const out = await runReflowChain({
    chain: [{ stageId: 1, stageKey: "elicit", order: 10, reason: "always" }],
    st, ownerKey: "judge", ownerIter: 1, parentDepth: 0,
    currentState: {}, allLlms: [], appendLog: function() {},
  });
  assert.equal(out.chainHistory[0].llmCount, 1);
});

await check("llmCount = 0 when sub-stage returned no LLMs (correct zero, not bug zero)", async () => {
  const st = {
    _config: {},
    _onLog: function() {}, _onLoopback: function() {}, _signal: null,
    _logger: { events: [],
      state: function() {}, llm: function() {}, cli: function() {},
      skill: function() {}, prompt: function() {}, result: function() {},
      context: { depth: 0, parentStageKey: null, parentIter: null },
    },
    _services: {
      invokeNode: async function() {
        // Edge case: a sub-stage returns no _llms (e.g. lint completes cleanly
        // via CLI alone without ever needing to call the LLM)
        return { lint: { status: "PASS" }, _llms: [] };
      },
      allStages: [],
    },
  };
  const out = await runReflowChain({
    chain: [{ stageId: 6, stageKey: "lint", order: 60, reason: "always" }],
    st, ownerKey: "judge", ownerIter: 1, parentDepth: 0,
    currentState: {}, allLlms: [], appendLog: function() {},
  });
  // Legitimately 0 (not 0-because-bug)
  assert.equal(out.chainHistory[0].llmCount, 0);
});

// Reflow-active stage set must clear even on unexpected throw. Without the
// try/finally wrap, an error escaping the chain walk leaves the UI
// fast-blinking forever.
await check("_onReflowStages([]) fires in finally even when chain entry's logger throws", async () => {
  const reflowSignalCalls = [];
  const st = {
    _config: {},
    _onLog: function() {}, _onLoopback: function() {}, _signal: null,
    _onReflowStages: function(ids) { reflowSignalCalls.push(ids.slice()); },
    _logger: {
      events: [],
      state: function() {
        // Simulate an unexpected throw inside the logger — this used to
        // escape past the for-loop and leave reflow-active set un-cleared
        throw new Error("logger blew up");
      },
      llm: function() {}, cli: function() {}, skill: function() {},
      prompt: function() {}, result: function() {},
      context: { depth: 0, parentStageKey: null, parentIter: null },
    },
    _services: {
      invokeNode: async function() { return { lint: {}, _llms: [] }; },
      allStages: [{ id: 6, key: "lint", order: 60 }],
    },
  };
  let threw = false;
  try {
    await runReflowChain({
      chain: [{ stageId: 6, stageKey: "lint", order: 60, reason: "triage" }],
      st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
  } catch (_) { threw = true; }
  // Whether or not the call threw, the LAST signal MUST be []
  assert.equal(reflowSignalCalls[reflowSignalCalls.length - 1].length, 0,
    "finally MUST publish [] to clear the reflow-active set");
});

// ═══════════════════════════════════════════════════════════════════════════
// Abort check at chain-entry boundary
//
// The runner checks st._signal.aborted at the top of each chain
// entry's iteration. If aborted, it throws AbortError immediately
// without invoking the next sub-node. The chain's try/finally ensures
// _onReflowStages([]) still fires to clean up UI state.
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[runReflowChain — abort check between entries]");

await check("aborted signal at entry boundary halts chain immediately", async () => {
  const ac = new AbortController();
  ac.abort();  // pre-abort
  let invokeCount = 0;
  const st = {
    _config: {}, _onLog: function() {}, _onLoopback: function() {},
    _signal: ac.signal,
    _logger: { events: [],
      state: function() {}, llm: function() {}, cli: function() {},
      skill: function() {}, prompt: function() {}, result: function() {},
      context: { depth: 0, parentStageKey: null, parentIter: null },
    },
    _services: {
      invokeNode: async function() { invokeCount++; return { _llms: [] }; },
      allStages: [{ id: 6, key: "lint", order: 60 }],
    },
  };
  let threw = false;
  try {
    await runReflowChain({
      chain: [{ stageId: 6, stageKey: "lint", order: 60, reason: "triage" }],
      st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
  } catch (e) {
    threw = (e && e.name === "AbortError");
  }
  assert.equal(threw, true, "Should throw AbortError on pre-aborted signal");
  assert.equal(invokeCount, 0, "invokeNode must NOT be called when signal is pre-aborted");
});

await check("abort mid-chain stops further entries", async () => {
  const ac = new AbortController();
  const calledStages = [];
  const st = {
    _config: {}, _onLog: function() {}, _onLoopback: function() {},
    _signal: ac.signal,
    _logger: { events: [],
      state: function() {}, llm: function() {}, cli: function() {},
      skill: function() {}, prompt: function() {}, result: function() {},
      context: { depth: 0, parentStageKey: null, parentIter: null },
    },
    _services: {
      invokeNode: async function(stageKey) {
        calledStages.push(stageKey);
        // After the first entry runs, abort.
        if (stageKey === "rtl_generate") ac.abort();
        return { [stageKey]: {}, _llms: [] };
      },
      allStages: [
        { id: 4, key: "rtl_generate", order: 40 },
        { id: 6, key: "lint",         order: 60 },
      ],
    },
  };
  let threw = false;
  try {
    await runReflowChain({
      chain: [
        { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
        { stageId: 6, stageKey: "lint",         order: 60, reason: "always" },
      ],
      st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
  } catch (e) {
    threw = (e && e.name === "AbortError");
  }
  assert.equal(threw, true);
  // rtl_generate ran (then triggered abort). lint must NOT run.
  assert.deepEqual(calledStages, ["rtl_generate"]);
});

await check("abort still clears _onReflowStages([]) via try/finally", async () => {
  const ac = new AbortController();
  ac.abort();
  const reflowSignalCalls = [];
  const st = {
    _config: {}, _onLog: function() {}, _onLoopback: function() {},
    _signal: ac.signal,
    _onReflowStages: function(ids) { reflowSignalCalls.push(ids.slice()); },
    _logger: { events: [],
      state: function() {}, llm: function() {}, cli: function() {},
      skill: function() {}, prompt: function() {}, result: function() {},
      context: { depth: 0, parentStageKey: null, parentIter: null },
    },
    _services: {
      invokeNode: async function() { return { _llms: [] }; },
      allStages: [{ id: 6, key: "lint", order: 60 }],
    },
  };
  try {
    await runReflowChain({
      chain: [{ stageId: 6, stageKey: "lint", order: 60, reason: "triage" }],
      st, ownerKey: "lint", ownerIter: 1, parentDepth: 0,
      currentState: {}, allLlms: [], appendLog: function() {},
    });
  } catch (_) { /* expected */ }
  // The publish-on-enter happens BEFORE the abort check (so the set
  // gets populated), then the abort fires, then finally clears with [].
  assert.equal(reflowSignalCalls[reflowSignalCalls.length - 1].length, 0,
    "finally MUST clear the reflow-active set even on abort");
});

console.log("\n═══════════════════════════════════════");
console.log("  Passed: " + passed);
console.log("  Failed: " + failures.length);
console.log("  Status: " + (failures.length === 0 ? "ALL PASS ✓" : "FAILURES"));
console.log("═══════════════════════════════════════");
if (failures.length > 0) process.exit(1);
