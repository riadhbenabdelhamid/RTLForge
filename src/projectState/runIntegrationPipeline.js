// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// projectState/runIntegrationPipeline — System-level integration driver
//
// Executes the three integration stages (int_lint → int_test → int_judge)
// for multi-module systems after all per-module pipelines have completed.
//
// What it does:
//   1. Guards: returns early if not multi-module
//   2. Change detection: skips re-run if no module contentHash has changed
//      since the last invocation (caller maintains lastHashes)
//   3. Extracts top-module RTL + spec, child RTLs, instance list, shared pkg
//   4. Stage 1 — int_lint: prompt → callLLM → extractJSON → dispatch
//      - If lint has any "error"-severity issues, halt
//   5. Stage 2 — int_test: system testbench prompt → callLLM, then a
//      verify-estimate prompt → callLLM, dispatching both
//   6. Stage 3 — int_judge: consolidates lint/verify/per-module judges,
//      dispatches the final integration verdict
//
// Return shape:
//   { ok: true, lintData, tbData, verData, judgeData, currentHashes }
//   { ok: false, stage: "int_lint"|"int_test"|"int_judge", error: string }
//   { ok: true, skipped: true }                              // idempotent no-op
//   { ok: true, notApplicable: true }                         // single-module
// ═══════════════════════════════════════════════════════════════════════════

import {
  promptIntegrationLint,
  promptSystemTB,
  promptIntegrationJudge,
  promptVerify,
} from "../prompts/index.js";
import {
  INTEGRATION_STAGE_DATA_SET,
  INTEGRATION_STAGE_COMPLETE,
  INTEGRATION_STAGE_ERROR_SET,
  LEDGER_APPEND,
} from "./actions.js";

/**
 * Execute the integration pipeline for a multi-module system.
 *
 * @param {object} args
 * @param {object} args.reducerState   - Current snapshot
 * @param {object} args.uiState        - { config }
 * @param {object} args.services
 * @param {function} args.services.callLLM      - Injected LLM call
 * @param {function} args.services.extractJSON  - Injected JSON extractor
 * @param {function} [args.services.estimateCost]
 * @param {AbortSignal} [args.services.signal]
 * @param {object}   [args.services.logger]
 * @param {function} args.dispatch
 * @param {object} [args.lastHashes]   - Prior hashes for change detection
 * @returns {Promise<object>}          - See module header for shape
 */
