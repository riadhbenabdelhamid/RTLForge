# Themes

Five themes ship with V22: **default** (the original dark teal), **modern**
(macOS-like light blue), **futuristic** (near-black with glowing borders
and editable accent color), **mono** (strict black & white), and **inverted
mono** (white on black).

## Choosing a theme

**Settings → UI tab.** Dropdown with the five themes. The change applies
immediately and persists in `config.theme`.

For the futuristic theme, a color picker appears below the dropdown.
Choose any color and the theme's accent, border tint, glow, and dim
variants all derive from it. The choice persists in `config.themeAccent`.

## Design — proxy-singleton

The whole codebase imports `TH` from `src/constants/theme.js`:

```js
import { TH } from "./constants/theme.js";

style={{ background: TH.bg0, color: TH.text0 }}
```

Pre-V22 `TH` was a frozen object snapshotted at import time, so changing
themes would have required rewriting every component to use a context
provider or CSS variables. Post-V22, `TH` is a **Proxy** that forwards
each property read to a swappable `activeTheme` reference.

```js
// Pseudocode for src/constants/theme.js

let activeTheme = DEFAULT_THEME;

export const TH = new Proxy({}, {
  get: (_, prop) => activeTheme[prop],
});

export function setActiveTheme(name, customAccent) {
  activeTheme = THEMES[name] || DEFAULT_THEME;
  if (name === "futuristic" && customAccent) {
    activeTheme = Object.assign(Object.create(DEFAULT_THEME), activeTheme, {
      accent: customAccent,
      border: accentToBorder(customAccent),
      // ...
    });
  }
  themeVersion++;
  notifyListeners();
}
```

Calling `setActiveTheme()` swaps the reference. Every subsequent `TH.bg0`
read sees the new value with zero component changes.

## Boot integration

`RTLForge.jsx` calls `setActiveTheme(config.theme, config.themeAccent)`
on first render via `useEffect`, and again whenever those config fields
change. It also subscribes to `themeVersion` via a `useReducer` counter
so React knows to re-render the tree when the theme changes (the Proxy
swap itself is silent — React doesn't see it).

## Theme registry

| Theme id | Look |
|---|---|
| `default` | Dark teal accent, the pre-V22 palette |
| `modern` | Light background, macOS system blue (#007aff), soft shadows |
| `futuristic` | Near-black background, accent-tinted glowing borders, **user-editable accent** |
| `mono` | Strict black & white. Two grays for borders + dims. Red/blue/green all collapse to black. |
| `inverted` | White on black inverted monochrome. |

Each theme is a plain object exposing the same key set. Missing keys
inherit from `DEFAULT_THEME` via prototype chain, so themes can omit
fields they don't customize.

## Adding a theme

1. Add a theme object in `src/constants/theme.js` (use the existing
   themes as templates).
2. Register it in `THEMES` and `listThemes()`.

The UI tab reads `listThemes()`, so the new theme appears in the
dropdown automatically.

## PRI_C

The priority-color map (`PRI_C.Must`, `PRI_C.Should`, `PRI_C.Nice-to-Have`)
is also a Proxy that delegates to `TH.red` / `TH.yellow` / `TH.green`.
Components that use `PRI_C[r.pri]` automatically follow the active theme.

## Custom accent derivation

When the user picks a custom accent for the futuristic theme:

```
accent     = chosen color
border     = same color at 42% alpha   (soft visible border tint)
accentDim  = same color at 14% alpha   (tag/chip backgrounds)
glow       = "0 0 0 1px border, 0 0 18px accentDim inset"
```

Both `#rgb` (short hex), `#rrggbb`, and `rgb(...)` inputs are accepted
and converted to the alphaized rgba form.
