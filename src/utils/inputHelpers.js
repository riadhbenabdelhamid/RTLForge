// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Input helpers
//
// Replaces the brittle `parseInt(e.target.value) || default` pattern used
// throughout panels.jsx. The old pattern collapses 0, NaN, and empty strings
// all to `default`, which means deleting the value silently snaps to the
// default instead of staying empty for further typing.
//
// `clampIntInput(opts)` returns a function suitable for use as an
// onChange-payload normalizer:
//   - Empty string → returns the `min` (or `0` if no min) so the field is
//     clamped, not snapped to the default.
//   - NaN / non-numeric → returns the previous value if provided, else min.
//   - Out of range → clamped to [min, max].
//   - Otherwise → the parsed integer.
//
// Usage:
//   const clamp = clampIntInput({ min: 1, max: 20, fallback: 3 });
//   onChange = e => setConfig(c => ({ ...c, maxLintIters: clamp(e.target.value, c.maxLintIters) }))
// ═══════════════════════════════════════════════════════════════════════════
export function clampIntInput(opts) {
  const o = opts || {};
  const min = (typeof o.min === "number") ? o.min : -Infinity;
  const max = (typeof o.max === "number") ? o.max :  Infinity;
  const fallback = (typeof o.fallback === "number") ? o.fallback
                 : (typeof o.min === "number") ? o.min : 0;
  return function clamp(rawValue, prev) {
    if (rawValue === "" || rawValue == null) {
      // Empty: clamp to min so the visible value is at least valid; we don't
      // want React to render an uncontrolled "" then snap to a number on the
      // next tick — that's the bug we're fixing.
      return (typeof o.min === "number") ? o.min : fallback;
    }
    const n = parseInt(String(rawValue), 10);
    if (isNaN(n)) {
      return (typeof prev === "number" && !isNaN(prev)) ? prev : fallback;
    }
    if (n < min) return min;
    if (n > max) return max;
    return n;
  };
}
