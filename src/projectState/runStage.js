// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// projectState/runStage — Pure async runStage function
//
// A pure async function that takes all its dependencies via arguments:
//
//   async function runStage({
//     stageId,       // number — which stage to run
//     stageKey,      // string — matches ALL_STAGES[].key
//     trigger,       // string — "manual" | "auto" | etc (for executionPath)
//     overrideDesc,  // string|null — overrides uiState.userDesc if provided
//     targetModId,   // string — the module to run the stage for
//     reducerState,  // SNAPSHOT at call time — read-only here
//     uiState,       // { userDesc, config, lintWarningsAsErrors,
//                    //   verifyWarningsAsErrors, sharedPackage, instances }
//     services,      // { pipeline, allStages, computeContentHash,
//                    //   computeIfaceHash, estimateCost, saveCheckpoint,
//                    //   signal, logger? }
//     dispatch,      // reducer dispatch function
//   })
//   → { ok: true,  newState }                           // success
//   → { ok: false, error, aborted: boolean }            // failure or abort
//
// What it does:
//   1. Snapshots the target module's current state for reading priors
//   2. Dispatches stage-error-clear + run-start
//   3. Builds accState with _userDesc, _config, _onLog, _signal, prior stage
//      data, child interfaces, shared package code
//   4. Calls services.pipeline.invokeNode(stageKey, accState)
//   5. On success, dispatches:
//        - MODULE_STAGE_DATA_SET for the primary result
//        - Cross-stage MODULE_STAGE_DATA_SET updates (e.g. spec→elicit,
//          lint→rtl_generate, judge→spec, etc)
//        - LEDGER_APPEND for token usage
//        - MODULE_STAGE_RUN_FINISH with status="complete"
//        - MODULE_STAGE_COMPLETE to add stageId to the completed Set
//        - MODULE_CONTENT_HASH_SET for stages 2 or 4
//        - Parent MODULE_CHILD_HASHES_SET dispatches for multi-module
//        - Optional services.saveCheckpoint() call (best-effort)
//   6. On error, dispatches RUN_FINISH(status="error" | "aborted") and
//      MODULE_STAGE_ERROR_SET for non-abort errors
//
// What it does NOT do (caller's responsibility):
//   - Set processing / activeStage / viewingStage (React-side UI flags)
//   - Create the AbortController (caller owns it, passes services.signal)
//   - Switch active module (caller dispatches SET_ACTIVE_MOD if needed)
//
// This separation means runStage can be called from React, from Node CLI,
// from tests, or from any other consumer, without depending on React hooks
// or useReducer binding.
// ═══════════════════════════════════════════════════════════════════════════

import { blankModule } from "./moduleRegistry.js";
import {
  MODULE_STAGE_ERROR_CLEAR,
  MODULE_STAGE_ERROR_SET,
  MODULE_STAGE_DATA_SET,
  MODULE_STAGE_DATA_MERGE,
  MODULE_STAGE_COMPLETE,
  MODULE_STAGE_RUN_START,
  MODULE_STAGE_RUN_UPDATE,
  MODULE_STAGE_RUN_FINISH,
  MODULE_CONTENT_HASH_SET,
  MODULE_CHILD_HASHES_SET,
  LEDGER_APPEND,
} from "./actions.js";
import { createStageLogger } from "./stageLogger.js";
// Run-budget guard: stage-boundary gate here + in-stage gate via st._budget.
import { createBudgetGuard } from "../pipeline/budget.js";

/**
 * Execute a single pipeline stage and dispatch all resulting state changes.
 *
 * @param {object} args
 * @param {number} args.stageId       Stage id from ALL_STAGES (e.g. 4)
 * @param {string} args.stageKey      Stage key from ALL_STAGES (e.g. "rtl_generate")
 * @param {string} [args.trigger]     Trigger label for executionPath (default "manual")
 * @param {string} [args.overrideDesc] Per-module description override
 * @param {string} args.targetModId   Module to run the stage for
 * @param {object} args.reducerState  Current reducer state (read-only snapshot)
 * @param {object} args.uiState       UI-side state bag (see module header)
 * @param {object} args.services      Injected services (see module header)
 * @param {function} args.dispatch    Reducer dispatch function
 * @returns {Promise<{ok: boolean, newState?, error?, aborted?}>}
 */
