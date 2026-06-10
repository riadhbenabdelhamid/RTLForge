// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// runMetrics — aggregate per-stage Duration + Tokens data
//
// JudgeStage's Duration and Tokens sub-tabs both need to walk every
// stage's stageData[i]._llms array and produce a structured rollup:
//
//   {
//     stages:  [{ key, label, calls: [...], total: {...} }],
//     overall: { startedAtMs, endedAtMs, durationMs, tokensIn, tokensOut, calls: N }
//   }
//
// We keep this in its own module so the JudgeStage code reads cleanly
// AND so the same helper can be unit-tested without a React harness.
//
// METHODOLOGY (surfaces in the UI as a footnote):
//   • Per-call timestamps come from callLLM's startedAtMs/endedAtMs
//     (Date.now() at request issue / response complete).
//   • Per-call latencyMs comes from performance.now() (monotonic).
//   • When a call lacks startedAtMs (e.g.
//     legacy ledger entries), we substitute null and the call shows "n/a" in the
//     UI. Cumulative duration uses latencyMs as a fallback.
//   • Tokens come from provider telemetry (tokensIn/tokensOut) only —
//     NEVER estimated. When the API doesn't return counts, the call's
//     tokensIn/tokensOut stay null and the UI renders "—". A
//     tokensMissing flag per call + a callsMissing counter at the run
//     level let the UI explicitly surface "X of Y calls didn't report
//     telemetry" rather than fabricating numbers with char/token
//     heuristics that are tokenizer-dependent and routinely 10-40% wrong.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the per-stage rollup from a project's stageData.
 *
 * @param {object} stageData         - mapping stageId → stage result
 * @param {Array}  stageDescriptors  - [{ id, key, label }, …]
 * @returns {{stages, overall}}
 */
export function buildRunMetrics(stageData, stageDescriptors) {
  const stages = [];
  let overallStart  = null;
  let overallEnd    = null;
  let overallCalls  = 0;
  let overallIn     = 0;
  let overallOut    = 0;
  let overallDurMs  = 0;
  let anyMissing    = false;
  let callsMissing  = 0;

  for (const sd of stageDescriptors || []) {
    const result = stageData ? stageData[sd.id] : null;
    if (!result) continue;
    // _llms (plural) is the canonical ledger. Older runs may only have _llm
    // (singular); we fall back to a one-element array.
    const llms = Array.isArray(result._llms)
      ? result._llms
      : (result._llm ? [result._llm] : []);
    if (llms.length === 0) continue;

    const calls = llms.map(function(c) { return normalizeCall(c, sd.key); });
    calls.forEach(function(c) {
      if (c.tokensMissing) { anyMissing = true; callsMissing++; }
    });

    // NO ESTIMATION. When a call has tokensIn=null, we explicitly track the
    // "missing telemetry" count rather than coercing
    // to 0. The stage total reflects the calls that DID return telemetry;
    // a separate `tokensInMissingCount` reports how many didn't. The UI
    // shows both: real total + how many calls contributed to it +
    // how many were unreported.
    const total = calls.reduce(function(acc, c) {
      if (c.startedAtMs != null) {
        if (overallStart == null || c.startedAtMs < overallStart) overallStart = c.startedAtMs;
      }
      if (c.endedAtMs != null) {
        if (overallEnd == null || c.endedAtMs > overallEnd) overallEnd = c.endedAtMs;
      }
      acc.calls += 1;
      // Sum only real telemetry. nulls contribute nothing AND increment
      // a "missing" counter so the UI can render "of X reported".
      if (c.tokensIn  != null) acc.tokensIn  += c.tokensIn;
      else                     acc.tokensInMissingCount++;
      if (c.tokensOut != null) acc.tokensOut += c.tokensOut;
      else                     acc.tokensOutMissingCount++;
      acc.durationMs += c.durationMs || 0;
      return acc;
    }, { calls: 0, tokensIn: 0, tokensOut: 0,
         tokensInMissingCount: 0, tokensOutMissingCount: 0,
         durationMs: 0 });

    overallCalls += total.calls;
    overallIn    += total.tokensIn;
    overallOut   += total.tokensOut;
    overallDurMs += total.durationMs;

    stages.push({
      id:    sd.id,
      key:   sd.key,
      label: sd.label,
      calls: calls,
      total: total,
    });
  }

  const overall = {
    startedAtMs: overallStart,
    endedAtMs:   overallEnd,
    // Prefer wall-clock window when both ends known; fall back to summed
    // monotonic durations otherwise. The UI shows which method is in use.
    durationMs:  (overallStart != null && overallEnd != null && overallEnd >= overallStart)
      ? (overallEnd - overallStart)
      : overallDurMs,
    durationMethod: (overallStart != null && overallEnd != null && overallEnd >= overallStart)
      ? "wall-clock"
      : "monotonic-sum",
    cumulativeDurationMs: overallDurMs,
    calls: overallCalls,
    tokensIn:  overallIn,
    tokensOut: overallOut,
    // Honest reporting of telemetry gaps
    anyMissing:   anyMissing,
    callsMissing: callsMissing,
  };
  return { stages: stages, overall: overall };
}

/**
 * Coerce one _llms[i] entry into a stable shape. Most fields are pass-through;
 * a few need normalization (tokens may be missing → estimate from text len).
 */
