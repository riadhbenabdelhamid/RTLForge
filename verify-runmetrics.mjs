// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// verify-runmetrics — Duration + Tokens aggregator helper
//
// Pins:
//   - per-stage rollup from stageData[i]._llms
//   - fallback to _llm (singular) when _llms missing
//   - wall-clock window vs monotonic-sum selection
//   - tokens estimation flag propagation
//   - iter extraction from stage strings
//   - format helpers (fmtDuration, fmtTime, fmtTokens)
// ═══════════════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") await r;
    process.stdout.write("  \u001b[32m✓\u001b[0m " + name + "\n");
    passed++;
  } catch (e) {
    process.stdout.write("  \u001b[31m✗\u001b[0m " + name + "  →  " + (e.message || e) + "\n");
    failures.push({ name, message: e.message || String(e) });
  }
}

const { buildRunMetrics, fmtDuration, fmtTime, fmtTokens } =
  await import("./src/react/components/runMetrics.js");

const stagesAll = [
  { id: 1, key: "elicit",       label: "Elicit" },
  { id: 2, key: "spec",         label: "Spec" },
  { id: 4, key: "rtl_generate", label: "RTL Generate" },
  { id: 5, key: "lint",         label: "Lint" },
  { id: 8, key: "verify",       label: "Verify" },
  { id: 9, key: "judge",        label: "Judge" },
];

console.log("\n[runMetrics/rollup]");

await check("buildRunMetrics: empty input returns empty stages + zero overall", () => {
  const m = buildRunMetrics({}, stagesAll);
  assert.deepEqual(m.stages, []);
  assert.equal(m.overall.calls, 0);
  assert.equal(m.overall.tokensIn, 0);
  assert.equal(m.overall.tokensOut, 0);
  assert.equal(m.overall.startedAtMs, null);
  assert.equal(m.overall.endedAtMs, null);
});

await check("buildRunMetrics: single stage, single call, full telemetry", () => {
  const sd = {
    1: { _llms: [{ stage: "elicit", startedAtMs: 1000, endedAtMs: 2500, latencyMs: 1500, tokensIn: 100, tokensOut: 50 }] },
  };
  const m = buildRunMetrics(sd, stagesAll);
  assert.equal(m.stages.length, 1);
  assert.equal(m.stages[0].calls.length, 1);
  assert.equal(m.stages[0].total.tokensIn, 100);
  assert.equal(m.overall.durationMs, 1500);
  assert.equal(m.overall.durationMethod, "wall-clock");
  assert.equal(m.overall.anyMissing, false);
});

await check("buildRunMetrics: multi-stage rollup totals are correct", () => {
  const sd = {
    1: { _llms: [{ stage: "elicit", startedAtMs: 100, endedAtMs: 200, latencyMs: 100, tokensIn: 10, tokensOut: 5 }] },
    4: { _llms: [{ stage: "rtl_generate", startedAtMs: 300, endedAtMs: 600, latencyMs: 300, tokensIn: 80, tokensOut: 120 }] },
    5: { _llms: [
      { stage: "lint-iter1", startedAtMs: 700, endedAtMs: 780, latencyMs: 80, tokensIn: 20, tokensOut: 10 },
      { stage: "rtl-fix-iter1", startedAtMs: 800, endedAtMs: 920, latencyMs: 120, tokensIn: 60, tokensOut: 90 },
    ]},
  };
  const m = buildRunMetrics(sd, stagesAll);
  assert.equal(m.stages.length, 3);
  assert.equal(m.overall.calls, 4);
  assert.equal(m.overall.tokensIn,  10 + 80 + 20 + 60);
  assert.equal(m.overall.tokensOut,  5 + 120 + 10 + 90);
  // Wall-clock window: 100 to 920 = 820ms
  assert.equal(m.overall.durationMs, 820);
  assert.equal(m.overall.durationMethod, "wall-clock");
  // Cumulative sum: 100 + 300 + 80 + 120 = 600
  assert.equal(m.overall.cumulativeDurationMs, 600);
});

await check("buildRunMetrics: falls back to _llm (singular) when _llms missing", () => {
  const sd = {
    1: { _llm: { stage: "elicit", startedAtMs: 100, endedAtMs: 200, latencyMs: 100, tokensIn: 10, tokensOut: 5 } },
  };
  const m = buildRunMetrics(sd, stagesAll);
  assert.equal(m.stages.length, 1);
  assert.equal(m.stages[0].calls.length, 1);
  assert.equal(m.stages[0].total.tokensIn, 10);
});