export async function runStage(args) {
  const stageId      = args.stageId;
  const stageKey     = args.stageKey;
  const trigger      = args.trigger || "manual";
  const overrideDesc = args.overrideDesc;
  const targetModId  = args.targetModId;
  const reducerState = args.reducerState;
  const uiState      = args.uiState || {};
  const services     = args.services || {};
  const dispatch     = args.dispatch;
  // Optional nesting context. When judge runs the K-to-X tail it calls runStage
  // for each downstream stage with a context like { depth: 1,
  // parentStageKey: "judge", parentIter: 2,
  // reason: "downstream" }. The logger stamps these onto every event;
  // the trace panel later uses them to render hierarchy.
  // Top-level user-triggered runs pass no context (defaults to depth 0).
  const context      = args.context || null;

  // ── Sanity checks ──
  if (stageId == null)    throw new Error("runStage: stageId is required");
  if (!stageKey)          throw new Error("runStage: stageKey is required");
  if (!targetModId)       throw new Error("runStage: targetModId is required");
  if (!reducerState)      throw new Error("runStage: reducerState is required");
  if (!services.pipeline || typeof services.pipeline.invokeNode !== "function") {
    throw new Error("runStage: services.pipeline with invokeNode is required");
  }
  if (typeof dispatch !== "function") {
    throw new Error("runStage: dispatch must be a function");
  }

  // ── Budget gate (stage boundary) ──
  // When the user configured maxRunTokens / maxRunCostUsd and the project's
  // cumulative ledger spend already exceeds it, refuse to start the stage.
  // This is a GRACEFUL halt, not a crash: the previous stage's checkpoint is
  // already saved, the error message tells the user exactly which limit
  // tripped and how to raise it, and re-running after raising the limit (or
  // resuming) picks up where the run stopped. The same guard also rides into
  // the node as st._budget so fix loops can stop mid-stage (see budget.js).
  const budget = createBudgetGuard((uiState && uiState.config) || {}, reducerState.ledger);
  if (budget.enabled) {
    const over = budget.exceeded();
    if (over) {
      dispatch({
        type: MODULE_STAGE_ERROR_SET,
        modId: targetModId,
        stageId,
        message: over.message,
      });
      if (services.logger && typeof services.logger.warn === "function") {
        services.logger.warn("Stage " + stageKey + " not started: " + over.message);
      }
      return { ok: false, budgetExceeded: true, error: new Error(over.message) };
    }
  }

  // ── Snapshot target module from reducer state ──
  const targetMod = reducerState.modules[targetModId] || blankModule();
  const prevError = targetMod.stageErrors[stageId] || null;

  // ── Compute runId: current stageRuns[stageId].length + 1 ──
  const runId = ((targetMod.stageRuns[stageId] || []).length) + 1;
  const now   = typeof services.now === "function" ? services.now() : Date.now();

  // ── 1. Clear any prior error for this stage ──
  dispatch({ type: MODULE_STAGE_ERROR_CLEAR, modId: targetModId, stageId });

  // ── 2. Start the run (pushes stageRuns entry, activeRunTab, showDebug, executionPath) ──
  dispatch({
    type:     MODULE_STAGE_RUN_START,
    modId:    targetModId,
    stageId,
    stageKey,
    run: { runId, trigger, ts: now, text: "", metrics: {}, status: "running" },
  });

  // ── 3. onLog callback — streams updates into the in-progress run ──
  const onLog = function(text, metrics) {
    dispatch({
      type:    MODULE_STAGE_RUN_UPDATE,
      modId:   targetModId,
      stageId,
      runId,
      patch:   { text, metrics: metrics || {} },
    });
  };

  // onLoopback callback — pipeline nodes call this when starting an internal
  // fix targeting an upstream stage (verify fixing rtl_generate / test_generate,
  // judge fixing spec / rtl_generate / test_generate). The UI uses it to render
  // the upstream stage badge with a bright-yellow faster-pulse cadence while the
  // loopback fix is in flight.
  //
  // We wrap the user-supplied callback so it always carries the current module
  // id alongside the stage id. With a single global stageId, in system mode
  // (multi-module) the viewing module's tab strip would pulse yellow when
  // ANOTHER module
  // looped back to that stageId, even though the viewing module's
  // completed step had nothing to do with the in-flight fix.
  //
  // Pipeline nodes' API is UNCHANGED: they still call `_onLoopback(stageId)`
  // or `_onLoopback(null)` — runStage prepends modId on the way out so
  // every node, present and future, gets correct module-scoped signaling
  // without code changes.
  const userOnLoopback = typeof services.onLoopback === "function"
    ? services.onLoopback
    : null;
  const onLoopback = userOnLoopback
    ? function(stageId) {
        // Some callers (judge.js after sub-step done) pass null to clear.
        // Carry the modId regardless so the UI knows which tab to clear.
        userOnLoopback(stageId == null ? null : stageId, targetModId);
      }
    : function() { /* no-op */ };

  // Multi-stage reflow signal. The reflow runner calls
  // _onReflowStages(stageIdsArray) when entering a chain so the UI can
  // fast-blink ALL stages active in the reflow simultaneously, not just
  // a single "target" the way _onLoopback does. Same modId-scoping
  // mechanism as onLoopback — runStage stamps the active modId so a
  // cross-module reflow doesn't pulse the viewing module's badges.
  // Callers pass null/[] to clear when the chain finishes.
  const userOnReflowStages = typeof services.onReflowStages === "function"
    ? services.onReflowStages
    : null;
  const onReflowStages = userOnReflowStages
    ? function(stageIds) {
        const ids = Array.isArray(stageIds) ? stageIds : (stageIds == null ? [] : [stageIds]);
        userOnReflowStages(ids, targetModId);
      }
    : function() { /* no-op */ };

  // ── 4. Build accState from uiState + reducerState snapshot ──
  const cfg = uiState.config || {};
  const accState = {
    _userDesc:   overrideDesc || uiState.userDesc || "",
    _config: Object.assign({}, cfg, {
      lintWarningsAsErrors:   !!uiState.lintWarningsAsErrors,
      verifyWarningsAsErrors: !!uiState.verifyWarningsAsErrors,
      _signal: services.signal || null,
    }),
    _onLog:      onLog,
    _onLoopback: onLoopback,
    // Multi-stage reflow signal channel.
    _onReflowStages: onReflowStages,
    _signal:     services.signal || null,
    _lastError:  prevError,
    _childInterfaces:   services.childInterfaces || null,
    _sharedPackageCode: uiState.sharedPackage ? uiState.sharedPackage.code : null,
    // Skill bridge: if `services.skillBridge` is provided, pipeline
    // nodes that opt-in via applySkillsToPrompt() will get user-defined
    // skill overlays applied to their prompts. The bridge encapsulates
    // workflow + cwd + policy resolution so nodes don't need to know
    // those details. Headless contexts (smoke tests, the GUI today)
    // can omit the bridge → nodes run with their core prompts only.
    _skillBridge: services.skillBridge || null,
    // Run-budget guard (createBudgetGuard). Fix loops consult it at
    // iteration boundaries via st._budget.overWith(allLlms) so a runaway
    // nested reflow stops gracefully INSIDE a stage instead of only at the
    // next stage boundary. Headless callers that omit budget config get a
    // disabled guard (enabled: false) — checks are skipped.
    _budget: budget,
    // Per-stage structured logger. Nodes (and the helpers they call) push events
    // for CLI executions, skill applications, prompt-override resolutions, and
    // state transitions via st._logger.cli(...) / .skill(...) / .prompt(...) /
    // .state(...). LLM events are synthesized automatically below from _llms
    // after the node returns, so nodes don't log those manually.
    //
    // When the caller passes a `context` (typically judge invoking runStage as
    // part of K-to-X reflow), every event inherits the depth + parentStageKey +
    // parentIter metadata so the trace panel can reconstruct the hierarchy.
    //
    // onEmit forwarder: when the orchestrator wires a services.onProgress
    // callback (the GUI does; headless tests don't), every event the node logs
    // is also dispatched to onProgress with the stage ID prefixed. The GUI uses
    // this to render the in-flight "currently doing X..." panel that replaces
    // "No data yet." while the stage runs. Top-level runs get progress; nested
    // sub-stage runs (depth > 0) skip the forward to avoid flooding
    // the panel with per-chain-entry events — the parent's chain
    // logger already captures them and we render those separately.
    _logger: createStageLogger(
      stageKey,
      context || undefined,
      (typeof services.onProgress === "function" && (!context || context.depth == null || context.depth === 0))
        ? function(event) { services.onProgress(stageId, event, targetModId); }
        : null,
    ),
    // Reflow-capable stages (judge, lint, verify, …) need access to the
    // pipeline service so they can invoke sub-nodes for their K-to-X reflow
    // chain. The runner builds a fresh accState for each chain target, invokes
    // its node via invokeNode (the same path the top-level orchestrator uses),
    // and merges the result back — with nested logger context (depth+1,
    // parentStageKey set to the owning stage).
    _services: {
      allStages:   services.allStages || [],
      invokeNode:  services.pipeline.invokeNode,
      skillBridge: services.skillBridge || null,
      childInterfaces: services.childInterfaces || null,
      // Cross-run triage memory adapter (record/lookup). Wired by the runtime
      // (CLI: a JSON file; GUI: in-memory); absent → judge's cross-run
      // learning no-ops. See pipeline/triageMemory.js.
      triageMemory: services.triageMemory || null,
      // The chain runner needs the modId to publish per-entry run records via
      // dispatch. We hand it the dispatch wrapped as onSubRun(stageId, record)
      // so the runner stays decoupled from the action-type constants.
      modId: targetModId,
      onSubRun: function(subRunRecord) {
        // Publishes one chain-entry's run as a fresh run lifecycle.
        // We START + FINISH in one dispatch pair so the existing
        // stageRuns infrastructure captures it. RUN_START allocates
        // a runId from the existing array length; we then immediately
        // FINISH with the result snapshot + context.
        const sid = subRunRecord.stageId;
        const stageMeta = (services.allStages || []).find(function(s) { return s.id === sid; });
        const subRunId = ((reducerState.modules[targetModId]
                            && reducerState.modules[targetModId].stageRuns
                            && reducerState.modules[targetModId].stageRuns[sid]) || []).length + 1;
        // NOTE: we read reducerState directly rather than the latest
        // dispatched state. For the run counter, this can race when
        // multiple chain entries fire fast — but the reducer's START
        // appends to whatever the latest array is, so the dispatched
        // runId might not match what we computed here. We pass our
        // computed runId in the START dispatch; the reducer uses it
        // as-is (it stores whatever .runId is in the run record).
        dispatch({
          type: MODULE_STAGE_RUN_START,
          modId: targetModId,
          stageId: sid,
          stageKey: stageMeta ? stageMeta.key : ("stage-" + sid),
          run: {
            runId: subRunId,
            trigger: subRunRecord.trigger || "reflow",
            ts: subRunRecord.startedAt || Date.now(),
            text: "",
            metrics: {},
            status: "running",
            // Context recording where this run came from (label is the
            // human-readable form used in the dropdown).
            context: subRunRecord.context || null,
          },
        });
        dispatch({
          type: MODULE_STAGE_RUN_FINISH,
          modId: targetModId,
          stageId: sid,
          runId: subRunId,
          status: subRunRecord.status || "complete",
          result: subRunRecord.result || null,
          context: subRunRecord.context || null,
          ts: subRunRecord.finishedAt || Date.now(),
        });
        // Return the assigned runId so the runner can stamp it on chainHistory;
        // the trace tab uses it to match run records to chain entries for
        // click-to-navigate across trace ↔ dropdown.
        return subRunId;
      },
    },
  };

  // ── 5. Populate prior stage data (all stages with order < targetOrder) ──
  const allStages = services.allStages || [];
  const targetMeta = allStages.find(function(s) { return s.id === stageId; });
  const targetOrder = (targetMeta && targetMeta.order) || 0;
  allStages.forEach(function(s) {
    if (s.order < targetOrder && targetMod.stageData[s.id] != null) {
      accState[s.key] = targetMod.stageData[s.id];
    }
  });

  // ── 6. Invoke pipeline ──
  let newState;
  try {
    newState = await services.pipeline.invokeNode(stageKey, accState);
  } catch (e) {
    const isAborted =
      e && (e.name === "AbortError" || (services.signal && services.signal.aborted));
    const status = isAborted ? "aborted" : "error";
    dispatch({
      type: MODULE_STAGE_RUN_FINISH, modId: targetModId, stageId, runId, status,
      // Record context + ts even on error so the dropdown can show this run as
      // "failed at depth N". No result, since the node threw before producing one.
      result: null,
      context: context || null,
      ts: Date.now(),
    });
    if (!isAborted) {
      dispatch({
        type: MODULE_STAGE_ERROR_SET,
        modId: targetModId,
        stageId,
        message: e && e.message ? e.message : String(e),
      });
    }
    if (services.logger && typeof services.logger.error === "function") {
      services.logger.error("Stage " + stageKey + (isAborted ? " aborted" : " failed") + ":", e);
    }
    return { ok: false, error: e, aborted: !!isAborted };
  }

  // ── 7. Primary result dispatch ──
  const result = newState[stageKey];

  // Synthesize per-stage log events from _llms.
  //
  // The per-step Log panel shows every LLM exchange, CLI execution, prompt
  // override, and state transition. Rather than require every pipeline node to
  // wire a logger explicitly, we synthesize "llm" events from each stage's
  // _llms ledger (which all nodes populate) here. Nodes that emit richer data
  // (CLI commands, skill applications) push extra events via st._logger.cli(...),
  // wired below.
  //
  // The events array attaches to result._log so it persists into
  // stageData[id]._log and the GUI Log panel can read it.
  if (result && typeof result === "object" && Array.isArray(result._llms)) {
    // Nesting fields propagated through synthesized events so the trace panel
    // can reconstruct hierarchy. Top-level runs (no context) default to
    // depth=0, parent=null.
    const ctxDepth  = context && context.depth          != null ? context.depth          : 0;
    const ctxParent = context && context.parentStageKey || null;
    const ctxParIt  = context && context.parentIter     != null ? context.parentIter     : null;
    const synthLog = result._llms.map(function(c) {
      // Extract iter suffix from stage name when present ("lint-iter1")
      const iterMatch = (c.stage || "").match(/-iter(\d+)$|-(\d+)$/);
      const iter = iterMatch ? parseInt(iterMatch[1] || iterMatch[2], 10) : null;
      const sp = c.systemPrompt || "";
      const um = c.userMessage  || "";
      const r  = c.text         || "";
      return {
        ts: (c.endedAtMs != null) ? c.endedAtMs : Date.now(),
        type: "llm",
        // Nesting metadata
        depth:          ctxDepth,
        parentStageKey: ctxParent,
        parentIter:     ctxParIt,
        stageLabel: c.stage || stageKey,
        iter: iter,
        model:    c.model    || "",
        provider: c.provider || "",
        systemPrompt: sp,
        userMessage:  um,
        response:     r,
        tokensIn:   (typeof c.tokensIn  === "number") ? c.tokensIn  : null,
        tokensOut:  (typeof c.tokensOut === "number") ? c.tokensOut : null,
        latencyMs:  c.latencyMs   || 0,
        startedAtMs: c.startedAtMs || null,
        endedAtMs:   c.endedAtMs   || null,
        promptTruncated:   (sp.length + um.length) > 200,
        responseTruncated: r.length > 200,
      };
    });
    // Preserve any pre-existing logger events the node already pushed
    const existing = (accState._logger && Array.isArray(accState._logger.events)) ? accState._logger.events : [];
    // Merge with chronological ordering by ts
    const merged = synthLog.concat(existing).sort(function(a, b) { return (a.ts || 0) - (b.ts || 0); });
    // Append a synthesized "result" event so the Log panel's filter counts
    // always include a Result entry and the user sees the final outcome inline
    // with the LLM/CLI/state events. Context is propagated so the result event
    // carries nesting metadata for the trace panel.
    const resultEvent = synthesizeResultEvent(stageKey, result, context);
    if (resultEvent) merged.push(resultEvent);
    result._log = merged;
  } else if (result && typeof result === "object" && accState._logger
             && Array.isArray(accState._logger.events) && accState._logger.events.length > 0) {
    // Stage had no _llms but logger captured other events (skill,
    // prompt, cli, state). Still attach them.
    const evs = accState._logger.events.slice();
    const resultEvent = synthesizeResultEvent(stageKey, result, context);
    if (resultEvent) evs.push(resultEvent);
    result._log = evs;
  }

  dispatch({ type: MODULE_STAGE_DATA_SET, modId: targetModId, stageId, data: result });

  // ── 8. Cross-stage side effects ──
  // These use MODULE_STAGE_DATA_MERGE rather than _SET (full replace): a full
  // replace wiped accumulated upstream metadata every time a downstream node
  // re-wrote upstream code. Specifically:
  //   - _manualEditHistory: the user's manual edits on RTL/TB, preserved across
  //     pipeline runs, would disappear after verify
  //     or judge ran.
  //   - lint._fixes / rtl_review._fixes mirrored onto stageData[4]
  //     (and equivalents on stageData[7]) — read by the renderer to
  //     populate the fix-list panel — would disappear.
  //   - The _originalCode chain — when verify decided NOT to modify
  //     RTL (best-known restore reverted), it returned `{ code }` only,
  //     and the replace stripped the previous _originalCode set by
  //     lint, leaving the user's "Compare past version" → "Original"
  //     entry showing the post-verify code instead of the truly
  //     original RTL Gen output.
  // Switching to DATA_MERGE (shallow merge into the existing slot)
  // preserves all unrelated keys while still letting the downstream
  // node's `code`, `_originalCode`, `_fixSource`, and `_fixes` overlay
  // the upstream fields. The PRIMARY dispatch at section 7 stays as
  // DATA_SET because that IS the canonical "stage produced this result"
  // replacement of its own slot.
  if (stageKey === "spec" && newState.elicit) {
    dispatch({ type: MODULE_STAGE_DATA_MERGE, modId: targetModId, stageId: 1, data: newState.elicit });
    dispatch({ type: MODULE_STAGE_COMPLETE, modId: targetModId, stageId: 1 });
  }
  if (stageKey === "lint" && newState.rtl_generate) {
    dispatch({ type: MODULE_STAGE_DATA_MERGE, modId: targetModId, stageId: 4, data: newState.rtl_generate });
  }
  if (stageKey === "rtl_review" && newState.rtl_generate) {
    dispatch({ type: MODULE_STAGE_DATA_MERGE, modId: targetModId, stageId: 4, data: newState.rtl_generate });
  }
  if (stageKey === "test_review" && newState.test_generate) {
    dispatch({ type: MODULE_STAGE_DATA_MERGE, modId: targetModId, stageId: 7, data: newState.test_generate });
  }
  // lint_test (id 12) modifies test_generate (id 7) when it applies fixes —
  // mirror the rtl_review/lint pattern that updates rtl_generate (id 4).
  if (stageKey === "lint_test" && newState.test_generate) {
    dispatch({ type: MODULE_STAGE_DATA_MERGE, modId: targetModId, stageId: 7, data: newState.test_generate });
  }
  if (stageKey === "verify" && newState.rtl_generate) {
    dispatch({ type: MODULE_STAGE_DATA_MERGE, modId: targetModId, stageId: 4, data: newState.rtl_generate });
  }
  if (stageKey === "verify" && newState.test_generate) {
    dispatch({ type: MODULE_STAGE_DATA_MERGE, modId: targetModId, stageId: 7, data: newState.test_generate });
  }
  if (stageKey === "judge" && newState.rtl_generate) {
    dispatch({ type: MODULE_STAGE_DATA_MERGE, modId: targetModId, stageId: 4, data: newState.rtl_generate });
  }
  if (stageKey === "judge" && newState.test_generate) {
    dispatch({ type: MODULE_STAGE_DATA_MERGE, modId: targetModId, stageId: 7, data: newState.test_generate });
  }
  // Judge's internal re-verify loop produces an updated verify result on
  // newState.verify. Without this dispatch the verify(8) slot stays at the
  // pre-judge value, and downstream reads (synthesisedTrace, the GUI verify tab,
  // the eval gate on later runs) keep seeing stale data.
  //
  // CARE: an AI-estimated verify result from judge MUST NOT overwrite a real CLI
  // verify the user already has. We honor that by writing the new verify only
  // when:
  //   (a) the new verify is CLI-backed (authoritative), OR
  //   (b) the existing slot is also not CLI-backed (no downgrade), OR
  //   (c) the existing slot has no verify at all (fresh run).
  // This lets judge propagate genuine re-verify runs and synthetic
  // ones into a slot that already had a synthetic, while protecting
  // a user's CLI result from being clobbered by an LLM estimate.
  if (stageKey === "judge" && newState.verify) {
    const existingVerify = (targetMod.stageData && targetMod.stageData[8]) || null;
    const newIsCli      = !!newState.verify.cli;
    const existingIsCli = !!(existingVerify && existingVerify.cli);
    const noExisting    = !existingVerify || existingVerify.total == null;
    const shouldWrite   = newIsCli || !existingIsCli || noExisting;
    if (shouldWrite) {
      dispatch({ type: MODULE_STAGE_DATA_MERGE, modId: targetModId, stageId: 8, data: newState.verify });
    }
  }
  if (stageKey === "judge" && newState.spec) {
    dispatch({ type: MODULE_STAGE_DATA_MERGE, modId: targetModId, stageId: 2, data: newState.spec });
  }
  // Only propagate judge's internal re-verify back to the verify stage's data
  // slot if it produced a real CLI result. Judge's regen loop calls promptVerify
  // (LLM-only), which is always AI-estimated; without this guard a manually
  // re-run verify with real Verilator output would be overwritten by judge's
  // estimate. This stays as DATA_SET (replace), not merge, because verify's slot
  // represents a discrete simulator run — merging would mix old and new test
  // results.
  if (stageKey === "judge" && newState.verify && newState.verify.cli === true) {
    dispatch({ type: MODULE_STAGE_DATA_SET, modId: targetModId, stageId: 8, data: newState.verify });
  }

  // ── 9. Ledger append (only if LLM call produced metrics) ──
  if (newState._llm && (newState._llm.tokensIn || newState._llm.tokensOut || newState._llm.latencyMs)) {
    const r = newState._llm;
    dispatch({
      type: LEDGER_APPEND,
      entry: {
        stage:    stageKey,
        model:    r.model,
        provider: r.provider || cfg.provider,
        tIn:      r.tokensIn,
        tOut:     r.tokensOut,
        cost:     services.estimateCost
          ? services.estimateCost(r.tokensIn, r.tokensOut, r.provider || cfg.provider)
          : 0,
        ms:       r.latencyMs,
      },
    });
  }

  // ── 10. Finish the run (status="complete", close debug panel) ──
  // Carry the per-run result snapshot + context so the per-stage dropdown can
  // show this run later. `context` is null for top-level runs; it's set when
  // the chain runner invokes runStage as part of a nested re-run.
  dispatch({
    type: MODULE_STAGE_RUN_FINISH,
    modId: targetModId, stageId, runId,
    status: "complete",
    result: result,
    context: context || null,
    ts: Date.now(),
  });

  // ── 11. Mark stage completed ──
  dispatch({ type: MODULE_STAGE_COMPLETE, modId: targetModId, stageId });

  // ── 11b. Observer — fire-and-forget signal extraction ──
  // The observer is opt-in (config.observerEnabled). It receives a
  // small summary of this stage's outcome, runs an LLM extractor, and
  // writes notable events to the SQLite KB at config.observerPath.
  // NEVER throws; the call returns synchronously and the LLM work
  // happens in the background.
  try {
    const stageKey = (services.allStages && services.allStages.find(function(s) { return s.id === stageId; }) || {}).key;
    if (services.observer && stageKey) {
      services.observer({
        workflow:      (uiState.config && uiState.config.workflow) || "rtl",
        projectId:     uiState.projectId || null,
        moduleId:      targetModId,
        stageKey:      stageKey,
        succeeded:     true,
        stageResult:   result || {},
        skillsApplied: (result && result._skillsApplied) || [],
        llm:           result && result._llm ? {
          tokensIn:  result._llm.tokensIn,
          tokensOut: result._llm.tokensOut,
          latencyMs: result._llm.latencyMs,
        } : null,
      });
    }
  } catch (_e) { /* observer must never break the pipeline */ }

  // ── 12. Content hash on stages 2 and 4 ──
  if (stageId === 2 || stageId === 4) {
    // Compute from what the state WILL be after our dispatches above:
    //   - If stageId === 2: spec = result, rtlCode = pre-run stage 4 (unchanged)
    //   - If stageId === 4: rtlCode = result.code, spec = pre-run stage 2 (unchanged)
    const spec = stageId === 2 ? (result || {}) : (targetMod.stageData[2] || {});
    const rtlCode = stageId === 4
      ? ((result && result.code) || "")
      : (targetMod.stageData[4] ? targetMod.stageData[4].code || "" : "");

    const contentHash = services.computeContentHash
      ? services.computeContentHash(spec, rtlCode)
      : null;
    if (contentHash != null) {
      dispatch({ type: MODULE_CONTENT_HASH_SET, modId: targetModId, contentHash });
    }

    // ── 13. Propagate to parent modules' childHashes ──
    const instances = uiState.instances || {};
    const parentIds = new Set();
    Object.values(instances).forEach(function(inst) {
      if (inst.moduleId === targetModId && inst.parentModuleId) {
        parentIds.add(inst.parentModuleId);
      }
    });
    parentIds.forEach(function(parentId) {
      const parentMod = reducerState.modules[parentId];
      if (!parentMod) return;
      const nextChildHashes = Object.assign({}, parentMod.childHashes || {});
      nextChildHashes[targetModId] = {
        contentHash,
        ifaceHash: services.computeIfaceHash
          ? services.computeIfaceHash(spec)
          : null,
      };
      dispatch({
        type: MODULE_CHILD_HASHES_SET,
        modId: parentId,
        childHashes: nextChildHashes,
      });
    });
  }

  // ── 14. Auto-checkpoint (best-effort, non-fatal on failure) ──
  if (typeof services.saveCheckpoint === "function") {
    try {
      await services.saveCheckpoint();
    } catch (ckErr) {
      if (services.logger && typeof services.logger.warn === "function") {
        services.logger.warn("[Checkpoint] Auto-save failed (non-fatal):", ckErr && ckErr.message);
      }
    }
  }

  return { ok: true, newState };
}

