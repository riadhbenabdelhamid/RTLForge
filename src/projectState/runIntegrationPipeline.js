import { sharedPkgFileName } from "../pipeline/cliFiles.js";
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
//   4. Stage 1 — int_lint: structural wiring check + real Verilator lint
//      (LLM fallback without a backend), with a FIX LOOP (S3): top-owned
//      errors are repaired inline; errors attributed to one child's file
//      return a reflowTarget for the caller to re-run that module's pipeline
//   5. Stage 2 — int_test: system testbench generation, then real simulation
//      with a FIX LOOP: compile failures route deterministically by file;
//      semantic test failures are LLM-triaged to top / tb / one child
//   6. Stage 3 — int_judge: consolidates lint/verify/per-module judges,
//      dispatches the final integration verdict
//
// Fix loops run ONLY on the real-tooling path (never against LLM estimates),
// are capped by config.maxIntegrationIters, and a repaired top is persisted
// back onto the module (merged) once the measured verdict is clean.
//
// Return shape:
//   { ok: true, lintData, tbData, verData, judgeData, currentHashes }
//   { ok: false, stage: "int_lint"|"int_test"|"int_judge", error: string }
//   { ok: false, stage, reflowTarget: "<modId>", reason, ... }  // child owns it
//   { ok: true, skipped: true }                              // idempotent no-op
//   { ok: true, notApplicable: true }                         // single-module
// ═══════════════════════════════════════════════════════════════════════════

