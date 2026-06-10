// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// react/components/themeTab — UI theme selector
//
// Settings → UI tab. Lists registered themes, applies on change, persists
// to config.theme and (for Futuristic) config.themeAccent.
//
// THEME SWITCHING FLOW:
//   1. User picks a theme in the dropdown.
//   2. We update config (persisted) AND call setActiveTheme() (immediate).
//   3. The app shell subscribes to theme changes via
//      subscribeToThemeChanges() and bumps a render counter so the tree
//      re-renders against the new TH proxy values.
//
// CONTINUOUS-DEVELOPMENT: adding a theme means adding one entry in
// theme.js's THEMES registry. ThemeTab reads listThemes() — no UI
// change needed.
// ═══════════════════════════════════════════════════════════════════════════

import { TH, listThemes, setActiveTheme, getActiveThemeName } from "../../constants/theme.js";

export function ThemeTab({ config, setConfig }) {
  const themes = listThemes();
  const activeName = (config && config.theme) || getActiveThemeName() || "default";
  const customAccent = (config && config.themeAccent) || "#00ffd0";

  function chooseTheme(name) {
    setConfig(function(c) {
      return Object.assign({}, c, { theme: name });
    });
    setActiveTheme(name, name === "futuristic" ? customAccent : undefined);
  }

  function chooseAccent(color) {
    setConfig(function(c) {
      return Object.assign({}, c, { themeAccent: color });
    });
    if (activeName === "futuristic") setActiveTheme("futuristic", color);
  }

  return (
    <div style={{ paddingBottom: 12 }}>
      <div style={{ fontSize: 12, color: TH.text2, marginBottom: 14, lineHeight: 1.6 }}>
        Choose how the interface looks. The "Futuristic" theme accepts a
        custom accent color; other themes ignore it.
      </div>

      {/* Theme dropdown */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <label style={{ fontSize: 12, color: TH.text2, minWidth: 70 }}>Theme:</label>
        <select
          value={activeName}
          onChange={function(e) { chooseTheme(e.target.value); }}
          style={{
            background: TH.bg0, border: "1px solid " + TH.border, color: TH.text0,
            fontSize: 12, padding: "5px 10px", borderRadius: 4,
            fontFamily: TH.font, minWidth: 280,
          }}
        >
          {themes.map(function(t) {
            return <option key={t.id} value={t.id}>{t.label}</option>;
          })}
        </select>
      </div>

      {/* Custom accent — visible only when Futuristic is active */}
      {activeName === "futuristic" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: TH.text2, minWidth: 70 }}>Accent:</label>
          <input
            type="color"
            value={customAccent}
            onChange={function(e) { chooseAccent(e.target.value); }}
            style={{
              width: 48, height: 28, padding: 0,
              background: "transparent", border: "1px solid " + TH.border,
              borderRadius: 4, cursor: "pointer",
            }}
            aria-label="Custom accent color"
          />
          <input
            type="text"
            value={customAccent}
            onChange={function(e) { chooseAccent(e.target.value); }}
            style={{
              background: TH.bg0, border: "1px solid " + TH.border, color: TH.text0,
              fontSize: 12, padding: "5px 10px", borderRadius: 4,
              fontFamily: TH.fontMono || TH.font, width: 110,
            }}
            placeholder="#00ffd0"
            aria-label="Accent color hex value"
          />
          <span style={{ fontSize: 11, color: TH.text2 }}>
            Used for borders, focus rings, and glow effects.
          </span>
        </div>
      )}

      {/* Live preview swatches — show how a few common elements look */}
      <ThemePreview />
    </div>
  );
}

function ThemePreview() {
  return (
    <div style={{
      marginTop: 6,
      padding: 14,
      background: TH.bg0,
      border: "1px solid " + TH.border,
      borderRadius: 6,
    }}>
      <div style={{
        fontSize: 9, color: TH.text3, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: 1, marginBottom: 10,
      }}>
        Preview
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button style={{
          padding: "6px 14px", fontSize: 12, fontWeight: 600,
          background: TH.accent, color: TH.bg0,
          border: "1px solid " + TH.accent, borderRadius: 4,
          fontFamily: TH.font, cursor: "default",
          boxShadow: TH.glow !== "none" ? TH.glow : undefined,
        }}>Primary</button>
        <button style={{
          padding: "6px 14px", fontSize: 12, fontWeight: 500,
          background: "transparent", color: TH.text1,
          border: "1px solid " + TH.border, borderRadius: 4,
          fontFamily: TH.font, cursor: "default",
        }}>Secondary</button>
        <span style={{
          display: "inline-block",
          padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 600,
          color: TH.accent, background: TH.accentDim,
        }}>tag</span>
        <span style={{
          padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 600,
          color: TH.red, background: TH.redDim,
        }}>FAIL</span>
        <span style={{
          padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 600,
          color: TH.green || TH.accent, background: TH.accentDim,
        }}>PASS</span>
        <span style={{
          padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 600,
          color: TH.yellow, background: TH.yellowDim,
        }}>WARN</span>
      </div>
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 13, color: TH.text0, fontFamily: TH.fontD }}>Heading text — text0</span>
        <span style={{ fontSize: 12, color: TH.text1 }}>Body text — text1</span>
        <span style={{ fontSize: 11, color: TH.text2 }}>Muted caption — text2</span>
        <span style={{ fontSize: 10, color: TH.text3 }}>Footnote — text3</span>
      </div>
    </div>
  );
}
