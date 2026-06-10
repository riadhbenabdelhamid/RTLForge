// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// projectState/dependencyGraph — Module dependency graph traversal
//
// For multi-module systems, the UI needs to know:
//   1. What order to run modules in (leaves first, top last) — getModuleOrder
//   2. How many levels deep each module sits from the top — computeEffectiveLevels
//
// Both functions operate on the (modules, instances) registry pair and the
// top module's id. They're pure and React-free.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Topologically sort modules so children run before their parents.
 *
 * Uses Kahn's algorithm on the (parent → child) dependency graph built
 * from the instance registry. Multiple instances of the same child type
 * count as ONE dependency edge (otherwise inDeg and dependents fall out
 * of sync and Kahn's algorithm reports a false circular dependency).
 *
 * @param {Object} modules     - Module registry keyed by modId
 * @param {Object} instances   - Instance registry — each value has
 *                               { parentModuleId, moduleId, ... }
 * @param {string} topModuleId - The root module's id (may be null)
 * @returns {string[]} Module ids in dependency order (leaves → top)
 * @throws {Error} If a circular dependency is detected
 */
export function getModuleOrder(modules, instances, topModuleId) {
  const modIds = Object.keys(modules);
  if (modIds.length <= 1) return modIds;

  // Build adjacency: parent → child edges mean child must come first.
  // inDeg[mId] = how many unique child module *types* must complete before mId.
  const inDeg = {};
  const dependents = {}; // childId → [parentIds that depend on it]
  modIds.forEach(function(m) { inDeg[m] = 0; dependents[m] = []; });

  // Collect unique (parent, child) dependency edges first (deduped)
  const edgeSet = {};
  Object.values(instances).forEach(function(inst) {
    const parent = inst.parentModuleId;
    const child  = inst.moduleId;
    if (parent && child && parent !== child && modules[parent] && modules[child]) {
      edgeSet[parent + "|" + child] = { parent, child };
    }
  });

  // Build inDeg and dependents from de-duped edges — invariant: every
  // inDeg increment has exactly one matching dependents entry.
  Object.values(edgeSet).forEach(function(e) {
    inDeg[e.parent] = (inDeg[e.parent] || 0) + 1;
    dependents[e.child].push(e.parent);
  });

  // Kahn's algorithm
  const queue = modIds.filter(function(m) { return inDeg[m] === 0; });
  const order = [];
  while (queue.length > 0) {
    const node = queue.shift();
    order.push(node);
    (dependents[node] || []).forEach(function(dep) {
      inDeg[dep] = inDeg[dep] - 1;
      if (inDeg[dep] === 0) queue.push(dep);
    });
  }

  if (order.length !== modIds.length) {
    const missing = modIds.filter(function(m) { return order.indexOf(m) === -1; });
    throw new Error("Circular dependency detected among modules: " + missing.join(", "));
  }

  return order;
}

/**
 * Computes effective hierarchy levels for all modules via BFS from the
 * top module. Level 0 = top, level 1 = directly instantiated by top, etc.
 *
 * Unreachable modules (no path from top) fall back to their stored
 * module.level property, or 0 if unset.
 *
 * @param {Object} modules     - Module registry keyed by modId
 * @param {Object} instances   - Instance registry
 * @param {string} topModuleId - Root module id (level 0)
 * @returns {Object} Map of modId → integer level (0 = top)
 */
export function computeEffectiveLevels(modules, instances, topModuleId) {
  const modIds = Object.keys(modules);
  const levels = {};
  modIds.forEach(function(mId) { levels[mId] = mId === topModuleId ? 0 : 999; });

  const queue = topModuleId ? [topModuleId] : [];
  const visited = {};
  while (queue.length > 0) {
    const cur = queue.shift();
    if (visited[cur]) continue;
    visited[cur] = true;
    const curLevel = levels[cur] || 0;
    Object.values(instances).forEach(function(inst) {
      if (inst.parentModuleId === cur && modules[inst.moduleId]) {
        const childLevel = curLevel + 1;
        if (childLevel < levels[inst.moduleId]) {
          levels[inst.moduleId] = childLevel;
        }
        if (!visited[inst.moduleId]) queue.push(inst.moduleId);
      }
    });
  }

  // Fallback: any module unreachable from top gets its stored level
  modIds.forEach(function(mId) {
    if (levels[mId] === 999) levels[mId] = (modules[mId] && modules[mId].level) || 0;
  });

  return levels;
}
