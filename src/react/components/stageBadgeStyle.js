// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// stageBadgeStyle
//
// Pure helper that computes badge styling from a stage's status flags. Kept
// separate from RTLForge.jsx so the logic can be unit-tested in isolation;
// RTLForge.jsx calls it per-stage in its tab-strip render.
//
// Behavioral contract:
//
//   • Badge SHAPE:
//       - Triangle (clip-path)  → stage is in the multi-stage reflow set
//                                  AND not currently executing
//                                  (Item 2: "awaiting" indicator)
//       - Circle                → everything else (default)
//
//   • Badge TEXT:
//       - "!"                   → hard error
//       - String(stageId)       → stale (rerun-pending) or not-yet-done
//       - "↻"                   → in reflow set (Item 3: replay arrow)
//       - "✓"                   → completed
//       - stageId               → fallback when no other category fits
//
//   • Badge ANIMATION:
//       - pulseFast 0.6s        → in reflow set (awaiting) OR legacy single-target loopback
//       - pulse 1.2s            → currently executing
//       - none                  → idle
//
//   • Colors stay consistent with the existing palette; this helper
//     returns a style object the caller can spread onto a <span>.
// ═══════════════════════════════════════════════════════════════════════════

import { TH } from "../../constants/theme.js";

/**
 * Compute badge style + content for a single stage tab.
 *
 * @param {object} f flags object:
 *   - stageId        — number
 *   - done           — true if previously completed
 *   - isCur          — true if currently executing (the active stage)
 *   - isStale        — true if marked stale by a downstream re-run
 *   - hasErr         — true if a hard error was captured for this stage
 *   - hasFuncFail    — true if completed-but-failed (lint errors, FAIL verdict, etc.)
 *   - inReflowSet    — true if this stage is a member of reflowStageIds
 *                      (and the reflow's modId matches the active mod)
 *   - legacyLoopback — true if loopbackStageId === this stage AND mod matches
 *   - processing     — true while any pipeline is running
 *
 * @returns {object} { badgeStyle, badgeText, isAwaitingReflow, isExecutingInReflow }
 */
export function stageBadgeStyle(f) {
  const isAwaitingReflow    = !!(f.inReflowSet && !f.isCur);
  const isExecutingInReflow = !!(f.inReflowSet && f.isCur);
  const isLoopback = !!f.processing
    && !f.isCur
    && (f.legacyLoopback || f.inReflowSet);

  // Background palette (mirrors prior inline logic for back-compat)
  const badgeBg = f.hasErr ? TH.redDim
    : (f.isStale ? TH.orangeDim
    : (isLoopback ? TH.yellowBrightDim
    : (f.isCur && f.processing ? TH.yellowDim
    : (f.hasFuncFail ? TH.redDim
    : (f.done ? TH.accentDim : TH.bg1)))));
  const badgeColor = f.hasErr ? TH.red
    : (f.isStale ? TH.orange
    : (isLoopback ? TH.yellowBright
    : (f.hasFuncFail ? TH.red
    : (f.done ? TH.accent
    : (f.isCur ? TH.yellow : TH.text3)))));
  const badgeBorder = f.hasErr ? TH.red
    : (f.isStale ? TH.orange
    : (isLoopback ? TH.yellowBright
    : (f.hasFuncFail ? TH.red
    : (f.done ? "rgba(0,255,180,.4)"
    : (f.isCur ? TH.yellow : TH.border)))));

  // ↻ replay arrow for stages in the reflow set. showReplay covers both
  // awaiting + executing; the running stage also shows ↻ because it IS a re-run
  // (the slow pulse distinguishes "this is the one running now").
  const showReplay = !!f.inReflowSet;
  const badgeText = f.hasErr ? "!"
    : (f.isStale ? String(f.stageId)
    : (showReplay ? "↻"
    : (f.done ? "✓" : f.stageId)));

  const animation = isLoopback ? "pulseFast 0.6s infinite"
    : (f.isCur && f.processing ? "pulse 1.2s infinite"
    : "none");

  // Triangle clip-path for awaiting reflow members. The shape signals "queued"
  // vs "currently running" (circle).
  // Text rides slightly low inside a triangle — we shift it down
  // 1px so the glyph reads centered to the eye.
  const badgeStyle = isAwaitingReflow
    ? {
        width: 20, height: 20,
        clipPath: "polygon(50% 0%, 100% 100%, 0% 100%)",
        background: badgeBg,
        color: badgeColor,
        display: "inline-flex",
        alignItems: "flex-end",
        justifyContent: "center",
        paddingBottom: 1,
        fontSize: 9, fontWeight: 700, flexShrink: 0,
        animation: animation,
      }
    : {
        width: 20, height: 20, borderRadius: "50%",
        display: "inline-flex",
        alignItems: "center", justifyContent: "center",
        fontSize: 10, fontWeight: 700, flexShrink: 0,
        background: badgeBg, color: badgeColor,
        border: "1.5px solid " + badgeBorder,
        animation: animation,
      };

  return {
    badgeStyle,
    badgeText,
    isAwaitingReflow,
    isExecutingInReflow,
    isLoopback,
  };
}
