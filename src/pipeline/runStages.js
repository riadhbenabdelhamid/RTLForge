// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// runStages — Linear pipeline executor
//
// Drives a compiled StateGraph through a sequence of stage keys, accumulating
// the state delta from each node into a single state object. This is the
// React-free building block that the React layer (useProject) and any
// future CLI/batch runner can call to execute the pipeline end-to-end.
//
// What this does NOT do (intentionally):
// - It does not maintain a "stage data" store keyed by stage id like the
//   React component does. The accState IS the source of truth.
// - It does not call any React state setters. Use onStageStart / onStageComplete
//   callbacks if you need to observe progress from a React component.
// - It does not implement multi-module orchestration (runAllPipelines) or
//   dependency-graph-driven execution. That lives in projectState/.
// - It does not handle the "build accState from stageData each call" pattern
//   the React layer uses for single-stage retries. The React layer does that
//   inline because it has access to stageData; this function operates on a
//   single in-memory accumulator.
//
// What it DOES do:
// - Iterates stage keys in order
// - Calls pipeline.invokeNode(key, accState) for each (which already merges
//   the returned delta via Object.assign in StateGraph.compile)
// - Honors AbortSignal cancellation between stages
// - Calls optional onStageStart / onStageComplete / onStageError callbacks
// - Returns the final accumulated state
//
// Errors propagate by default; pass opts.continueOnError=true to log and skip.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run a sequence of pipeline stages, accumulating state through each node.
 *
 * @param {object} pipeline      Compiled StateGraph (from buildPipeline().compile())
 * @param {string[]} stageKeys   Ordered list of node keys to invoke
 * @param {object} initialState  Initial accState (must contain _userDesc, _config, etc as required by the nodes)
 * @param {object} [opts]        Execution options
 * @param {AbortSignal} [opts.signal]                       Cancellation signal
 * @param {(key, st) => void} [opts.onStageStart]           Called before each node
 * @param {(key, st) => void} [opts.onStageComplete]        Called after each node returns
 * @param {(key, err, st) => boolean} [opts.onStageError]   Called on node throw; return true to continue, false to abort
 * @param {boolean} [opts.continueOnError=false]            If true, errors are caught and skipped
 * @returns {Promise<object>} Final accumulated state
 */
export async function runStages(pipeline, stageKeys, initialState, opts) {
  opts = opts || {};
  let st = Object.assign({}, initialState);

  for (let i = 0; i < stageKeys.length; i++) {
    const key = stageKeys[i];

    // Honor abort signal between stages
    if (opts.signal && opts.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    if (!pipeline.hasNode(key)) {
      const err = new Error("runStages: unknown stage key '" + key + "'");
      if (opts.onStageError && opts.onStageError(key, err, st)) continue;
      if (opts.continueOnError) { console.warn("[runStages] " + err.message); continue; }
      throw err;
    }

    if (opts.onStageStart) {
      try { opts.onStageStart(key, st); }
      catch (cbErr) { console.warn("[runStages] onStageStart callback threw:", cbErr); }
    }

    try {
      st = await pipeline.invokeNode(key, st);
    } catch (e) {
      // Always re-throw aborts
      if (e.name === "AbortError") throw e;

      if (opts.onStageError) {
        const shouldContinue = opts.onStageError(key, e, st);
        if (shouldContinue) continue;
      }
      if (opts.continueOnError) {
        console.warn("[runStages] Stage '" + key + "' failed: " + (e.message || e));
        continue;
      }
      throw e;
    }

    if (opts.onStageComplete) {
      try { opts.onStageComplete(key, st); }
      catch (cbErr) { console.warn("[runStages] onStageComplete callback threw:", cbErr); }
    }
  }

  return st;
}

/**
 * Convenience: extract stage keys from a getActiveStages() result list.
 * Use as: runStages(pipeline, stageKeysFromActive(getActiveStages(config)), ...)
 */
export function stageKeysFromActive(activeStages) {
  return (activeStages || []).map(function(s) { return s.key; });
}
