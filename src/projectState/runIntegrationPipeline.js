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
import { CODE_SCHEMA } from "../prompts/schemas.js";
import { runCli, parseCLIOutput, parseTestLine } from "../cli/index.js";
import { extractModuleInterface } from "../utils/svInterface.js";
import { checkSystemWiring } from "../pipeline/wiringCheck.js";
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

  // ── Real-tooling setup (SoC roadmap S1) ──
  // When a backend is configured, int_lint and the system sim run REAL
  // Verilator over the assembled file set; the LLM paths below remain the
  // fallback (the per-module lint's own cli-vs-estimate duality). Insertion
  // order matters: package first, children, top last.
  const cliExec = services.runCli || runCli;   // injected in tests
  const useCli = !!config.backendUrl;
  const _cliOpts = {
    retries: config.cliRetryCount == null ? 1 : config.cliRetryCount,
    timeoutMs: (config.backendTimeoutSec || 600) * 1000,
    logger: services.logger || null,
  };
  const designFiles = {};
  if (pkgCode) designFiles["shared_pkg.sv"] = pkgCode;
  childRTLs.forEach(function(c) { if (c.code) designFiles[c.modName + ".sv"] = c.code; });
  if (topRTL && topId) designFiles[topId + ".sv"] = topRTL;
  const designList = Object.keys(designFiles).join(" ");

  // Interface views for the LLM prompts (SoC roadmap S4): headers only —
  // full sources go to Verilator, which has no context limit.
  const childViews = childRTLs.map(function(c) {
    return {
      modName: c.modName,
      code: extractModuleInterface(c.code, c.modName)
        || ("// interface unavailable for " + c.modName),
    };
  });

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
    // Deterministic wiring check FIRST (S2): zero tokens, instant, and its
    // findings are attributed per instance — the classic integration bugs
    // (bad port names, unconnected inputs, bogus overrides, missing
    // instances) never reach the LLM or even Verilator unexplained.
    const structural = checkSystemWiring({ topRTL, children: childRTLs, instances: instList });

    // Real Verilator lint over the assembled system (S1). The verdict is
    // MEASURED, not estimated; the LLM path below stays as the no-backend
    // fallback.
    if (useCli && designList) {
      const lintCmd = (config.lintCmd || "verilator --lint-only -Wall {RTL}")
        .replace(/\{RTL\}/g, designList);
      const res = await cliExec(config.backendUrl, { command: lintCmd, files: designFiles },
        services.signal, _cliOpts);
      if (res && !res._error && res.exitCode !== undefined) {
        const parsed = parseCLIOutput(res.stderr);
        lintData = {
          status: parsed.errors.length === 0 ? "PASS" : "FAIL",
          issues: parsed.errors.map(function(e) { return { type: e.code || "ERROR", msg: e.msg, sev: "error" }; })
            .concat(parsed.warnings.map(function(w) { return { type: w.code || "WARNING", msg: w.msg, sev: "warning" }; })),
          summary: parsed.errors.length + " error(s), " + parsed.warnings.length
            + " warning(s) — real Verilator lint over " + Object.keys(designFiles).length + " file(s)",
          cli: true,
          log: (res.stdout || "") + "\n" + (res.stderr || ""),
        };
      }
    }
    if (!lintData) {
      const lintP = promptIntegrationLint(topRTL, childViews, pkgCode, instList);
      lintP.config = Object.assign({}, config, { _signal: services.signal || null });
      const lintR = await services.callLLM(lintP);
      lintData = services.extractJSON(lintR.text);
      appendLedger("int_lint", lintR);
    }
    // Merge the structural findings ahead of tool/LLM findings — they carry
    // instance attribution and are ground truth regardless of path.
    if (structural.issues.length > 0) {
      lintData.issues = structural.issues.concat(lintData.issues || []);
      if (structural.issues.some(function(i) { return i.sev === "error"; })) {
        lintData.status = "FAIL";
      }
    }
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
    tbP.jsonSchema = CODE_SCHEMA;   // structured outputs (S4)
    const tbR = await services.callLLM(tbP);
    tbData = services.extractJSON(tbR.text);
    appendLedger("int_test", tbR);

    // Real system simulation (S1): compile top + children + package with the
    // generated system TB and RUN it — measured pass/fail from the same
    // [PASS]/[FAIL] markers the per-module verify parses. The LLM estimate
    // below stays as the no-backend fallback.
    if (useCli && designList && tbData.code) {
      const simFiles = Object.assign({}, designFiles, { "system_tb.sv": tbData.code });
      const simCmds = (config.simCmds || "").split("\n")
        .filter(function(c) { return c.trim(); })
        .map(function(c) {
          return c.replace(/\{RTL\}\.sim/g, "system.sim")
            .replace(/\{RTL\}/g, designList)
            .replace(/\{TB\}/g, "system_tb.sv");
        });
      if (simCmds.length > 0) {
        const res = await cliExec(config.backendUrl, { commands: simCmds, files: simFiles },
          services.signal, _cliOpts);
        if (res && !res._error && res.exitCode !== undefined) {
          const out = (res.stdout || "") + "\n" + (res.stderr || "");
          // parseTestLine returns {name, status, cyc, ms}; the pipeline-wide
          // test shape uses `st` (per-module verify, classifiers, ledger).
          const tests = out.split("\n").map(parseTestLine).filter(Boolean)
            .map(function(t) { return { name: t.name, st: t.status, cyc: t.cyc, ms: t.ms }; });
          const pass = tests.filter(function(t) { return t.st === "PASS"; }).length;
          verData = {
            sim: "Verilator (CLI)",
            total: tests.length || 1,
            pass,
            fail: (tests.length || 1) - pass,
            tests,
            cli: true,
            _noMarkers: tests.length === 0 && res.exitCode === 0,
            log: out,
          };
        }
      }
    }
    if (!verData) {
      const verP = promptVerify(tbData.code || "", topRTL, topSpec);
      verP.config = Object.assign({}, config, { _signal: services.signal || null });
      const verR = await services.callLLM(verP);
      verData = services.extractJSON(verR.text);
      appendLedger("int_verify", verR);
    }

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
