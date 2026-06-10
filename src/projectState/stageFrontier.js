// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// projectState/stageFrontier — Compute "next stage to run" for a module
//
// Unlike the stage-list navigation helpers in constants/stages.js
// (nextStageId, prevStageId, stageIdsFrom, isStageActive), this function
// takes a module's `completed` Set as input and therefore lives in
// projectState alongside the other module-state helpers.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute the "frontier" — the next stage the user should run on a module.
 *
 * - Returns the first active stage id that has not been completed yet, or
 * - The last active stage id if everything in the active set is done, or
 * - 0 if there are no active stages.
 *
 * Non-active completed ids are ignored (a stage that was completed in a
 * previous config but is no longer in the active list does not advance
 * the frontier).
 *
 * @param {Set<number>} completed - The module's completed stage set
 * @param {Array} activeStages    - Ordered stage list from getActiveStages()
 * @returns {number}
 */
export function computeStageFrontier(completed, activeStages) {
  if (!activeStages || activeStages.length === 0) return 0;
  const activeIds = activeStages.map(function(s) { return s.id; });
  const lastId = activeIds[activeIds.length - 1];

  let highest = 0;
  (completed || new Set()).forEach(function(id) {
    if (id > highest && activeIds.indexOf(id) >= 0) highest = id;
  });

  if (highest >= lastId) return lastId;

  const nextIdx = activeIds.indexOf(highest) + 1;
  if (nextIdx < activeIds.length) return activeIds[nextIdx];
  return (completed && completed.size > 0) ? (activeIds[0] || 1) : 0;
}
