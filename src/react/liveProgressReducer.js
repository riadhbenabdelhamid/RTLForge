// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// liveProgressReducer — pure accumulation for the in-flight stage panel
//
// useProject buffers progress events per stage and flushes them into the
// `liveProgress` map. The counters shown by LiveProgressPanel
// (`llmCount` / `cliCount`) used to be recomputed as
// `events.filter(type==="x").length` over an array CAPPED at 500 — so a stage
// that emitted more than 500 live events silently UNDERCOUNTED.
//
// This module accumulates the counters MONOTONICALLY: each flushed batch adds
// its own LLM/CLI events to the running totals, independent of how many events
// the (bounded) `events` array currently retains. Pure + exported so the
// counting contract is unit-tested without standing up the React hook.
// ═══════════════════════════════════════════════════════════════════════════

// Keep the retained event tail bounded so a stage that runs "forever" can't
// grow the array without limit. The counters are tracked separately and are
// NOT affected by this cap.
export const LIVE_EVENTS_CAP = 500;

/**
 * Count events of a given `type` in a batch. Tolerates a null/non-array input.
 */
export function countType(events, type) {
  if (!Array.isArray(events)) return 0;
  let n = 0;
  for (const e of events) {
    if (e && e.type === type) n++;
  }
  return n;
}

/**
 * Fold a freshly-buffered batch (`incoming`) into the existing live-progress
 * slot for a stage. Returns a NEW slot object (no mutation of inputs).
 *
 * @param {object|null} existing  prior slot: { events, startedAtMs,
 *                                lastUpdatedMs, modId, llmCount, cliCount }
 * @param {object} incoming       buffered batch: { events, startedAtMs,
 *                                lastUpdatedMs, modId }
 */
export function accumulateProgressSlot(existing, incoming) {
  const inc = incoming || {};
  const incEvents = Array.isArray(inc.events) ? inc.events : [];
  const base = existing || {
    events: [],
    startedAtMs: inc.startedAtMs,
    lastUpdatedMs: inc.startedAtMs,
    modId: inc.modId,
    llmCount: 0,
    cliCount: 0,
  };
  const mergedEvents = base.events.concat(incEvents);
  const capped = mergedEvents.length > LIVE_EVENTS_CAP
    ? mergedEvents.slice(-LIVE_EVENTS_CAP)
    : mergedEvents;
  return {
    events: capped,
    startedAtMs: base.startedAtMs,
    lastUpdatedMs: inc.lastUpdatedMs != null ? inc.lastUpdatedMs : base.lastUpdatedMs,
    modId: base.modId || inc.modId,
    // Monotonic: add this batch's calls to the running totals so the count is
    // correct even after the bounded `events` array has dropped older entries.
    llmCount: (base.llmCount || 0) + countType(incEvents, "llm"),
    cliCount: (base.cliCount || 0) + countType(incEvents, "cli"),
  };
}
