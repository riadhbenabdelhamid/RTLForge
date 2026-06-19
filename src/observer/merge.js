// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// observer/merge — pure merge-planning for `rtlforge observe merge <other.db>`
//
// WHY A SEPARATE PURE MODULE:
//
// The DB wiring (open the source read-only, read both sides, insert the new
// rows) lives in the CLI command. The DECISION — which incoming rows are new
// vs already-present — is pure and lives here so it is unit-testable WITHOUT
// better-sqlite3 (a native dep that isn't always installed). This mirrors the
// repo's "pure core + adapter" split (errorsToAvoid, triageMemory).
//
// DEDUP: by content signature. Autoincrement `id` is per-DB and not portable
// across databases, so two DBs that recorded the same observation hold
// different ids; we instead key on a stable content signature (the same
// `sigOf` used by import-browser, injected here as `sigFn`). Consequences:
//   • re-running a merge inserts nothing (idempotent);
//   • duplicate rows WITHIN one source collapse to a single insert.
//
// DISMISSED ROWS: skipped by default — don't import a teammate's hidden
// noise. `opts.includeDismissed` carries them in (re-inserted un-dismissed,
// since insertEvent always writes flag_dismissed = 0).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Decide which incoming rows to insert into a destination that already holds
 * `existingRows`. Pure — no DB, no I/O.
 *
 * @param {Array}    existingRows  rows already in the destination
 * @param {Array}    incomingRows  rows from the source DB
 * @param {Function} sigFn         row → stable content signature (string)
 * @param {object}   [opts]
 * @param {boolean}  [opts.includeDismissed=false]  carry dismissed source rows
 * @returns {{ toInsert: Array, inserted: number, dupSkipped: number,
 *            dismissedSkipped: number, scanned: number }}
 */
export function planMerge(existingRows, incomingRows, sigFn, opts) {
  const o = opts || {};
  const incoming = Array.isArray(incomingRows) ? incomingRows : [];
  const seen = new Set();
  for (const e of (existingRows || [])) {
    if (e) seen.add(sigFn(e));
  }
  const toInsert = [];
  let dupSkipped = 0;
  let dismissedSkipped = 0;
  for (const r of incoming) {
    if (!r) continue;
    if (o.includeDismissed !== true && (r.flag_dismissed === 1 || r.flag_dismissed === true)) {
      dismissedSkipped++;
      continue;
    }
    const sig = sigFn(r);
    if (seen.has(sig)) { dupSkipped++; continue; }
    seen.add(sig);          // collapse duplicate incoming rows within one merge
    toInsert.push(r);
  }
  return {
    toInsert:         toInsert,
    inserted:         toInsert.length,
    dupSkipped:       dupSkipped,
    dismissedSkipped: dismissedSkipped,
    scanned:          incoming.length,
  };
}
