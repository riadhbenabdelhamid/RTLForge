// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// constants/theme — Themeable color palette via Proxy-singleton
//
// Design:
//   Components keep importing `TH` and reading `TH.text0`, `TH.bg0`, etc.
//   The exported `TH` is a Proxy that delegates reads to the ACTIVE
//   theme object. Switching themes is a one-line update:
//
//       setActiveTheme("futuristic")              // by name
//       setActiveTheme("futuristic", "#ff00aa")   // with custom accent
//
//   …followed by `bumpThemeVersion()` which schedules a React re-render
//   at the root (mounted by the app shell). No component code changes;
//   no context provider; no CSS-variables refactor.
//
// AVAILABLE THEMES:
//   "default"   — the existing dark teal accent (kept as default for
//                  backward compatibility with screenshots, tests, etc.)
//   "modern"    — macOS-like, light background, blue accent, soft shadows
//   "futuristic"— near-black with glowing borders, USER-EDITABLE accent
//   "mono"      — black & white only, minimal use of grays
//   "inverted"  — white-on-black inverted monochrome
//
// Every theme exposes the SAME key set as the original TH — components
// must keep working regardless of theme. Missing keys in a theme inherit
// from "default" via a per-theme prototype chain.
//
// THEME PERSISTENCE: config.theme = "futuristic", config.themeAccent =
// "#ff00aa". The settings UI writes those; on app boot the shell calls
// setActiveTheme(config.theme, config.themeAccent) before the first render.
// ═══════════════════════════════════════════════════════════════════════════

// ── Base theme (default palette) ───────────────────────────────────────────
const DEFAULT_THEME = {
  name: "default",
  bg0:        "#06090f",
  bg1:        "#0b1018",
  bg2:        "#111827",
  bg3:        "#1a2332",
  border:     "#1e2a3a",
  accent:     "#00ffb4",
  accentDim:  "rgba(0,255,180,.12)",
  blue:       "#38bdf8",
  blueDim:    "rgba(56,189,248,.12)",
  orange:     "#fb923c",
  orangeDim:  "rgba(251,146,60,.12)",
  red:        "#f87171",
  redDim:     "rgba(248,113,113,.12)",
  yellow:     "#fbbf24",
  yellowDim:  "rgba(251,191,36,.12)",
  yellowBright:    "#fde047",
  yellowBrightDim: "rgba(253,224,71,.18)",
  green:      "#34d399",
  text0:      "#e2e8f0",
  text1:      "#94a3b8",
  text2:      "#64748b",
  text3:      "#475569",
  font:       "'IBM Plex Mono','Fira Code',monospace",
  fontD:      "'Outfit','Manrope',sans-serif",
  fontMono:   "'IBM Plex Mono','Fira Code',monospace",
  // Optional: themes can declare a `glow` style fragment used by atoms
  // that want themed shadows (Futuristic uses this).
  glow:       "none",
};

// ── Modern (macOS-like) ────────────────────────────────────────────────────
// Light background, blue accent, soft shadows, more whitespace feel
// thanks to lighter borders and higher-contrast text. Sticks to the
// system fonts where available.
const MODERN_THEME = Object.assign(Object.create(DEFAULT_THEME), {
  name: "modern",
  bg0:        "#ffffff",
  bg1:        "#f5f5f7",
  bg2:        "#ebebeb",
  bg3:        "#d8d8d8",
  border:     "#d2d2d7",
  accent:     "#007aff",                 // macOS system blue
  accentDim:  "rgba(0,122,255,.10)",
  blue:       "#0a84ff",
  blueDim:    "rgba(10,132,255,.10)",
  orange:     "#ff9500",
  orangeDim:  "rgba(255,149,0,.10)",
  red:        "#ff3b30",
  redDim:     "rgba(255,59,48,.10)",
  yellow:     "#ffcc00",
  yellowDim:  "rgba(255,204,0,.10)",
  yellowBright:    "#ffd60a",
  yellowBrightDim: "rgba(255,214,10,.18)",
  green:      "#34c759",
  text0:      "#1d1d1f",
  text1:      "#3a3a3c",
  text2:      "#6e6e73",
  text3:      "#aeaeb2",
  fontD:      "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif",
  font:       "ui-monospace, 'SF Mono', 'Menlo', monospace",
  fontMono:   "ui-monospace, 'SF Mono', 'Menlo', monospace",
  glow:       "0 1px 2px rgba(0,0,0,0.06), 0 1px 6px rgba(0,0,0,0.04)",
});

