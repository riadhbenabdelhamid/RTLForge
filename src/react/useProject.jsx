// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// react/useProject — Thin React hook binding the modular core to React state
//
// This hook is the connective tissue between the modular core and any React
// UI that wants to consume it. It:
//
//   1. Owns a `useReducer(projectReducer, createInitialProjectState())` for
//      all transactional project state (modules, instances, ledger, phase,
//      integration, checkpoint, etc).
//   2. Owns React `useState` for ancillary UI state that doesn't need
//      reducer semantics (userDesc buffer, config, mode, designMode,
//      navigation — activeStage/viewingStage, treat-warnings-as-errors
//      flags, processing spinner).
//   3. Maintains a `stateRef` so async drivers always see the latest
//      reducer state without depending on stale closures.
//   4. Binds the three drivers (`runStage`, `runAllPipelines`,
//      `runIntegrationPipeline`) to (dispatch, stateRef, uiStateRef, services)
//      so callers see plain React-friendly methods like `p.runStage(4)`.
//   5. Wires a pluggable checkpoint layer with auto-save on
//      every successful stage and a `resumeFromCheckpoint` method for
//      loading from an index entry.
//   6. Exposes memoized derived values the UI commonly needs:
//      activeStages, isMultiModule, allModulesComplete, ledgerTotals, activeMod.
//
// What this hook DELIBERATELY does not own:
//
//   - Panel visibility (showSettings, showSidebar, showLedger, etc) — those
//     are trivially local state to the components that render them.
//   - Viewing flags (viewingIntegration, viewingSharedPkg, editingSharedPkg)
//     — again, component-local.
//   - The `runStageForModule` compat shim — callers can just call
//     `dispatch({ type: SET_ACTIVE_MOD, modId })` then `runStage(id)`.
//   - Full `handleLaunch` orchestration — callers compose it from
//     `launchSingleModule` or raw dispatch + drivers, because the
//     initial-module setup differs for single-module vs multi-module projects.
//   - `propagateChanges` — a later slice will extract that one separately.
//
// ─── Usage ──────────────────────────────────────────────────────────────────
//
//   import { useProject } from "./react/useProject.jsx";
//   import { callLLM, extractJSON, estimateCost } from "./llm/index.js";
//   import { promptSharedPackage } from "./prompts/index.js";
//
//   function RTLForgeApp() {
//     const p = useProject({
//       callLLM, extractJSON, estimateCost, promptSharedPackage,
//     });
//
//     return (
//       <div>
//         <input
//           value={p.userDesc}
//           onChange={(e) => p.setUserDesc(e.target.value)}
//         />
//         <button
//           disabled={p.processing}
//           onClick={() => p.launchSingleModule(p.userDesc)}
//         >
//           Launch
//         </button>
//         <ProgressBar progress={p.state.pipelineProgress} />
//         {p.activeMod && (
//           <StageView
//             stageData={p.activeMod.stageData[p.viewingStage]}
//             onRun={() => p.runStage(p.viewingStage)}
//             onAbort={p.abortCurrentStage}
//           />
//         )}
//         <LedgerPanel totals={p.ledgerTotals} entries={p.state.ledger} />
//       </div>
//     );
//   }
//
// ─── Note on import location ────────────────────────────────────────────────
// This file is at src/react/useProject.jsx because it imports React and
// is the first file in the modular core with a React dependency. It is
// NOT re-exported from the top-level src/index.js barrel, because doing
// so would force every non-React consumer (Node CLI, smoke tests, CI) to
// pull React as a peer dependency. Consumers who want this hook import
// it directly:
//   import { useProject } from "rtl-forge-v6/src/react/useProject.jsx";
// ═══════════════════════════════════════════════════════════════════════════

import { useReducer, useState, useRef, useMemo, useCallback, useEffect } from "react";

import {
  // Reducer + actions
  createInitialProjectState, projectReducer,
  MODULE_UPSERT, SET_ACTIVE_MOD, PROJECT_PHASE_SET, LOAD_STATE, RESET_PROJECT,

  // Pure state helpers
  blankModule, computeContentHash, computeIfaceHash,
  buildChildInterfaces, computeStageFrontier,
  getModuleOrder, computeEffectiveLevels,

  // Drivers
  runStage as runStageCore,
  runAllPipelines as runAllPipelinesCore,
  runIntegrationPipeline as runIntegrationPipelineCore,

  // Checkpoint
  serializeCheckpoint, deserializeCheckpoint, generateProjectId,
  createBrowserStorage, createCheckpointManager,

  // Pipeline factory
  buildPipeline,
  // Cross-run triage learning (session-scoped in the GUI)
  createInMemoryTriageMemory,
  // Cross-run "errors to avoid" catalog (session-scoped in the GUI)
  createInMemoryErrorMemory,

  // Stage navigation + constants
  getActiveStages, ALL_STAGES, nextStageId, stageIdsFrom,
} from "../index.js";

import {
  MiniZip, downloadZip, buildSVASource,
  generateMakefile, generateRunScript, generateReadme, downloadJSON,
  generateRequirementsYaml,
} from "../utils/export.js";
import { computeInterfaceSignature } from "../utils/hash.js";
import { createBrowserSkillBridge } from "../skills/browserBridge.js";
// Backend kill switch for abort. When the user clicks
// abort and a backend simulation/lint is currently running, this
// function POSTs to /api/abort so the actual CLI process dies.
// Without it, aborting only stops the fetch in the browser — the
// backend keeps running the long-lived process and the next call
// hits the busy backend.
import { abortBackendTask } from "../cli/runCli.js";

// ─── Defaults ──────────────────────────────────────────────────────────────

/** A sensible default config for users who don't supply one. */
export function defaultProjectConfig() {
  return {
    provider: "lmstudio",
    apiKey: "",
    // Default model is empty. User must explicitly pick a model in
    // Settings → LLM before any stage will run — baking in a default
    // here is misleading and could send requests with a stale identifier.
    model: "",
    temperature: 0.2,
    useGlobalLLM: true,
    stageSettings: {},
    // Per-stage model routing (constants/providers.js getStageConfig). Maps a
    // stage key to a specific LLM identity, honored at highest precedence:
    //   modelRouting: { test_generate: { provider: "openai", model: "gpt-4o" },
    //                   test_review:   { provider: "openai", model: "gpt-4o" } }
    // Empty by default. Use it to decorrelate the TB writer/reviewer from the
    // RTL writer, or to route cheap stages (triage/lint-estimation) to a
    // cheaper model. A routed stage to a new cloud provider needs its own
    // apiKey in the route (the global key is for the global provider).
    modelRouting: {},
    simPath: "/usr/local/bin/verilator",
    lintCmd: "verilator --lint-only -Wall {RTL}",
    // --assert makes Verilator actually evaluate SVA assertions at runtime;
    // without it, bound formal properties (see pipeline/svaBind.js) would
    // compile but silently never fire.
    simCmds: "verilator --binary --assert -Wall -j 0 {RTL} {TB} -o sim\n./obj_dir/sim",
    backendUrl: "http://localhost:3001",
    // Bind formal_props SVA into verify/judge simulation builds (svaBind.js).
    // Safe by construction: unbindable properties are filtered out, and a
    // checker that still breaks the compile triggers a retry without SVA.
    svaInSim: true,
    // Run-budget ceilings (pipeline/budget.js). null = unlimited. When set,
    // runStage refuses to start a stage past the ceiling and fix loops stop
    // gracefully mid-stage, keeping the best-known state. Cost is estimated
    // from llm/cost.js rates; local providers cost $0, so use maxRunTokens
    // to bound local runs.
    maxRunTokens: null,
    maxRunCostUsd: null,
    // Mutation gate (pipeline/mutation.js): after a real-CLI verify PASS,
    // inject small bugs into the RTL and require the TB to catch them.
    // Off by default — each mutant costs one full compile+sim. Pair with
    // the mutation_score eval criterion to make TB strength a hard gate.
    mutationTesting: false,
    mutationMaxMutants: 5,
    // Coverage strengthening (pipeline/coverageStrengthen.js): after a real-CLI
    // verify PASS, ADD targeted tests for weak coverage kinds + uncovered
    // requirements, adopting only if it provably helps. Off by default — each
    // round costs one LLM call + a compile+sim. Thresholds come from the
    // enabled coverage eval criteria.
    coverageStrengthening: false,
    coverageStrengthenRounds: 2,
    // Errors-to-avoid (pipeline/errorsToAvoid.js): harvest recurring lint errors
    // across runs and inject the top ones into cold RTL/TB generation. Off by
    // default; the catalog is session-scoped in the GUI, a JSON file in the CLI.
    errorsToAvoid: false,
    // Full-auto only: run dependency-independent modules concurrently in
    // waves (runAllPipelines.js). Opt-in: parallel waves multiply concurrent
    // LLM + Verilator load, and /api/abort only kills the latest backend
    // task, so aborting a wave can leave sibling sims running.
    parallelModules: false,
    maxLintIters: 3,
    maxVerifyIters: 3,
    maxJudgeIters: 3,
    maxRtlReviewIters: 2,
    maxTestReviewIters: 2,
    simTimeoutCycles: 100000,
    enableCoverage: false,
    libraryPath: "",
    settingsDir: "",
    optionalStages: { formal_props: true, lint: true, lint_test: false },
    // CLI robustness defaults
    strictCli: true,            // when backendUrl is set, fail loudly instead of falling back to LLM
    cliRetryCount: 1,           // retry transient backend errors this many times before giving up
    // Truncation recovery (llm/callLLM.js): when a provider reports the
    // output was cut by the token cap (stop_reason max_tokens / length),
    // the call is auto-retried with a doubled cap instead of failing the
    // stage with "TRUNCATED OUTPUT". Ceiling bounds the escalation.
    truncationRetries: 2,
    maxTokensCeiling: 16384,
    backendTimeoutSec: 600,     // browser-side fetch timeout for /api/execute (default 10 min)
    // Judge-specific strict mode for re-verify. Default OFF. When ON,
    // judge throws if the CLI backend is unavailable instead of silently
    // estimating sim results via LLM.
    // The CLI backend is ATTEMPTED FIRST regardless of this flag when
    // a backendUrl + simCmds are configured; the flag only governs
    // what happens when CLI is missing or errors.
    strictJudgeCli: false,
    // Judge K-to-X reflow.
    //
    // When judge's eval gate FAILs and picks a triage target K, the
    // judge stage now re-runs the entire downstream pipeline tail
    // from K back through judge — not just the single regen step.
    // Example: triage picks test_generate → re-run sequence becomes
    //   test_generate → test_review (if enabled) → lint_test (if
    //   enabled) → verify → judge. This is "K-to-X reflow".
    //
    // judgeReflowMode controls how aggressively the reflow re-runs
    // intermediate stages:
    //
    //   "smart"  (default) — re-run only stages the triage target
    //                        affects: dependent stages whose inputs
    //                        changed. Stages whose inputs are
    //                        unchanged and that already passed are
    //                        skipped. Conservative and fast.
    //   "strict"           — re-run every downstream stage from K
    //                        through judge regardless. Slower but
    //                        guarantees no stale artifacts.
    //
    // Per-stage iteration limits RESET each time judge re-enters a
    // stage (i.e. lint gets its full maxLintIters at every judge
    // iteration). Power users can clamp those nested resets to a
    // smaller limit via nestedLintIters / nestedVerifyIters; when
    // null the base limit is used.
    judgeReflowMode:   "smart",
    nestedLintIters:   null,
    nestedVerifyIters: null,

    // Each loopback-capable stage gets its OWN reflow mode setting.
    // When that stage's internal loop decides it needs
    // a regenerated artifact, this mode controls how the K-to-X chain
    // is computed:
    //
    //   "smart"  (default) — skip downstream stages that previously
    //                        passed and have no upstream changes
    //   "strict"           — re-run every stage in the tail
    //
    // The tail itself is fixed per stage (see STAGE_REFLOW_SCOPE in
    // src/constants/stages.js):
    //   lint        → rtl_generate → rtl_review → lint
    //   lint_test   → test_generate → test_review → lint_test
    //   rtl_review  → rtl_generate → rtl_review
    //   test_review → test_generate → test_review
    //   verify      → rtl_generate → ... → verify (broad)
    //
    // Per-stage iteration limits (maxLintIters, maxVerifyIters) RESET
    // each time that stage is re-entered as part of a parent chain.
    // The same map applies at every nesting depth (judge→verify→lint
    // gives lint its full maxLintIters; lint inside that gives an
    // inner lint its full maxLintIters again). Recursion is bounded
    // by the product of all per-stage iter limits.
    lintReflowMode:        "smart",
    lintTestReflowMode:    "smart",
    rtlReviewReflowMode:   "smart",
    testReviewReflowMode:  "smart",
    verifyReflowMode:      "smart",
  };
}

// ─── The hook ──────────────────────────────────────────────────────────────

