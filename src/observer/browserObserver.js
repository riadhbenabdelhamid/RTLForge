// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// observer/browserObserver — Browser-side observer (no native SQLite)
//
// Mirrors observer/ingest.js for the GUI. SQLite isn't available in the
// browser, so events go to localStorage instead:
//
//   rtlforge:obs:<workflow>:<ts>:<rand>  →  JSON event row
//
// Storage is bounded by quota (typically 5MB per origin); we prune the
// oldest entries when count exceeds 1000 to stay well under that ceiling.
//
// The CLI command `rtlforge observe import-browser` (future work) can
// merge these into the canonical SQLite DB for users who want one
// unified KB. For now the two surfaces are independent stores with the
// same schema.
// ═══════════════════════════════════════════════════════════════════════════

import { extractObservation } from "./extractor.js";

const OBS_PREFIX = "rtlforge:obs:";
const MAX_EVENTS = 1000;

function lsAvailable() {
  return typeof localStorage !== "undefined" && localStorage != null;
}

function lsKeyFor(workflow) {
  return OBS_PREFIX + (workflow || "rtl") + ":" + Date.now() + ":" +
    Math.random().toString(36).slice(2, 8);
}

/**
 * Same buildRawInput as the node observer — copied for symmetry rather
 * than imported (node version pulls in fs/path).
 */
function buildRawInput(ctx) {
  const r = ctx.stageResult || {};
  const out = {
    stage:           ctx.stageKey,
    succeeded:       !!ctx.succeeded,
    skills_applied:  Array.isArray(ctx.skillsApplied) ? ctx.skillsApplied : [],
  };
  if (ctx.llm) {
    out.tokens_in  = ctx.llm.tokensIn  || 0;
    out.tokens_out = ctx.llm.tokensOut || 0;
    out.latency_ms = ctx.llm.latencyMs || 0;
  }
  switch (ctx.stageKey) {
    case "lint":
    case "lint_test":
      out.error_count   = (r.errors || []).length;
      out.warning_count = (r.warnings || []).length;
      out.fixes_applied = (r.fixes || []).length;
      out.first_errors  = (r.errors || []).slice(0, 3).map(function(e) {
        return typeof e === "string" ? e.slice(0, 200) : (e.msg || "").slice(0, 200);
      });
      break;
    case "verify":
      out.tests_total = r.total || 0;
      out.tests_pass  = r.pass  || 0;
      out.tests_fail  = r.fail  || 0;
      out.cli         = !!r.cli;
      out.coverage    = r.cov || null;
      break;
    case "judge":
      out.overall = r.overall;
      out.score   = r.score;
      out.iterations = (r.judgeHistory || []).length;
      out.eval_failing_ids = r.eval ? (r.eval.failingIds || []).slice(0, 5) : [];
      break;
    case "rtl_review":
    case "test_review":
      out.score = r.score;
      out.fixes_applied = (r.fixes || []).length;
      break;
  }
  return out;
}

/**
 * Browser-side observer entry point. Same shape as node observeStage.
 */
export function observeStageBrowser(ctx, services) {
  try {
    const cfg = (services && services.config) || {};
    if (cfg.observerEnabled !== true) return;
    if (!lsAvailable()) return;

    const raw = buildRawInput(ctx);

    (async function() {
      try {
        const extracted = await extractObservation(raw, services);
        if (!extracted || extracted.kind === "nothing") return;
        const event = {
          ts:          Date.now(),
          workflow:    ctx.workflow || cfg.workflow || "rtl",
          project_id:  ctx.projectId || null,
          module_id:   ctx.moduleId || null,
          stage_key:   ctx.stageKey || null,
          event_kind:  extracted.kind,
          raw_input:   raw,
          extracted:   extracted,
          severity:    extracted.severity || "info",
          flag_dismissed: 0,
        };
        const k = lsKeyFor(event.workflow);
        try {
          localStorage.setItem(k, JSON.stringify(event));
        } catch (_e) {
          // Quota exceeded — prune and retry
          pruneOldest(MAX_EVENTS / 2);
          try { localStorage.setItem(k, JSON.stringify(event)); }
          catch (_e2) { /* give up — observer is best-effort */ }
        }
        // Routine prune to keep within bounds
        pruneOldest(MAX_EVENTS);
      } catch (_e) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[observer/browser] ingest failed: " +
            (_e && _e.message ? _e.message : _e));
        }
      }
    })();
  } catch (_e) { /* outermost guard */ }
}

function pruneOldest(targetMax) {
  if (!lsAvailable()) return;
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(OBS_PREFIX)) keys.push(k);
  }
  if (keys.length <= targetMax) return;
  // Keys include a timestamp prefix (rtlforge:obs:<workflow>:<ts>:<rand>) —
  // sort lexically and the oldest naturally sort first.
  keys.sort();
  const toRemove = keys.slice(0, keys.length - targetMax);
  for (const k of toRemove) {
    try { localStorage.removeItem(k); } catch (_e) { /* ignore */ }
  }
}

/**
 * Browser query helper — list events for a workflow, with the same
 * filters the CLI supports. Useful for the future ObserverTab in the GUI.
 */
export function listBrowserEvents(workflow, opts) {
  if (!lsAvailable()) return [];
  const o = opts || {};
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(OBS_PREFIX)) continue;
    // Filter by workflow if requested
    if (workflow && !k.startsWith(OBS_PREFIX + workflow + ":")) continue;
    let row;
    try { row = JSON.parse(localStorage.getItem(k)); } catch (_e) { continue; }
    if (!row) continue;
    if (o.kind && row.event_kind !== o.kind) continue;
    if (o.severity && row.severity !== o.severity) continue;
    if (o.includeDismissed !== true && row.flag_dismissed) continue;
    row._lsKey = k;
    out.push(row);
  }
  out.sort(function(a, b) { return (b.ts || 0) - (a.ts || 0); });
  return out.slice(0, o.limit || 200);
}

export function dismissBrowserEvent(lsKey) {
  if (!lsAvailable()) return false;
  try {
    const row = JSON.parse(localStorage.getItem(lsKey));
    if (!row) return false;
    row.flag_dismissed = 1;
    localStorage.setItem(lsKey, JSON.stringify(row));
    return true;
  } catch (_e) { return false; }
}

export function deleteBrowserEvent(lsKey) {
  if (!lsAvailable()) return false;
  try { localStorage.removeItem(lsKey); return true; }
  catch (_e) { return false; }
}

export function wipeAllBrowserEvents() {
  if (!lsAvailable()) return 0;
  const toRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(OBS_PREFIX)) toRemove.push(k);
  }
  for (const k of toRemove) localStorage.removeItem(k);
  return toRemove.length;
}
