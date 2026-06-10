// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// react/components/atoms — 12 small UI primitives
//
// The foundation layer of the React component split. These components are pure
// functions of props with no useReducer or useProject dependency. They consume
// only the theme object (TH) from constants and a few React hooks. Stage
// components, settings panels, and the root RTLForge component import from here.
//
// Each component is a top-level `export function` so consumers can tree-shake
// and import individually.
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef } from "react";
import { TH } from "../../constants/theme.js";

// ─── Spinner ───────────────────────────────────────────────────────────────
// Centered loading spinner with optional caption. The `spin` keyframe is
// expected to be defined globally (in the app root style block).
export function Spinner({ text }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 50, justifyContent: "center" }}>
      <div style={{ width: 20, height: 20, border: "2px solid " + TH.bg3, borderTop: "2px solid " + TH.accent, borderRadius: "50%", animation: "spin .7s linear infinite" }} />
      <span style={{ color: TH.text2, fontSize: 12 }}>{text || "Processing…"}</span>
    </div>
  );
}

// ─── SubTab ────────────────────────────────────────────────────────────────
// Pill-style tab strip. Each tab is { id, label, count? }.
export function SubTab({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 2, background: TH.bg0, borderRadius: 6, padding: 3, marginBottom: 16, flexWrap: "wrap" }}>
      {tabs.map(function(t) {
        return (
          <button
            key={t.id}
            onClick={function() { onChange(t.id); }}
            style={{
              padding: "6px 14px",
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 600,
              border: "none",
              cursor: "pointer",
              fontFamily: TH.font,
              letterSpacing: 0.3,
              transition: "all .15s",
              background: active === t.id ? TH.bg2 : "transparent",
              color: active === t.id ? TH.accent : TH.text2,
              boxShadow: active === t.id ? "inset 0 0 0 1px " + TH.border : "none",
            }}
          >
            {t.label}
            {t.count != null && <span style={{ marginLeft: 5, opacity: 0.5 }}>({t.count})</span>}
          </button>
        );
      })}
    </div>
  );
}

// ─── Chip ──────────────────────────────────────────────────────────────────
// A toggle/filter pill. Becomes hollow when inactive and filled when active.
export function Chip({ label, active, onClick, disabled }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      style={{
        display: "inline-flex",
        padding: "4px 11px",
        borderRadius: 4,
        fontSize: 11,
        cursor: disabled ? "default" : "pointer",
        border: "1px solid " + (active ? TH.accent : TH.border),
        background: active ? TH.accentDim : "transparent",
        color: active ? TH.accent : TH.text1,
        transition: "all .12s",
        fontFamily: TH.font,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

// ─── Btn ───────────────────────────────────────────────────────────────────
// Standard button with three variants: "primary" (default), "secondary",
// "danger". Style overrides via `style` prop merge on top of the variant.
export function Btn({ children, variant, size, onClick, disabled, style: s, title }) {
  // Variant map — `ghost` was previously falling back to primary because
  // it wasn't declared here. That's now fixed: ghost = transparent bg,
  // text1 color, soft border — the standard "tertiary action" look.
  const vs = {
    primary:   { background: TH.accent,        color: TH.bg0,   borderColor: TH.accent },
    secondary: { background: "transparent",    color: TH.text1, borderColor: TH.border },
    ghost:     { background: "transparent",    color: TH.text1, borderColor: "transparent" },
    danger:    { background: "transparent",    color: TH.red,   borderColor: TH.red    },
  }[variant || "primary"] || { background: TH.accent, color: TH.bg0, borderColor: TH.accent };

  // Size: "sm" for dense toolbars (Settings, SkillsTab header), default
  // for primary actions. Both honor `whiteSpace: nowrap` so labels don't
  // hyphenate inside a flex row.
  const sizing = (size === "sm")
    ? { padding: "4px 10px", fontSize: 11, fontWeight: 500 }
    : { padding: "7px 16px", fontSize: 12, fontWeight: 600 };

  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title || undefined}
      style={Object.assign({
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        borderRadius: 4,
        cursor: disabled ? "not-allowed" : "pointer",
        border: "1px solid",
        fontFamily: TH.font,
        transition: "all .15s",
        opacity: disabled ? 0.4 : 1,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }, sizing, vs, s || {})}
    >
      {children}
    </button>
  );
}

// ─── Tag ───────────────────────────────────────────────────────────────────
// Small inline label. Color and background are independent so callers can
// theme it for severity, status, or category.
export function Tag({ children, color, bg }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 3,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 0.5,
      whiteSpace: "nowrap",
      color: color || TH.text2,
      background: bg || TH.bg3,
    }}>
      {children}
    </span>
  );
}