/**
 * Bind the modular RTL Forge core to a React component tree.
 *
 * @param {object} [opts]
 * @param {function} [opts.callLLM]              - LLM transport, required if you
 *                                                 want runAllPipelines' shared-package
 *                                                 generation or runIntegrationPipeline to work
 * @param {function} [opts.extractJSON]          - JSON extractor for LLM responses
 * @param {function} [opts.estimateCost]         - Cost estimator (tIn, tOut, provider) → number
 * @param {function} [opts.promptSharedPackage]  - Prompt builder for shared-package LLM call
 * @param {object}   [opts.storage]              - Override the storage adapter (default: createBrowserStorage)
 * @param {number}   [opts.maxCheckpoints=3]     - Checkpoint capacity
 * @param {object}   [opts.initialConfig]        - Override the initial config (default: defaultProjectConfig())
 * @param {object}   [opts.logger]               - Logger with info/warn/error methods (default: console)
 * @param {function} [opts.onAbort]              - Called when abortCurrentStage fires
 * @returns {object} see the return block at the end of the hook for the full API
 */

/**
 * Emit a deterministic run_summary for the active module after a full-auto /
 * batch run (Slice C of #21). No LLM, no network — it runs the eval gate over
 * the finished stageData and folds in token cost, then writes one localStorage
 * row the Trends panel reads. Best-effort and fully guarded; never throws into
 * the run loop. Opt out via config.trackRunSummaries === false.
 */
async function emitRunSummaryGUI(state, config, estimateCost) {
  try {
    if (!state || !config || config.trackRunSummaries === false) return;
    const modId = state.activeModId;
    const mod = state.modules && state.modules[modId];
    const sd = (mod && mod.stageData) || {};
    const [trends, gate, crit, bo] = await Promise.all([
      import("../observer/trends.js"),
      import("../eval/gate.js"),
      import("../eval/criteria.js"),
      import("../observer/browserObserver.js"),
    ]);
    const verdict = gate.runEvalGate(
      trends.synthStateFromStageData(sd),
      crit.normalizeEvalConfig(config.evalCriteria || {}).config,
    );
    const summary = trends.summarizeRun({
      stageData: sd, verdict: verdict, estimateCost: estimateCost,
      provider: config.provider, model: config.model, ts: Date.now(),
    });
    bo.recordRunSummaryBrowser(summary, {
      config: config, projectId: state.projectId || null, moduleId: modId,
    });
  } catch (_e) { /* best-effort */ }
}