function normalizeCall(c, fallbackStage) {
  const stage = c.stage || fallbackStage || "unknown";
  // Iteration / round suffix is part of the stage name (e.g. "lint-iter1").
  // We split it to support per-iteration grouping in the UI.
  const iterMatch = stage.match(/-iter(\d+)$|-(\d+)$/);
  const iter = iterMatch ? parseInt(iterMatch[1] || iterMatch[2], 10) : null;

  // Rule: NO estimation. Token counts come from provider telemetry or they're
  // reported as missing. Estimation (char/4 or any heuristic) is misleading
  // because it depends on tokenizer family (BPE/WordPiece/SentencePiece)
  // and is wrong by 10-40% in typical RTL/SV content. Users making
  // cost decisions need real numbers or an honest "—".
  let tokensIn  = (typeof c.tokensIn  === "number") ? c.tokensIn  : null;
  let tokensOut = (typeof c.tokensOut === "number") ? c.tokensOut : null;

  // When the provider returned a literal 0 for tokensIn but the call
  // clearly had a prompt (we sent text), the telemetry is broken
  // (sometimes happens with mis-summed cache fields, certain proxies,
  // or older Ollama versions). Treat that as missing rather than as
  // a misleading "0".
  const hadPrompt = (typeof c.promptLen === "number" && c.promptLen > 0)
    || (typeof c.userMessage === "string" && c.userMessage.length > 0);
  if (tokensIn === 0 && hadPrompt) tokensIn = null;

  // Similarly: tokensOut === 0 alongside a non-empty response text
  // indicates broken telemetry. Empty response → 0 is legitimate.
  const hadResponse = (typeof c.text === "string" && c.text.length > 0);
  if (tokensOut === 0 && hadResponse) tokensOut = null;

  // tokensMissing flags whether ANY count on this call lacked provider
  // telemetry. The UI uses this to render "—" instead of "0" and to
  // surface a one-line warning explaining that the LLM endpoint isn't
  // returning usage data so the total may be incomplete.
  const tokensMissing = (tokensIn == null) || (tokensOut == null);

  return {
    stage:        stage,
    iter:         iter,
    startedAtMs:  (typeof c.startedAtMs === "number") ? c.startedAtMs : null,
    endedAtMs:    (typeof c.endedAtMs   === "number") ? c.endedAtMs   : null,
    durationMs:   (typeof c.latencyMs   === "number") ? c.latencyMs   : 0,
    tokensIn:     tokensIn,
    tokensOut:    tokensOut,
    tokensMissing: tokensMissing,
    provider:     c.provider || "",
    model:        c.model    || "",
  };
}

/**
 * Format a duration in ms as "1.2s" / "523ms" / "1m 23s" for display.
 */
export function fmtDuration(ms) {
  if (ms == null || isNaN(ms)) return "—";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60 * 1000) return (ms / 1000).toFixed(1) + "s";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return m + "m " + s + "s";
}

/**
 * Format a wall-clock epoch-ms as HH:MM:SS.fff for display. Returns
 * "—" when null.
 */
export function fmtTime(ms) {
  if (ms == null) return "—";
  const d = new Date(ms);
  const pad = function(n, w) { const s = String(n); return s.length >= w ? s : "0".repeat(w - s.length) + s; };
  return pad(d.getHours(), 2) + ":" + pad(d.getMinutes(), 2) + ":" + pad(d.getSeconds(), 2) + "." + pad(d.getMilliseconds(), 3);
}

/**
 * Format a token count for display. Null/undefined → "—" (missing
 * telemetry; provider didn't return usage data). Numbers render with
 * thousands separators. We deliberately do NOT include a fudge marker
 * — token counts are either reported or not.
 */
export function fmtTokens(n) {
  if (n == null) return "—";
  return n.toLocaleString();
}

// ═══════════════════════════════════════════════════════════════════════════
// rampPalette — value-ranked dark→light color assignment
//
// Returns an array of N hex colors aligned 1:1 with `values`. The
// smallest value gets the darkest shade in the family ramp; the largest
// gets the lightest. Stable for ties. The Duration tab uses the orange
// family; the Tokens tab uses the blue family. This makes the pie
// chart visually communicate magnitude — large slices look bright,
// small slices look muted — before the user reads the numbers.
// ═══════════════════════════════════════════════════════════════════════════

const COLOR_RAMPS = {
  orange: [
    "#6b2b00", "#8b3a00", "#aa4a00", "#cc6210",
    "#e07b1f", "#ee9a40", "#f5b870", "#ffd9a8",
  ],
  blue: [
    "#0a2845", "#143a66", "#1d4e85", "#2767a3",
    "#3a82c4", "#5fa1d8", "#8cbfe6", "#bfdcf2",
  ],
};

export function rampPalette(values, family) {
  const ramp = COLOR_RAMPS[family] || COLOR_RAMPS.orange;
  const n = values.length;
  if (n === 0) return [];
  // Rank ascending; ties keep their original order for stability.
  const indexed = values.map(function(v, i) { return { v: v, i: i }; });
  indexed.sort(function(a, b) {
    if (a.v !== b.v) return a.v - b.v;
    return a.i - b.i;
  });
  const out = new Array(n);
  for (let rank = 0; rank < n; rank++) {
    const orig = indexed[rank].i;
    // Map rank ∈ [0, n-1] onto ramp index ∈ [0, ramp.length-1].
    // n === 1 → lightest shade (single slice owns 100%).
    const rampIdx = (n === 1)
      ? (ramp.length - 1)
      : Math.round((rank / (n - 1)) * (ramp.length - 1));
    out[orig] = ramp[rampIdx];
  }
  return out;
}

export function durationPalette(values) { return rampPalette(values, "orange"); }
export function tokenPalette(values)    { return rampPalette(values, "blue");   }
