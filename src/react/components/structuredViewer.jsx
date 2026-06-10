// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// react/components/structuredViewer — per-iteration LLM-fix viewer
//
// Displays the parsed JSON output of a single fix iteration in a structured
// way:
//   - Fixes tab: enumerates the `fixes` array (id, test/desc).
//   - Side-by-side tab: before-code vs after-code with SystemVerilog syntax
//     highlighting, paged side-by-side. A toggle switches to a vdiff-style
//     line-aligned diff that highlights additions, deletions, and changes.
//
// IMPORTANT: this component reads from the iteration's `_structured` field
// (populated by the pipeline nodes once the LLM call completes). It never
// reads the streaming buffer directly. So mid-stream weird-chunking is
// invisible to this viewer — by design, per user requirement: "wait until
// streaming is complete before displaying".
//
// The component handles missing/null structured data gracefully (shows a
// "structured data not available" placeholder).
// ═══════════════════════════════════════════════════════════════════════════
import { useState, useMemo } from "react";
import { TH } from "../../constants/theme.js";
import { tokenizeSV, svTokenColors } from "../../utils/svHighlight.js";
import { diffLines, diffToSideBySide, diffStats } from "../../utils/diff.js";

const TOKEN_COLOURS = svTokenColors(TH);

/**
 * Render a single line of source code with SV syntax highlighting.
 * Returns an array of <span> elements ready to splat into a parent.
 */
function _highlightLine(line) {
  if (!line) return [];
  const tokens = tokenizeSV(line);
  return tokens.map(function(tok, i) {
    const colour = TOKEN_COLOURS[tok.type] || TH.text0;
    return (
      <span key={i} style={{ color: colour, whiteSpace: "pre" }}>{tok.value}</span>
    );
  });
}

/**
 * SyntaxBlock — renders a code blob with SV syntax highlighting and line
 * numbers. Used by the Side-by-Side view's left and right panels and
 * exported so the SplitCodeView's "Compare past version" panel can reuse the
 * same renderer.
 *
 * @param {object}  p
 * @param {string}  p.code        Code to render.
 * @param {string}  [p.label]     Optional header label.
 * @param {number}  [p.maxH=500]  Max height for the scroll container.
 * @param {boolean} [p.hideHeader=false]  When true, skip the header bar
 *   entirely (useful when this is embedded inside another panel that has
 *   its own header — e.g. SplitCodeView's main code panel).
 * @param {boolean} [p.borderless=false]  When true, omit the outer border /
 *   radius / panel chrome — appropriate when the parent already provides
 *   container styling.
 */