export async function runIntegrationPipeline(args) {
  const reducerState = args.reducerState;
  const uiState      = args.uiState || {};
  const services     = args.services || {};
  const dispatch     = args.dispatch;
  const lastHashes   = args.lastHashes || {};
  const config       = uiState.config || {};

  if (!reducerState) throw new Error("runIntegrationPipeline: reducerState is required");
  if (typeof services.callLLM !== "function") {
    throw new Error("runIntegrationPipeline: services.callLLM is required");
  }
  if (typeof services.extractJSON !== "function") {
    throw new Error("runIntegrationPipeline: services.extractJSON is required");
  }
  if (typeof dispatch !== "function") {
    throw new Error("runIntegrationPipeline: dispatch must be a function");
  }

  const modules      = reducerState.modules || {};
  const instances    = reducerState.instances || {};
  const decomposition = reducerState.decomposition || null;
  const sharedPackage = reducerState.sharedPackage || null;

  // ── Guard: single-module is not applicable ──
  const isMultiModule = Object.keys(modules).length > 1;
  if (!isMultiModule) {
    return { ok: true, notApplicable: true };
  }

  // ── Change detection: skip if nothing has changed since last run ──
  const currentHashes = {};
  let anyChanged = false;
  Object.keys(modules).forEach(function(mId) {
    const h = modules[mId] ? modules[mId].contentHash : null;
    currentHashes[mId] = h;
    if (h !== lastHashes[mId]) anyChanged = true;
  });
  // Added/removed modules also count as changes
  if (Object.keys(currentHashes).length !== Object.keys(lastHashes).length) {
    anyChanged = true;
  }
  if (!anyChanged && Object.keys(lastHashes).length > 0) {
    if (services.logger && services.logger.info) {
      services.logger.info("[runIntegrationPipeline] All module hashes unchanged — skipping");
    }
    return { ok: true, skipped: true, currentHashes };
  }

  // ── Extract top module data ──
  const topId = decomposition ? decomposition.topModule : null;
  const topMod = topId ? modules[topId] : null;
  const topRTL =
    topMod && topMod.stageData && topMod.stageData[4]
      ? topMod.stageData[4].code || ""
      : "";
  const topSpec =
    topMod && topMod.stageData && topMod.stageData[2]
      ? topMod.stageData[2]
      : { iface: [], params: [], requirements: [] };
  const childRTLs = Object.keys(modules)
    .filter(function(mId) { return mId !== topId; })
    .map(function(mId) {
      const mod = modules[mId];
      return {
        modName: mId,
        code:
          mod && mod.stageData && mod.stageData[4]
            ? mod.stageData[4].code || ""
            : "",
      };
    });
  const instList = Object.values(instances);
  const pkgCode = sharedPackage ? sharedPackage.code : null;

  // Collect per-module judge results (stage 9)
  const perModuleJudges = Object.keys(modules).map(function(mId) {
    const mod = modules[mId];
    const judge = mod && mod.stageData && mod.stageData[9] ? mod.stageData[9] : null;
    return {
      modId: mId,
      score: judge ? judge.score : 0,
      overall: judge ? judge.overall : "N/A",
    };
  });

  function appendLedger(stage, r) {
    if (!r) return;
    if (!(r.tokensIn || r.tokensOut || r.latencyMs)) return;
    const cost = services.estimateCost
      ? services.estimateCost(r.tokensIn, r.tokensOut, r.provider || config.provider)
      : 0;
    dispatch({
      type: LEDGER_APPEND,
      entry: {
        stage,
        model: r.model,
        provider: r.provider || config.provider,
        tIn: r.tokensIn,
        tOut: r.tokensOut,
        cost,
        ms: r.latencyMs,
      },
    });
  }

  // ─── Stage 1: Integration Lint ──────────────────────────────────────────
  let lintData;
  try {
    const lintP = promptIntegrationLint(topRTL, childRTLs, pkgCode, instList);
    lintP.config = Object.assign({}, config, { _signal: services.signal || null });
    const lintR = await services.callLLM(lintP);
    lintData = services.extractJSON(lintR.text);
    appendLedger("int_lint", lintR);
    dispatch({ type: INTEGRATION_STAGE_DATA_SET, stageId: "int_lint", data: lintData });
    dispatch({ type: INTEGRATION_STAGE_COMPLETE, stageId: "int_lint" });

    // Halt if any error-severity issues
    const hasLintErrors = (lintData.issues || []).some(function(i) { return i.sev === "error"; });
    if (hasLintErrors) {
      return { ok: false, stage: "int_lint", error: "Integration lint reported errors", lintData, currentHashes };
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    dispatch({ type: INTEGRATION_STAGE_ERROR_SET, stageId: "int_lint", message: msg });
    return { ok: false, stage: "int_lint", error: msg, currentHashes };
  }

  // ─── Stage 2: System Testbench + Verify Estimate ────────────────────────
  let tbData, verData;
  try {
    const tbP = promptSystemTB(
      topRTL,
      topSpec,
      instList,
      (decomposition && decomposition.interconnects) || [],
      topId,
    );
    tbP.config = Object.assign({}, config, { _signal: services.signal || null });
    const tbR = await services.callLLM(tbP);
    tbData = services.extractJSON(tbR.text);
    appendLedger("int_test", tbR);

    const verP = promptVerify(tbData.code || "", topRTL, topSpec);
    verP.config = Object.assign({}, config, { _signal: services.signal || null });
    const verR = await services.callLLM(verP);
    verData = services.extractJSON(verR.text);
    appendLedger("int_verify", verR);

    dispatch({
      type: INTEGRATION_STAGE_DATA_SET,
      stageId: "int_test",
      data: { code: tbData.code, verify: verData },
    });
    dispatch({ type: INTEGRATION_STAGE_COMPLETE, stageId: "int_test" });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    dispatch({ type: INTEGRATION_STAGE_ERROR_SET, stageId: "int_test", message: msg });
    return { ok: false, stage: "int_test", error: msg, lintData, currentHashes };
  }

  // ─── Stage 3: Integration Judge ─────────────────────────────────────────
  let judgeData;
  try {
    const judgeP = promptIntegrationJudge(
      lintData || { status: "N/A", issues: [], summary: "N/A" },
      verData || null,
      perModuleJudges,
    );
    judgeP.config = Object.assign({}, config, { _signal: services.signal || null });
    const judgeR = await services.callLLM(judgeP);
    judgeData = services.extractJSON(judgeR.text);
    appendLedger("int_judge", judgeR);
    dispatch({ type: INTEGRATION_STAGE_DATA_SET, stageId: "int_judge", data: judgeData });
    dispatch({ type: INTEGRATION_STAGE_COMPLETE, stageId: "int_judge" });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    dispatch({ type: INTEGRATION_STAGE_ERROR_SET, stageId: "int_judge", message: msg });
    return { ok: false, stage: "int_judge", error: msg, lintData, tbData, verData, currentHashes };
  }

  return { ok: true, lintData, tbData, verData, judgeData, currentHashes };
}
