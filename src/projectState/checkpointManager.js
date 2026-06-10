// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// projectState/checkpointManager — Save/load/list/remove/clear checkpoints
//
// Factory that takes a storage adapter (from storage.js) and returns an
// object with bound save/load/listIndex/remove/clear methods. The adapter
// is the only state — no module-globals, no React assumptions, no DOM
// access. Same instance can be used from React, from Node CLI, from tests.
//
// Index file: a single key `${prefix}_index` holds a JSON array of
// { projectId, userDesc, designMode, timestamp, moduleCount,
//   completedStages, totalStages, furthestStage } entries, sorted newest-first.
// The index lets the UI render a "saved checkpoints" list without
// loading every full payload.
//
// Capacity policy: when index length exceeds maxCheckpoints (default 3),
// the oldest entries are pruned. Their underlying storage entries are
// best-effort deleted (errors are logged but not propagated).
//
// Takes storage explicitly (rather than calling a global getStorage()); the
// prefix and maxCheckpoints are constructor options.
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_PREFIX = "rtlforge:checkpoint:";
const DEFAULT_MAX_CHECKPOINTS = 3;

/**
 * Build a checkpoint manager bound to a storage adapter.
 *
 * @param {object} storage - Adapter from createMemoryStorage / createBrowserStorage / etc.
 * @param {object} [opts]
 * @param {string} [opts.prefix=rtlforge:checkpoint:] - Key namespace
 * @param {number} [opts.maxCheckpoints=3]            - Index capacity
 * @param {Array}  [opts.allStages]                   - Stage registry for index labels;
 *                                                      pass ALL_STAGES from constants/stages.js
 * @returns {{save, load, listIndex, remove, clear}}
 */
export function createCheckpointManager(storage, opts) {
  if (!storage || typeof storage.get !== "function") {
    throw new Error("createCheckpointManager: storage must be a valid adapter");
  }
  opts = opts || {};
  const PREFIX = opts.prefix || DEFAULT_PREFIX;
  const INDEX_KEY = PREFIX + "_index";
  const MAX = opts.maxCheckpoints || DEFAULT_MAX_CHECKPOINTS;
  const ALL_STAGES = opts.allStages || [];

  // ── Index helpers ──

  async function readIndex() {
    try {
      const r = await storage.get(INDEX_KEY);
      if (!r || !r.value) return [];
      const parsed = JSON.parse(r.value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
      return []; // missing key or corrupt JSON → empty index
    }
  }

  async function writeIndex(index) {
    await storage.set(INDEX_KEY, JSON.stringify(index));
  }

  function buildIndexEntry(payload) {
    let totalCompleted = 0;
    let totalStages = 0;
    let furthestLabel = "";
    const mods = payload.modules || {};
    Object.keys(mods).forEach(function(mId) {
      const mod = mods[mId];
      const cArr = mod.completed || [];
      totalCompleted += cArr.length;
      totalStages += ALL_STAGES.length;
      cArr.forEach(function(sid) {
        const meta = ALL_STAGES.find(function(s) { return s.id === sid; });
        if (meta && sid > 0) furthestLabel = meta.label;
      });
    });
    return {
      projectId: payload.projectId,
      userDesc:  (payload.userDesc || "").substring(0, 100),
      designMode: payload.designMode,
      timestamp:  payload.timestamp,
      moduleCount: Object.keys(payload.modules || {}).length,
      completedStages: totalCompleted,
      totalStages,
      furthestStage: furthestLabel,
    };
  }

  // ── Public methods ──

  /**
   * Persist a checkpoint payload and update the index.
   * @returns {Promise<boolean>} true on success, false if storage failed
   */
  async function save(projectId, payload) {
    if (!projectId) return false;
    try {
      const key = PREFIX + projectId;
      await storage.set(key, JSON.stringify(payload));

      // Update the index
      let index = await readIndex();
      // Remove any existing entry for this projectId (we're updating it)
      index = index.filter(function(e) { return e.projectId !== projectId; });
      index.push(buildIndexEntry(payload));
      // Sort newest-first by timestamp
      index.sort(function(a, b) {
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });
      // Enforce capacity: prune oldest beyond MAX
      while (index.length > MAX) {
        const old = index.pop();
        try { await storage.delete(PREFIX + old.projectId); }
        catch (_e) { /* best-effort */ }
      }
      await writeIndex(index);
      return true;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[Checkpoint] save failed:", e && e.message);
      return false;
    }
  }

  /**
   * Load a checkpoint payload by projectId.
   * @returns {Promise<object|null>} payload or null if not found / corrupt
   */
  async function load(projectId) {
    if (!projectId) return null;
    try {
      const r = await storage.get(PREFIX + projectId);
      if (!r || !r.value) return null;
      return JSON.parse(r.value);
    } catch (_e) {
      return null;
    }
  }

  /**
   * Get the index of saved checkpoints (sorted newest-first).
   * @returns {Promise<Array>}
   */
  async function listIndex() {
    // Phantom-checkpoint cleanup: drop entries that have NO sign of
    // intentional creation — no userDesc, no completed stages, no
    // modules at all. Such entries were created by autosaves that
    // fired before meaningful state existed and have no recoverable
    // data. We filter at read-time AND persist the cleaned index so
    // it self-heals.
    //
    // NOTE: moduleCount > 0 IS a signal of intent — `ensureModule(id)`
    // is the user (or a test) explicitly creating module shells before
    // running stages, and those checkpoints contain restorable state.
    let index = await readIndex();
    const before = index.length;
    index = index.filter(function(e) {
      const noDesc = !e.userDesc || !e.userDesc.trim();
      const noProgress = (!e.completedStages || e.completedStages === 0)
        && (!e.furthestStage || e.furthestStage === "");
      const noModules = !e.moduleCount || e.moduleCount === 0;
      return !(noDesc && noProgress && noModules);
    });
    if (index.length !== before) {
      try { await writeIndex(index); } catch (_e) { /* best-effort */ }
    }
    return index;
  }

  /**
   * Delete a single checkpoint and its index entry.
   */
  async function remove(projectId) {
    if (!projectId) return;
    try {
      await storage.delete(PREFIX + projectId);
      let index = await readIndex();
      index = index.filter(function(e) { return e.projectId !== projectId; });
      await writeIndex(index);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[Checkpoint] remove failed:", e && e.message);
    }
  }

  /**
   * Delete all checkpoints and the index.
   */
  async function clear() {
    try {
      const index = await readIndex();
      for (let i = 0; i < index.length; i++) {
        try { await storage.delete(PREFIX + index[i].projectId); }
        catch (_e) { /* best-effort */ }
      }
      try { await storage.delete(INDEX_KEY); }
      catch (_e) { /* best-effort */ }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[Checkpoint] clear failed:", e && e.message);
    }
  }

  return { save, load, listIndex, remove, clear };
}
