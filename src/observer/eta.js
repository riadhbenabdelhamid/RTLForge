// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// observer/eta — per-model run ETA from recorded stage spans (roadmap #10)
//
// Runs take 5–40 min with zero forward guidance. run_summary events now carry
// stageSpans (wall-clock ms per stage); the ETA is the sum of per-stage
// MEDIANS over the last few runs of the SAME model. Honest by construction:
// below minSamples for a stage there is no estimate for it, and a run estimate
// reports how many stages it actually covers — never a fabricated number.
// Pure + browser-safe (fed by SQLite summaries in the CLI, localStorage
// summaries in the GUI).
// ═══════════════════════════════════════════════════════════════════════════

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Median span for one (model, stage) over the most recent `window` runs.
 * @returns {{ms: number, samples: number}|null} null below minSamples
 */
export function stageEta(summaries, model, stageKey, opts) {
  const o = opts || {};
  const window = o.window || 5;
  const minSamples = o.minSamples || 2;
  const spans = [];
  for (let i = (summaries || []).length - 1; i >= 0 && spans.length < window; i--) {
    const s = summaries[i];
    if (!s || s.model !== model || !s.stageSpans) continue;
    const ms = s.stageSpans[stageKey];
    if (typeof ms === "number" && ms > 0) spans.push(ms);
  }
  if (spans.length < minSamples) return null;
  return { ms: median(spans), samples: spans.length };
}

/**
 * ETA for the remaining stages of a run.
 * @returns {{ms, stagesKnown, stagesTotal, basedOnRuns}|null}
 *          null when NO stage has enough history (never fabricate)
 */
export function runEta(summaries, model, stageKeys, opts) {
  let ms = 0, known = 0, basedOn = 0;
  for (const key of (stageKeys || [])) {
    const e = stageEta(summaries, model, key, opts);
    if (e) { ms += e.ms; known++; basedOn = Math.max(basedOn, e.samples); }
  }
  if (known === 0) return null;
  return { ms, stagesKnown: known, stagesTotal: (stageKeys || []).length, basedOnRuns: basedOn };
}

/** "~7 min" / "~40 s" — coarse on purpose (medians on a flaky transport). */
export function formatEta(ms) {
  if (ms == null) return "";
  if (ms < 90000) return "~" + Math.max(1, Math.round(ms / 1000)) + " s";
  return "~" + Math.round(ms / 60000) + " min";
}
