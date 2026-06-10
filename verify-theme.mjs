// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// verify-theme — Standalone verifier for src/constants/theme.js
//
// Pins the proxy-singleton behavior, theme switching, custom accent
// derivation, and the back-compat key set every theme must support.
// ═══════════════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") await r;
    process.stdout.write("  \u001b[32m✓\u001b[0m " + name + "\n");
    passed++;
  } catch (e) {
    process.stdout.write("  \u001b[31m✗\u001b[0m " + name + "  →  " + (e.message || e) + "\n");
    failures.push({ name, message: e.message || String(e) });
  }
}

const {
  TH, PRI_C, listThemes, setActiveTheme,
  getActiveThemeName, getThemeVersion, subscribeToThemeChanges,
} = await import("./src/constants/theme.js");

// ── registry ─────────────────────────────────────────────────────────────
console.log("\n[theme/registry]");

await check("listThemes returns 5 entries (default + 4 alternates)", () => {
  const themes = listThemes();
  assert.equal(themes.length, 5);
  const ids = themes.map(function(t) { return t.id; }).sort();
  assert.deepEqual(ids, ["default", "futuristic", "inverted", "modern", "mono"]);
});

await check("every theme has the back-compat key set", () => {
  // Switch to each theme and confirm the canonical keys resolve.
  // Missing keys would be `undefined`; via prototype inheritance from
  // DEFAULT_THEME they should always be present.
  const must = ["bg0", "bg1", "bg2", "bg3", "border",
    "accent", "accentDim", "blue", "blueDim", "orange", "orangeDim",
    "red", "redDim", "yellow", "yellowDim", "yellowBright",
    "yellowBrightDim", "green",
    "text0", "text1", "text2", "text3",
    "font", "fontD", "fontMono"];
  for (const t of listThemes()) {
    setActiveTheme(t.id);
    for (const k of must) {
      const v = TH[k];
      assert.ok(v != null && v !== "",
        "theme '" + t.id + "' is missing key '" + k + "'");
    }
  }
  setActiveTheme("default");
});

// ── proxy semantics ──────────────────────────────────────────────────────
console.log("\n[theme/proxy]");

await check("TH.bg0 reflects active theme — switching mutates resolved value", () => {
  setActiveTheme("default");
  const dbg = TH.bg0;
  setActiveTheme("mono");
  const mbg = TH.bg0;
  assert.notEqual(dbg, mbg, "bg0 should differ between default and mono");
  setActiveTheme("default");
});

await check("PRI_C.Must follows the active theme's red", () => {
  setActiveTheme("default");
  const dRed = PRI_C.Must;
  setActiveTheme("mono");
  // In mono, red is collapsed to black (#000000)
  const mRed = PRI_C.Must;
  assert.notEqual(dRed, mRed);
  setActiveTheme("default");
});

await check("Object.keys(TH) returns a usable, non-empty key list", () => {
  setActiveTheme("default");
  const keys = Object.keys(TH);
  assert.ok(keys.length > 0);
  assert.ok(keys.includes("accent"));
  assert.ok(keys.includes("bg0"));
});

await check("'in' operator works on TH proxy", () => {
  setActiveTheme("default");
  assert.ok("accent" in TH);
  assert.ok("text0" in TH);
});

// ── futuristic accent customization ──────────────────────────────────────
console.log("\n[theme/futuristic]");

await check("Futuristic accepts custom accent and updates border tint", () => {
  setActiveTheme("futuristic", "#ff00aa");
  assert.equal(TH.accent, "#ff00aa");
  // Border should be the rgba-tinted accent (42% alpha)
  assert.match(TH.border, /rgba\(255,0,170,0\.42\)/);
  assert.match(TH.accentDim, /rgba\(255,0,170,0\.14\)/);
});

await check("Futuristic with no customAccent falls back to default accent", () => {
  setActiveTheme("futuristic");
  // Default futuristic accent is #00ffd0
  assert.equal(TH.accent, "#00ffd0");
});

await check("Custom accent on non-futuristic theme is ignored", () => {
  setActiveTheme("mono", "#ff00aa");
  // mono accent is hardcoded black; customAccent is ignored
  assert.equal(TH.accent, "#000000");
});

await check("Short hex (#rgb) is expanded correctly for accent tinting", () => {
  setActiveTheme("futuristic", "#f0a");
  // #f0a → r=ff, g=00, b=aa
  assert.match(TH.border, /rgba\(255,0,170/);
});

// ── version + subscription ───────────────────────────────────────────────
console.log("\n[theme/version]");

await check("themeVersion bumps on every setActiveTheme call", () => {
  const v0 = getThemeVersion();
  setActiveTheme("modern");
  const v1 = getThemeVersion();
  setActiveTheme("default");
  const v2 = getThemeVersion();
  assert.ok(v1 > v0);
  assert.ok(v2 > v1);
});

await check("subscribers are notified on theme change", () => {
  let calls = 0;
  let lastV = 0;
  const unsub = subscribeToThemeChanges(function(v) { calls++; lastV = v; });
  setActiveTheme("mono");
  setActiveTheme("default");
  assert.equal(calls, 2);
  assert.ok(lastV > 0);
  unsub();
});

await check("unsubscribed listeners are no longer notified", () => {
  let calls = 0;
  const unsub = subscribeToThemeChanges(function() { calls++; });
  unsub();
  setActiveTheme("modern");
  setActiveTheme("default");
  assert.equal(calls, 0);
});

// ── identity ─────────────────────────────────────────────────────────────
console.log("\n[theme/identity]");

await check("getActiveThemeName reports the current theme", () => {
  setActiveTheme("modern");
  assert.equal(getActiveThemeName(), "modern");
  setActiveTheme("default");
  assert.equal(getActiveThemeName(), "default");
});

await check("unknown theme name falls back to default", () => {
  setActiveTheme("does-not-exist");
  assert.equal(getActiveThemeName(), "default");
});

console.log("\n═══════════════════════════════════════");
console.log("  Passed: " + passed);
console.log("  Failed: " + failures.length);
console.log("  Status: " + (failures.length === 0 ? "ALL PASS ✓" : "FAILURES"));
console.log("═══════════════════════════════════════");
if (failures.length > 0) process.exit(1);
