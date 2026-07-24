// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// triageInvestigator — waveform-grounded verify triage (run 18 autopsy)
//
// Run 18 measured the failure mode this replaces: one-shot LLM triage looked
// at 21 failing checks and blamed the testbench five times in a row while a
// one-line RTL bug (dout loaded unconditionally) sat untouched. Triage is an
// INVESTIGATION, not a classification — and the failing simulation's VCD is
// free ground truth that was already on disk.
//
// This module runs a bounded probe loop: the model requests signal windows
// from the VCD ({"probe": {signals, aroundTime, span}}), the harness answers
// each from the dump via vcdWindow.signalWindow (no re-simulation, no code
// mutation), and after at most `maxProbes` rounds the model must return a
// verdict grounded in what it OBSERVED. The loop is strictly bounded, pure
// LLM-side (the only tool is a read-only waveform oracle), and every failure
// path returns null so the caller falls back to the classic one-shot triage.
//
// The verdict is still LLM judgment — waveform-grounded, but not a
// measurement — so the caller keeps it subject to the no-improvement flip
// (triageFlipTarget), unlike the formal-arbiter and compile-log triages.
// ═══════════════════════════════════════════════════════════════════════════

import { callLLM, extractJSON } from "../llm/index.js";
import { parseVCDSignals, signalWindow, firstFailTime, clockPeriodEstimate } from "./vcdWindow.js";
import { j } from "../prompts/base.js";

const DEFAULT_MAX_PROBES = 3;
const PROBE_MAX_SIGNALS = 10;

/** Signal inventory line for the brief: "tb.dut.wr_ptr [4]". */
function inventoryText(vcdText) {
  const sigs = parseVCDSignals(vcdText);
  const seen = new Set();
  const lines = [];
  for (const s of sigs) {
    if (/^(smt_|anyinit_|__|\$)/.test(s.name)) continue;
    const key = s.path + "." + s.name;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push("  " + key + (s.width > 1 ? " [" + s.width + "]" : ""));
    if (lines.length >= 40) { lines.push("  … (inventory truncated)"); break; }
  }
  return lines.join("\n");
}

/** Static investigation brief — identical across probe rounds (prefix-stable). */
function buildBrief(opts) {
  const failing = (opts.tests || []).filter(function(t) { return t.st === "FAIL"; })
    .slice(0, 12)
    .map(function(t) { return { name: t.name, req: t.req || null, evidence: t.evidence || "" }; });
  const reqs = ((opts.spec && opts.spec.requirements) || [])
    .map(function(r) { return { id: r.id, pri: r.pri, desc: r.desc }; });
  return `\
TASK: Determine whether the simulation failures below are caused by the RTL
(design bug) or by the TESTBENCH (wrong stimulus, wrong timing, or wrong
expected values). You have a WAVEFORM ORACLE: the failing simulation's VCD.

METHOD — evidence before opinion:
1. Pick a failing check. From the spec, state what the signals SHOULD do at
   that time.
2. Probe the waveform around that time and compare observation to spec.
3. If the DUT's outputs violate the spec for spec-compliant stimulus, the
   RTL is at fault. If the stimulus or the check's timing/expected value
   contradicts the spec, the TESTBENCH is at fault.
4. Your verdict MUST cite observed signal values and times from your probes.
5. Ground any claim about a signal's toggling or periodicity in a window
   spanning several clock periods, citing the transitions (or their absence)
   across that whole window — two samples inside one period show a level,
   which is consistent with a normally toggling clock.

RESPONSE FORMAT — exactly ONE JSON object per turn, either a probe:
{"probe": {"signals": ["dout","rd_en"], "aroundTime": 626000, "span": 40000}}
or a final verdict:
{"verdict": {"target": "rtl_generate" | "test_generate",
             "reason": "<one sentence>",
             "evidence": "<observed values/times that prove it>"}}

SPEC REQUIREMENTS:
${j(reqs)}

FAILING CHECKS:
${j(failing)}

RTL UNDER TEST:
${opts.rtlCode || "(unavailable)"}

TESTBENCH:
${opts.tbCode || "(unavailable)"}

SIGNALS AVAILABLE IN THE VCD:
${inventoryText(opts.vcdText)}

First failure time (from the sim log): ${opts.firstFail != null ? opts.firstFail : "(unknown — probe near the failing checks' reported times)"}
`;
}

/** Answer one probe request from the VCD. Never throws.
 *  Requested spans are floored at two clock periods (run 26: a 2-sample window
 *  1/10 of a period wide "grounded" the claim that clk never toggled). */
export function answerProbe(vcdText, probe) {
  try {
    const p = probe || {};
    const spanFloor = 2 * clockPeriodEstimate(vcdText);
    const reqSpan = typeof p.span === "number" && p.span > 0 ? p.span : undefined;
    const win = signalWindow(vcdText, {
      preferSignals: Array.isArray(p.signals) ? p.signals.map(String) : [],
      aroundTime: typeof p.aroundTime === "number" ? p.aroundTime : undefined,
      span: reqSpan == null ? undefined : Math.max(reqSpan, spanFloor),
      maxSignals: PROBE_MAX_SIGNALS,
    });
    return win || "(no signal activity in the requested window — widen the span or check the time units)";
  } catch (_e) {
    return "(probe failed to render — try different signals or times)";
  }
}