// ─── MetricCard ────────────────────────────────────────────────────────────
// Boxed label/value pair used in summary headers. Color defaults to accent.
export function MetricCard({ label, value, color }) {
  return (
    <div style={{ background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4, padding: "10px 16px", minWidth: 100 }}>
      <div style={{ fontSize: 10, color: TH.text2, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || TH.accent, fontFamily: TH.fontD }}>{value}</div>
    </div>
  );
}

// ─── CodeBlock ─────────────────────────────────────────────────────────────
// Read-only code display. With `lineNumbers` it renders a gutter; without
// it's just a scrollable monospace box. The fixed line height is critical:
// the textarea variant (in EditableCodeView) syncs its scroll to the gutter
// using the same px line height so the numbers stay aligned.
export function CodeBlock({ code, maxH, lineNumbers }) {
  const fontSize = 11.5;
  const lh = "19px"; // fixed px line height ensures perfect alignment
  if (!lineNumbers) {
    return (
      <div style={{
        background: TH.bg0,
        border: "1px solid " + TH.border,
        borderRadius: 4,
        padding: 16,
        overflow: "auto",
        maxHeight: maxH || 450,
        fontSize: fontSize,
        lineHeight: lh,
        whiteSpace: "pre",
        color: TH.text1,
        fontFamily: TH.font,
      }}>
        {code}
      </div>
    );
  }
  const lines = (code || "").split("\n");
  const gutterW = String(lines.length).length * 9 + 18;
  return (
    <div style={{ background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4, overflow: "auto", maxHeight: maxH || 450, fontFamily: TH.font, display: "flex" }}>
      <div style={{ flexShrink: 0, width: gutterW, padding: "16px 0", textAlign: "right", userSelect: "none", color: TH.text3, borderRight: "1px solid " + TH.border, background: TH.bg1 }}>
        {lines.map(function(_, i) {
          return <div key={i} style={{ paddingRight: 10, fontSize: fontSize, lineHeight: lh, height: lh }}>{i + 1}</div>;
        })}
      </div>
      <div style={{ flex: 1, padding: 16, whiteSpace: "pre", color: TH.text1, overflow: "visible", fontSize: fontSize, lineHeight: lh, margin: 0 }}>{code}</div>
    </div>
  );
}