// ─── helpers ──────────────────────────────────────────────────────────

// Translate a stage's result blob into a one-line
// "result" log event so the Log panel filter shows a Result count > 0
// and the user sees the final outcome at the end of the log. We try a
// few well-known shape conventions: lint/lint_test → status, verify →
// pass/total, judge → overall, review → overallSeverity. When nothing
// matches we synthesize a generic "completed" event so the filter still
// shows the panel had a Result.
function synthesizeResultEvent(stageKey, result, context) {
  if (!result || typeof result !== "object") return null;
  const ts = Date.now();
  // Stamp nesting context onto the synthesized result event so trace-panel
  // hierarchy logic doesn't need to special-case it.
  const ctx = context || {};
  const baseFields = {
    ts: ts,
    type: "result",
    depth:          ctx.depth          == null ? 0    : ctx.depth,
    parentStageKey: ctx.parentStageKey || null,
    parentIter:     ctx.parentIter     == null ? null : ctx.parentIter,
  };
  if (stageKey === "lint" || stageKey === "lint_test") {
    return Object.assign({}, baseFields, {
      status: result.status || "completed",
      summary: result.status === "PASS"
        ? "Lint clean"
        : ((result.errors || []).length + " error(s), " + (result.warnings || []).length + " warning(s)"),
    });
  }
  if (stageKey === "verify") {
    const pass = result.pass || 0;
    const fail = result.fail || 0;
    const total = result.total || 0;
    return Object.assign({}, baseFields, {
      status: fail === 0 ? "PASS" : "FAIL",
      summary: pass + "/" + total + " tests passing" + (fail > 0 ? " (" + fail + " failed)" : ""),
    });
  }
  if (stageKey === "judge") {
    return Object.assign({}, baseFields, {
      status: result.overall || "completed",
      summary: "score " + (result.score != null ? result.score : "?") +
        " · " + (result.recs || []).length + " recommendation(s)",
    });
  }
  if (stageKey === "rtl_review" || stageKey === "test_review") {
    return Object.assign({}, baseFields, {
      status: result.overallSeverity || "completed",
      summary: (result.issues || []).length + " issue(s) identified",
    });
  }
  return Object.assign({}, baseFields, {
    status: "completed",
    summary: stageKey + " stage finished",
  });
}