import {
  promptIntegrationLint,
  promptSystemTB,
  promptIntegrationJudge,
  promptIntegrationTriage,
  promptIntegrationTopFix,
  promptSystemTBFix,
  promptSharedPackageFix,
  promptVerify,
} from "../prompts/index.js";
import { CODE_SCHEMA, FIX_SCHEMA } from "../prompts/schemas.js";
import { maybeRepair } from "../pipeline/syntaxRepair.js";
import { runCli, parseCLIOutput, parseTestLine } from "../cli/index.js";
import { extractModuleInterface } from "../utils/svInterface.js";
import { checkSystemWiring } from "../pipeline/wiringCheck.js";
import {
  INTEGRATION_STAGE_DATA_SET,
  INTEGRATION_STAGE_COMPLETE,
  INTEGRATION_STAGE_ERROR_SET,
  MODULE_STAGE_DATA_SET,
  SHARED_PACKAGE_SET,
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
  // Named after the PACKAGE, not a fixed "shared_pkg.sv": Verilator's
  // DECLFILENAME warns when they differ, and under warnings-as-errors that
  // warning failed the entire system simulation on a package that was
  // perfectly good (run 47). 1310cb7 fixed this for the per-module stages;
  // the integration path had its own copy of the name.
  const PKG_FILE = sharedPkgFileName(pkgCode);
  if (pkgCode) designFiles[PKG_FILE] = pkgCode;
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

  // ─── Fix-loop plumbing (S3) ─────────────────────────────────────────────
  // Integration failures must CONVERGE, not halt. The loops below are active
  // only on the REAL-tooling path (fixing against an LLM-estimated verdict is
  // exactly what S1 killed). Routing is deterministic first: structural
  // findings and error FILE attribution beat any model's opinion.
  const maxIntIters = config.maxIntegrationIters == null ? 2 : config.maxIntegrationIters;
  const fileToMod = {};
  childRTLs.forEach(function(c) { fileToMod[c.modName + ".sv"] = c.modName; });
  if (topId) fileToMod[topId + ".sv"] = topId;
  const prevTopFixes = [];
  const prevPkgFixes = [];
  let currentPkg = pkgCode;
  let persistedPkg = pkgCode;

  function buildFiles(top, tb) {
    const files = {};
    if (currentPkg) files[PKG_FILE] = currentPkg;
    childRTLs.forEach(function(c) { if (c.code) files[c.modName + ".sv"] = c.code; });
    if (top && topId) files[topId + ".sv"] = top;
    if (tb != null) files["system_tb.sv"] = tb;
    return files;
  }

  async function llmFixTop(current, findings) {
    const p = promptIntegrationTopFix(current, findings, childViews, instList, prevTopFixes);
    p.config = Object.assign({}, config, { _signal: services.signal || null });
    p.jsonSchema = FIX_SCHEMA;
    const r = await services.callLLM(p);
    appendLedger("int_fix_top", r);
    const d = services.extractJSON(r.text);
    let code = (d && d.code) || null;
    if (!code) return null;
    code = maybeRepair(config, code).code;      // syntax-repair chokepoint
    if (code === current) return null;          // identical output — stall
    if (d.fixes) prevTopFixes.push(...[].concat(d.fixes));
    return code;
  }

  // The shared package has no per-module pipeline, so package-attributed
  // findings are repaired inline here. Same guard set as llmFixTop.
  async function llmFixPkg(findings) {
    const p = promptSharedPackageFix(currentPkg, findings, prevPkgFixes);
    p.config = Object.assign({}, config, { _signal: services.signal || null });
    p.jsonSchema = FIX_SCHEMA;
    const r = await services.callLLM(p);
    appendLedger("int_fix_pkg", r);
    const d = services.extractJSON(r.text);
    let code = (d && d.code) || null;
    if (!code) return null;
    code = maybeRepair(config, code).code;
    if (code === currentPkg) return null;
    if (d.fixes) prevPkgFixes.push(...[].concat(d.fixes));
    return code;
  }

  // Best-known persistence for a repaired package: only once the measured
  // verdict is clean; merged over the prior sharedPackage slot.
  function persistPkg(fixSource) {
    if (currentPkg === persistedPkg || !sharedPackage) return;
    dispatch({
      type: SHARED_PACKAGE_SET,
      sharedPackage: Object.assign({}, sharedPackage, { code: currentPkg, _fixSource: fixSource }),
    });
    persistedPkg = currentPkg;
  }

  let currentTop = topRTL;
  let persistedTop = topRTL;

  // ─── Stage 1: Integration Lint (+ fix loop) ─────────────────────────────
  let lintData;
  let lintFixIters = 0;
  try {
    for (let iter = 0; ; iter++) {
      // Deterministic wiring check FIRST (S2): zero tokens, instant,
      // instance-attributed — the classic integration bugs never reach the
      // LLM or even Verilator unexplained.
      const structural = checkSystemWiring({ topRTL: currentTop, children: childRTLs, instances: instList });

      // Real Verilator lint over the assembled system (S1); the LLM path
      // stays as the no-backend fallback.
      lintData = null;
      if (useCli && designList) {
        const lintCmd = (config.lintCmd || "verilator --lint-only -Wall {RTL}")
          .replace(/\{RTL\}/g, designList);
        const res = await cliExec(config.backendUrl, { command: lintCmd, files: buildFiles(currentTop) },
          services.signal, _cliOpts);
        if (res && !res._error && res.exitCode !== undefined) {
          const parsed = parseCLIOutput(res.stderr);
          lintData = {
            status: parsed.errors.length === 0 ? "PASS" : "FAIL",
            issues: parsed.errors.map(function(e) { return { type: e.code || "ERROR", msg: e.msg, file: e.file, sev: "error" }; })
              .concat(parsed.warnings.map(function(w) { return { type: w.code || "WARNING", msg: w.msg, file: w.file, sev: "warning" }; })),
            summary: parsed.errors.length + " error(s), " + parsed.warnings.length
              + " warning(s) — real Verilator lint over " + Object.keys(designFiles).length + " file(s)",
            cli: true,
            log: (res.stdout || "") + "\n" + (res.stderr || ""),
          };
        }
      }
      if (!lintData) {
        const lintP = promptIntegrationLint(currentTop, childViews, pkgCode, instList);
        lintP.config = Object.assign({}, config, { _signal: services.signal || null });
        const lintR = await services.callLLM(lintP);
        lintData = services.extractJSON(lintR.text);
        appendLedger("int_lint", lintR);
      }
      // Merge structural findings ahead of tool/LLM findings — ground truth
      // with instance attribution, regardless of path.
      if (structural.issues.length > 0) {
        lintData.issues = structural.issues.concat(lintData.issues || []);
        if (structural.issues.some(function(i) { return i.sev === "error"; })) {
          lintData.status = "FAIL";
        }
      }
      lintData.fixIterations = lintFixIters;

      const errs = (lintData.issues || []).filter(function(i) { return i.sev === "error"; });
      if (errs.length === 0) break;
      if (!lintData.cli || iter >= maxIntIters) break;   // no fixing on estimates; cap reached

      // Route: structural findings are wiring by construction → top. Pure
      // Verilator errors route by FILE — package errors FIRST (its syntax
      // errors cascade into every file compiled after it, so child/top
      // attribution is unreliable until the package is clean); then all in
      // one child's file → reflow that module's own pipeline (one fix path
      // per code, no fork).
      const structuralErr = errs.some(function(i) { return i.structural; });
      let target = "top";
      if (!structuralErr) {
        if (errs.some(function(e) { return e.file === PKG_FILE; })) {
          target = "pkg";
        } else {
          const errMods = errs.map(function(e) { return fileToMod[e.file]; }).filter(Boolean);
          const childMods = Array.from(new Set(errMods.filter(function(m) { return m !== topId; })));
          if (childMods.length === 1 && errMods.length > 0 && !errMods.some(function(m) { return m === topId; })) {
            target = childMods[0];
          }
        }
      }
      if (target === "pkg") {
        const fixedPkg = await llmFixPkg(errs.filter(function(e) { return e.file === PKG_FILE; }));
        if (!fixedPkg) break;                             // stall — report what stands
        currentPkg = fixedPkg;
        lintFixIters++;
        continue;
      }
      if (target !== "top") {
        const reason = "system lint errors are attributed to module '" + target + "' — re-run its pipeline, then re-integrate";
        // Evidence for the module's informed re-run (rtl_generate consumes it
        // as _fixContext) — without it the reflow is a cold regen from the
        // same spec, which likely reproduces the same code.
        const reflowEvidence = errs.map(function(e) { return { type: e.type, msg: e.msg }; });
        // The dispatched data carries the routing too, so the GUI can offer
        // the one-click reflow without extra plumbing.
        lintData.reflowTarget = target;
        lintData.reflowReason = reason;
        lintData.reflowEvidence = reflowEvidence;
        dispatch({ type: INTEGRATION_STAGE_DATA_SET, stageId: "int_lint", data: lintData });
        return {
          ok: false, stage: "int_lint", reflowTarget: target, reason, reflowEvidence,
          error: "Integration lint reported errors in " + target,
          lintData, currentHashes,
        };
      }
      const fixed = await llmFixTop(currentTop, errs);
      if (!fixed) break;                                  // stall — report what stands
      currentTop = fixed;
      lintFixIters++;
    }

    dispatch({ type: INTEGRATION_STAGE_DATA_SET, stageId: "int_lint", data: lintData });
    dispatch({ type: INTEGRATION_STAGE_COMPLETE, stageId: "int_lint" });

    const hasLintErrors = (lintData.issues || []).some(function(i) { return i.sev === "error"; });
    if (hasLintErrors) {
      return { ok: false, stage: "int_lint", error: "Integration lint reported errors", lintData, currentHashes };
    }
    // Best-known persistence: the top was repaired AND now lints clean —
    // write it back onto the module (merged over the prior slot, the
    // ownership lesson) so verify/export/checkpoints see the fixed system.
    if (lintFixIters > 0 && currentTop !== persistedTop && topMod) {
      dispatch({
        type: MODULE_STAGE_DATA_SET, modId: topId, stageId: 4,
        data: Object.assign({}, topMod.stageData && topMod.stageData[4], {
          code: currentTop, _fixSource: "fixed post int_lint",
        }),
      });
      persistedTop = currentTop;
    }
    persistPkg("fixed post int_lint");
  } catch (e) {
    const msg = (e && e.message) || String(e);
    dispatch({ type: INTEGRATION_STAGE_ERROR_SET, stageId: "int_lint", message: msg });
    return { ok: false, stage: "int_lint", error: msg, currentHashes };
  }

  // ─── Stage 2: System Testbench + real sim (+ fix loop) ──────────────────
  let tbData, verData;
  let simFixIters = 0;
  const prevTbFixes = [];
  try {
    // Generate the system TB once (against the current — possibly repaired —
    // top); the loop below repairs it rather than regenerating.
    const tbP = promptSystemTB(
      currentTop,
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
    let currentTb = tbData.code || null;

    async function llmFixTb(current, failures) {
      const topHeader = extractModuleInterface(currentTop, topId) || currentTop;
      const p = promptSystemTBFix(current, failures, topHeader, prevTbFixes);
      p.config = Object.assign({}, config, { _signal: services.signal || null });
      p.jsonSchema = FIX_SCHEMA;
      const r = await services.callLLM(p);
      appendLedger("int_fix_tb", r);
      const d = services.extractJSON(r.text);
      let code = (d && d.code) || null;
      if (!code) return null;
      code = maybeRepair(config, code).code;
      if (code === current) return null;        // identical output — stall
      if (d.fixes) prevTbFixes.push(...[].concat(d.fixes));
      return code;
    }

    // Real system simulation (S1): compile top + children + package with the
    // system TB and RUN it — measured pass/fail from the same [PASS]/[FAIL]
    // markers the per-module verify parses. The LLM estimate below stays as
    // the no-backend fallback, and — like lint — is never "fixed" against.
    if (useCli && designList && currentTb) {
      const simCmds = (config.simCmds || "").split("\n")
        .filter(function(c) { return c.trim(); })
        .map(function(c) {
          return c.replace(/\{RTL\}\.sim/g, "system.sim")
            .replace(/\{RTL\}/g, designList)
            .replace(/\{TB\}/g, "system_tb.sv");
        });
      for (let iter = 0; simCmds.length > 0; iter++) {
        const res = await cliExec(config.backendUrl, { commands: simCmds, files: buildFiles(currentTop, currentTb) },
          services.signal, _cliOpts);
        if (!res || res._error || res.exitCode === undefined) break;   // backend hiccup → estimate fallback
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
          fixIterations: simFixIters,
        };
        if (verData.fail === 0 || iter >= maxIntIters) break;

        // Route the failure. Deterministic first: a COMPILE failure names its
        // file — no model opinion needed. Semantic test failures go to LLM
        // triage (top wiring vs TB expectations vs one child's internals).
        let target = null;
        let evidence;
        let triageReason = null;
        // Judge by CLASSIFIED errors, not by a "%Error" substring: Verilator
        // prints "%Error: Exiting due to N warning(s)" under -Wall, so the
        // raw match routed a warnings-only build into the repair path and
        // handed llmFixTop an EMPTY findings list — asking the model to fix
        // nothing, exactly as the shared-package check did before 093ea40
        // (measured, run 47, third sighting of this pattern).
        const _perr = parseCLIOutput(out).errors;
        if (tests.length === 0 && _perr.length > 0) {
          const perr = _perr;
          evidence = perr.slice(0, 10);
          // Package errors first — they cascade into every later file.
          if (perr.some(function(e) { return e.file === PKG_FILE; })) target = "pkg";
          else {
            const f = (perr.find(function(e) { return e.file; }) || {}).file;
            if (f === "system_tb.sv") target = "tb";
            else if (fileToMod[f] && fileToMod[f] !== topId) target = fileToMod[f];
            else target = "top";
          }
        } else if (verData._noMarkers) {
          // Sim ran clean but the TB never printed markers — the marker
          // protocol is the TB's contract, so this is a TB defect.
          target = "tb";
          evidence = [{ msg: "simulation completed but the testbench emitted no [PASS]/[FAIL] markers" }];
        } else {
          evidence = { failures: tests.filter(function(t) { return t.st !== "PASS"; }), logTail: out.split("\n").slice(-30).join("\n") };
          const trP = promptIntegrationTriage(evidence, currentTop, childViews, instList);
          trP.config = Object.assign({}, config, { _signal: services.signal || null });
          const trR = await services.callLLM(trP);
          appendLedger("int_triage", trR);
          const trD = services.extractJSON(trR.text);
          target = trD && trD.target;
          triageReason = (trD && trD.reason) || null;
          const valid = target === "top" || target === "tb" || fileToMod[target + ".sv"];
          if (!valid) target = "tb";   // garbage triage → cheapest fix path
        }

        if (target === "pkg") {
          const fixedPkg = await llmFixPkg(Array.isArray(evidence)
            ? evidence.filter(function(e) { return e.file === PKG_FILE; })
            : evidence);
          if (!fixedPkg) break;                            // stall — report what stands
          currentPkg = fixedPkg;
          simFixIters++;
          continue;
        }
        if (target !== "top" && target !== "tb") {
          const reason = "system simulation failure is attributed to module '" + target + "' — re-run its pipeline, then re-integrate";
          // Normalize the branch-shaped evidence for the module's informed
          // re-run: compile errors carry their own messages; semantic
          // failures become test-level findings plus the triage verdict.
          const reflowEvidence = Array.isArray(evidence)
            ? evidence.map(function(e) { return { type: e.code || e.type || "ERROR", msg: e.msg }; })
            : (evidence.failures || []).map(function(t) {
                return { type: "TEST_FAIL", msg: "system-level test '" + t.name + "' failed against the integrated design" };
              }).concat(triageReason ? [{ type: "TRIAGE", msg: triageReason }] : []);
          dispatch({
            type: INTEGRATION_STAGE_DATA_SET,
            stageId: "int_test",
            data: { code: currentTb, verify: verData, fixIterations: simFixIters, reflowTarget: target, reflowReason: reason, reflowEvidence },
          });
          return {
            ok: false, stage: "int_test", reflowTarget: target, reason, reflowEvidence,
            error: "System simulation failed in " + target,
            lintData, tbData, verData, currentHashes,
          };
        }
        const fixed = target === "top"
          ? await llmFixTop(currentTop, evidence)
          : await llmFixTb(currentTb, evidence);
        if (!fixed) break;                                 // stall — report what stands
        if (target === "top") currentTop = fixed;
        else currentTb = fixed;
        simFixIters++;
      }
    }
    if (!verData) {
      const verP = promptVerify(currentTb || "", currentTop, topSpec);
      verP.config = Object.assign({}, config, { _signal: services.signal || null });
      const verR = await services.callLLM(verP);
      verData = services.extractJSON(verR.text);
      appendLedger("int_verify", verR);
    }

    dispatch({
      type: INTEGRATION_STAGE_DATA_SET,
      stageId: "int_test",
      data: { code: currentTb, verify: verData, fixIterations: simFixIters },
    });
    dispatch({ type: INTEGRATION_STAGE_COMPLETE, stageId: "int_test" });
    tbData = Object.assign({}, tbData, { code: currentTb });

    // Best-known persistence for a top repaired DURING the sim loop: only
    // when the measured verdict is now clean (merged over the prior slot).
    if (verData.cli && verData.fail === 0 && currentTop !== persistedTop && topMod) {
      dispatch({
        type: MODULE_STAGE_DATA_SET, modId: topId, stageId: 4,
        data: Object.assign({}, topMod.stageData && topMod.stageData[4], {
          code: currentTop, _fixSource: "fixed post int_test",
        }),
      });
      persistedTop = currentTop;
    }
    if (verData.cli && verData.fail === 0) persistPkg("fixed post int_test");
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