// ── Futuristic ─────────────────────────────────────────────────────────────
// Near-black background, glowing borders, editable accent (themeAccent).
// The `accent` field is overwritten by setActiveTheme when the user
// supplies a custom color.
const FUTURISTIC_THEME = Object.assign(Object.create(DEFAULT_THEME), {
  name: "futuristic",
  bg0:        "rgba(2,4,10,0.85)",
  bg1:        "rgba(4,8,16,0.78)",
  bg2:        "rgba(8,14,24,0.72)",
  bg3:        "rgba(12,20,32,0.65)",
  border:     "rgba(0,255,208,.42)",          // accent-tinted by default
  accent:     "#00ffd0",                       // user-editable
  accentDim:  "rgba(0,255,208,.14)",
  text0:      "#e6f7ff",
  text1:      "#a3c4d6",
  text2:      "#6a8ea1",
  text3:      "#46647a",
  glow:       "0 0 0 1px rgba(0,255,208,.30), 0 0 18px rgba(0,255,208,.18) inset",
});

// ── Mono (black & white) ───────────────────────────────────────────────────
// Strict monochrome. Background is white, text is black, accent is also
// black. Two shades of gray (border, dim) and nothing else.
const MONO_THEME = Object.assign(Object.create(DEFAULT_THEME), {
  name: "mono",
  bg0:        "#ffffff",
  bg1:        "#fafafa",
  bg2:        "#f0f0f0",
  bg3:        "#e8e8e8",
  border:     "#d0d0d0",
  accent:     "#000000",
  accentDim:  "rgba(0,0,0,.06)",
  blue:       "#000000",
  blueDim:    "rgba(0,0,0,.06)",
  orange:     "#000000",
  orangeDim:  "rgba(0,0,0,.06)",
  red:        "#000000",
  redDim:     "rgba(0,0,0,.10)",
  yellow:     "#000000",
  yellowDim:  "rgba(0,0,0,.06)",
  yellowBright:    "#000000",
  yellowBrightDim: "rgba(0,0,0,.12)",
  green:      "#000000",
  text0:      "#000000",
  text1:      "#333333",
  text2:      "#666666",
  text3:      "#999999",
  glow:       "none",
});

// ── Inverted mono (white on black) ─────────────────────────────────────────
const INVERTED_MONO_THEME = Object.assign(Object.create(DEFAULT_THEME), {
  name: "inverted",
  bg0:        "#000000",
  bg1:        "#0a0a0a",
  bg2:        "#141414",
  bg3:        "#1e1e1e",
  border:     "#2a2a2a",
  accent:     "#ffffff",
  accentDim:  "rgba(255,255,255,.10)",
  blue:       "#ffffff",
  blueDim:    "rgba(255,255,255,.06)",
  orange:     "#ffffff",
  orangeDim:  "rgba(255,255,255,.06)",
  red:        "#ffffff",
  redDim:     "rgba(255,255,255,.10)",
  yellow:     "#ffffff",
  yellowDim:  "rgba(255,255,255,.06)",
  yellowBright:    "#ffffff",
  yellowBrightDim: "rgba(255,255,255,.18)",
  green:      "#ffffff",
  text0:      "#ffffff",
  text1:      "#cccccc",
  text2:      "#999999",
  text3:      "#666666",
  glow:       "none",
});

// ── Registry ───────────────────────────────────────────────────────────────
const THEMES = {
  default:    DEFAULT_THEME,
  modern:     MODERN_THEME,
  futuristic: FUTURISTIC_THEME,
  mono:       MONO_THEME,
  inverted:   INVERTED_MONO_THEME,
};

export function listThemes() {
  return [
    { id: "default",    label: "Default — Dark Teal" },
    { id: "modern",     label: "Modern — macOS-like" },
    { id: "futuristic", label: "Futuristic — Glow + Custom Accent" },
    { id: "mono",       label: "Mono — Black & White" },
    { id: "inverted",   label: "Inverted Mono — White on Black" },
  ];
}

// ── Active reference + version ─────────────────────────────────────────────
let activeTheme = DEFAULT_THEME;
let themeVersion = 0;
const versionListeners = new Set();

/**
 * Subscribe to theme-version changes (for the React root). Returns an
 * unsubscribe fn.
 */
export function subscribeToThemeChanges(listener) {
  versionListeners.add(listener);
  return function() { versionListeners.delete(listener); };
}