export function useProject(opts = {}) {

  // ── 1. Reducer state ─────────────────────────────────────────────────────
  const [state, dispatch] = useReducer(
    projectReducer, undefined, createInitialProjectState,
  );

  // stateRef lets async drivers read the latest state mid-flight: they
  // can't rely on the closed-over `state` because React batches updates.
  // Each render syncs the ref, so drivers always see the freshest snapshot.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  /**
   * Dispatch an action AND immediately apply it to stateRef so that any
   * async code called in the same tick (before the next React render)
   * sees the updated state. This solves the "dispatch then runStage in
   * the same handler" timing issue.
   */
  function dispatchSync(action) {
    dispatch(action);
    stateRef.current = projectReducer(stateRef.current, action);
  }

  // ── 2. UI-side useState (things that don't need reducer semantics) ────────
  const [userDesc, setUserDesc]         = useState("");
  const [activeStage, setActiveStage]   = useState(0);
  const [viewingStage, setViewingStage] = useState(0);
  const [processing, setProcessing]     = useState(false);
  // Tracks which upstream stage is currently being looped back to AND in
  // which module, so that in system mode (multi-module) a loopback in
  // module B doesn't pulse a completed step in module A's tab strip.
  //
  //   loopback = { modId: <id>, stageId: <id> }   when active
  //   loopback = null                             otherwise
  //
  // We also expose loopbackStageId as a derived plain-number convenience
  // so single-module callsites that read it from useProject's return value
  // keep working unchanged. The animation gate consults
  // `loopback.modId === activeModId` so cross-module signals don't pulse
  // the wrong tab.
  const [loopback, setLoopback]         = useState(null);
  // setLoopbackStageId(stageId, modId?) wraps the setter to also capture the
  // modId so the UI animation can scope to the active module. Pipeline nodes
  // still call _onLoopback(stageId); runStage carries modId through and
  // forwards both to this setter.
  const setLoopbackStageId = useCallback(function setLoopbackStageId(stageId, modId) {
    if (stageId == null) {
      setLoopback(null);
      return;
    }
    setLoopback({
      stageId: stageId,
      // Default to the currently-active mod if the caller didn't pass one
      // (defensive for any future caller that hasn't been updated yet).
      modId: modId || (stateRef.current && stateRef.current.activeModId) || null,
    });
  }, []);
  const loopbackStageId = loopback ? loopback.stageId : null;
  const loopbackModId   = loopback ? loopback.modId   : null;

  // Multi-stage reflow signal.
  //
  // While a K-to-X reflow chain is in flight, the runner publishes the
  // FULL set of stage IDs that are active in the chain (regen target,
  // all downstream re-runs, and the owner stage itself). The UI uses
  // this set to fast-blink every active stage simultaneously — not just
  // a single "target" the way loopbackStageId does.
  //
  // Shape: { stageIds: Set<number>, modId: string|null }  when active
  //        null                                            otherwise
  //
  // Module-scoping: the runStage wrapper stamps modId onto every call,
  // so a reflow in module A doesn't pulse module B's tabs.
  const [reflowSignal, setReflowSignal] = useState(null);
  const setReflowStageIds = useCallback(function setReflowStageIds(stageIds, modId) {
    if (!stageIds || (Array.isArray(stageIds) && stageIds.length === 0)) {
      setReflowSignal(null);
      return;
    }
    setReflowSignal({
      stageIds: new Set(stageIds),
      modId: modId || (stateRef.current && stateRef.current.activeModId) || null,
    });
  }, []);
  // Convenience derived values for consumers.
  const reflowStageIds = reflowSignal ? reflowSignal.stageIds : null;
  const reflowModId    = reflowSignal ? reflowSignal.modId    : null;

  // Per-stage run selection.
  //
  // Each stage has a `stageRuns[stageId]` array in module state (managed
  // by the reducer). When a stage runs multiple times — original + N
  // reflow re-runs at various nesting depths — every run gets recorded
  // there with its result snapshot and context (depth, parentStageKey,
  // parentIter).
  //
  // The dropdown UI lets the user pick which run's result to display.
  // The trace panel's chain-entry click ALSO writes here (same state =
  // both surfaces in sync, per the user's "both" answer).
  //
  // Shape: { [stageId]: runId }
  // Missing key = "show the latest run" (default).
  // When set, the stage panel reads stageRuns[stageId].find(r => r.runId === selectedRun[stageId])
  // and renders its .result snapshot instead of stageData[stageId].
  //
  // Module-scoped via the outer keying: each module has its own
  // selectedRun map. We don't mirror state across modules; if the user
  // switches modules, the previous module's selection is preserved when
  // they return.
  const [selectedRunByMod, setSelectedRunByMod] = useState({});
  const setSelectedRun = useCallback(function setSelectedRun(stageId, runId, modId) {
    setSelectedRunByMod(function(prev) {
      const m = modId || (stateRef.current && stateRef.current.activeModId) || "_default";
      const modSel = Object.assign({}, prev[m] || {});
      if (runId == null) {
        delete modSel[stageId];
      } else {
        modSel[stageId] = runId;
      }
      return Object.assign({}, prev, { [m]: modSel });
    });
  }, []);
  const clearSelectedRuns = useCallback(function clearSelectedRuns(modId) {
    setSelectedRunByMod(function(prev) {
      const m = modId || (stateRef.current && stateRef.current.activeModId) || "_default";
      if (!prev[m]) return prev;
      return Object.assign({}, prev, { [m]: {} });
    });
  }, []);

  // Live progress display.
  //
  // While a stage is running, its node fires events through the stage
  // logger (st._logger.cli, .llm, .skill, .prompt, .state). We plumb the
  // logger through runStage's services.onProgress so every event lands
  // in `liveProgress[stageId].events` while the
  // stage is still running. The stage panel uses this to render a
  // real-time "currently doing X..." display that auto-collapses to
  // a sidebar once the final result arrives.
  //
  // Coalescing: LLM streaming can fire 100+ events/sec, which would
  // thrash React if each one triggered a re-render. We buffer into
  // a ref and flush via requestAnimationFrame — at most one render
  // per frame regardless of event rate. Frame coalescing also keeps
  // the latest event visible even when the buffer is busy.
  //
  // Shape: { [stageId]: { events: Array, startedAtMs, lastUpdatedMs,
  //                       modId, llmCount, cliCount } }
  // When a stage completes, useProject leaves the entry intact so the
  // collapsed sidebar can still show "ran N events / M ms" — the UI
  // can also choose to clear it from outside.
  const [liveProgress, setLiveProgress]   = useState({});
  const liveProgressBufRef = useRef({});  // { [stageId]: { events: [...], modId } }
  const liveProgressFlushScheduledRef = useRef(false);
  const flushLiveProgress = useCallback(function flushLiveProgress() {
    liveProgressFlushScheduledRef.current = false;
    const buf = liveProgressBufRef.current;
    if (!buf || Object.keys(buf).length === 0) return;
    liveProgressBufRef.current = {};
    setLiveProgress(function(prev) {
      const next = Object.assign({}, prev);
      for (const sidStr of Object.keys(buf)) {
        const sid = Number(sidStr);
        const incoming = buf[sidStr];
        const existing = next[sid] || {
          events: [], startedAtMs: incoming.startedAtMs, lastUpdatedMs: incoming.startedAtMs,
          modId: incoming.modId, llmCount: 0, cliCount: 0,
        };
        // Append events; cap at 500 to bound memory if a stage runs forever
        const mergedEvents = existing.events.concat(incoming.events);
        const capped = mergedEvents.length > 500 ? mergedEvents.slice(-500) : mergedEvents;
        const llmCount = capped.filter(function(e) { return e.type === "llm"; }).length;
        const cliCount = capped.filter(function(e) { return e.type === "cli"; }).length;
        next[sid] = {
          events: capped,
          startedAtMs: existing.startedAtMs,
          lastUpdatedMs: incoming.lastUpdatedMs,
          modId: existing.modId || incoming.modId,
          llmCount: llmCount,
          cliCount: cliCount,
        };
      }
      return next;
    });
  }, []);
  const pushLiveProgress = useCallback(function pushLiveProgress(stageId, event, modId) {
    if (!stageId) return;
    const buf = liveProgressBufRef.current;
    const slot = buf[stageId] = buf[stageId] || {
      events: [], modId: modId || null,
      startedAtMs: event.ts || Date.now(),
      lastUpdatedMs: event.ts || Date.now(),
    };
    slot.events.push(event);
    slot.lastUpdatedMs = event.ts || Date.now();
    if (!liveProgressFlushScheduledRef.current) {
      liveProgressFlushScheduledRef.current = true;
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(flushLiveProgress);
      } else {
        setTimeout(flushLiveProgress, 16);
      }
    }
  }, [flushLiveProgress]);
  const clearLiveProgress = useCallback(function clearLiveProgress(stageId) {
    setLiveProgress(function(prev) {
      if (stageId == null) return {};
      if (!prev[stageId]) return prev;
      const next = Object.assign({}, prev);
      delete next[stageId];
      return next;
    });
  }, []);
  const [mode, setMode]                 = useState("semi-auto"); // "semi-auto" | "full-auto"
  const [designMode, setDesignMode]     = useState("module");    // "module" | "system"
  const [config, setConfig] = useState(() => {
    // Try to restore settings from localStorage
    if (typeof window !== "undefined" && window.localStorage) {
      try {
        const saved = window.localStorage.getItem("rtlforge:settings");
        if (saved) {
          const parsed = JSON.parse(saved);
          // Merge with defaults so new fields get their defaults
          return Object.assign({}, defaultProjectConfig(), parsed);
        }
      } catch (_) {}
    }
    return opts.initialConfig || defaultProjectConfig();
  });

  // Persist config to localStorage whenever it changes
  useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      try {
        // Don't persist apiKey for security
        const toSave = Object.assign({}, config);
        delete toSave.apiKey;
        window.localStorage.setItem("rtlforge:settings", JSON.stringify(toSave));
      } catch (_) {}
    }
  }, [config]);
  const [lintWarningsAsErrors,   setLintWarningsAsErrors]   = useState(false);
  const [verifyWarningsAsErrors, setVerifyWarningsAsErrors] = useState(false);
  const [projectId, setProjectId]       = useState(null);

  // ── 2b. Additional UI state ───────────────────────────────
  // These live in the hook so handlers can read/set them and the return
  // object can expose them.
  const [propagating, setPropagating]                 = useState(false);
  const [showSettings, setShowSettings]               = useState(false);
  const [showLedger, setShowLedger]                   = useState(false);
  const [showDebug, setShowDebug]                     = useState({}); // per-stage: { [stageId]: boolean }
  const [showSidebar, setShowSidebar]                 = useState(true);
  const [sidebarSearch, setSidebarSearch]             = useState("");
  const [sidebarTab, setSidebarTab]                   = useState("level"); // "level" | "instance"
  const [viewingSharedPkg, setViewingSharedPkg]       = useState(false);
  const [editingSharedPkg, setEditingSharedPkg]       = useState(false);
  const [viewingIntegration, setViewingIntegration]   = useState(false);
  const [activeIntStage, setActiveIntStage]           = useState(null);
  const [activeRunTab, setActiveRunTab]               = useState(null);
  const [backendVerified, setBackendVerified]         = useState(null);
  const [staleModules, setStaleModules]               = useState({});
  const [importedPackages, setImportedPackages]       = useState({});
  const [libraryMatches, setLibraryMatches]           = useState([]);
  const [importDialog, setImportDialog]               = useState(null);
  const [manualImportDialog, setManualImportDialog]   = useState(null);
  const [manualImportText, setManualImportText]       = useState("");
  const [pendingResume, setPendingResume]              = useState(null);
  const [checkpointIndex, setCheckpointIndex]         = useState([]);
  const [lastCheckpointTs, setLastCheckpointTs]       = useState(null);
  const [saveFlash, setSaveFlash]                     = useState(null);
  // Surface a clear notice when checkpoint restore happens with
  // no apiKey in the current session. Without this notice the user just
  // sees their next LLM call fail with no obvious connection to the
  // restore action.
  const [apiKeyClearedNotice, setApiKeyClearedNotice] = useState(false);

  // Refs for browser elements (import file inputs)
  const importFileRef       = useRef(null);
  const manualImportFileRef = useRef(null);
  const checkpointSavingRef = useRef(false);

  // ── 3. Singleton refs ────────────────────────────────────────────────────
  // Pipeline is built once per hook instance. buildPipeline wires all 11
  // nodes into a StateGraph — we don't want to rebuild it on every render.
  const pipelineRef = useRef(null);
  if (!pipelineRef.current) pipelineRef.current = buildPipeline();
  const pipeline = pipelineRef.current;

  // Session-scoped triage memory: judge records each triage outcome here and
  // consults it before the next decision, so cross-MODULE learning works
  // within a session. (Persisting across sessions via localStorage is a
  // follow-up; the CLI already persists to a JSON file.)
  const triageMemoryRef = useRef(null);
  if (!triageMemoryRef.current) triageMemoryRef.current = createInMemoryTriageMemory();
  const errorMemoryRef = useRef(null);
  if (!errorMemoryRef.current) errorMemoryRef.current = createInMemoryErrorMemory();

  // Abort handle for the currently running stage. Reset to null when no
  // stage is running.
  const abortControllerRef = useRef(null);

  // Refs the abort handler reads. We use refs (not state)
  // so abortCurrentStage doesn't need to re-create itself when these
  // change. configRef gives us the latest backendUrl for kill-the-
  // backend-task; processingRef lets the deadline poller stop early
  // once natural unwind has happened. The actual mirror-into-refs
  // happens below, after the state values are declared.
  const configRef = useRef(null);
  const processingRef = useRef(false);

  // Integration pipeline idempotency: if no module contentHash has changed
  // since the last run, runIntegrationPipeline returns a skipped result.
  // This ref carries the snapshot across renders.
  const lastIntegrationHashesRef = useRef({});

  // ── 4. Storage + checkpoint manager ───────────────────────────
  const storage = useMemo(
    () => opts.storage || createBrowserStorage(),
    [opts.storage],
  );
  const checkpointManager = useMemo(
    () => createCheckpointManager(storage, {
      allStages: ALL_STAGES,
      maxCheckpoints: opts.maxCheckpoints || 3,
    }),
    [storage, opts.maxCheckpoints],
  );

  // ── 5. Memoized derived values ───────────────────────────────────────────
  const activeStages = useMemo(() => getActiveStages(config), [config]);

  const isMultiModule = useMemo(
    () => Object.keys(state.modules).length > 1,
    [state.modules],
  );

  const allModulesComplete = useMemo(() => {
    const ids = Object.keys(state.modules);
    if (ids.length === 0) return false;
    return ids.every((mId) => {
      const mod = state.modules[mId];
      if (!mod || !mod.completed) return false;
      return activeStages.every((s) => mod.completed.has(s.id));
    });
  }, [state.modules, activeStages]);

  const ledgerTotals = useMemo(() => {
    return state.ledger.reduce(
      (a, e) => ({
        tIn:  a.tIn  + (e.tIn  || e.tokensIn  || 0),
        tOut: a.tOut + (e.tOut || e.tokensOut || 0),
        cost: a.cost + (e.cost || 0),
      }),
      { tIn: 0, tOut: 0, cost: 0 },
    );
  }, [state.ledger]);

  // Per-active-module derivation (most UI reads from here)
  const activeMod = useMemo(
    () => (state.activeModId && state.modules[state.activeModId]) || blankModule(),
    [state.activeModId, state.modules],
  );

  // ── 5b. Derived shortcuts ─────────────
  // These live in the reducer state, but RTLForge destructures them from
  // useProject's return value — so we expose them flat here.
  const modules         = state.modules;
  const instances       = state.instances;
  const projectPhase    = state.projectPhase;
  const decomposition   = state.decomposition;
  const decompError     = state.decompError;
  const ledger          = state.ledger;
  const integrationState = state.integrationState;
  const sharedPackage   = state.sharedPackage;
  const pipelineProgress = state.pipelineProgress;
  const activeModId     = state.activeModId;

  // Per-module shortcuts
  const stageData      = activeMod.stageData || {};
  const stageErrors    = activeMod.stageErrors || {};
  const completed      = activeMod.completed || new Set();
  const stageRuns      = activeMod.stageRuns || {};
  const executionPath  = activeMod.executionPath || [];
  const modName        = (stageData[1] && stageData[1].modName) || state.activeModId || "_init";
  const LAST_STAGE     = activeStages.length > 0 ? activeStages[activeStages.length - 1].id : 9;

  // Ledger totals alias
  const totals = ledgerTotals;

  // ── 5c. Dispatch wrappers for reducer state setters ──────────────────────
  // setModules/setActiveModId/etc map to dispatch calls. The wrappers match
  // the same call signature as plain useState setters.
  const setActiveModId = useCallback((id) => {
    dispatch({ type: SET_ACTIVE_MOD, modId: typeof id === "function" ? id(state.activeModId) : id });
  }, [state.activeModId]);

  const setProjectPhase = useCallback((phase) => {
    dispatch({ type: PROJECT_PHASE_SET, phase: typeof phase === "function" ? phase(state.projectPhase) : phase });
  }, [state.projectPhase]);

  const setModules = useCallback((fnOrVal) => {
    // setModules takes either a function (prev => next) or a value.
    // We translate to bulk reducer operations. This is used by handleLaunch,
    // confirmDecomp, and the library import handlers.
    if (typeof fnOrVal === "function") {
      const next = fnOrVal(stateRef.current.modules);
      // Upsert each module; remove any that disappeared
      const prevIds = Object.keys(stateRef.current.modules);
      const nextIds = Object.keys(next);
      nextIds.forEach((id) => {
        dispatch({ type: MODULE_UPSERT, modId: id, mod: next[id] });
      });
      prevIds.forEach((id) => {
        if (!next[id]) dispatch({ type: "MODULE_REMOVE", modId: id });
      });
    } else {
      // Value: clear all, then upsert each
      const prevIds = Object.keys(stateRef.current.modules);
      const nextIds = Object.keys(fnOrVal || {});
      prevIds.forEach((id) => {
        if (!fnOrVal || !fnOrVal[id]) dispatch({ type: "MODULE_REMOVE", modId: id });
      });
      nextIds.forEach((id) => {
        dispatch({ type: MODULE_UPSERT, modId: id, mod: fnOrVal[id] });
      });
    }
  }, []);

  const setInstances = useCallback((fnOrVal) => {
    const next = typeof fnOrVal === "function" ? fnOrVal(stateRef.current.instances) : fnOrVal;
    dispatch({ type: "INSTANCES_SET", instances: next || {} });
  }, []);

  const setDecomposition = useCallback((val) => {
    dispatch({ type: "DECOMPOSITION_SET", decomposition: val });
  }, []);

  const setDecompError = useCallback((val) => {
    dispatch({ type: "DECOMPOSITION_ERROR_SET", error: val });
  }, []);

  const setSharedPackage = useCallback((val) => {
    dispatch({ type: "SHARED_PACKAGE_SET", sharedPackage: val });
  }, []);

  // ── 5d. Module helper shortcuts ──────────────────────────────────────────
  const getModule = useCallback((modId) => stateRef.current.modules[modId] || null, []);

  const updateModule = useCallback((modId, updater) => {
    const cur = stateRef.current.modules[modId];
    if (!cur) return;
    const next = typeof updater === "function" ? updater(cur) : updater;
    dispatchSync({ type: MODULE_UPSERT, modId, mod: next });
  }, []);

  /** Write stage data for the active module. Uses dispatchSync so that
   *  back-to-back calls in the same event handler (e.g. ElicitStage's
   *  set("answers") + set("customAnswers"), or SpecStage's updateReq +
   *  markEdited) each see the result of the previous call. */
  const updateSD = useCallback((stageId, val) => {
    const mid = stateRef.current.activeModId;
    if (!mid) return;
    const mod = stateRef.current.modules[mid] || {};
    const curStageData = (mod.stageData || {})[stageId] || {};
    const newData = typeof val === "function" ? val(curStageData) : val;
    dispatchSync({ type: "MODULE_STAGE_DATA_SET", modId: mid, stageId, data: newData });
  }, []);

  /**
   * Mark subsequent stages as stale after a manual edit to a completed stage.
   * The NEXT stage after stageId becomes "stale" (orange, still reachable for
   * re-run). All stages BEYOND that become unreachable (removed from completed).
   *
   * This is NOT called for automated loop-back modifications (lint/verify
   * fixing prior steps) — those go through runStageCore's dispatch, not
   * through the UI's setSD wrapper.
   */
  const markStaleFrom = useCallback((editedStageId) => {
    const mid = stateRef.current.activeModId;
    if (!mid) return;
    const mod = stateRef.current.modules[mid];
    if (!mod || !mod.completed || !mod.completed.has(editedStageId)) return;

    // Find which stages come AFTER editedStageId in the active order
    const idx = activeStages.findIndex((s) => s.id === editedStageId);
    if (idx < 0 || idx >= activeStages.length - 1) return;

    const nextStage = activeStages[idx + 1];
    const beyondStages = activeStages.slice(idx + 2);

    // Mark the next stage as stale
    setStaleModules((prev) => {
      const n = Object.assign({}, prev);
      n[mid + ":" + nextStage.id] = true;
      return n;
    });

    // Remove completion for all stages beyond the stale one
    const newCompleted = new Set(mod.completed);
    beyondStages.forEach((s) => newCompleted.delete(s.id));
    if (newCompleted.size !== mod.completed.size) {
      updateModule(mid, (m) => Object.assign({}, m, { completed: newCompleted }));
    }

    // Reset activeStage to the stale stage so the user lands there
    setActiveStage(nextStage.id);
  }, [activeStages, updateModule]);

  /** Append a ledger entry. */
  const addLedger = useCallback((stage, r) => {
    dispatch({
      type: "LEDGER_APPEND",
      entry: {
        ts: Date.now(),
        stage,
        provider: r.provider || config.provider,
        model: r.model || config.model,
        tIn: r.tokensIn || 0,
        tOut: r.tokensOut || 0,
        cost: (typeof opts.estimateCost === "function")
          ? opts.estimateCost(r.tokensIn || 0, r.tokensOut || 0, r.provider || config.provider)
          : 0,
        latencyMs: r.latencyMs || 0,
      },
    });
  }, [config.provider, config.model, opts.estimateCost]);

  /**
   * Switch the active module and set the viewing/active stage cursors
   * to sensible defaults for the new module.
   */
  const switchModule = useCallback((modId) => {
    const cur = stateRef.current;
    if (!cur.modules[modId]) return;
    dispatch({ type: SET_ACTIVE_MOD, modId });
    const mod = cur.modules[modId] || blankModule();
    const frontier = computeStageFrontier(mod.completed, activeStages);
    setActiveStage(frontier);
    // viewingStage = last completed stage (so user lands on a "done" view),
    // or the frontier if nothing is completed yet
    let highest = 0;
    mod.completed.forEach((id) => { if (id > highest) highest = id; });
    setViewingStage(highest > 0 ? highest : frontier);
  }, [activeStages]);

  /** Build child interfaces from the current state. */
  const buildChildInterfacesLocal = useCallback((parentModId) => {
    return buildChildInterfaces(
      parentModId,
      stateRef.current.modules,
      stateRef.current.instances,
    );
  }, []);

  /** Per-module progress summary. */
  const moduleProgress = useCallback((modId) => {
    const mod = stateRef.current.modules[modId];
    if (!mod) return { total: 0, complete: 0, errors: 0, pct: 0 };
    const total = activeStages.length;
    if (total === 0) return { total: 0, complete: 0, errors: 0, pct: 0 };
    let complete = 0;
    let errors = 0;
    activeStages.forEach((s) => {
      if (mod.completed && mod.completed.has(s.id)) complete++;
      if (mod.stageErrors && mod.stageErrors[s.id]) errors++;
    });
    return { total, complete, errors, pct: total > 0 ? Math.round((complete / total) * 100) : 0 };
  }, [activeStages]);

  /** Aggregate progress across ALL modules (for sidebar summary). */
  const moduleProgressSummary = useMemo(() => {
    const modIds = Object.keys(state.modules);
    const total = modIds.length;
    if (total === 0) return { total: 0, complete: 0, errors: 0, pct: 0 };
    let complete = 0;
    let errors = 0;
    modIds.forEach((mId) => {
      const mod = state.modules[mId];
      if (mod && mod.completed && mod.completed.size >= activeStages.length) complete++;
      if (mod && mod.stageErrors) {
        Object.values(mod.stageErrors).forEach((e) => { if (e) errors++; });
      }
    });
    return { total, complete, errors, pct: total > 0 ? Math.round((complete / total) * 100) : 0 };
  }, [state.modules, activeStages]);

  /** Stage navigation helpers (backward compat aliases). */
  const nextStageIdFn = useCallback((currentId) => nextStageId(activeStages, currentId), [activeStages]);
  const stageIdsFromFn = useCallback((fromId) => stageIdsFrom(activeStages, fromId), [activeStages]);
  const isStageActive = useCallback((id) => activeStages.some((s) => s.id === id), [activeStages]);

  // ── 6. uiStateRef — fresh snapshot of UI state for the drivers ───────────
  // The drivers need uiState to include userDesc/mode/designMode/config/etc.
  // We keep a ref that's resynced on every render so drivers always see the
  // latest without being recreated when any of those change.
  const uiStateRef = useRef({});
  uiStateRef.current = {
    userDesc, mode, designMode, config,
    lintWarningsAsErrors, verifyWarningsAsErrors,
    projectId,
    activeStages,
  };

  // ── 7. Checkpoint save/delete actions ────────────────────────────────────
  const saveCheckpointNow = useCallback(async () => {
    if (checkpointSavingRef.current) return null;
    checkpointSavingRef.current = true;
    try {
      // Refuse to save a checkpoint that has no meaningful state. Otherwise
      // the autosave path could fire with an empty userDesc AND empty
      // modules — producing an "Unnamed" entry in the checkpoint list with
      // no recoverable data. We require either a non-empty userDesc OR at
      // least one started module before we'll persist.
      const uiSt = uiStateRef.current || {};
      const rSt  = stateRef.current  || {};
      const hasDesc    = !!(uiSt.userDesc && uiSt.userDesc.trim().length > 0);
      const hasModules = rSt.modules && Object.keys(rSt.modules).some(function(k) {
        const m = rSt.modules[k];
        return m && ((m.completed && m.completed.size > 0) ||
          (m.stageData && Object.keys(m.stageData).length > 0));
      });
      if (!hasDesc && !hasModules) {
        (opts.logger || console).debug
          && (opts.logger || console).debug("[useProject] skipping checkpoint save: no userDesc or module data yet");
        return null;
      }
      // Ensure we have a projectId
      let pid = uiSt.projectId;
      if (!pid) {
        pid = generateProjectId(uiSt.userDesc || "untitled", uiSt.designMode || "module");
        setProjectId(pid);
        uiStateRef.current.projectId = pid;
      }
      const payload = serializeCheckpoint(stateRef.current, uiStateRef.current);
      payload.projectId = pid;
      await checkpointManager.save(pid, payload);
      setSaveFlash("ok");
      setLastCheckpointTs(new Date().toISOString());
      // Refresh checkpoint index
      try {
        const idx = await checkpointManager.listIndex();
        setCheckpointIndex(idx || []);
      } catch (_) {}
      setTimeout(() => setSaveFlash(null), 1500);
      return payload;
    } catch (e) {
      (opts.logger || console).warn("[useProject] checkpoint save failed:", (e && e.message) || e);
      setSaveFlash("fail");
      setTimeout(() => setSaveFlash(null), 2000);
      return null;
    } finally {
      checkpointSavingRef.current = false;
    }
  }, [checkpointManager, opts.logger]);

  const deleteCheckpointNow = useCallback(async () => {
    const pid = uiStateRef.current.projectId;
    if (!pid) return;
    try { await checkpointManager.remove(pid); }
    catch (e) { (opts.logger || console).warn("[useProject] checkpoint delete failed:", (e && e.message) || e); }
  }, [checkpointManager, opts.logger]);

  // ── 8. Services bag for drivers ──────────────────────────────────────────
  // Stable across renders — drivers always use getState() / uiStateRef.current
  // to read fresh state, so services itself only changes when the injected
  // callbacks change.
  const services = useMemo(() => {
    const bag = {
      getState: () => stateRef.current,
      pipeline,
      allStages: ALL_STAGES,
      computeContentHash,
      computeIfaceHash,
      estimateCost: opts.estimateCost,
      callLLM: opts.callLLM,
      extractJSON: opts.extractJSON,
      promptSharedPackage: opts.promptSharedPackage,
      saveCheckpoint: saveCheckpointNow,
      deleteCheckpoint: deleteCheckpointNow,
      triageMemory: triageMemoryRef.current,
      errorMemory: errorMemoryRef.current,
      logger: opts.logger || console,
      // Skill bridge for the GUI: applies config.promptOverrides as a
      // synthetic skill before each pipeline stage. Pipeline nodes that
      // opt in via applySkillsToPrompt() pick this up automatically.
      // The bridge is rebuilt lazily per stage call by reading the
      // current uiState.config — that way config edits in Settings take
      // effect on the very next stage run without needing to rebuild
      // services.
      skillBridge: {
        applyOverlay: function(prompt, stageKey) {
          const liveBridge = createBrowserSkillBridge({
            config: (uiStateRef.current && uiStateRef.current.config) || {},
            onWarning: function(msg) {
              if (opts.logger && typeof opts.logger.warn === "function") {
                opts.logger.warn("[skill] " + msg);
              } else if (typeof console !== "undefined") {
                console.warn("[skill] " + msg);
              }
            },
          });
          return liveBridge.applyOverlay(prompt, stageKey);
        },
      },
      // GUI-side stage observer. Since the browser
      // can't use better-sqlite3, the GUI observer instead writes to
      // localStorage under a `rtlforge:obs:<id>` key. Same LLM
      // extractor; different storage. The CLI's `rtlforge observe
      // import-browser` (future work) will merge these into the SQLite
      // DB if the user wants unified history. Opt-in via
      // config.observerEnabled.
      observer: function(ctx) {
        const cfg = (uiStateRef.current && uiStateRef.current.config) || {};
        if (cfg.observerEnabled !== true) return;
        // Lazy import the browser observer adapter so we don't pay the
        // module cost for disabled observers.
        import("../observer/browserObserver.js").then(function(m) {
          m.observeStageBrowser(ctx, {
            callLLM: opts.callLLM,
            extractJSON: opts.extractJSON,
            config: cfg,
          });
        }).catch(function(_e) { /* best-effort */ });
      },
    };
    // The full-auto orchestrator needs a runIntegrationPipeline it can call
    // after all modules complete. We bind it here with fresh state/uiState
    // on each invocation.
    bag.runIntegrationPipeline = async () => {
      const r = await runIntegrationPipelineCore({
        reducerState: stateRef.current,
        uiState: {
          ...uiStateRef.current,
          sharedPackage: stateRef.current.sharedPackage,
          instances:     stateRef.current.instances,
        },
        services: bag,
        dispatch: dispatchSync,
        lastHashes: lastIntegrationHashesRef.current,
      });
      if (r && r.currentHashes) {
        lastIntegrationHashesRef.current = r.currentHashes;
      }
      return r;
    };
    return bag;
  }, [
    pipeline, saveCheckpointNow, deleteCheckpointNow,
    opts.callLLM, opts.extractJSON, opts.estimateCost, opts.promptSharedPackage,
    opts.logger,
  ]);

  // ── 9. Action bindings ───────────────────────────────────────────────────

  /**
   * Run one stage against the currently active module.
   * @param {number} stageId
   * @param {string} [trigger="manual"]
   * @param {string} [overrideDesc] Overrides uiState.userDesc for this run only
   */
  const runStage = useCallback(async (stageId, trigger = "manual", overrideDesc) => {
    const stageMeta = ALL_STAGES.find((s) => s.id === stageId);
    if (!stageMeta) {
      (opts.logger || console).warn("[useProject] unknown stageId: " + stageId);
      return { ok: false, error: new Error("unknown stage " + stageId) };
    }
    const targetModId = stateRef.current.activeModId;
    if (!targetModId) {
      (opts.logger || console).warn("[useProject] no active module");
      return { ok: false, error: new Error("no active module") };
    }

    setProcessing(true);
    setActiveStage(stageId);
    setViewingStage(stageId);

    // Clear stale marking for this stage (it's being re-run)
    setStaleModules((prev) => {
      const key = targetModId + ":" + stageId;
      if (!prev[key]) return prev;
      const n = Object.assign({}, prev);
      delete n[key];
      return n;
    });

    const abortCtrl = new AbortController();
    abortControllerRef.current = abortCtrl;

    const childInterfaces = buildChildInterfaces(
      targetModId,
      stateRef.current.modules,
      stateRef.current.instances,
    );

    try {
      const result = await runStageCore({
        stageId,
        stageKey: stageMeta.key,
        trigger,
        overrideDesc,
        targetModId,
        reducerState: stateRef.current,
        uiState: {
          ...uiStateRef.current,
          sharedPackage: stateRef.current.sharedPackage,
          instances:     stateRef.current.instances,
        },
        services: {
          ...services,
          childInterfaces,
          signal: abortCtrl.signal,
          // Pipeline nodes call this when starting an internal fix targeting
          // an upstream stage; the UI uses loopbackStageId to render that
          // stage's badge with a brighter yellow at faster pulse cadence.
          onLoopback: setLoopbackStageId,
          // Multi-stage reflow signal.
          onReflowStages: setReflowStageIds,
          // Per-event progress hook.
          onProgress: pushLiveProgress,
        },
        dispatch: dispatchSync,
      });
      // Auto-checkpoint on successful stage completion
      if (result && result.ok) {
        try { await saveCheckpointNow(); } catch (_) {}
      }
      return result;
    } finally {
      if (abortControllerRef.current === abortCtrl) abortControllerRef.current = null;
      // Defensive — if the run threw mid-loopback, clear the visual signal
      // so the UI doesn't get stuck pulsing yellow forever.
      setLoopbackStageId(null);
      // Same belt-and-suspenders clear for the multi-stage reflow signal.
      setReflowStageIds([]);
      setProcessing(false);
    }
  }, [services, opts.logger]);

  /**
   * Drive every module through every active stage (full-auto) or run only
   * the first active stage on the first non-imported module (semi-auto).
   * @param {"full-auto"|"semi-auto"} execMode
   */
  const runAllPipelines = useCallback(async (execMode) => {
    setProcessing(true);
    const abortCtrl = new AbortController();
    abortControllerRef.current = abortCtrl;
    try {
      const result = await runAllPipelinesCore({
        execMode: execMode || mode,
        reducerState: stateRef.current,
        uiState: uiStateRef.current,
        services: {
          ...services,
          signal: abortCtrl.signal,
          onLoopback: setLoopbackStageId,
          // Multi-stage reflow signal.
          onReflowStages: setReflowStageIds,
          // Per-event progress hook.
          onProgress: pushLiveProgress,
        },
        dispatch: dispatchSync,
      });
      // Record a deterministic run_summary for the active module (Slice C of
      // #21) so the Trends panel can chart cost + gate-PASS rate. Fire-and-
      // forget: best-effort, never blocks or fails the run. Opt out via
      // config.trackRunSummaries === false.
      emitRunSummaryGUI(stateRef.current, configRef.current, opts.estimateCost);
      return result;
    } finally {
      if (abortControllerRef.current === abortCtrl) abortControllerRef.current = null;
      setLoopbackStageId(null);
      // Clear any active reflow signal too. If a chain
      // was in flight when the run was aborted, the runner's normal
      // exit-clear won't fire. This belt-and-suspenders clear keeps the
      // UI from leaving stages stuck in fast-blink after a hard abort.
      setReflowStageIds([]);
      setProcessing(false);
    }
  }, [services, mode]);

  /**
   * Run the integration pipeline (int_lint → int_test → int_judge) for
   * multi-module systems. Idempotent — returns early with `skipped: true`
   * if no module contentHash has changed since the last call.
   */
  const runIntegrationPipeline = useCallback(async () => {
    setProcessing(true);
    try {
      return await services.runIntegrationPipeline();
    } finally {
      setProcessing(false);
    }
  }, [services]);

  /** Run a stage for a specific module (sets activeModId first). */
  const runStageForModule = useCallback(async (modId, stageId, trigger, overrideDesc) => {
    switchModule(modId);
    return runStage(stageId, trigger || "manual", overrideDesc);
  }, [switchModule, runStage]);

  // Mirror state into refs each render so abortCurrentStage
  // can read the latest values without re-binding the callback. Cheap
  // (just two assignments) and render-safe.
  configRef.current = config;
  processingRef.current = processing;

  /** Abort the currently running stage, if any. */
  const abortCurrentStage = useCallback(() => {
    if (abortControllerRef.current) {
      // Multi-pronged abort:
      //   1. Signal the AbortController so all awaits respecting the
      //      signal (fetch, _sleep, etc.) bail out.
      //   2. POST to the backend's /api/abort so any long-running CLI
      //      process (e.g. Verilator simulation that's been compiling
      //      for 30s) dies on the backend side too. Otherwise the abort
      //      only stops the fetch in the browser — the backend keeps
      //      running the simulation and the NEXT user run hits a busy
      //      backend.
      //   3. Schedule a hard-stop timeout: if after 5s the run state
      //      hasn't unwound naturally (processing flag still true,
      //      reflowStageIds still populated), force-clear them. The
      //      user shouldn't be blocked from starting a new run by a
      //      slow inner abort propagation.
      abortControllerRef.current.abort();

      // Kill any running backend task. Best-effort — if the backend
      // is unreachable or the POST fails, we still proceeded with
      // the local abort above. The fetch is fire-and-forget; we don't
      // await it because the user just clicked abort and shouldn't
      // wait for the network roundtrip.
      const cfg = configRef.current;
      if (cfg && cfg.backendUrl) {
        try { abortBackendTask(cfg.backendUrl); }
        catch (_) { /* non-fatal */ }
      }

      if (opts.onAbort) {
        try { opts.onAbort(); }
        catch (_) { /* non-fatal */ }
      }

      // Hard-stop: 5-second deadline. If the run loop hasn't unwound
      // naturally by then, force-clear visible state so the user can
      // start a new run. Background promises may still resolve later
      // (their results get discarded since their dispatches go to a
      // now-mismatched abortControllerRef.current via the !== check
      // in the run loops' finally blocks).
      const deadline = setTimeout(function() {
        setProcessing(false);
        setReflowStageIds([]);
        setLoopbackStageId(null);
      }, 5000);
      // Also clear the deadline if processing flips off naturally
      // (covers the common case where abort propagates in <5s).
      const interval = setInterval(function() {
        if (!processingRef.current) {
          clearTimeout(deadline);
          clearInterval(interval);
        }
      }, 100);
    }
  }, [opts.onAbort, setReflowStageIds]);

  /**
   * Move forward one stage (semi-auto) or run all remaining stages (full-auto).
   */
  const proceed = useCallback(async () => {
    const cur = uiStateRef.current;
    const next = nextStageId(cur.activeStages, activeStage);
    if (!next) return;
    if (mode === "full-auto") {
      const remaining = stageIdsFrom(cur.activeStages, next);
      for (const sid of remaining) {
        const r = await runStage(sid, "auto");
        if (r && r.ok === false) return r;
      }
      return { ok: true };
    }
    return runStage(next, "manual");
  }, [activeStage, mode, runStage]);

  // ── 10. Lifecycle helpers ────────────────────────────────────────────────

  /**
   * Convenience launcher for single-module mode. Creates the module,
   * switches to it, generates a projectId, and either runs stage 1 (elicit)
   * in semi-auto or kicks off runAllPipelines in full-auto.
   *
   * For system mode (decomposition first), compose with dispatch + drivers
   * directly — the setup is project-specific.
   */
  const launchSingleModule = useCallback(async (description, modIdArg) => {
    const desc = (description || "").trim();
    if (!desc) return { ok: false, error: new Error("empty description") };
    const modId = modIdArg || "_init";
    const pid = generateProjectId(desc, "module");

    setProjectId(pid);
    setUserDesc(desc);
    setDesignMode("module");
    dispatchSync({ type: PROJECT_PHASE_SET, phase: "running" });
    dispatchSync({ type: MODULE_UPSERT, modId });
    dispatchSync({ type: SET_ACTIVE_MOD, modId });

    if (mode === "full-auto") {
      return runAllPipelines("full-auto");
    }
    // Semi-auto: run elicit (stage 1) to get the spec dialog going
    return runStage(1, "auto", desc);
  }, [mode, runAllPipelines, runStage]);

  /**
   * Load a checkpoint by projectId (from the index) or pass a full payload.
   * Dispatches LOAD_STATE and restores the UI-side state fields too.
   * Preserves the current apiKey so users don't have to re-enter it.
   */
  const resumeFromCheckpoint = useCallback(async (projectIdOrPayload) => {
    let payload;
    if (typeof projectIdOrPayload === "string") {
      payload = await checkpointManager.load(projectIdOrPayload);
    } else {
      payload = projectIdOrPayload;
    }
    if (!payload) return null;
    const restored = deserializeCheckpoint(payload);
    if (!restored) return null;

    dispatchSync({ type: LOAD_STATE, state: restored.reducerState });

    const ui = restored.uiState || {};
    if (ui.userDesc    != null) setUserDesc(ui.userDesc);
    if (ui.designMode  != null) setDesignMode(ui.designMode);
    if (ui.mode        != null) setMode(ui.mode);
    if (ui.projectId   != null) setProjectId(ui.projectId);
    if (ui.config) {
      // Detect "key never persisted, current session also has no key"
      // and trigger a non-intrusive notice. Local providers (ollama/lmstudio)
      // don't need keys, so we suppress the notice for those.
      const restoredProvider = ui.config.provider;
      const localProviders   = { ollama: 1, lmstudio: 1 };
      setConfig((prev) => {
        const haveKey = !!(prev.apiKey && prev.apiKey.length > 0);
        if (!haveKey && !localProviders[restoredProvider]) setApiKeyClearedNotice(true);
        return ({ ...ui.config, apiKey: prev.apiKey || "" });
      });
    }
    if ("lintWarningsAsErrors"   in ui) setLintWarningsAsErrors(!!ui.lintWarningsAsErrors);
    if ("verifyWarningsAsErrors" in ui) setVerifyWarningsAsErrors(!!ui.verifyWarningsAsErrors);

    // Restore stage cursors — find the furthest completed stage for the
    // active module and set viewingStage + activeStage correctly
    const rState = stateRef.current; // freshly synced by dispatchSync above
    const aModId = rState.activeModId;
    const aMod = aModId ? rState.modules[aModId] : null;
    if (aMod) {
      const stages = getActiveStages(ui.config || rState.config || {});
      const frontier = computeStageFrontier(aMod.completed, stages);
      let highest = 0;
      aMod.completed.forEach((id) => { if (id > highest) highest = id; });
      setActiveStage(ui.activeStage || frontier);
      setViewingStage(highest > 0 ? highest : frontier);
    } else if (ui.activeStage != null) {
      setActiveStage(ui.activeStage);
      setViewingStage(ui.activeStage);
    }

    // Reset integration idempotency ref
    lastIntegrationHashesRef.current = {};
    return restored;
  }, [checkpointManager]);

  /** Async helper to fetch the checkpoint index without reaching into services. */
  const listCheckpoints = useCallback(
    () => checkpointManager.listIndex(),
    [checkpointManager],
  );

  /** Reset everything — project state, UI state, refs, progress. */
  const resetProject = useCallback(() => {
    dispatch({ type: RESET_PROJECT });
    setUserDesc("");
    setActiveStage(0);
    setViewingStage(0);
    setProcessing(false);
    setProjectId(null);
    setShowSettings(false);
    setShowLedger(false);
    setShowDebug(false);
    setViewingSharedPkg(false);
    setEditingSharedPkg(false);
    setViewingIntegration(false);
    setActiveIntStage(null);
    setStaleModules({});
    setLibraryMatches([]);
    setPendingResume(null);
    setSaveFlash(null);
    abortControllerRef.current = null;
    lastIntegrationHashesRef.current = {};
  }, []);

  // ── 12. Launch + workflow handlers ───────────────────────────────────────────

  /** Full handleLaunch — covers both module and system mode.
   *  Module mode delegates to launchSingleModule.
   *  System mode runs decomposition via callLLM → review_decomp phase. */
  const handleLaunch = useCallback(async () => {
    if (!userDesc.trim()) return;

    const newPid = generateProjectId(userDesc, designMode);
    setProjectId(newPid);

    // ══ MODULE mode — skip decomposition ══
    if (designMode === "module") {
      setProjectPhase("running");
      setDecomposition(null);
      setDecompError(null);

      const initId = "_init";
      dispatchSync({ type: MODULE_UPSERT, modId: initId });
      dispatchSync({ type: SET_ACTIVE_MOD, modId: initId });

      if (mode === "full-auto") {
        const launchStages = stageIdsFromFn(2);
        for (let si = 0; si < launchStages.length; si++) {
          const s = launchStages[si];
          await runStage(s);
          const latestMod = stateRef.current.modules[initId];
          if (latestMod && latestMod.stageErrors && latestMod.stageErrors[s]) break;
        }
      } else {
        await runStage(1);
      }

      // Rename _init → real modName from elicit result
      const initMod = stateRef.current.modules[initId];
      const realId = (initMod && initMod.stageData && initMod.stageData[1] && initMod.stageData[1].modName) || initId;
      if (realId !== initId) {
        setModules((prev) => {
          if (!prev[initId]) return prev;
          const n = Object.assign({}, prev);
          n[realId] = prev[initId];
          delete n[initId];
          return n;
        });
        dispatch({ type: SET_ACTIVE_MOD, modId: realId });
      }
      return;
    }

    // ══ SYSTEM mode — decompose, then go to review_decomp ══
    setProjectPhase("decomposing");
    setDecomposition(null);
    setDecompError(null);

    if (!opts.callLLM || !opts.extractJSON) {
      setDecompError("System mode requires callLLM and extractJSON — pass them to useProject({callLLM, extractJSON}).");
      setProjectPhase("idle");
      return;
    }

    let decomp;
    const maxRetries = 2;
    let currentMaxTokens = 8000;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const avail = buildAvailableModules();
        // promptDecompose is expected to be available if system mode is used
        const { promptDecompose } = await import("../prompts/index.js");
        const dp = promptDecompose(userDesc, avail, true);
        dp.maxTokens = currentMaxTokens;
        dp.config = Object.assign({}, config);
        const dr = await opts.callLLM(dp);

        const wasTruncated = dr.stopReason === "max_tokens" || dr.stopReason === "length";
        if (wasTruncated && attempt < maxRetries - 1) {
          currentMaxTokens *= 2;
          addLedger("decompose-truncated", dr);
          continue;
        }

        decomp = opts.extractJSON(dr.text);
        setDecomposition(decomp);
        addLedger("decompose", dr);
        if (wasTruncated) {
          setDecompError("Response was truncated — decomposition may be incomplete. Review carefully or re-decompose.");
        }
        break;
      } catch (e) {
        if (attempt < maxRetries - 1) { currentMaxTokens *= 2; continue; }
        setDecompError(e.message);
        setProjectPhase("idle");
        return;
      }
    }

    if (!decomp) {
      setDecompError("Decompose failed after " + maxRetries + " attempts");
      setProjectPhase("idle");
      return;
    }

    if (decomp.type === "single") {
      setDecompError("The LLM classified this as a single module. You can re-decompose, add modules manually, or switch to Module mode if this is correct.");
    }

    const newModules = {};
    (decomp.modules || []).forEach((m) => {
      newModules[m.modId] = Object.assign(blankModule(), { name: m.name, description: m.description, level: m.level, params: m.params || [] });
    });
    setModules(newModules);

    const newInstances = {};
    (decomp.instances || []).forEach((inst) => {
      newInstances[inst.instId] = { instId: inst.instId, moduleId: inst.moduleId, parentModuleId: inst.parentModuleId, instanceName: inst.instanceName, paramOverrides: inst.paramOverrides || {}, description: inst.description || "" };
    });
    setInstances(newInstances);

    // Auto-match library modules
    const { matchLibrary } = await import("../utils/library.js");
    const matches = matchLibrary(decomp, importedPackages);
    setLibraryMatches(matches);

    dispatch({ type: SET_ACTIVE_MOD, modId: decomp.topModule || (decomp.modules && decomp.modules[0] && decomp.modules[0].modId) || null });
    setProjectPhase("review_decomp");
  }, [designMode, userDesc, config, mode, runStage, addLedger, importedPackages, opts.callLLM, opts.extractJSON]);

  /** Confirm decomposition and begin per-module pipelines. */
  const confirmDecomp = useCallback(() => {
    setProjectPhase("running");
    setTimeout(() => { runAllPipelines(mode); }, 50);
  }, [mode, runAllPipelines]);

  /** Go back to idle from decomp review. */
  const handleBackToIdle = useCallback(() => {
    setProjectPhase("idle");
    setModules({});
    setInstances({});
    setDecomposition(null);
    dispatch({ type: SET_ACTIVE_MOD, modId: null });
    setActiveStage(0);
    setViewingStage(0);
  }, []);

  /** Re-decompose from review screen. */
  const handleRedecompose = useCallback(async () => {
    setProjectPhase("decomposing");
    setDecompError(null);
    if (!opts.callLLM || !opts.extractJSON) {
      setDecompError("callLLM/extractJSON not provided.");
      setProjectPhase("review_decomp");
      return;
    }
    try {
      const avail = buildAvailableModules();
      const { promptDecompose } = await import("../prompts/index.js");
      const dp = promptDecompose(userDesc, avail, true);
      dp.config = Object.assign({}, config);
      const dr = await opts.callLLM(dp);
      const decomp = opts.extractJSON(dr.text);
      setDecomposition(decomp);
      addLedger("decompose", dr);
      if (decomp.type === "single") {
        setDecompError("The LLM still returned a single-module result. Try rephrasing or add modules manually.");
      }
      const newModules = {};
      (decomp.modules || []).forEach((m) => {
        newModules[m.modId] = Object.assign(blankModule(), { name: m.name, description: m.description, level: m.level, params: m.params || [] });
      });
      setModules(newModules);
      const newInstances = {};
      (decomp.instances || []).forEach((inst) => {
        newInstances[inst.instId] = { instId: inst.instId, moduleId: inst.moduleId, parentModuleId: inst.parentModuleId, instanceName: inst.instanceName, paramOverrides: inst.paramOverrides || {}, description: inst.description || "" };
      });
      setInstances(newInstances);
      const { matchLibrary } = await import("../utils/library.js");
      const matches = matchLibrary(decomp, importedPackages);
      setLibraryMatches(matches);
      dispatch({ type: SET_ACTIVE_MOD, modId: decomp.topModule || (decomp.modules && decomp.modules[0] && decomp.modules[0].modId) || null });
      setProjectPhase("review_decomp");
    } catch (e) {
      setDecompError(e.message);
      setProjectPhase("review_decomp");
    }
  }, [userDesc, config, addLedger, importedPackages, opts.callLLM, opts.extractJSON]);

  /** Rerun a stage from the active module. Clears stages >= id first. */
  const handleRerun = useCallback(async (id) => {
    const targetModId = stateRef.current.activeModId;
    const latestMod = targetModId && stateRef.current.modules[targetModId];
    const latestCompleted = latestMod ? latestMod.completed : new Set();
    if (!latestCompleted.has(id)) return;

    // Stage IDs are not in pipeline order: rtl_review (10), test_review (11),
    // and lint_test (12) have IDs numerically larger than verify (8) and judge
    // (9) while being upstream of them in the active pipeline. A naive
    // `s.id >= id` numeric comparison would wipe those slots when the user
    // re-ran verify or judge, making them appear inaccessible.
    //
    // Use the active pipeline order instead: `stageIdsFrom` returns the
    // ordered tail starting at `id`. Only those stages are downstream and
    // need clearing.
    const downstreamIds = new Set(stageIdsFrom(activeStages, id));

    // Clear stages downstream of (and including) id for the target module
    updateModule(targetModId, (mod) => {
      const newCompleted = new Set(Array.from(mod.completed || []).filter((s) => !downstreamIds.has(s)));
      const sd = Object.assign({}, mod.stageData);
      const se = Object.assign({}, mod.stageErrors);
      ALL_STAGES.forEach((s) => {
        if (downstreamIds.has(s.id)) { sd[s.id] = {}; se[s.id] = null; }
      });
      return Object.assign({}, mod, { completed: newCompleted, stageData: sd, stageErrors: se });
    });

    // Mark parents stale if multi-module
    if (isMultiModule && targetModId) {
      const parentModIds = Object.values(stateRef.current.instances)
        .filter((inst) => inst.moduleId === targetModId)
        .map((inst) => inst.parentModuleId);
      if (parentModIds.length > 0) {
        setStaleModules((prev) => {
          const n = Object.assign({}, prev);
          const childMod = stateRef.current.modules[targetModId] || blankModule();
          const childSpec = childMod.stageData[2] || {};
          const currentIfaceHash = computeIfaceHash(childSpec);
          parentModIds.forEach((pid) => {
            const parentMod = stateRef.current.modules[pid];
            if (!parentMod) return;
            const storedChild = (parentMod.childHashes || {})[targetModId];
            const storedIfaceHash = storedChild ? storedChild.ifaceHash : null;
            if (storedIfaceHash && storedIfaceHash === currentIfaceHash) {
              n[pid] = { reason: "Child \"" + targetModId + "\" RTL changed (interface unchanged)", type: "rtl_only" };
            } else {
              n[pid] = { reason: "Child \"" + targetModId + "\" interface changed", type: "interface" };
            }
          });
          return n;
        });
      }
    }
    if (mode === "full-auto") {
      const rerunIds = stageIdsFromFn(id);
      for (let ri = 0; ri < rerunIds.length; ri++) await runStage(rerunIds[ri], "rerun");
    } else {
      await runStage(id, "rerun");
    }
  }, [mode, runStage, isMultiModule, updateModule]);

  /** Manual import: set code for a stage (RTL Gen or Test Gen).
   *  Extracts module name from `module <name>` declaration to keep
   *  filenames and module IDs consistent. */
  const handleManualImport = useCallback((stageId, code) => {
    if (!code || !code.trim()) return;
    const mId = stateRef.current.activeModId;
    if (!mId) return;
    const trimmed = code.trim();
    // Extract module name from SystemVerilog `module <name>`
    const modMatch = trimmed.match(/\bmodule\s+(\w+)/);
    const extractedName = modMatch ? modMatch[1] : null;
    updateModule(mId, (mod) => {
      const sd = Object.assign({}, mod.stageData);
      sd[stageId] = {
        code: trimmed,
        _manualImport: true,
        _importedAt: new Date().toISOString(),
        _userEdited: false,
      };
      // If we extracted a module name and this is RTL (stage 4), update
      // the elicit data's modName so filenames stay consistent
      if (extractedName && stageId === 4) {
        const elicitData = sd[1] || {};
        sd[1] = Object.assign({}, elicitData, { modName: extractedName });
      }
      const newCompleted = new Set([...Array.from(mod.completed || []), stageId]);
      const se = Object.assign({}, mod.stageErrors);
      se[stageId] = null;
      return Object.assign({}, mod, {
        stageData: sd,
        completed: newCompleted,
        stageErrors: se,
        // Update module name if extracted
        name: extractedName || mod.name,
      });
    });
    setManualImportDialog(null);
    setManualImportText("");
    setViewingStage(stageId);
    setActiveStage(stageId);
  }, [updateModule]);

  /** Build list of available library modules for promptDecompose. */
  function buildAvailableModules() {
    const avail = [];
    Object.keys(importedPackages).forEach((key) => {
      const entry = importedPackages[key];
      const pkg = entry.pkg;
      if (entry.type === "module") {
        const mod = pkg.module || {};
        const params = (pkg.interface && pkg.interface.params) ? pkg.interface.params.map((p) => p.name) : [];
        avail.push({ modId: mod.modId || key, type: "module", params, description: mod.description || "" });
      } else if (entry.type === "system") {
        const sys = pkg.system || {};
        const topMod = pkg.modules && pkg.modules[sys.topModule];
        const sysParams = topMod && topMod.interface && topMod.interface.params ? topMod.interface.params.map((p) => p.name) : [];
        avail.push({ modId: sys.systemName || key, type: "system", topModule: sys.topModule, params: sysParams, description: sys.description || "" });
      }
    });
    return avail;
  }

  /** Create a module entry from a package module (for import handlers). */
  function createImportedModuleEntry(modId, modEntry, extraFlags) {
    const desc = modEntry.description || "";
    const spec = (modEntry.artifacts && modEntry.artifacts.spec) || modEntry.interface || {};
    const rtlCode = modEntry.artifacts ? modEntry.artifacts.rtl || "" : "";
    const tbCode = modEntry.artifacts ? modEntry.artifacts.testbench || "" : "";
    const svaRaw = modEntry.artifacts ? modEntry.artifacts.sva : null;
    const judgeData = modEntry.artifacts ? modEntry.artifacts.judge || {} : {};
    let svaData = { properties: [], covers: [], bind_module: "" };
    if (svaRaw && typeof svaRaw === "string") svaData = { properties: [], covers: [], bind_module: svaRaw };
    else if (svaRaw && typeof svaRaw === "object") svaData = svaRaw;

    const sd = {};
    sd[1] = { domain: desc, modName: modId, questions: [], assumptions: [], answers: {} };
    sd[2] = spec;
    sd[3] = { strategy: "Imported", description: "From package", blocks: [], mermaid: "" };
    sd[4] = { code: rtlCode };
    sd[5] = svaData;
    sd[6] = { tool: "Imported", status: "PASS", warnings: [], errors: [], summary: "Imported", iterations: [] };
    sd[7] = { code: tbCode };
    sd[8] = { sim: "Imported", total: 0, pass: 0, fail: 0, cov: { line: 0, branch: 0, toggle: 0 }, tests: [], log: "" };
    sd[9] = judgeData;
    return Object.assign(blankModule(), {
      name: modEntry.name || modId, description: desc,
      params: spec.params || modEntry.params || [],
      stageData: sd, completed: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      imported: true,
    }, extraFlags || {});
  }

  /** Import a single module from a ModulePackage. */
  function importModuleFromPkg(pkg) {
    const modId = pkg.module ? pkg.module.modId : "imported_module";
    if (!modId) return null;
    let finalId = modId;
    if (stateRef.current.modules[modId]) {
      finalId = modId + "_imported";
      while (stateRef.current.modules[finalId]) finalId += "_";
    }
    const modEntry = { modId: finalId, name: (pkg.module && pkg.module.name) || finalId, description: (pkg.module && pkg.module.description) || "", interface: pkg.interface || {}, artifacts: pkg.artifacts || {} };
    const mod = createImportedModuleEntry(finalId, modEntry, { importMode: "leaf", importSource: "module" });
    dispatch({ type: MODULE_UPSERT, modId: finalId, mod });
    setImportedPackages((prev) => Object.assign({}, prev, { [finalId]: { type: "module", mode: "leaf", pkg } }));
    return finalId;
  }

  /** Import system as BLACK-BOX (top module only). */
  function importSystemBlackBox(pkg) {
    const sys = pkg.system || {};
    const topModId = sys.topModule;
    const topModEntry = pkg.modules && pkg.modules[topModId];
    if (!topModEntry) return null;
    let finalId = topModId;
    if (stateRef.current.modules[topModId]) {
      finalId = topModId + "_imported";
      while (stateRef.current.modules[finalId]) finalId += "_";
    }
    const mod = createImportedModuleEntry(finalId, topModEntry, { importMode: "blackbox", importSource: sys.systemName || "system" });
    dispatch({ type: MODULE_UPSERT, modId: finalId, mod });
    setImportedPackages((prev) => Object.assign({}, prev, { [sys.systemName || topModId]: { type: "system", mode: "blackbox", pkg } }));
    return finalId;
  }

  /** Import system as EXPLODED (all modules + instances). */
  function importSystemExploded(pkg) {
    const sys = pkg.system || {};
    const sysName = sys.systemName || "system";
    const prefix = sysName + "_";
    Object.keys(pkg.modules || {}).forEach((mId) => {
      const modEntry = pkg.modules[mId];
      let finalId = mId;
      if (stateRef.current.modules[mId]) {
        finalId = mId + "_imported";
        while (stateRef.current.modules[finalId]) finalId += "_";
      }
      const mod = createImportedModuleEntry(finalId, modEntry, { importMode: "exploded", importSource: sysName });
      dispatch({ type: MODULE_UPSERT, modId: finalId, mod });
    });
    // Create instance entries
    const newInstances = {};
    (pkg.instances || []).forEach((inst) => {
      const prefixedId = prefix + (inst.instId || inst.instanceName);
      newInstances[prefixedId] = { instId: prefixedId, moduleId: inst.moduleId, parentModuleId: inst.parentModuleId, instanceName: inst.instanceName, paramOverrides: inst.paramOverrides || {}, description: inst.description || "" };
    });
    if (Object.keys(newInstances).length > 0) {
      setInstances((prev) => Object.assign({}, prev, newInstances));
    }
    setImportedPackages((prev) => Object.assign({}, prev, { [sysName]: { type: "system", mode: "exploded", pkg } }));
  }

  /** Main import handler — reads a File, dispatches to module or system import. */
  const importPackage = useCallback(async (file) => {
    try {
      const text = await file.text();
      const pkg = JSON.parse(text);
      if (pkg.system) {
        // System package — need to ask user for mode
        setImportDialog({ pkg, resolve: null, reject: null });
      } else {
        importModuleFromPkg(pkg);
      }
    } catch (e) {
      (opts.logger || console).error("[RTL Forge] Import failed:", e);
    }
  }, [opts.logger]);

  /** Trigger file picker for package import. */
  function triggerImport() {
    if (importFileRef.current) importFileRef.current.click();
  }

  /** Detach an imported module — clear imported flag, enable re-run. */
  function detachModule(modId) {
    updateModule(modId, (mod) => {
      const n = Object.assign({}, mod);
      delete n.imported;
      delete n.importMode;
      delete n.importSource;
      n.completed = new Set();
      const sd = Object.assign({}, n.stageData);
      // Keep stageData[1] (elicit/identity) but clear everything else
      ALL_STAGES.forEach((s) => {
        if (s.id > 1) sd[s.id] = {};
      });
      n.stageData = sd;
      n.stageErrors = {};
      return n;
    });
  }

  /** Apply selected library matches from the DecompReview screen. */
  const applyLibraryMatches = useCallback((selected) => {
    selected.forEach((sel) => {
      const m = sel.match;
      const mode = sel.mode;
      const pkgEntry = importedPackages[m.libraryKey];
      if (!pkgEntry) return;
      if (pkgEntry.type === "module") {
        const pkg = pkgEntry.pkg;
        const mod = createImportedModuleEntry(m.decompModId, { modId: m.decompModId, name: (pkg.module && pkg.module.name) || m.decompModId, description: (pkg.module && pkg.module.description) || "", interface: pkg.interface || {}, artifacts: pkg.artifacts || {} }, { importMode: "leaf", importSource: "library" });
        dispatch({ type: MODULE_UPSERT, modId: m.decompModId, mod });
      } else if (pkgEntry.type === "system") {
        if (mode === "blackbox") {
          importSystemBlackBox(pkgEntry.pkg);
        } else {
          importSystemExploded(pkgEntry.pkg);
        }
      }
    });
    setLibraryMatches([]);
  }, [importedPackages]);

  /** Delete package from library (state + storage). */
  const deletePackageFromLibrary = useCallback(async (key) => {
    setImportedPackages((prev) => {
      const n = Object.assign({}, prev);
      delete n[key];
      return n;
    });
    try {
      const store = storage;
      const isModule = key.indexOf("sys:") < 0;
      const storageKey = isModule ? "rtlforge:lib:mod:" + key : "rtlforge:lib:sys:" + key;
      await store.delete(storageKey).catch(() => {});
    } catch (e) { /* non-fatal */ }
  }, [storage]);

  /** Re-download package from library (triggers a browser download). */
  const redownloadPackage = useCallback((key) => {
    const entry = importedPackages[key];
    if (!entry) return;
    const json = JSON.stringify(entry.pkg, null, 2);
    const ext = entry.type === "system" ? ".rtlsyspkg.json" : ".rtlpkg.json";
    if (typeof window !== "undefined") {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = key + ext; a.click();
      URL.revokeObjectURL(url);
    }
  }, [importedPackages]);

  /** Clear entire library (state + storage). */
  const clearLibrary = useCallback(async () => {
    const keys = Object.keys(importedPackages);
    setImportedPackages({});
    try {
      const store = storage;
      for (const k of keys) {
        const entry = importedPackages[k];
        const sk = entry && entry.type === "system" ? "rtlforge:lib:sys:" + k : "rtlforge:lib:mod:" + k;
        await store.delete(sk).catch(() => {});
      }
      await store.delete("rtlforge:lib:index").catch(() => {});
    } catch (e) { /* non-fatal */ }
  }, [importedPackages, storage]);

  /** Propagate changes — re-run stale parents from spec onward. */
  const propagateChanges = useCallback(async (modId) => {
    if (!staleModules[modId]) return;
    setPropagating(true);
    const staleInfo = staleModules[modId];
    const startStage = staleInfo.type === "rtl_only" ? 4 : 2;
    try {
      switchModule(modId);
      const stagesToRun = stageIdsFromFn(startStage);
      for (const sid of stagesToRun) {
        await runStage(sid, "propagate");
        const latestMod = stateRef.current.modules[modId];
        if (latestMod && latestMod.stageErrors && latestMod.stageErrors[sid]) break;
      }
      setStaleModules((prev) => {
        const n = Object.assign({}, prev);
        delete n[modId];
        return n;
      });
    } finally {
      setPropagating(false);
    }
  }, [staleModules, switchModule, runStage]);

  /** Discard a checkpoint by projectId. */
  const discardCheckpoint = useCallback(async (pid) => {
    try { await checkpointManager.remove(pid); }
    catch (e) { (opts.logger || console).warn("[useProject] discard checkpoint failed:", e); }
    setCheckpointIndex((prev) => prev.filter((c) => c.projectId !== pid));
  }, [checkpointManager, opts.logger]);

  /** Delete the current project's checkpoint. */
  const deleteCurrentCheckpoint = useCallback(async () => {
    const pid = projectId;
    if (!pid) return;
    try { await checkpointManager.remove(pid); }
    catch (e) { (opts.logger || console).warn("[useProject] delete current checkpoint failed:", e); }
  }, [checkpointManager, projectId, opts.logger]);

  // ── Export handlers (fully implemented — uses src/utils/export.js) ──────

  const handleExport = useCallback(() => {
    const mid = stateRef.current.activeModId || modName;
    const name = modName || mid;
    const sd = stateRef.current.modules[mid] ? stateRef.current.modules[mid].stageData : {};
    const zip = new MiniZip();
    const prefix = name + "_regression/";
    if (sd[4] && sd[4].code) zip.addFile(prefix + "rtl/" + name + ".sv", sd[4].code);
    if (sd[7] && sd[7].code) zip.addFile(prefix + "tb/" + name + "_tb.sv", sd[7].code);
    const svaStr = buildSVASource(sd[5]);
    if (svaStr) zip.addFile(prefix + "sva/" + name + "_sva.sv", svaStr);
    const curSharedPkg = stateRef.current.sharedPackage;
    if (curSharedPkg && curSharedPkg.code) zip.addFile(prefix + "rtl/" + (curSharedPkg.packageName || "shared_pkg") + ".sv", curSharedPkg.code);
    const judgeData = sd[9] || {};
    const modListEntry = {
      modId: name, score: judgeData.score, overall: judgeData.overall,
      hasSVA: !!svaStr,
      isManualRTL: !!(sd[4] && sd[4]._manualImport),
      isManualTB: !!(sd[7] && sd[7]._manualImport),
    };
    const modList = [modListEntry];
    // Acceptance ledger (Phase 5): prefer judge's, fall back to verify's.
    const acceptLedger = (sd[9] && sd[9]._ledger) || (sd[8] && sd[8]._ledger) || null;
    zip.addFile(prefix + "Makefile", generateMakefile(modList, false, null, name));
    zip.addFile(prefix + "scripts/run_tests.sh", generateRunScript(modList, false, null, name));
    zip.addFile(prefix + "README.md", generateReadme(name, modList, false, null, curSharedPkg, null, null, ledgerTotals, acceptLedger));
    if (acceptLedger) zip.addFile(prefix + "requirements.yaml", generateRequirementsYaml(acceptLedger));
    const specData = sd[2] || {};
    const manifest = {
      project: name, generated: new Date().toISOString(), generator: "RTL Forge v6",
      modules: [{ modId: name, file: "rtl/" + name + ".sv", testbench: "tb/" + name + "_tb.sv", sva: svaStr ? "sva/" + name + "_sva.sv" : null, score: judgeData.score, overall: judgeData.overall, specManualEdits: specData._manualEdits || null }],
    };
    zip.addFile(prefix + "manifest.json", JSON.stringify(manifest, null, 2));
    zip.addFile(prefix + "token_ledger.yaml", "# RTL Forge — Token Ledger\n" + JSON.stringify({ totals: ledgerTotals, entries: stateRef.current.ledger }, null, 2));
    downloadZip(zip, name + "_regression.zip");
  }, [modName, ledgerTotals]);

  const exportModulePackage = useCallback((modIdArg) => {
    const mid = modIdArg || stateRef.current.activeModId;
    const mod = stateRef.current.modules[mid];
    if (!mod) return null;
    const pkg = {
      version: 2,
      type: "module",
      exportedAt: new Date().toISOString(),
      module: { modId: mid, name: mod.name, description: mod.description },
      interface: mod.stageData[2] || {},
      artifacts: {
        rtl: (mod.stageData[4] && mod.stageData[4].code) || "",
        testbench: (mod.stageData[7] && mod.stageData[7].code) || "",
        sva: mod.stageData[5] || null,
        spec: mod.stageData[2] || {},
        judge: mod.stageData[9] || {},
      },
    };
    // Trigger download
    if (typeof window !== "undefined") {
      const json = JSON.stringify(pkg, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = mid + ".rtlpkg.json"; a.click();
      URL.revokeObjectURL(url);
    }
    return pkg;
  }, []);

  const exportSystemPackage = useCallback(() => {
    if (!isMultiModule) return;
    const curState = stateRef.current;
    const intJudge = curState.integrationState && curState.integrationState.stageData
      ? curState.integrationState.stageData.int_judge : null;
    if (!intJudge) return;
    const sysName = curState.decomposition ? curState.decomposition.systemName || "system" : "system";
    const sysDesc = curState.decomposition ? curState.decomposition.description || "" : "";
    const topMod = curState.decomposition ? curState.decomposition.topModule || "" : "";
    const effectiveLevels = computeEffectiveLevels(curState.modules, curState.instances, topMod);
    const modulesMap = {};
    Object.keys(curState.modules).forEach((mId) => {
      const mod = curState.modules[mId];
      const sd = mod ? mod.stageData || {} : {};
      const spec = sd[2] || {};
      const rtlCode = sd[4] ? sd[4].code || "" : "";
      const tbCode = sd[7] ? sd[7].code || "" : "";
      const svaSource = buildSVASource(sd[5]);
      const judgeData = sd[9] || {};
      const parentModuleIds = [];
      const childInstances = [];
      const seenParents = {};
      Object.values(curState.instances).forEach((inst) => {
        if (inst.moduleId === mId && !seenParents[inst.parentModuleId]) {
          parentModuleIds.push(inst.parentModuleId);
          seenParents[inst.parentModuleId] = true;
        }
        if (inst.parentModuleId === mId) childInstances.push(inst.instId || inst.instanceName);
      });
      let usedAtMultipleLevels = false;
      if (parentModuleIds.length > 1) {
        const pLevels = parentModuleIds.map((pid) => effectiveLevels[pid] || 0);
        usedAtMultipleLevels = Math.max(...pLevels) > Math.min(...pLevels);
      }
      modulesMap[mId] = {
        modId: mId, name: mod.name || mId, description: mod.description || "",
        interface: { iface: spec.iface || [], params: spec.params || [] },
        artifacts: {
          rtl: rtlCode, rtlManualImport: !!(sd[4] && sd[4]._manualImport),
          testbench: tbCode, testbenchManualImport: !!(sd[7] && sd[7]._manualImport),
          sva: svaSource || null, spec, specManualEdits: spec._manualEdits || null, judge: judgeData,
        },
        context: { parentModuleIds, childInstances, usedAtMultipleLevels },
        signature: computeInterfaceSignature(spec.iface || [], spec.params || []),
      };
    });
    const instancesArray = Object.values(curState.instances).map((inst) => ({
      instId: inst.instId || inst.instanceName, moduleId: inst.moduleId,
      parentModuleId: inst.parentModuleId, instanceName: inst.instanceName,
      paramOverrides: inst.paramOverrides || {}, description: inst.description || "",
    }));
    const pkg = {
      format: "rtlforge-system-package-v2", exportedAt: new Date().toISOString(),
      system: { systemName: sysName, description: sysDesc, topModule: topMod },
      modules: modulesMap, instances: instancesArray,
      sharedPackage: curState.sharedPackage || null,
      interconnects: curState.decomposition ? curState.decomposition.interconnects || [] : [],
      integration: {
        lint: curState.integrationState.stageData.int_lint || null,
        test: curState.integrationState.stageData.int_test || null,
        judge: intJudge,
      },
    };
    downloadJSON(pkg, sysName + ".rtlsyspkg.json");
    // Save to library
    setImportedPackages((prev) => Object.assign({}, prev, { [sysName]: { type: "system", mode: "blackbox", pkg } }));
  }, [isMultiModule]);

  const handleExportAll = useCallback(() => {
    if (!isMultiModule) { handleExport(); return; }
    const curState = stateRef.current;
    const sysName = curState.decomposition ? curState.decomposition.systemName || "system" : "system";
    const topId = curState.decomposition ? curState.decomposition.topModule : null;
    const zip = new MiniZip();
    const prefix = sysName + "_regression/";
    const modList = [];
    Object.keys(curState.modules).forEach((mId) => {
      const mod = curState.modules[mId];
      const sd = mod ? mod.stageData || {} : {};
      const judgeData = sd[9] || {};
      const svaStr = buildSVASource(sd[5]);
      modList.push({
        modId: mId, score: judgeData.score, overall: judgeData.overall,
        hasSVA: !!svaStr,
        isManualRTL: !!(sd[4] && sd[4]._manualImport),
        isManualTB: !!(sd[7] && sd[7]._manualImport),
      });
      if (sd[4] && sd[4].code) zip.addFile(prefix + "rtl/" + mId + ".sv", sd[4].code);
      if (sd[7] && sd[7].code) zip.addFile(prefix + "tb/" + mId + "_tb.sv", sd[7].code);
      if (svaStr) zip.addFile(prefix + "sva/" + mId + "_sva.sv", svaStr);
      // Per-module acceptance ledger (Phase 5): judge's, else verify's.
      const modLedger = (sd[9] && sd[9]._ledger) || (sd[8] && sd[8]._ledger) || null;
      if (modLedger) zip.addFile(prefix + "requirements/" + mId + ".yaml", generateRequirementsYaml(modLedger));
    });
    const curShared = curState.sharedPackage;
    if (curShared && curShared.code) zip.addFile(prefix + "rtl/" + (curShared.packageName || "shared_pkg") + ".sv", curShared.code);
    const intState = curState.integrationState || {};
    const intTest = intState.stageData ? intState.stageData.int_test : null;
    if (intTest && intTest.code) zip.addFile(prefix + "tb/" + sysName + "_top_tb.sv", intTest.code);
    zip.addFile(prefix + "Makefile", generateMakefile(modList, true, topId, sysName));
    zip.addFile(prefix + "scripts/run_tests.sh", generateRunScript(modList, true, topId, sysName));
    const intJudge = intState.stageData ? intState.stageData.int_judge : null;
    zip.addFile(prefix + "README.md", generateReadme(sysName, modList, true, curState.decomposition, curShared, null, intJudge, ledgerTotals));
    const moduleManifest = [];
    const perModScores = {};
    Object.keys(curState.modules).forEach((mId) => {
      const mod = curState.modules[mId];
      const sd = mod ? mod.stageData || {} : {};
      const j = sd[9] || {};
      perModScores[mId] = j.score || 0;
      const svaStr = buildSVASource(sd[5]);
      const entry = {
        modId: mId, file: "rtl/" + mId + ".sv", testbench: "tb/" + mId + "_tb.sv",
        sva: svaStr ? "sva/" + mId + "_sva.sv" : null, score: j.score, overall: j.overall,
        instances: [],
      };
      Object.values(curState.instances).forEach((inst) => {
        if (inst.moduleId === mId) entry.instances.push({ instId: inst.instId, parent: inst.parentModuleId, paramOverrides: inst.paramOverrides });
      });
      moduleManifest.push(entry);
    });
    const manifest = {
      system: sysName, generated: new Date().toISOString(), generator: "RTL Forge v6",
      modules: moduleManifest,
      hierarchy: curState.decomposition ? { topModule: curState.decomposition.topModule, modules: (curState.decomposition.modules || []).map((m) => ({ modId: m.modId, level: m.level })) } : {},
      scores: { perModule: perModScores, integration: intJudge ? intJudge.score : null },
    };
    zip.addFile(prefix + "manifest.json", JSON.stringify(manifest, null, 2));
    zip.addFile(prefix + "token_ledger.yaml", "# RTL Forge — Token Ledger\n" + JSON.stringify({ totals: ledgerTotals, entries: curState.ledger }, null, 2));
    downloadZip(zip, sysName + "_regression.zip");
  }, [isMultiModule, handleExport, ledgerTotals]);

  const handleCopyManifest = useCallback(() => {
    const curState = stateRef.current;
    const sysName = curState.decomposition ? curState.decomposition.systemName || "system" : "system";
    const intJudge = curState.integrationState && curState.integrationState.stageData
      ? curState.integrationState.stageData.int_judge : null;
    const perModScores = {};
    Object.keys(curState.modules).forEach((mId) => {
      const mod = curState.modules[mId];
      const j = mod && mod.stageData && mod.stageData[9];
      perModScores[mId] = j ? j.score : 0;
    });
    const moduleManifest = Object.keys(curState.modules).map((mId) => {
      const entry = { modId: mId, file: mId + ".sv", testbench: mId + "_tb.sv", instances: [] };
      Object.values(curState.instances).forEach((inst) => {
        if (inst.moduleId === mId) entry.instances.push({ instId: inst.instId, parent: inst.parentModuleId, paramOverrides: inst.paramOverrides });
      });
      return entry;
    });
    const manifest = {
      system: sysName, generated: new Date().toISOString(), generator: "RTL Forge v6",
      modules: moduleManifest,
      scores: { perModule: perModScores, integration: intJudge ? intJudge.score : null },
    };
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(JSON.stringify(manifest, null, 2)).then(() => {
        (opts.logger || console).log("[RTL Forge] Manifest copied to clipboard");
      });
    } else {
      (opts.logger || console).warn("[RTL Forge] Clipboard API not available");
    }
  }, [opts.logger]);

  // ── 13. Effects ─────────────────────────────────────────────────────────

  /** Check for saved checkpoints on mount. */
  useEffect(() => {
    async function checkForCheckpoints() {
      try {
        const index = await checkpointManager.listIndex();
        if (index && index.length > 0) {
          setCheckpointIndex(index);
          // Show resume dialog for the most recent checkpoint
          const latest = index[0]; // listIndex returns most-recent-first
          try {
            const payload = await checkpointManager.load(latest.projectId);
            if (payload) setPendingResume(payload);
          } catch (e) { /* checkpoint data corrupt — skip */ }
        }
      } catch (e) { /* storage unavailable — non-fatal */ }
    }
    checkForCheckpoints();
  }, [checkpointManager]);

  /** Auto-verify backend when URL changes. */
  useEffect(() => {
    if (!config.backendUrl) { setBackendVerified(null); return; }
    let cancelled = false;
    import("../cli/index.js").then(({ testBackendConnection }) => {
      testBackendConnection(config.backendUrl).then((result) => {
        if (!cancelled) setBackendVerified(result && result.ok);
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [config.backendUrl]);

  /** Auto-enable TB lint (lint_test) once a CLI backend is verified.
   *
   * lint_test defaults OFF because LLM-estimated TB lint adds cost with weak
   * signal. With a REAL backend it's nearly free (one verilator --lint-only
   * run) and catches TB syntax errors BEFORE verify — the most expensive
   * stage — instead of inside it. So the first time the backend verifies, we
   * flip it on.
   *
   * An explicit user choice always wins: the workflow panel stamps
   * config.optionalStagesUserSet.lint_test when the user touches that
   * checkbox, and this effect never overrides a stamped key. */
  useEffect(() => {
    if (backendVerified !== true) return;
    setConfig((prev) => {
      const userSet = (prev.optionalStagesUserSet || {}).lint_test === true;
      const os = prev.optionalStages || {};
      if (userSet || os.lint_test === true) return prev; // respect choice / already on
      return Object.assign({}, prev, {
        optionalStages: Object.assign({}, os, { lint_test: true }),
      });
    });
  }, [backendVerified]);

  /** Load library from storage on mount. */
  useEffect(() => {
    async function loadLibrary() {
      try {
        const store = storage;
        let indexResult;
        try { indexResult = await store.get("rtlforge:lib:index"); } catch (e) { return; }
        if (!indexResult) return;
        const index = JSON.parse(indexResult.value);
        const loaded = {};
        for (const mId of (index.modules || [])) {
          try {
            const mr = await store.get("rtlforge:lib:mod:" + mId);
            if (mr) loaded[mId] = { type: "module", mode: "leaf", pkg: JSON.parse(mr.value) };
          } catch (e) { /* skip corrupt entry */ }
        }
        for (const sId of (index.systems || [])) {
          try {
            const sr = await store.get("rtlforge:lib:sys:" + sId);
            if (sr) loaded[sId] = { type: "system", mode: "blackbox", pkg: JSON.parse(sr.value) };
          } catch (e) { /* skip corrupt entry */ }
        }
        if (Object.keys(loaded).length > 0) {
          setImportedPackages((prev) => Object.assign({}, prev, loaded));
        }
      } catch (e) { /* storage unavailable — non-fatal */ }
    }
    loadLibrary();
  }, [storage]);

  // ── 14. Return API ──────────────────────────────────
  return {
    // Reducer state
    state,
    dispatch,

    // Derived memoized values
    activeMod,
    activeStages,
    isMultiModule,
    allModulesComplete,
    ledgerTotals,

    // Derived shortcuts
    modules, instances, projectPhase, decomposition, decompError,
    ledger, totals, integrationState, sharedPackage, pipelineProgress,
    activeModId, stageData, stageErrors, completed, stageRuns, executionPath,
    modName, LAST_STAGE,

    // Dispatch wrappers (setters)
    setActiveModId, setProjectPhase, setModules, setInstances,
    setDecomposition, setDecompError, setSharedPackage,

    // Module helpers
    getModule, updateModule, updateSD, addLedger, markStaleFrom,
    runStageForModule, buildChildInterfaces: buildChildInterfacesLocal,
    moduleProgress,
    moduleProgressSummary,

    // Stage navigation
    nextStageId: nextStageIdFn, stageIdsFrom: stageIdsFromFn, isStageActive,

    // Navigation & processing
    activeStage, setActiveStage,
    viewingStage, setViewingStage,
    processing, propagating, setPropagating,
    loopbackStageId,             // which upstream stage is being looped-back-to
    loopbackModId,               // which module owns the loopback (null in single-mod mode)
    // Multi-stage reflow signal. While a K-to-X reflow chain is in flight,
    // reflowStageIds is the Set<number> of stage IDs currently active in the
    // chain (so the UI can fast-blink all of them simultaneously). null when
    // no chain is in flight.
    reflowStageIds,
    reflowModId,
    // Live progress display data. While a stage is running,
    // liveProgress[stageId] holds the latest events, counts, and timestamps.
    // The stage panel uses this to render in-flight activity instead of
    // "No data yet." Call clearLiveProgress(id) (or with no arg to clear all)
    // when collapsing or resetting.
    liveProgress,
    clearLiveProgress,
    // Per-stage run selection. The dropdown writes
    // here; the stage panel reads here. selectedRunByMod is keyed by
    // module ID so multi-module projects have independent state.
    // Consumers usually want a flat view scoped to the active module:
    //   const sr = selectedRunByMod[activeModId] || {};
    //   const runId = sr[stageId];
    // We export the raw map plus the setter helpers.
    selectedRunByMod,
    setSelectedRun,
    clearSelectedRuns,
    mode, setMode,
    userDesc, setUserDesc,
    designMode, setDesignMode,

    // UI panels
    showSettings, setShowSettings,
    showLedger, setShowLedger,
    showDebug, setShowDebug,

    // Config
    config, setConfig,

    // Actions
    runStage,
    runAllPipelines,
    runIntegrationPipeline,
    proceed,
    abortCurrentStage,
    switchModule,
    handleLaunch,
    handleRerun,
    handleExport,
    handleManualImport,

    // Module registry
    activeRunTab, setActiveRunTab,

    // Decomposition (system mode)
    confirmDecomp, handleBackToIdle, handleRedecompose,

    // Sidebar
    showSidebar, setShowSidebar,
    sidebarSearch, setSidebarSearch,
    sidebarTab, setSidebarTab,

    // Shared package
    viewingSharedPkg, setViewingSharedPkg,
    editingSharedPkg, setEditingSharedPkg,

    // Integration pipeline
    viewingIntegration, setViewingIntegration,
    activeIntStage, setActiveIntStage,

    // Export
    exportModulePackage, exportSystemPackage,
    handleExportAll, handleCopyManifest,

    // Import / Library
    importedPackages, setImportedPackages,
    importPackage, importModuleFromPkg,
    importSystemBlackBox, importSystemExploded,
    importDialog, setImportDialog,
    importFileRef, triggerImport,
    detachModule,
    libraryMatches, setLibraryMatches,
    applyLibraryMatches,
    deletePackageFromLibrary, redownloadPackage, clearLibrary,
    buildAvailableModules,

    // Staleness + propagation
    staleModules, setStaleModules,
    propagateChanges,

    // Warning toggles
    lintWarningsAsErrors, setLintWarningsAsErrors,
    verifyWarningsAsErrors, setVerifyWarningsAsErrors,

    // Backend verification
    backendVerified, setBackendVerified,

    // Manual import
    manualImportDialog, setManualImportDialog,
    manualImportText, setManualImportText,
    manualImportFileRef,

    // Checkpoint & Resume
    projectId, setProjectId,
    pendingResume, setPendingResume,
    checkpointIndex, setCheckpointIndex,
    lastCheckpointTs, saveFlash,
    saveCheckpointNow, resumeFromCheckpoint,
    discardCheckpoint, deleteCurrentCheckpoint,
    listCheckpoints,

    // apiKey-cleared notice on session restore
    apiKeyClearedNotice,
    dismissApiKeyNotice: function() { setApiKeyClearedNotice(false); },

    // Lifecycle
    launchSingleModule,
    resetProject,

    // Escape hatches
    pipeline, services,
  };
}
