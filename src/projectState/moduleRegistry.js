// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// projectState/moduleRegistry — Per-module state scaffolding and hashing
//
// Each module in the RTL Forge UI has a per-module state object keyed by
// modId. This file exports:
//
//   blankModule()            — factory returning a fresh scaffold
//   computeContentHash(spec, rtlCode) — hash of interface+params+rtl code
//   computeIfaceHash(spec)   — hash of just interface+params (for child change
//                              detection without rebuilding the child)
//
// These functions are pure and React-free. They're used by the state reducer
// and checkpoint serialization, and can also be consumed directly from smoke
// tests and CI scripts.
// ═══════════════════════════════════════════════════════════════════════════

import { djb2 } from "../utils/hash.js";

/**
 * Creates a blank per-module state scaffold.
 *
 * IMPORTANT: `completed` is a Set. Object.assign({}, mod) copies the
 * reference, not the Set contents. All state updaters MUST create a new
 * Set via `new Set(...)` when modifying completed — never call
 * `mod.completed.add(x)` on an existing reference, or React won't
 * detect the change.
 *
 * @returns {object} Fresh module state scaffold
 */
export function blankModule() {
  return {
    stageData: {},
    completed: new Set(),
    stageErrors: {},
    stageRuns: {},
    executionPath: [],
    activeRunTab: {},
    showDebug: {},
    contentHash: null,       // djb2 hash of spec.iface + spec.params + rtlCode
    childHashes: {},         // { [childModId]: { contentHash, ifaceHash } }
  };
}

/**
 * Compute a content hash from spec interface, params, and RTL code.
 * Used to detect when a child module has meaningfully changed (and
 * therefore parents may need re-verification).
 *
 * @param {object} spec     - The stage 2 spec object (may be null/undefined)
 * @param {string} rtlCode  - The stage 4 RTL code (may be null/undefined)
 * @returns {string} 8-char hex hash
 */
export function computeContentHash(spec, rtlCode) {
  const ifacePart = spec && spec.iface  ? JSON.stringify(spec.iface)  : "";
  const paramPart = spec && spec.params ? JSON.stringify(spec.params) : "";
  return djb2(ifacePart + "|" + paramPart + "|" + (rtlCode || ""));
}

/**
 * Compute just the interface signature hash (ports + params, no RTL code).
 * Used when a parent wants to check whether a child's interface has
 * changed without caring about the child's internal implementation.
 *
 * @param {object} spec - The stage 2 spec object (may be null/undefined)
 * @returns {string} 8-char hex hash
 */
export function computeIfaceHash(spec) {
  const ifacePart = spec && spec.iface  ? JSON.stringify(spec.iface)  : "";
  const paramPart = spec && spec.params ? JSON.stringify(spec.params) : "";
  return djb2(ifacePart + "|" + paramPart);
}