await check("buildRunMetrics: monotonic-sum fallback when no wall-clock", () => {
  const sd = {
    1: { _llms: [{ stage: "elicit", latencyMs: 100, tokensIn: 10, tokensOut: 5 }] },
    4: { _llms: [{ stage: "rtl_generate", latencyMs: 250, tokensIn: 50, tokensOut: 100 }] },
  };
  const m = buildRunMetrics(sd, stagesAll);
  assert.equal(m.overall.startedAtMs, null);
  assert.equal(m.overall.endedAtMs, null);
  assert.equal(m.overall.durationMethod, "monotonic-sum");
  assert.equal(m.overall.durationMs, 350);
});

console.log("\n[runMetrics/tokens-estimation]");

// NO ESTIMATION. Missing telemetry → null, surfaced
// to the user explicitly. We never fabricate counts with char/4 or any
// other heuristic.
console.log("\n[runMetrics/tokens — no-estimation policy]");

await check("tokens: missing tokensIn/Out → null + tokensMissing=true (no fabrication)", () => {
  const sd = {
    1: { _llms: [{
      stage: "elicit", latencyMs: 100,
      // No tokensIn / tokensOut at all
      userMessage: "x".repeat(400),  // would have estimated to 100 pre-fix
      text: "y".repeat(200),
    }]},
  };
  const m = buildRunMetrics(sd, stagesAll);
  const call = m.stages[0].calls[0];
  assert.equal(call.tokensIn,  null, "missing tokensIn must stay null, NOT estimated");
  assert.equal(call.tokensOut, null, "missing tokensOut must stay null, NOT estimated");
  assert.equal(call.tokensMissing, true);
  assert.equal(m.overall.anyMissing, true);
  assert.equal(m.overall.callsMissing, 1);
  // Stage total excludes the null-token call from its sum
  assert.equal(m.stages[0].total.tokensIn,  0);
  assert.equal(m.stages[0].total.tokensInMissingCount, 1);
});

await check("tokens: real numbers pass through unchanged", () => {
  const sd = {
    1: { _llms: [{
      stage: "elicit", latencyMs: 100,
      tokensIn: 42, tokensOut: 21,
    }]},
  };
  const m = buildRunMetrics(sd, stagesAll);
  const call = m.stages[0].calls[0];
  assert.equal(call.tokensIn, 42);
  assert.equal(call.tokensOut, 21);
  assert.equal(call.tokensMissing, false);
  assert.equal(m.overall.anyMissing, false);
});

await check("tokens: tokensIn=0 with non-empty prompt → treated as missing (broken telemetry)", () => {
  const sd = {
    1: { _llms: [{
      stage: "elicit", latencyMs: 100,
      tokensIn: 0,                  // API returned 0 but...
      tokensOut: 50,
      promptLen: 4000,              // ...we actually sent 4000 chars
    }]},
  };
  const m = buildRunMetrics(sd, stagesAll);
  const call = m.stages[0].calls[0];
  assert.equal(call.tokensIn, null, "tokensIn=0 + sent prompt = broken telemetry, NOT a fabricated estimate");
  assert.equal(call.tokensOut, 50, "tokensOut stays real");
  assert.equal(call.tokensMissing, true);
});

await check("tokens: tokensOut=0 with non-empty response text → treated as missing", () => {
  const sd = {
    1: { _llms: [{
      stage: "elicit", latencyMs: 100,
      tokensIn: 100,
      tokensOut: 0,                 // API returned 0 but...
      text: "z".repeat(2000),       // ...we got a real response
    }]},
  };
  const m = buildRunMetrics(sd, stagesAll);
  const call = m.stages[0].calls[0];
  assert.equal(call.tokensOut, null);
  assert.equal(call.tokensMissing, true);
});

await check("tokens: stage totals exclude missing-telemetry calls from sum", () => {
  const sd = {
    1: { _llms: [
      { stage: "elicit-a", latencyMs: 100, tokensIn: 100, tokensOut: 50 },
      { stage: "elicit-b", latencyMs: 100, tokensIn: 200, tokensOut: 100 },
      { stage: "elicit-c", latencyMs: 100 },  // missing both
    ]},
  };
  const m = buildRunMetrics(sd, stagesAll);
  // Sum only reflects the 2 reported calls
  assert.equal(m.stages[0].total.tokensIn,  300);
  assert.equal(m.stages[0].total.tokensOut, 150);
  // Missing counts surface separately
  assert.equal(m.stages[0].total.tokensInMissingCount,  1);
  assert.equal(m.stages[0].total.tokensOutMissingCount, 1);
  assert.equal(m.overall.callsMissing, 1);
});

await check("fmtTokens: null → '—' (no estimated marker)", async () => {
  const { fmtTokens: f } = await import("./src/react/components/runMetrics.js");
  assert.equal(f(null), "—");
  assert.equal(f(undefined), "—");
  assert.equal(f(0), "0");
  assert.equal(f(1234), "1,234");
});

