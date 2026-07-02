// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// formal_verify — bounded model checking of the bound SVA (roadmap #8)
//
// formal_props properties were only ever SIMULATED (svaBind) — exercised by
// whatever stimulus the TB drives, which is not verification. This optional
// stage (order 67, default off) runs real BMC on the same bound checker via
// SymbiYosys and attaches PASS/FAIL(+counterexample) per run. A FAIL includes
// a compact signal window from the counterexample VCD (reusing vcdWindow, #7).
//
// v1 scope (stated in docs/improvement-roadmap.md): detection + counterexample
// surfacing. Wiring failures into an automated fix loop is the follow-up —
// the counterexample already lands where a human or the verify fix prompt can
// read it. No LLM calls; the tool does the proving.
//
// Browser safety: the node-only runner is imported with the same @vite-ignore
// variable-specifier trick as localExecutor; when the import or `sby` is
// unavailable the stage SKIPs, never fails the run.
// ═══════════════════════════════════════════════════════════════════════════

import { buildSvaChecker } from "../svaBind.js";
import { signalWindow } from "../vcdWindow.js";
import { createLogger } from "../log.js";

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
  const checker = buildSvaChecker(st.formal_props, st.spec, moduleName);
  if (!checker || checker.included.length === 0) {
    return skip("no bindable formal properties (run the SVA Props stage first)");
  }

  let runner;
  try {
    runner = await import(/* @vite-ignore */ FORMAL_RUNNER_MODULE);
  } catch (_e) {
    return skip("formal runner unavailable in this environment");
  }
  if (!runner.sbyAvailable()) {
    return skip("`sby` (SymbiYosys) not found on PATH — install oss-cad-suite or run `rtlforge doctor`");
  }

  const depth = st._config.formalDepth || 15;
  appendLog("Formal verify — BMC", checker.included.length + " propert"
    + (checker.included.length === 1 ? "y" : "ies") + " bound, depth " + depth + " (sby/smtbmc)…");

  const res = runner.runBmc({
    source: rtl + "\n" + checker.text,
    top: moduleName,
    depth,
    timeoutMs: (st._config.formalTimeoutSec || 120) * 1000,
  });

  let cexWindow = null;
  if (res.status === "FAIL" && res.cexVcd) {
    try { cexWindow = signalWindow(res.cexVcd, {}) || null; } catch (_e) { cexWindow = null; }
  }

  appendLog("Formal verify — " + res.status,
    res.status === "PASS" ? "All bound properties hold to depth " + depth + " (" + Math.round(res.elapsedMs / 1000) + "s)."
      : res.status === "FAIL" ? "A property is violated — counterexample " + (cexWindow ? "extracted below.\n" + cexWindow : "trace unavailable.")
      : "BMC did not complete (" + res.status + "):\n" + res.log);

  return {
    formal_verify: {
      status: res.status,
      depth,
      properties: checker.included.map(function(p) { return p.id || p.name || "prop"; }),
      skipped: checker.skipped,
      log: res.log,
      cexWindow,
      elapsedMs: res.elapsedMs,
      _llms: [],
    },
  };
}