/** Current theme version — used by `useTheme()` to trigger re-renders. */
export function getThemeVersion() { return themeVersion; }

/** Current theme name (e.g. "default", "futuristic"). */
export function getActiveThemeName() { return activeTheme.name; }

/**
 * Set the active theme. Pass `themeName` (one of the registry keys) and
 * an optional `customAccent` (CSS color string) which Futuristic theme
 * applies to its accent + border tint.
 */
export function setActiveTheme(themeName, customAccent) {
  const base = THEMES[themeName] || DEFAULT_THEME;
  // Futuristic supports a per-user accent — we clone the base and patch
  // the accent + related fields. Other themes ignore customAccent.
  if (themeName === "futuristic" && customAccent) {
    const customized = Object.assign(Object.create(DEFAULT_THEME), base, {
      accent:    customAccent,
      // We also tint the border so the glow stays cohesive with the
      // chosen accent. Lightweight approach: 42% alpha overlay using
      // rgba parsed from the hex/rgb input.
      border:    accentToBorder(customAccent),
      accentDim: accentToDim(customAccent),
      glow:      "0 0 0 1px " + accentToBorder(customAccent) + ", 0 0 18px " + accentToDim(customAccent) + " inset",
    });
    activeTheme = customized;
  } else {
    activeTheme = base;
  }
  themeVersion++;
  for (const l of versionListeners) {
    try { l(themeVersion); } catch (_) { /* ignore listener errors */ }
  }
}

/** Helper: derive a translucent border color from an accent CSS value. */
function accentToBorder(c) {
  return alphaize(c, 0.42);
}
/** Helper: derive a 14%-alpha dim variant. */
function accentToDim(c) {
  return alphaize(c, 0.14);
}
function alphaize(c, a) {
  const s = String(c).trim();
  // #RRGGBB
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }
  // #RGB
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const r = parseInt(m[1][0] + m[1][0], 16);
    const g = parseInt(m[1][1] + m[1][1], 16);
    const b = parseInt(m[1][2] + m[1][2], 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }
  // rgb(r,g,b) — wrap with alpha
  m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(s);
  if (m) {
    return "rgba(" + m[1] + "," + m[2] + "," + m[3] + "," + a + ")";
  }
  // already rgba — best-effort: just return as-is (don't break user input)
  return s;
}

// ── The Proxy ──────────────────────────────────────────────────────────────
// Components import `TH` and use `TH.text0`. The Proxy forwards each
// access to the live `activeTheme` reference, so theme changes are
// reflected immediately.
//
// `get` returns the value from `activeTheme` (which already inherits
// missing keys from DEFAULT_THEME via prototype). `ownKeys` and
// `getOwnPropertyDescriptor` are also forwarded so Object.keys(TH) and
// for…in work correctly if any caller relies on them.
export const TH = new Proxy({}, {
  get: function(_target, prop) {
    return activeTheme[prop];
  },
  has: function(_target, prop) {
    return prop in activeTheme;
  },
  ownKeys: function() {
    // Return all keys including inherited (Object.keys would normally
    // skip inherited; we use the union to keep behavior predictable).
    const own = Object.getOwnPropertyNames(activeTheme);
    const proto = Object.getPrototypeOf(activeTheme) || {};
    const inherited = Object.getOwnPropertyNames(proto);
    return Array.from(new Set(own.concat(inherited)));
  },
  getOwnPropertyDescriptor: function(_target, prop) {
    if (prop in activeTheme) {
      return { configurable: true, enumerable: true, value: activeTheme[prop], writable: false };
    }
    return undefined;
  },
});

// ── PRI_C (priority colors) — themed through TH ────────────────────────────
// A getter proxy so priority colors follow the active theme (rather than
// snapshotting TH.red / TH.yellow / TH.green at import time).
export const PRI_C = new Proxy({}, {
  get: function(_t, prop) {
    if (prop === "Must")          return TH.red;
    if (prop === "Should")        return TH.yellow;
    if (prop === "Nice-to-Have")  return TH.green;
    return undefined;
  },
  has: function(_t, prop) {
    return ["Must", "Should", "Nice-to-Have"].indexOf(prop) >= 0;
  },
  ownKeys: function() { return ["Must", "Should", "Nice-to-Have"]; },
  getOwnPropertyDescriptor: function(_t, prop) {
    if (["Must", "Should", "Nice-to-Have"].indexOf(prop) >= 0) {
      return { configurable: true, enumerable: true, writable: false, value: this.get(_t, prop) };
    }
    return undefined;
  },
});