export function SyntaxBlock({ code, label, maxH, hideHeader, borderless }) {
  const lines = (code || "").split("\n");
  return (
    <div style={{
      flex: 1,
      background: TH.bg0,
      border: borderless ? "none" : ("1px solid " + TH.border),
      borderRadius: borderless ? 0 : 4,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
    }}>
      {!hideHeader && (
        <div style={{
          padding: "6px 12px",
          fontSize: 10,
          fontWeight: 700,
          color: TH.text2,
          background: TH.bg1,
          borderBottom: "1px solid " + TH.border,
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}>
          {label}
        </div>
      )}
      <div style={{
        overflow: "auto",
        maxHeight: maxH || 500,
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        lineHeight: 1.55,
      }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <tbody>
            {lines.map(function(line, i) {
              return (
                <tr key={i}>
                  <td style={{
                    padding: "0 8px",
                    color: TH.text3,
                    textAlign: "right",
                    userSelect: "none",
                    background: TH.bg1,
                    borderRight: "1px solid " + TH.border,
                    width: 40,
                    verticalAlign: "top",
                    fontSize: 10,
                  }}>{i + 1}</td>
                  <td style={{
                    padding: "0 8px",
                    whiteSpace: "pre",
                    verticalAlign: "top",
                    color: TH.text0,
                  }}>
                    {_highlightLine(line)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * DiffBlock — vdiff-style line-aligned diff with highlighted additions,
 * deletions, and changes. Each row pairs left/right line numbers and shows
 * the content with side-specific background colour cues.
 *
 * Exported so SplitCodeView's compare panel can use the same renderer when the
 * user toggles vdiff mode.
 */
export function DiffBlock({ before, after, maxH }) {
  const segments = useMemo(function() { return diffLines(before, after); }, [before, after]);
  const rows = useMemo(function() { return diffToSideBySide(segments); }, [segments]);
  const stats = useMemo(function() { return diffStats(segments); }, [segments]);

  // Background colour per row type
  const rowBg = function(type, side) {
    if (type === "equal") return "transparent";
    if (type === "del")   return side === "left"  ? TH.redDim : "transparent";
    if (type === "add")   return side === "right" ? TH.accentDim : "transparent";
    if (type === "change") return side === "left" ? TH.redDim : TH.accentDim;
    return "transparent";
  };
  const cellBorderColour = function(type) {
    if (type === "del")    return TH.red;
    if (type === "add")    return TH.accent;
    if (type === "change") return TH.yellow || TH.orange;
    return TH.border;
  };

  return (
    <div style={{
      background: TH.bg0,
      border: "1px solid " + TH.border,
      borderRadius: 4,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
    }}>
      <div style={{
        padding: "6px 12px",
        fontSize: 10,
        fontWeight: 700,
        color: TH.text2,
        background: TH.bg1,
        borderBottom: "1px solid " + TH.border,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        display: "flex",
        gap: 12,
        alignItems: "center",
      }}>
        <span>Diff</span>
        <span style={{ color: TH.accent, fontWeight: 600 }}>+{stats.added}</span>
        <span style={{ color: TH.red,    fontWeight: 600 }}>−{stats.removed}</span>
        <span style={{ color: TH.text3 }}>{stats.equal} unchanged</span>
      </div>
      <div style={{
        overflow: "auto",
        maxHeight: maxH || 500,
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        lineHeight: 1.55,
      }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <tbody>
            {rows.map(function(row, i) {
              return (
                <tr key={i}>
                  {/* Left line number */}
                  <td style={{
                    padding: "0 8px",
                    color: TH.text3,
                    textAlign: "right",
                    userSelect: "none",
                    background: TH.bg1,
                    borderRight: "1px solid " + TH.border,
                    width: 36,
                    verticalAlign: "top",
                    fontSize: 10,
                  }}>{row.left ? row.left.n : ""}</td>
                  {/* Left content */}
                  <td style={{
                    padding: "0 8px",
                    whiteSpace: "pre",
                    verticalAlign: "top",
                    background: rowBg(row.type, "left"),
                    borderRight: "1px solid " + cellBorderColour(row.type),
                    width: "50%",
                  }}>
                    {row.left ? _highlightLine(row.left.content) : null}
                  </td>
                  {/* Right line number */}
                  <td style={{
                    padding: "0 8px",
                    color: TH.text3,
                    textAlign: "right",
                    userSelect: "none",
                    background: TH.bg1,
                    borderRight: "1px solid " + TH.border,
                    width: 36,
                    verticalAlign: "top",
                    fontSize: 10,
                  }}>{row.right ? row.right.n : ""}</td>
                  {/* Right content */}
                  <td style={{
                    padding: "0 8px",
                    whiteSpace: "pre",
                    verticalAlign: "top",
                    background: rowBg(row.type, "right"),
                    width: "50%",
                  }}>
                    {row.right ? _highlightLine(row.right.content) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * StructuredFixViewer — top-level component for one fix iteration's
 * structured data. Three view modes selectable by user.
 *
 * @param {object} props
 * @param {object} props.structured  The iteration's _structured field, with
 *   shape { rawText, parsed, parseOk, beforeCode, afterCode, kind } OR null
 *   if the iteration didn't reach the LLM-fix step.
 * @param {boolean} [props.streamingInProgress=false] If true, show a
 *   "streaming…" placeholder instead of rendering. Honors the user's
 *   "wait until streaming is complete" requirement.
 * @param {string} [props.title]  Optional title shown at the top.
 * @param {number} [props.maxH=500]  Max height for the code panes.
 */
export function StructuredFixViewer({ structured, streamingInProgress, title, maxH }) {
  const [view, setView] = useState("fixes");      // "fixes" | "sideBySide" | "diff"

  if (streamingInProgress) {
    return (
      <div style={{
        padding: 24,
        textAlign: "center",
        color: TH.text2,
        fontSize: 12,
        background: TH.bg0,
        border: "1px solid " + TH.border,
        borderRadius: 4,
      }}>
        Streaming in progress — structured view will be available when the iteration completes.
      </div>
    );
  }
  if (!structured) {
    return (
      <div style={{
        padding: 24,
        textAlign: "center",
        color: TH.text2,
        fontSize: 12,
        background: TH.bg0,
        border: "1px solid " + TH.border,
        borderRadius: 4,
      }}>
        Structured data not available for this iteration.
      </div>
    );
  }

  const parsed = structured.parsed || {};
  const fixes = Array.isArray(parsed.fixes) ? parsed.fixes : [];
  const beforeCode = structured.beforeCode || "";
  const afterCode  = structured.afterCode  || "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {title && (
        <div style={{ fontSize: 11, color: TH.text2, fontWeight: 600 }}>{title}</div>
      )}
      {/* View selector */}
      <div style={{ display: "flex", gap: 4 }}>
        {[
          { id: "fixes",      label: "Fixes (" + fixes.length + ")" },
          { id: "sideBySide", label: "Side by Side" },
          { id: "diff",       label: "Diff" },
        ].map(function(v) {
          const active = view === v.id;
          return (
            <button
              key={v.id}
              onClick={function() { setView(v.id); }}
              style={{
                padding: "5px 12px",
                fontSize: 11,
                fontWeight: 600,
                background: active ? TH.accentDim : TH.bg1,
                color:      active ? TH.accent    : TH.text2,
                border: "1px solid " + (active ? TH.accent : TH.border),
                borderRadius: 4,
                cursor: "pointer",
              }}
            >{v.label}</button>
          );
        })}
        {!structured.parseOk && (
          <span style={{
            marginLeft: "auto",
            padding: "5px 10px",
            fontSize: 10,
            color: TH.red,
            background: TH.redDim,
            border: "1px solid " + TH.red,
            borderRadius: 4,
          }}>JSON parse failed</span>
        )}
      </div>

      {/* Fixes view */}
      {view === "fixes" && (
        <div style={{
          background: TH.bg0,
          border: "1px solid " + TH.border,
          borderRadius: 4,
          padding: fixes.length === 0 ? 24 : 0,
        }}>
          {fixes.length === 0 ? (
            <div style={{ textAlign: "center", color: TH.text3, fontSize: 11 }}>
              No fixes recorded in this iteration.
            </div>
          ) : (
            fixes.map(function(f, i) {
              const id   = f && (f.id || f.test) ? String(f.id || f.test) : "";
              const desc = f && (f.desc || f.description || f.text)
                ? String(f.desc || f.description || f.text)
                : (typeof f === "string" ? f : JSON.stringify(f));
              return (
                <div key={i} style={{
                  padding: "10px 14px",
                  borderBottom: i < fixes.length - 1 ? "1px solid " + TH.border : "none",
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                }}>
                  <div style={{
                    minWidth: 90,
                    padding: "2px 8px",
                    fontSize: 10,
                    fontWeight: 600,
                    color: TH.accent,
                    background: TH.accentDim,
                    borderRadius: 3,
                    fontFamily: "ui-monospace, monospace",
                  }}>{id || "fix " + (i + 1)}</div>
                  <div style={{ fontSize: 11, color: TH.text1, lineHeight: 1.5, flex: 1 }}>{desc}</div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Side-by-Side view */}
      {view === "sideBySide" && (
        <div style={{ display: "flex", gap: 8 }}>
          <SyntaxBlock code={beforeCode} label="Before" maxH={maxH} />
          <SyntaxBlock code={afterCode}  label="After"  maxH={maxH} />
        </div>
      )}

      {/* Diff view */}
      {view === "diff" && (
        <DiffBlock before={beforeCode} after={afterCode} maxH={maxH} />
      )}
    </div>
  );
}
