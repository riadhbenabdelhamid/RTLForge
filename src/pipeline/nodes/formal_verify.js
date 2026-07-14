// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// formal_verify — bounded model checking of the bound SVA + fix loop
// (roadmap #8, incl. the follow-up fix loop)
//
// formal_props properties were only ever SIMULATED (svaBind) — exercised by
// whatever stimulus the TB drives, which is not verification. This optional
// stage (order 67, default off) proves/refutes the same bound checker with
// SymbiYosys BMC. On a violation, the counterexample signal window (reusing
// vcdWindow, #7) grounds an LLM fix loop: fix → syntax-repair chokepoint →
// re-check, up to maxFormalIters. Fixed code is mirrored onto rtl_generate
// ONLY when the check reaches PASS (best-known semantics; the ownership merge
// from #4 keeps the gen slot's telemetry intact).
//
// Browser safety: the node-only runner is imported with the same @vite-ignore
// variable-specifier trick as localExecutor (tests inject st._services.
// formalRunner). Every unavailable precondition SKIPs — never fails a run.
// ═══════════════════════════════════════════════════════════════════════════

import { buildSvaChecker, svaCheckerToImmediate, inlineFormalAsserts, formalResetAssume } from "../svaBind.js";
import { signalWindow } from "../vcdWindow.js";
import { createLogger } from "../log.js";
import { callLLM, extractJSON } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { promptRTLFromFormalFail } from "../../prompts/index.js";
import { FIX_SCHEMA } from "../../prompts/schemas.js";
import { maybeRepairWithLog } from "../syntaxRepair.js";
import { tagFixes } from "../fixLoopHelpers.js";

const FORMAL_RUNNER_MODULE = "../../cli/formalRunner.js";

