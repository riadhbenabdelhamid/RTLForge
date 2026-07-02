// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// applyEdits — fail-closed exact-match patcher for fix-loop edits (roadmap #2)
//
// Patch-mode fix prompts return { edits: [{ find, replace }] } instead of the
// whole file: ~10× smaller outputs, no truncation ladder, and the unchanged
// 95 % of the file cannot churn. The contract mirrors the Edit-tool: each
// `find` must match the current code EXACTLY and UNIQUELY. Fail-closed — if
// ANY edit fails, nothing is applied and the caller falls back to the
// full-file path, so the worst case is exactly today's behavior.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {string} code
 * @param {Array<{find: string, replace: string}>} edits
 * @returns {{ok: boolean, code: string, applied: number, failReason: string|null}}
 */
export function applyEdits(code, edits) {
  const src = String(code || "");
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, code: src, applied: 0, failReason: "no edits" };
  }
  let cur = src;
  let applied = 0;
  for (const e of edits) {
    const find = e && typeof e.find === "string" ? e.find : "";
    const replace = e && typeof e.replace === "string" ? e.replace : null;
    if (!find || replace === null) {
      return { ok: false, code: src, applied: 0, failReason: "edit " + (applied + 1) + " malformed (find/replace must be strings)" };
    }
    const first = cur.indexOf(find);
    if (first === -1) {
      return { ok: false, code: src, applied: 0, failReason: "edit " + (applied + 1) + " not found in current code" };
    }
    if (cur.indexOf(find, first + 1) !== -1) {
      return { ok: false, code: src, applied: 0, failReason: "edit " + (applied + 1) + " matches more than once (not unique)" };
    }
    cur = cur.slice(0, first) + replace + cur.slice(first + find.length);
    applied++;
  }
  if (cur === src) {
    return { ok: false, code: src, applied: 0, failReason: "edits produced identical code" };
  }
  return { ok: true, code: cur, applied, failReason: null };
}
