// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// RunSelectorDropdown — picks among a stage's recorded runs
//
// Renders a dropdown above a stage's content showing every recorded run
// of that stage (the original top-level run + every chain re-run at any
// nesting depth). The user picks which run's result they want to see;
// the parent component then renders stage data from that run's
// `.result` snapshot instead of `stageData[stageId]`.
//
// Run shape (stored in module.stageRuns[stageId][] by the reducer):
//   {
//     runId:      number — sequential per stage
//     trigger:    "user" | "reflow:<ownerKey>"
//     ts:         number — when the run STARTED (ms epoch)
//     finishedAt: number — when the run FINISHED (ms epoch)
//     status:     "running" | "complete" | "error" | "aborted"
//     result:     <the stage's full output snapshot>  | null on error
//     context:    null  for top-level runs
//                 | { depth, parentStageKey, parentIter, reason, error }
//                   for chain re-runs
//   }
//
// Selection state:
//   selectedRunId === null  → caller renders the LATEST run (default)
//   selectedRunId === N     → caller renders run with that runId
//
// If a stage has only one run (the original), we don't render the
// dropdown at all — there's nothing to pick between. The caller can
// check `runs.length > 1` before mounting us.
// ═══════════════════════════════════════════════════════════════════════════

import { TH } from "../../constants/theme.js";

function formatRelativeTime(ts) {
  if (!ts) return "";
  const ageMs = Date.now() - ts;
  if (ageMs < 0) return "just now";
  if (ageMs < 1000) return "just now";
  if (ageMs < 60_000) return Math.floor(ageMs / 1000) + "s ago";
  if (ageMs < 3_600_000) return Math.floor(ageMs / 60_000) + "m ago";
  if (ageMs < 86_400_000) return Math.floor(ageMs / 3_600_000) + "h ago";
  return Math.floor(ageMs / 86_400_000) + "d ago";
}

function formatStatusGlyph(status) {
  switch (status) {
    case "complete": return "✓";
    case "error":    return "✗";
    case "aborted":  return "⊘";
    case "running":  return "…";
    default:         return "·";
  }
}

function statusColor(status) {
  switch (status) {
    case "complete": return TH.accent;
    case "error":    return TH.red;
    case "aborted":  return TH.orange;
    case "running":  return TH.yellow;
    default:         return TH.text3;
  }
}

/**
 * Build a human-readable label for one run.
 *   - "Original run"                                                 (top-level, no context)
 *   - "Re-run inside lint iter 2 (depth 1)"                          (chain, depth 1)
 *   - "Re-run inside judge iter 1 (depth 1)"                         (chain, depth 1)
 *   - "Re-run inside verify iter 2 (depth 2, via lint)"              (chain, depth >1)
 *
 * For depth >1 we don't have the full parent path in `context` —
 * the runner records the immediate parent only. We use depth as a
 * proxy ("depth N") and parentStageKey ("via X") so the user can tell
 * apart same-depth runs from different ancestry.
 */
export function labelForRun(run) {
  if (!run) return "(unknown run)";
  if (!run.context || run.context.depth === 0 || run.context.depth == null) {
    return run.trigger === "user" || !run.trigger
      ? "Original run"
      : "Top-level run · " + (run.trigger || "—");
  }
  const c = run.context;
  const owner = c.parentStageKey || "unknown";
  const iter  = c.parentIter != null ? c.parentIter : "?";
  const depth = c.depth;
  if (depth === 1) {
    return "Re-run inside " + owner + " iter " + iter + " (depth 1)";
  }
  return "Re-run inside " + owner + " iter " + iter + " (depth " + depth + ")";
}

export function RunSelectorDropdown({ stageId, runs, selectedRunId, onSelectRun }) {
  if (!Array.isArray(runs) || runs.length < 2) return null;
  // The "show latest" sentinel renders as the first option. selectedRunId
  // === null is the default (latest); explicit runId means user picked one.
  const latestRun  = runs[runs.length - 1];
  const effectiveId = (selectedRunId == null) ? latestRun.runId : selectedRunId;
  const selectedRun = runs.find(function(r) { return r.runId === effectiveId; }) || latestRun;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "8px 14px",
      background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
      marginBottom: 12,
    }}>
      <span style={{ fontSize: 9, color: TH.text3, fontWeight: 700,
                     textTransform: "uppercase", letterSpacing: 1 }}>
        Viewing run
      </span>
      <select
        value={String(effectiveId)}
        onChange={function(e) {
          const picked = Number(e.target.value);
          // If user picked the latest run, store null so the panel
          // automatically follows future runs as they arrive.
          if (picked === latestRun.runId) {
            onSelectRun(null);
          } else {
            onSelectRun(picked);
          }
        }}
        style={{
          flex: 1,
          padding: "4px 8px",
          background: TH.bg1, color: TH.text0,
          border: "1px solid " + TH.border, borderRadius: 3,
          fontSize: 11, fontFamily: TH.fontMono,
          cursor: "pointer",
        }}
      >
        {runs.map(function(r) {
          const label = labelForRun(r);
          const glyph = formatStatusGlyph(r.status);
          const age   = formatRelativeTime(r.finishedAt || r.ts);
          const latestTag = (r.runId === latestRun.runId) ? " · latest" : "";
          return (
            <option key={r.runId} value={String(r.runId)}>
              {"#" + r.runId + "  " + glyph + "  " + label + "  ·  " + age + latestTag}
            </option>
          );
        })}
      </select>
      {/* Reset to latest */}
      {selectedRunId != null && (
        <button
          onClick={function() { onSelectRun(null); }}
          style={{
            padding: "3px 8px", fontSize: 9,
            background: TH.bg1, color: TH.text2,
            border: "1px solid " + TH.border, borderRadius: 3,
            cursor: "pointer", fontFamily: TH.fontMono,
          }}
          title="Snap selection to whatever run is most recent"
        >
          ↻ LATEST
        </button>
      )}
      {/* Status badge for the selected run */}
      <span style={{
        fontSize: 9, padding: "2px 7px",
        background: TH.bg1, border: "1px solid " + statusColor(selectedRun.status),
        color: statusColor(selectedRun.status),
        borderRadius: 3, fontFamily: TH.fontMono, fontWeight: 700,
        textTransform: "uppercase",
      }}>
        {selectedRun.status || "—"}
      </span>
    </div>
  );
}