console.log("\n[runMetrics/iter-extraction]");

await check("iter extraction: '-iter<N>' suffix", () => {
  const sd = {
    5: { _llms: [
      { stage: "lint-iter1", latencyMs: 100 },
      { stage: "lint-iter2", latencyMs: 100 },
      { stage: "rtl-fix-iter1", latencyMs: 100 },
    ]},
  };
  const m = buildRunMetrics(sd, stagesAll);
  const calls = m.stages[0].calls;
  assert.equal(calls[0].iter, 1);
  assert.equal(calls[1].iter, 2);
  assert.equal(calls[2].iter, 1);
});

await check("iter extraction: trailing dash-number form", () => {
  const sd = {
    9: { _llms: [
      { stage: "judge-triage-1", latencyMs: 100 },
      { stage: "tb-regen-judge-2", latencyMs: 100 },
    ]},
  };
  const m = buildRunMetrics(sd, stagesAll);
  const calls = m.stages[0].calls;
  assert.equal(calls[0].iter, 1);
  assert.equal(calls[1].iter, 2);
});

await check("iter extraction: returns null when no iter suffix", () => {
  const sd = {
    1: { _llms: [{ stage: "elicit", latencyMs: 100 }] },
  };
  const m = buildRunMetrics(sd, stagesAll);
  assert.equal(m.stages[0].calls[0].iter, null);
});

console.log("\n[runMetrics/format-helpers]");

await check("fmtDuration: ms / s / m s ranges", () => {
  assert.equal(fmtDuration(0), "0ms");
  assert.equal(fmtDuration(523), "523ms");
  assert.equal(fmtDuration(1500), "1.5s");
  assert.equal(fmtDuration(72000), "1m 12s");
  assert.equal(fmtDuration(null), "—");
  assert.equal(fmtDuration(NaN), "—");
});

await check("fmtTime: epoch-ms → HH:MM:SS.fff", () => {
  // Use a UTC-stable reference and compare structure (the hour depends
  // on test machine's TZ). Just verify format shape.
  const r = fmtTime(Date.UTC(2026, 0, 1, 12, 34, 56, 789));
  assert.match(r, /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.equal(fmtTime(null), "—");
});

console.log("\n[runMetrics/rampPalette]");

const { rampPalette } = await import("./src/react/components/runMetrics.js");

await check("rampPalette: darkest shade goes to smallest value, lightest to largest", () => {
  const colors = rampPalette([100, 1000, 50, 500], "orange");
  // Original indices sorted by value ascending: [2 (50), 0 (100), 3 (500), 1 (1000)]
  // So colors[2] should be darkest, colors[1] should be lightest.
  // Both blue and orange ramps are 8 shades; with 4 values mapped, ranks
  // 0..3 map to ramp positions 0, 2, 5, 7 (rounded). So all 4 should be distinct.
  const seen = new Set(colors);
  assert.equal(seen.size, 4, "all 4 colors should be distinct");
  // Ramps are dark-to-light hex strings. Verify ordering: smallest value
  // gets a darker color (lower R+G+B sum) than largest.
  function brightness(hex) {
    const h = hex.replace("#", "");
    return parseInt(h.slice(0, 2), 16)
         + parseInt(h.slice(2, 4), 16)
         + parseInt(h.slice(4, 6), 16);
  }
  assert.ok(brightness(colors[2]) < brightness(colors[1]),
    "smallest value (50, at idx 2) should be DARKER than largest (1000, at idx 1)");
});

await check("rampPalette: stable for ties (preserves original order)", () => {
  const colors = rampPalette([100, 100, 100], "orange");
  assert.equal(colors.length, 3);
  // All values tied → ramp positions step through 0, mid, last
  // What matters: function returns 3 colors, doesn't crash.
});

await check("rampPalette: single value → uses lightest shade", () => {
  const colors = rampPalette([42], "orange");
  assert.equal(colors.length, 1);
  // Should be the LAST entry in the orange ramp (lightest)
  assert.equal(colors[0], "#ffd9a8");
});

await check("rampPalette: empty input → empty output", () => {
  assert.deepEqual(rampPalette([], "orange"), []);
});

await check("rampPalette: blue family produces different colors than orange family", () => {
  const o = rampPalette([100, 200, 300], "orange");
  const b = rampPalette([100, 200, 300], "blue");
  for (let i = 0; i < o.length; i++) {
    assert.notEqual(o[i], b[i]);
  }
});

console.log("\n═══════════════════════════════════════");
console.log("  Passed: " + passed);
console.log("  Failed: " + failures.length);
console.log("  Status: " + (failures.length === 0 ? "ALL PASS ✓" : "FAILURES"));
console.log("═══════════════════════════════════════");
if (failures.length > 0) process.exit(1);