// ─── EditableCodeView ──────────────────────────────────────────────────────
// CodeBlock + edit toggle + manual-edit annotation banners + scroll sync
// between textarea and gutter. Used by stage views (RTL, TB) where users
// can override LLM-generated code.
export function EditableCodeView({ code, onChange, label, maxH, fixSource, originalCode, onRestore, manualImport, importedAt }) {
  const [editing, setEditing]     = useState(false);
  const [editCode, setEditCode]   = useState(code || "");
  const [wasEdited, setWasEdited] = useState(false);
  const textareaRef = useRef(null);
  const gutterRef   = useRef(null);

  // Sync editCode when code changes externally (e.g. pipeline re-run)
  useEffect(function() {
    if (!editing) setEditCode(code || "");
  }, [code, editing]);

  const fontSize = 11.5;
  const lh = "19px";
  const lines = (editing ? editCode : (code || "")).split("\n");
  const gutterW = String(lines.length).length * 9 + 18;

  function handleSave() {
    if (editCode !== code) {
      onChange(editCode);
      setWasEdited(true);
    }
    setEditing(false);
  }
  function handleCancel() {
    setEditCode(code || "");
    setEditing(false);
  }

  // Sync scroll between textarea and gutter
  function handleScroll(e) {
    if (gutterRef.current) gutterRef.current.scrollTop = e.target.scrollTop;
  }

  const isEdited = wasEdited || (code && originalCode && code !== originalCode && !fixSource);

  return (
    <div>
      {/* Annotation banners */}
      {manualImport && (
        <div style={{ marginBottom: 8, padding: "6px 12px", background: TH.blueDim, border: "1px solid rgba(56,189,248,.3)", borderRadius: 4, fontSize: 11, color: TH.blue }}>
          📁 Manually imported {label} — not LLM-generated{importedAt ? " (" + importedAt.substring(0, 16) + ")" : ""}
        </div>
      )}
      {fixSource && (
        <div style={{ marginBottom: 8, padding: "6px 12px", background: TH.orangeDim, border: "1px solid rgba(251,146,60,.3)", borderRadius: 4, fontSize: 11, color: TH.orange, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>⚠ Code modified: <strong>{fixSource}</strong></span>
          {originalCode && onRestore && (
            <button onClick={onRestore} style={{ background: TH.bg0, border: "1px solid " + TH.orange, borderRadius: 3, padding: "2px 10px", color: TH.orange, fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: TH.font }}>
              ↺ Restore Original
            </button>
          )}
        </div>
      )}
      {isEdited && !fixSource && (
        <div style={{ marginBottom: 8, padding: "6px 12px", background: "rgba(192,132,252,.1)", border: "1px solid rgba(192,132,252,.25)", borderRadius: 4, fontSize: 11, color: "#c084fc", display: "flex", alignItems: "center", gap: 6 }}>
          ✏️ Manually edited by user
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
        {!editing && (
          <button onClick={function() { setEditCode(code || ""); setEditing(true); }} style={{ padding: "3px 10px", borderRadius: 3, border: "1px solid " + TH.border, background: TH.bg1, color: TH.text1, fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: TH.font }}>
            ✏ Edit
          </button>
        )}
        {editing && (
          <button onClick={handleSave} style={{ padding: "3px 10px", borderRadius: 3, border: "1px solid " + TH.accent, background: TH.accentDim, color: TH.accent, fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: TH.font }}>
            💾 Save
          </button>
        )}
        {editing && (
          <button onClick={handleCancel} style={{ padding: "3px 10px", borderRadius: 3, border: "1px solid " + TH.border, background: TH.bg1, color: TH.text2, fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: TH.font }}>
            ✕ Cancel
          </button>
        )}
        <span style={{ fontSize: 10, color: TH.text3, marginLeft: 4 }}>{lines.length} lines</span>
        {editing && <span style={{ fontSize: 10, color: TH.yellow, marginLeft: "auto" }}>Editing…</span>}
      </div>

      {/* Code area */}
      {editing ? (
        <div style={{ display: "flex", border: "1px solid " + TH.accent, borderRadius: 4, overflow: "hidden", maxHeight: maxH || 550, background: TH.bg0 }}>
          <div ref={gutterRef} style={{ flexShrink: 0, width: gutterW, padding: "10px 0", textAlign: "right", userSelect: "none", color: TH.text3, borderRight: "1px solid " + TH.border, background: TH.bg1, overflow: "hidden" }}>
            {lines.map(function(_, i) {
              return <div key={i} style={{ paddingRight: 10, fontSize: fontSize, lineHeight: lh, height: lh }}>{i + 1}</div>;
            })}
          </div>
          <textarea
            ref={textareaRef}
            value={editCode}
            onChange={function(e) { setEditCode(e.target.value); }}
            onScroll={handleScroll}
            spellCheck={false}
            style={{ flex: 1, margin: 0, padding: 10, border: "none", outline: "none", resize: "none", background: "transparent", color: TH.text0, fontSize: fontSize, lineHeight: lh, fontFamily: TH.font, whiteSpace: "pre", overflow: "auto", minHeight: 200, maxHeight: maxH || 550 }}
          />
        </div>
      ) : (
        <CodeBlock code={code || ("No " + (label || "code") + ".")} maxH={maxH || 550} lineNumbers />
      )}
    </div>
  );
}

// ─── DataTable ─────────────────────────────────────────────────────────────
// Minimal CSS-grid-based table. `columns` is a list of header strings,
// `rows` is a list of arrays of cell content (already rendered React nodes),
// `gridCols` is a CSS grid-template-columns string the caller chooses.
export function DataTable({ columns, rows, gridCols }) {
  return (
    <div style={{ border: "1px solid " + TH.border, borderRadius: 4, overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: gridCols, padding: "8px 12px", background: TH.bg0, borderBottom: "2px solid " + TH.border, fontSize: 10, fontWeight: 700, color: TH.text2, textTransform: "uppercase", letterSpacing: 0.8 }}>
        {columns.map(function(c) { return <span key={c}>{c}</span>; })}
      </div>
      {rows.map(function(r, i) {
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: gridCols, padding: "8px 12px", borderBottom: i < rows.length - 1 ? "1px solid " + TH.bg1 : "none", fontSize: 12, alignItems: "center" }}>
            {r}
          </div>
        );
      })}
    </div>
  );
}

// ─── ErrorBox ──────────────────────────────────────────────────────────────
// Red-bordered error display with a "Error: " prefix.
export function ErrorBox({ msg }) {
  return (
    <div style={{ padding: 16, background: TH.redDim, border: "1px solid " + TH.red, borderRadius: 6, color: TH.red, fontSize: 12, lineHeight: 1.5, wordBreak: "break-word" }}>
      <strong>Error: </strong>{msg}
    </div>
  );
}

// ─── Label ─────────────────────────────────────────────────────────────────
// Form field label with the small uppercase styling used throughout settings.
export function Label({ children }) {
  return (
    <label style={{ display: "block", fontSize: 10, color: TH.text2, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, fontWeight: 700 }}>
      {children}
    </label>
  );
}

// ─── RunHistoryPanel ───────────────────────────────────────────────────────
// Renders the per-run streaming log with run-tab selectors, status indicators,
// and a metrics bar (TTFT, tok/s, output tokens). Streams the active run text
// and auto-scrolls to the bottom on append.
export function RunHistoryPanel({ runs, activeRunId, setActiveRunId }) {
  const logRef = useRef(null);

  // Hooks must run unconditionally — declare before any early return
  const activeRun = (runs && runs.length > 0)
    ? (runs.find(function(r) { return r.runId === activeRunId; }) || runs[runs.length - 1])
    : null;
  const text = activeRun ? (activeRun.text || "") : "";

  useEffect(function() {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [text]);

  if (!runs || runs.length === 0) {
    return <div style={{ padding: 20, color: TH.text3, fontSize: 11 }}>No run data yet.</div>;
  }

  const metrics = activeRun.metrics || {};
  const isStreaming = activeRun.status === "running" && text.length > 0;

  const runStatusColor = function(r) {
    return r.status === "complete" ? TH.accent
         : r.status === "error"    ? TH.red
         : r.status === "aborted"  ? TH.orange
         : TH.yellow;
  };
  const runLabel = function(r) {
    return "Run " + r.runId
      + (r.status === "aborted" ? " (aborted)" : "")
      + (r.trigger && r.trigger !== "manual" && r.trigger !== "initial" ? " (" + r.trigger + ")" : "");
  };

  return (
    <div>
      {/* Run selector tabs */}
      {runs.length > 1 && (
        <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
          {runs.map(function(r) {
            const isActive = r.runId === (activeRunId || runs[runs.length - 1].runId);
            return (
              <button
                key={r.runId}
                onClick={function() { setActiveRunId(r.runId); }}
                style={{
                  padding: "4px 12px",
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 600,
                  border: "1px solid",
                  cursor: "pointer",
                  fontFamily: TH.font,
                  transition: "all .12s",
                  background: isActive ? TH.bg2 : "transparent",
                  borderColor: isActive ? runStatusColor(r) : TH.border,
                  color: isActive ? runStatusColor(r) : TH.text2,
                }}
              >
                {runLabel(r)}
                <span style={{ marginLeft: 5, width: 6, height: 6, borderRadius: "50%", background: runStatusColor(r), display: "inline-block", verticalAlign: "middle" }} />
              </button>
            );
          })}
        </div>
      )}
      {/* Active run info bar */}
      <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: isStreaming ? TH.accent : runStatusColor(activeRun), animation: isStreaming ? "pulse 1s infinite" : "none" }} />
          <span style={{ fontSize: 11, color: isStreaming ? TH.accent : TH.text2, fontWeight: 600 }}>
            {isStreaming
              ? "Streaming…"
              : (activeRun.status === "complete" ? "Complete"
                : activeRun.status === "error"    ? "Error"
                : "Waiting")}
          </span>
        </div>
        <span style={{ fontSize: 10, color: TH.text3 }}>{new Date(activeRun.ts).toLocaleTimeString()}</span>
        {activeRun.trigger && activeRun.trigger !== "initial" && <Tag color={TH.orange} bg={TH.orangeDim}>{activeRun.trigger}</Tag>}
        {metrics.ttft > 0 && (
          <div style={{ background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4, padding: "2px 8px" }}>
            <span style={{ fontSize: 9, color: TH.text3 }}>TTFT </span>
            <span style={{ fontSize: 11, color: TH.blue, fontWeight: 700 }}>{metrics.ttft}ms</span>
          </div>
        )}
        {metrics.tokPerSec && (
          <div style={{ background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4, padding: "2px 8px" }}>
            <span style={{ fontSize: 9, color: TH.text3 }}>Speed </span>
            <span style={{ fontSize: 11, color: TH.accent, fontWeight: 700 }}>{metrics.tokPerSec} tok/s</span>
          </div>
        )}
        {metrics.tokensOut > 0 && (
          <div style={{ background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4, padding: "2px 8px" }}>
            <span style={{ fontSize: 9, color: TH.text3 }}>Tokens </span>
            <span style={{ fontSize: 11, color: TH.text0, fontWeight: 700 }}>{metrics.tokensOut}</span>
          </div>
        )}
        {/* Copy + Download buttons for the active run log */}
        {text && text.length > 0 && (
          <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
            <button
              onClick={function() {
                if (typeof navigator !== "undefined" && navigator.clipboard) {
                  navigator.clipboard.writeText(text).catch(function() { /* best-effort */ });
                }
              }}
              title="Copy log to clipboard"
              style={{
                background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 3,
                padding: "2px 8px", cursor: "pointer", color: TH.text1,
                fontSize: 10, fontFamily: TH.font,
              }}
            >📋 Copy</button>
            <button
              onClick={function() {
                if (typeof window === "undefined") return;
                try {
                  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
                  const url  = URL.createObjectURL(blob);
                  const a    = document.createElement("a");
                  a.href = url;
                  a.download = "rtlforge_run_" + (activeRun.runId || "log") + "_" + new Date().toISOString().replace(/[:.]/g, "-") + ".log";
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  setTimeout(function() { URL.revokeObjectURL(url); }, 100);
                } catch (_) { /* best-effort */ }
              }}
              title="Download log as .log file"
              style={{
                background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 3,
                padding: "2px 8px", cursor: "pointer", color: TH.text1,
                fontSize: 10, fontFamily: TH.font,
              }}
            >⬇ Download</button>
          </div>
        )}
      </div>
      {/* Log text */}
      <div ref={logRef} style={{ background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4, padding: 14, maxHeight: 380, overflow: "auto", fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", color: TH.text1, fontFamily: TH.font }}>
        {text || "No output yet."}
        {isStreaming && <span style={{ color: TH.accent, animation: "pulse 0.8s infinite" }}>▌</span>}
      </div>
    </div>
  );
}