export async function formalVerifyNode(st) {
  const appendLog = createLogger(st._onLog, "thin");
  const moduleName = (st.elicit && st.elicit.modName) || "module";
  const rtl = (st.rtl_generate && st.rtl_generate.code) || "";

  function skip(reason) {
    appendLog("Formal verify — skipped", reason);
    return { formal_verify: { status: "SKIPPED", reason, _llms: [] } };
  }

  if (!rtl) return skip("no RTL to check");
  const _diag = {};
  const checker = buildSvaChecker(st.formal_props, st.spec, moduleName, _diag);
  if (!checker || checker.included.length === 0) {
    const _why = (_diag.skipped || []).map(function(s) { return s.id + ": " + s.reason; }).join("; ");
    return skip("no bindable formal properties"
      + (_why ? " — " + _why : " (run the SVA Props stage first)"));
  }
  // Open-source yosys cannot parse concurrent SVA — translate the checker's
  // simple forms to clocked immediate assertions; sequence forms stay
  // sim-checked only (svaCheckerToImmediate, measured live: yosys dies with
  // "unexpected '@'" on the raw checker).
  const formalChecker = svaCheckerToImmediate(checker.text);
  if (formalChecker.translated === 0) {
    return skip("no formally-checkable properties — the bound SVA uses sequence forms"
      + " yosys cannot express as immediate assertions (they remain sim-checked)");
  }

  let runner = st._services && st._services.formalRunner;
  if (!runner) {
    try {
      runner = await import(/* @vite-ignore */ FORMAL_RUNNER_MODULE);
    } catch (_e) {
      return skip("formal runner unavailable in this environment");
    }
  }
  if (!runner.sbyAvailable()) {
    return skip("`sby` (SymbiYosys) not found on PATH — install oss-cad-suite");
  }

  // Depth: config floor, raised to the props stage's suggestion when it
  // knows the deepest interesting state (a DEPTH-entry fill needs DEPTH+
  // cycles — the default 15 cannot reach a 16-deep FIFO's full boundary).
  // Clamped so a hallucinated number cannot stall the solver.
  const _suggested = Math.min(parseInt((st.formal_props && st.formal_props.suggestedDepth) || 0, 10) || 0, 64);
  const depth = Math.max(st._config.formalDepth || 15, _suggested);
  const timeoutMs = (st._config.formalTimeoutSec || 120) * 1000;
  const maxFixIters = st._config.maxFormalIters == null ? 2 : st._config.maxFormalIters;
  const propIds = checker.included.map(function(p) { return p.id || p.name || "prop"; });
  appendLog("Formal verify — BMC", propIds.length + " propert"
    + (propIds.length === 1 ? "y" : "ies") + " bound, depth " + depth + " (sby/smtbmc)…");

  const allLlms = [];
  const previousFixes = [];
  let currentRtl = rtl;
  let res = null;
  let cexWindow = null;
  let fixIterations = 0;

  for (let iter = 0; ; iter++) {
    // Inline (never bind) — yosys silently ignores `bind`, which made a buggy
    // design "pass" vacuously through the bound checker. Aux model lines go
    // in FIRST (f_ declarations before the assertions that read them), and
    // BMC starts from asserted reset — without that assumption the solver
    // refutes modeled-state properties from unreachable initial values.
    const _rstAssume = formalResetAssume(st.spec);
    res = runner.runBmc({
      source: inlineFormalAsserts(currentRtl,
        (checker.auxLines || [])
          .concat(_rstAssume ? [_rstAssume] : [])
          .concat(formalChecker.assertLines)),
      top: moduleName, depth, timeoutMs,
    });
    cexWindow = null;
    if (res.status === "FAIL" && res.cexVcd) {
      try { cexWindow = signalWindow(res.cexVcd, {}) || null; } catch (_e) { cexWindow = null; }
    }
    if (res.status !== "FAIL" || iter >= maxFixIters) break;

    // ── Fix loop: the counterexample grounds a minimal-diff repair ──
    appendLog("Formal fix — iteration " + (iter + 1) + "/" + maxFixIters,
      "Property violated at depth ≤ " + depth + (cexWindow ? "; counterexample:\n" + cexWindow : "") );
    let fp = promptRTLFromFormalFail(currentRtl,
      { properties: propIds, cexWindow, log: res.log }, st.spec, st.elicit, previousFixes);
    fp = await applySkillsToPrompt(fp, st, "rtl_generate");
    const _sc = getStageConfig(st._config, "rtl_fix");
    fp.config = _sc;
    fp.maxTokens = _sc._maxTokens;
    fp.jsonSchema = FIX_SCHEMA;
    fp.onChunk = function(t, m) { appendLog.stream("Formal fix output (iter " + (iter + 1) + ")", t); if (st._onLog) st._onLog(appendLog.buf, m); };
    const fr = await callLLM(fp);
    allLlms.push(Object.assign({ stage: "formal-fix-iter" + (iter + 1) }, fr));
    const fd = extractJSON(fr.text, fr);
    let candidate = (fd && fd.code) || currentRtl;
    candidate = maybeRepairWithLog(st._config, candidate, appendLog).code;
    if (candidate === currentRtl) {
      appendLog("⚠ Formal fix stalled", "The model returned identical code — stopping the loop.");
      break;
    }
    previousFixes.push(...tagFixes((fd && fd.fixes) || [], iter + 1));
    currentRtl = candidate;
    fixIterations++;
  }

  appendLog("Formal verify — " + res.status,
    res.status === "PASS"
      ? "All bound properties hold to depth " + depth
        + (fixIterations > 0 ? " after " + fixIterations + " fix iteration(s)" : "")
        + " (" + Math.round(res.elapsedMs / 1000) + "s)."
      : res.status === "FAIL"
        ? "A property remains violated after " + fixIterations + " fix iteration(s)."
          + (cexWindow ? "\n" + cexWindow : "")
        : "BMC did not complete (" + res.status + "):\n" + res.log);

  // ── Opportunistic unbounded proof (k-induction) ───────────────────────
  // Only after a BMC PASS, and only the PASS result is consumed: an
  // induction PASS is mathematically unbounded (holds for ALL time, no
  // depth caveat) so we upgrade the verdict; an induction failure says
  // NOTHING about the design (correct designs routinely fail induction
  // from physically unreachable states), so it is logged and DISCARDED —
  // it never lowers the verdict and never reaches the fix loop.
  let proven = false;
  let proveStatus = null;
  if (res.status === "PASS" && st._config.formalProve !== false) {
    const _proveRes = runner.runBmc({
      source: inlineFormalAsserts(currentRtl,
        (checker.auxLines || [])
          .concat(formalResetAssume(st.spec) ? [formalResetAssume(st.spec)] : [])
          .concat(formalChecker.assertLines)),
      top: moduleName, depth, timeoutMs, mode: "prove",
    });
    proveStatus = _proveRes.status;
    proven = _proveRes.status === "PASS";
    appendLog("Unbounded proof attempt — " + (proven ? "PROVEN" : "not proven"),
      proven
        ? "k-induction closed: every bound property holds for ALL time — the "
          + "depth-" + depth + " bound no longer applies ("
          + Math.round(_proveRes.elapsedMs / 1000) + "s)."
        : "Induction did not close (" + _proveRes.status + "). This is NOT a "
          + "defect signal — correct designs routinely fail induction from "
          + "unreachable states. The bounded verdict (PASS to depth " + depth
          + ") stands unchanged; the induction result is discarded.");
  }

  const out = {
    formal_verify: {
      status: res.status,
      depth,
      proven,        // true only when k-induction closed — unbounded result
      proveStatus,   // raw prove-task status (null when not attempted)
      properties: propIds,
      skipped: checker.skipped,
      formalSkipped: formalChecker.skippedFormal,   // sequence forms, sim-checked only
      fixIterations,
      log: res.log,
      cexWindow,
      elapsedMs: res.elapsedMs,
      _llms: allLlms.slice(),
    },
    _llms: allLlms.slice(),
    _llm: allLlms.length > 0 ? allLlms[allLlms.length - 1]
      : { stage: "formal_verify", tokensIn: 0, tokensOut: 0, latencyMs: 0, model: "sby", provider: "cli" },
  };
  // Best-known semantics: forward the repaired RTL only when the proof now
  // PASSES. A non-owner write — the ownership merge (#4) preserves the gen
  // slot's _syntaxRepairs/_bestOfN/_llms.
  if (fixIterations > 0 && res.status === "PASS") {
    out.rtl_generate = { code: currentRtl, _fixSource: "fixed post formal_verify" };
  }
  return out;
}
