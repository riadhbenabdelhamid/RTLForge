// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/format — ANSI styling primitives + small layout helpers
//
// Honours NO_COLOR (https://no-color.org/) and stdout TTY detection. When
// colors are disabled, ALL helpers degrade to plain text that still aligns.
// ═══════════════════════════════════════════════════════════════════════════

const ESC = "\u001b[";

/** Detect whether to emit color codes. */
export function colorsEnabled() {
  if (process.env.NO_COLOR != null) return false;        // strict NO_COLOR
  if (process.env.RTLFORGE_NO_COLOR != null) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  if (process.stdout && typeof process.stdout.isTTY === "boolean") {
    return process.stdout.isTTY;
  }
  return false;
}

function wrap(open, close) {
  return function(text) {
    if (!colorsEnabled()) return String(text);
    return ESC + open + "m" + String(text) + ESC + close + "m";
  };
}

export const c = {
  reset:   wrap("0",  "0"),
  bold:    wrap("1",  "22"),
  dim:     wrap("2",  "22"),
  italic:  wrap("3",  "23"),
  underline: wrap("4", "24"),
  // Foreground
  red:     wrap("31", "39"),
  green:   wrap("32", "39"),
  yellow:  wrap("33", "39"),
  blue:    wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan:    wrap("36", "39"),
  gray:    wrap("90", "39"),
  white:   wrap("37", "39"),
  // Bright
  brightRed:    wrap("91", "39"),
  brightYellow: wrap("93", "39"),
  brightGreen:  wrap("92", "39"),
  brightBlue:   wrap("94", "39"),
};

/**
 * Status icons (always plain ASCII so they render in any terminal). The
 * paired color helps readability on color-capable terminals.
 */
export const ICON = {
  ok:      function() { return c.green("✓"); },
  fail:    function() { return c.red("✗"); },
  pending: function() { return c.gray("·"); },
  running: function() { return c.brightYellow("◐"); },
  warn:    function() { return c.yellow("⚠"); },
  info:    function() { return c.cyan("ℹ"); },
  arrow:   function() { return c.gray("→"); },
};

/**
 * Truncate or pad to exactly `width` columns (no Unicode width handling —
 * we keep it simple; SV identifiers, stage labels, and module names are
 * all ASCII in practice).
 */
export function pad(s, width, side) {
  const str = String(s == null ? "" : s);
  if (str.length === width) return str;
  if (str.length > width) return str.slice(0, Math.max(0, width - 1)) + "…";
  const padding = " ".repeat(width - str.length);
  return side === "right" ? padding + str : str + padding;
}

/**
 * Render a 2D table with column-aligned cells.
 *
 * @param {Array<{key: string, label: string, width?: number, align?: "left"|"right"}>} cols
 * @param {Array<object>} rows
 * @returns {string} multi-line string ready for stdout.
 */
export function table(cols, rows) {
  // Auto-width: max(header, max-row) per column unless caller pinned width.
  const widths = cols.map(function(col) {
    if (typeof col.width === "number") return col.width;
    let w = String(col.label || col.key).length;
    for (const r of rows) {
      const v = r[col.key];
      const len = String(v == null ? "" : v).length;
      if (len > w) w = len;
    }
    return Math.min(w, 80);
  });

  const lines = [];
  // Header
  lines.push(cols.map(function(col, i) {
    return c.bold(pad(col.label || col.key, widths[i], col.align));
  }).join("  "));
  // Separator
  lines.push(c.dim(widths.map(function(w) { return "─".repeat(w); }).join("  ")));
  // Rows
  for (const r of rows) {
    lines.push(cols.map(function(col, i) {
      let val = r[col.key];
      if (typeof col.format === "function") val = col.format(val, r);
      return pad(val, widths[i], col.align);
    }).join("  "));
  }
  return lines.join("\n");
}

/**
 * Indent every line of `text` by `n` spaces.
 */
export function indent(text, n) {
  const pad = " ".repeat(n || 2);
  return String(text).split("\n").map(function(l) { return pad + l; }).join("\n");
}

/**
 * Box a heading line. Width auto from text.
 */
export function heading(text) {
  const t = String(text);
  return c.bold(c.cyan(t)) + "\n" + c.dim("─".repeat(t.length));
}

/**
 * Format a duration in ms as a human-readable string.
 */
export function duration(ms) {
  if (ms == null || isNaN(ms)) return "—";
  if (ms < 1000)        return ms + "ms";
  if (ms < 60_000)      return (ms / 1000).toFixed(1) + "s";
  if (ms < 3_600_000)   return Math.floor(ms / 60_000) + "m " + Math.floor((ms % 60_000) / 1000) + "s";
  return Math.floor(ms / 3_600_000) + "h " + Math.floor((ms % 3_600_000) / 60_000) + "m";
}