/**
 * Run the bounded investigation. Returns
 *   { target, reason, evidence, probes: [{request, window}] }
 * or null (caller falls back to one-shot triage). LLM calls are pushed onto
 * opts.allLlms with stage labels verify-triage-probe-<n>.
 *
 * @param {object} opts { vcdText, simOut, tests, spec, rtlCode, tbCode,
 *                        llmConfig, maxTokens, maxProbes, allLlms, iter,
 *                        onLog, onChunk }
 */
export async function investigateTriage(opts) {
  const vcdText = opts.vcdText;
  if (!vcdText || parseVCDSignals(vcdText).length === 0) return null;
  const maxProbes = typeof opts.maxProbes === "number" ? opts.maxProbes : DEFAULT_MAX_PROBES;
  // A zero-probe budget cannot ground anything — the whole point of the
  // investigation is observation, so skip it entirely and let the classic
  // one-shot triage run (triageProbes: 0 is effectively a second off-switch).
  if (maxProbes <= 0) return null;
  const allLlms = opts.allLlms || [];

  const brief = buildBrief({
    tests: opts.tests, spec: opts.spec,
    rtlCode: opts.rtlCode, tbCode: opts.tbCode,
    vcdText: vcdText,
    firstFail: firstFailTime(opts.simOut || ""),
  });

  const probes = [];
  // Probe transcript accumulates AFTER the static brief (prefix-stable for
  // local-server KV reuse across rounds).
  let transcript = "";
  for (let round = 0; round <= maxProbes; round++) {
    const last = round === maxProbes;
    const turn = brief + transcript + "\n"
      + (last
        ? "You have 0 probes remaining — return the final {\"verdict\": …} now, grounded in the windows above."
        : "Probes remaining: " + (maxProbes - round) + ". Respond with ONE probe or the final verdict.");
    const req = {
      systemPrompt: "You are RTL Forge's failure investigator. Respond ONLY with a single JSON object.",
      userMessage: turn,
      maxTokens: opts.maxTokens || 1000,
      config: opts.llmConfig,
      onChunk: opts.onChunk,
    };
    let resp;
    try {
      resp = await callLLM(req);
    } catch (_e) {
      return null;  // transport failure → classic triage
    }
    allLlms.push(Object.assign({ stage: "verify-triage-probe-" + (opts.iter || 1) + "." + (round + 1) }, resp));
    let parsed = null;
    try { parsed = extractJSON(resp.text, resp); } catch (_e) { parsed = null; }
    if (parsed && parsed.verdict && (parsed.verdict.target === "rtl_generate" || parsed.verdict.target === "test_generate")) {
      // NO VERDICT WITHOUT A PROBE (measured: run 20 — the model returned a
      // round-0 verdict whose "observed: probing dut.dout shows 8'h01 at
      // t=306000" cited a probe it never made; fabricated grounding language
      // is exactly what this loop exists to prevent). The oracle is cheap
      // and local: a first zero-probe verdict gets one rejection nudge; a
      // second ends the investigation (null → classic triage).
      if (probes.length === 0) {
        if (transcript.indexOf("VERDICT REJECTED") >= 0) return null;
        transcript += "\nVERDICT REJECTED — you have made ZERO probes, so you have observed "
          + "nothing; any \"observed\" claim above is fabricated. Request at least one "
          + "{\"probe\": …} against the signals your hypothesis depends on, then verdict "
          + "from what the window actually shows.\n";
        continue;
      }
      return {
        target: parsed.verdict.target,
        reason: parsed.verdict.reason || "",
        evidence: parsed.verdict.evidence || "",
        probes: probes,
      };
    }
    if (last) return null;  // forced-verdict round produced no verdict
    if (parsed && parsed.probe) {
      const window = answerProbe(vcdText, parsed.probe);
      probes.push({ request: parsed.probe, window: window });
      transcript += "\nPROBE " + (probes.length) + " — you requested "
        + j(parsed.probe) + ":\n" + window + "\n";
      if (typeof opts.onLog === "function") {
        opts.onLog("Investigation probe " + probes.length,
          "signals=" + JSON.stringify((parsed.probe.signals || []).slice(0, 6))
          + " aroundTime=" + parsed.probe.aroundTime);
      }
      continue;
    }
    // Neither a probe nor a usable verdict → one corrective nudge via the
    // transcript; a second malformed turn ends the investigation.
    if (transcript.indexOf("MALFORMED RESPONSE") >= 0) return null;
    transcript += "\nMALFORMED RESPONSE — reply with exactly one JSON object: "
      + "{\"probe\": …} or {\"verdict\": …}.\n";
  }
  return null;
}
