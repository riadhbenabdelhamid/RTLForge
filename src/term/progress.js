// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/progress — Live stage-progress renderer
//
// Two render modes:
//   1. TTY mode (interactive)    : redraw the stage list in place using
//                                  ANSI cursor-up / clear-line. Smooth.
//   2. Non-TTY mode (CI / pipe)  : print one line per stage transition.
//                                  No cursor games — works in any log file.
//
// The renderer is "passive" — it owns no timers and does not reach into
// the store. The driver calls `setStageState(stageId, state)` after every
// reducer update and the renderer redraws. This keeps test surface flat.
// ═══════════════════════════════════════════════════════════════════════════

import { c, ICON, pad, duration } from "./format.js";

/**
 * Stage states the renderer knows about:
 *   "pending"  — not started yet
 *   "running"  — currently executing
 *   "ok"       — completed successfully
 *   "fail"     — completed with an error
 *   "warn"     — completed with a non-fatal issue
 *   "skip"     — skipped (e.g. optional stage disabled)
 */
const STATE_TO_ICON = {
  pending: "pending",
  running: "running",
  ok:      "ok",
  fail:    "fail",
  warn:    "warn",
  skip:    "info",
};

/**
 * Build a renderer over a list of stage descriptors:
 *   [{ id: 1, label: "Elicit" }, { id: 2, label: "Spec" }, ...]
 *
 * @param {Array<{id: number, label: string}>} stages
 * @param {object} [opts]
 * @param {NodeJS.WriteStream} [opts.stream]   - default process.stdout
 * @param {boolean} [opts.tty]                 - force TTY mode regardless of stream
 * @returns {object} renderer
 */
export function createProgressRenderer(stages, opts) {
  const o = opts || {};
  const stream = o.stream || process.stdout;
  const isTty = (o.tty != null) ? !!o.tty : !!(stream && stream.isTTY);

  const states = new Map();           // id -> { state, startedAt, finishedAt, note }
  for (const s of stages) {
    states.set(s.id, { state: "pending", startedAt: null, finishedAt: null, note: null });
  }

  let drawn = false;                  // true once the multi-line block is on screen
  const labelWidth = Math.max.apply(null, stages.map(function(s) { return String(s.label).length; }));

  function buildLines() {
    const lines = [];
    for (const s of stages) {
      const st = states.get(s.id) || { state: "pending" };
      const iconKind = STATE_TO_ICON[st.state] || "pending";
      const icon = ICON[iconKind]();
      let label = pad(s.label, labelWidth, "left");
      // Color the label by state so a quick eye-scan shows red rows fast
      if (st.state === "fail")        label = c.red(label);
      else if (st.state === "running") label = c.bold(c.brightYellow(label));
      else if (st.state === "ok")     label = c.green(label);
      else if (st.state === "warn")   label = c.yellow(label);
      else if (st.state === "skip")   label = c.dim(label);
      else                            label = c.dim(label);

      let suffix = "";
      if (st.startedAt && st.finishedAt) {
        suffix = c.dim("  " + duration(st.finishedAt - st.startedAt));
      } else if (st.state === "running" && st.startedAt) {
        suffix = c.dim("  " + duration(Date.now() - st.startedAt));
      }
      if (st.note) suffix += "  " + c.dim(st.note);
      lines.push("  " + icon + "  " + label + suffix);
    }
    return lines;
  }

  function redrawTty() {
    const lines = buildLines();
    if (drawn) {
      // Move cursor up by the number of lines we printed last time, then
      // clear-from-cursor-down. "\u001b[<n>A" up; "\u001b[J" clear-down.
      stream.write("\u001b[" + lines.length + "A\u001b[J");
    }
    stream.write(lines.join("\n") + "\n");
    drawn = true;
  }

  function lineForId(stageId) {
    const s = stages.find(function(x) { return x.id === stageId; });
    if (!s) return null;
    const st = states.get(stageId);
    const icon = ICON[STATE_TO_ICON[st.state] || "pending"]();
    let suffix = "";
    if (st.note)             suffix = " — " + st.note;
    if (st.startedAt && st.finishedAt) {
      suffix += "  " + c.dim("(" + duration(st.finishedAt - st.startedAt) + ")");
    }
    return "  " + icon + "  " + s.label + suffix;
  }

  return {
    /** Mark a stage as starting. */
    start: function(stageId, note) {
      const st = states.get(stageId);
      if (!st) return;
      st.state = "running";
      st.startedAt = Date.now();
      st.finishedAt = null;
      st.note = note || null;
      if (isTty) redrawTty();
      else stream.write(lineForId(stageId) + "\n");
    },
    /** Mark a stage finished with a state. */
    finish: function(stageId, finalState, note) {
      const st = states.get(stageId);
      if (!st) return;
      st.state = finalState || "ok";
      st.finishedAt = Date.now();
      if (note) st.note = note;
      if (isTty) redrawTty();
      else stream.write(lineForId(stageId) + "\n");
    },
    /** Update the running state's note (e.g. "iter 2/3"). */
    update: function(stageId, note) {
      const st = states.get(stageId);
      if (!st) return;
      st.note = note;
      if (isTty) redrawTty();
      // Non-TTY: don't spam — only print on transitions
    },
    /** Initial paint before any stage starts. */
    paint: function() {
      if (!isTty) return;
      redrawTty();
    },
    /** Force a final redraw. Useful so the last "running" state is correct. */
    flush: function() {
      if (isTty) redrawTty();
    },
    /** Read current state of a stage (for tests). */
    stateOf: function(stageId) {
      const st = states.get(stageId);
      return st ? Object.assign({}, st) : null;
    },
    /** Internal: build current lines (for tests). */
    _buildLines: buildLines,
    isTty: isTty,
  };
}
