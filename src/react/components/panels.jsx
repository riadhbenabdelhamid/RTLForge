// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// react/components/panels — Top-level dialogs, viewers, and review screens
//
// Four top-level views/dialogs:
//
//   - SplitCodeView  side-by-side code + fixes viewer with draggable splitter
//   - ResumeDialog   checkpoint-detected modal with progress summary +
//                    resume/discard
//   - SettingsPanel  global settings modal with 5 tabs
//                    (workflow/llm/sim/library/checkpoints)
//   - DecompReview   multi-module decomposition review with hierarchy tree +
//                    detail panel
//
// The root RTLForge component mounts these conditionally. None of them touch
// `useProject` directly — their plumbing goes through props, and the root
// component connects dispatches/actions to the callback props each panel
// exposes (onResume, onConfirm, onApplyMatches, etc).
//
// SettingsPanel renders WorkflowTab from the separate workflow.jsx module
// as the content of its first tab. This is a cross-component-file import
// which is fine — it keeps the 85-line DEFAULT_PROMPT_SECTIONS payload in
// workflow.jsx where only SettingsPanel pays for it.
//
// Browser-only notes:
//   - SplitCodeView's drag handler attaches mousemove/mouseup listeners
//     directly to `document`. Guarded with a typeof check for SSR safety.
//   - ResumeDialog and SettingsPanel use `position: fixed` overlays.
//     These work in any DOM context but have no meaning outside one.
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useRef, useEffect } from "react";
import {
  Btn, Tag, Chip, Label, CodeBlock, DataTable, MetricCard, SubTab, ErrorBox,
} from "./atoms.jsx";
import { TH } from "../../constants/theme.js";
import { ALL_STAGES, OPTIONAL_STAGE_DEFS, getStageSettingKeys } from "../../constants/stages.js";
import { PROVIDERS, PROVIDER_SUPPORTS, RECOMMENDED_STAGE_SETTINGS } from "../../constants/providers.js";
import { callLLM } from "../../llm/index.js";
import { testBackendConnection } from "../../cli/index.js";
import { blankModule } from "../../projectState/moduleRegistry.js";
import { computeEffectiveLevels } from "../../projectState/dependencyGraph.js";
import { clampIntInput } from "../../utils/inputHelpers.js";
import { WorkflowTab } from "./workflow.jsx";
import { SkillsTab } from "./skillsTab.jsx";
import { EvalsTab } from "./evalsTab.jsx";
import { ThemeTab } from "./themeTab.jsx";
import { ObserverTab } from "./observerTab.jsx";
import { SyntaxBlock, DiffBlock } from "./structuredViewer.jsx";

// Module-level clampers reused across the SIM tab inputs.
const _clampIter   = clampIntInput({ min: 1, max: 20, fallback: 3 });
const _clampReview = clampIntInput({ min: 1, max: 10, fallback: 2 });
const _clampSimT   = clampIntInput({ min: 1000, max: 100000000, fallback: 100000 });
const _clampNetT   = clampIntInput({ min: 10, max: 3600, fallback: 600 });
const _clampRetry  = clampIntInput({ min: 0, max: 5, fallback: 1 });

// ═══════════════════════════════════════════════════════════════════════════
// DirPickerInput — text input with a "Browse…" button that opens the
// native directory picker. Falls back to text-only input on browsers that
// don't support webkitdirectory.
//
// Web browsers do NOT expose absolute filesystem paths to JavaScript for
// security reasons, so the picker can only return a *relative* representation
// of the chosen folder (the directory's name + the relative paths of the
// files inside). We use that relative name to populate the field and let the
// user prepend any prefix they want; users running RTL Forge in Electron /
// Tauri / a packaged desktop wrapper will get true absolute paths because
// those runtimes expose webkitRelativePath with the absolute root.
//
// Props:
//   value, onChange   — controlled string input pair
//   placeholder       — passed through to <input>
//   style             — applied to the wrapper <input>
//   buttonStyle       — applied to the Browse button
// ═══════════════════════════════════════════════════════════════════════════
export function DirPickerInput({ value, onChange, placeholder, style, buttonStyle, label }) {
  const fileRef = useRef(null);
  const supportsDirPicker = (function() {
    if (typeof document === "undefined") return false;
    const probe = document.createElement("input");
    return "webkitdirectory" in probe || "directory" in probe;
  })();

  function handleBrowse() {
    if (fileRef.current) fileRef.current.click();
  }
  function handleFiles(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // Try to pull a usable directory path from the first file.
    // Electron / Tauri exposes file.path (absolute). Plain browsers expose
    // file.webkitRelativePath like "myDir/sub/file.sv" — we extract "myDir".
    const f = files[0];
    let picked = null;
    if (f.path && typeof f.path === "string" && f.path.length > 0) {
      // Electron-style absolute path → strip the file part to get the dir
      const sep = f.path.indexOf("\\") >= 0 ? "\\" : "/";
      const parts = f.path.split(sep);
      parts.pop();
      // Walk up until the last component is the chosen folder name.
      // file.webkitRelativePath tells us how deep the user-picked dir was.
      const rel = f.webkitRelativePath || "";
      const depth = rel ? (rel.split("/").length - 1) : 0;
      for (let i = 0; i < depth; i++) parts.pop();
      picked = parts.join(sep);
    } else if (f.webkitRelativePath) {
      // Browser path: only the relative directory name is exposed.
      picked = f.webkitRelativePath.split("/")[0];
    }
    if (picked != null) {
      onChange({ target: { value: picked } });
    }
    // Reset so picking the same dir again still fires onChange
    e.target.value = "";
  }

  // Hidden file input + visible text input + Browse button
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
      <input
        type="text"
        value={value || ""}
        onChange={onChange}
        placeholder={placeholder}
        style={Object.assign({ flex: 1 }, style || {})}
        aria-label={label || "Directory path"}
      />
      <button
        type="button"
        onClick={handleBrowse}
        disabled={!supportsDirPicker}
        title={supportsDirPicker
          ? "Pick a folder from your filesystem (the picker may only expose the folder name in plain browsers — desktop builds get the absolute path)."
          : "Folder picker not supported in this browser; type the path manually."}
        style={Object.assign({
          padding: "0 12px",
          borderRadius: 4,
          border: "1px solid " + TH.border,
          background: supportsDirPicker ? TH.bg2 : TH.bg0,
          color: supportsDirPicker ? TH.text0 : TH.text3,
          fontSize: 11, fontWeight: 600, fontFamily: TH.font,
          cursor: supportsDirPicker ? "pointer" : "not-allowed",
          whiteSpace: "nowrap",
        }, buttonStyle || {})}
      >
        📁 Browse…
      </button>
      {/* Hidden directory file input */}
      <input
        ref={fileRef}
        type="file"
        // Both attributes for cross-browser compatibility
        webkitdirectory=""
        directory=""
        multiple
        onChange={handleFiles}
        style={{ display: "none" }}
        aria-hidden="true"
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SplitCodeView — side-by-side code + fixes viewer with draggable splitter
// ═══════════════════════════════════════════════════════════════════════════
//
// Renders a horizontally-split viewer with the current code on the left
// and the fix history on the right. The split ratio is draggable between
// 15% and 85%. Either panel can be collapsed via the toolbar buttons.
// Supports an iteration selector when `iterations` has >1 entry, with a
// "Restore" button for going back to an earlier snapshot.
//
// Props:
//   code              : current code string
//   fixes             : array of fix objects/strings to render in the right panel
//   iterations        : array of iteration snapshots for the selector
//   label             : display label for the code panel header ("RTL", "TB")
//   maxH              : max container height (default 550)
//   fixSource         : string describing what modified the code (triggers banner)
//   originalCode      : pre-fix code for the "Restore Original" button
//   onRestore         : callback (iterationIdx) or callback(-1) for restore
//   onChange          : code change callback (unused in this renderer but kept for API symmetry)
//   manualImport      : boolean flag for manually-imported code banner
//   importedAt        : ISO timestamp of manual import
//   onSelectIteration : callback (idx) when iteration selector changes
//   currentIteration  : currently displayed iteration index
//   pastSnapshots     : array of past versions across all stages,
//                       shape from utils/pastVersions.collectRTLSnapshots /
//                       collectTBSnapshots. When provided AND non-empty, a
//                       "Compare with past version" toggle appears in the
//                       toolbar; clicking it opens a side-by-side panel that
//                       shows the user-picked past version on the left and
//                       the latest `code` on the right. The user picks the
//                       past version from a dropdown labelled by step + iter.
//   onCommitEdit      : invoked with ({code, ts}) when the
//                       user toggles "Done Editing" off. The host (RTLForge)
//                       uses this to push a manual-edit snapshot onto
//                       stageData[4|7]._manualEditHistory[] so the compare
//                       dropdown can list "Manual edit #N @ <timestamp>".
export function SplitCodeView({
  code, fixes, iterations, label, maxH, fixSource, originalCode,
  onRestore, onChange, manualImport, importedAt,
  onSelectIteration, currentIteration,
  pastSnapshots, onCommitEdit,
}) {
  const [splitRatio, setSplitRatio] = useState(0.6); // 0=code only, 1=fixes only
  const [collapsed, setCollapsed] = useState(null); // null=split, "fixes"=code only, "code"=fixes only
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  // When `comparing` is true, a side-by-side past-version-vs-
  // current panel is rendered above the existing split view. The user
  // picks the past version with `selectedSnapshotIdx` (index into
  // pastSnapshots).
  const [comparing, setComparing] = useState(false);
  const [selectedSnapshotIdx, setSelectedSnapshotIdx] = useState(0);
  // Compare panel's own drag-resize splitter and vdiff-mode toggle.
  // Independent from the main code-vs-fixes splitter above so each panel
  // remembers its own user-set ratio.
  const [compareSplitRatio, setCompareSplitRatio] = useState(0.5);
  const [compareDragging, setCompareDragging] = useState(false);
  const [compareDiffMode, setCompareDiffMode] = useState(false);   // false=side-by-side, true=vdiff
  const containerRef = useRef(null);
  const compareContainerRef = useRef(null);

  // Drag handler — attaches document-level listeners during drag.
  // Guarded for SSR: if there's no document, the handler is a no-op.
  function handleMouseDown(e) {
    e.preventDefault();
    setDragging(true);
    if (typeof document === "undefined") return;
    function onMove(ev) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newRatio = Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width));
      setSplitRatio(newRatio);
    }
    function onUp() {
      setDragging(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Drag handler for the compare panel splitter (between past version
  // and latest version). Independent from the main splitter so each panel
  // remembers its own user-set ratio.
  function handleCompareMouseDown(e) {
    e.preventDefault();
    setCompareDragging(true);
    if (typeof document === "undefined") return;
    function onMove(ev) {
      if (!compareContainerRef.current) return;
      const rect = compareContainerRef.current.getBoundingClientRect();
      const newRatio = Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width));
      setCompareSplitRatio(newRatio);
    }
    function onUp() {
      setCompareDragging(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const allFixes  = fixes || [];
  const allIters  = iterations || [];
  const showFixPanel  = collapsed !== "fixes";
  const showCodePanel = collapsed !== "code";

  return (
    <div>
      {/* Top toolbar */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
        {/* Collapse toggles */}
        <button
          onClick={function() { setCollapsed(collapsed === "fixes" ? null : "fixes"); }}
          style={{
            padding: "3px 10px", borderRadius: 3,
            border: "1px solid " + (collapsed === "fixes" ? TH.accent : TH.border),
            background: collapsed === "fixes" ? TH.accentDim : TH.bg1,
            color: collapsed === "fixes" ? TH.accent : TH.text2,
            fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: TH.font,
          }}
        >
          {collapsed === "fixes" ? "◀ Show Fixes" : "Code Only"}
        </button>
        {onChange && (
          <button
            onClick={function() {
              // When the user toggles "Done Editing" off,
              // notify the host so it can record a manual-edit snapshot in
              // _manualEditHistory[] for the compare dropdown.
              if (editing && onCommitEdit) {
                onCommitEdit({ code: code || "", ts: new Date().toISOString() });
              }
              setEditing(!editing);
              if (editing) setCollapsed("fixes");
            }}
            style={{
              padding: "3px 10px", borderRadius: 3,
              border: "1px solid " + (editing ? TH.accent : TH.border),
              background: editing ? TH.accentDim : TH.bg1,
              color: editing ? TH.accent : TH.text2,
              fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: TH.font,
            }}
          >
            {editing ? "✓ Done Editing" : "✏ Edit Code"}
          </button>
        )}
        {allFixes.length > 0 && (
          <button
            onClick={function() { setCollapsed(collapsed === "code" ? null : "code"); }}
            style={{
              padding: "3px 10px", borderRadius: 3,
              border: "1px solid " + (collapsed === "code" ? TH.accent : TH.border),
              background: collapsed === "code" ? TH.accentDim : TH.bg1,
              color: collapsed === "code" ? TH.accent : TH.text2,
              fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: TH.font,
            }}
          >
            {collapsed === "code" ? "◀ Show Code" : "Fixes Only"}
          </button>
        )}

        {/* compare with past version toggle */}
        {Array.isArray(pastSnapshots) && pastSnapshots.length > 0 && (
          <button
            onClick={function() { setComparing(!comparing); }}
            style={{
              padding: "3px 10px", borderRadius: 3,
              border: "1px solid " + (comparing ? TH.blue : TH.border),
              background: comparing ? TH.blueDim : TH.bg1,
              color: comparing ? TH.blue : TH.text2,
              fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: TH.font,
            }}
            title="Show a past version of the code side-by-side with the current"
          >
            {comparing ? "✕ Close Compare" : "⇄ Compare Past Version"}
          </button>
        )}

        {/* Iteration selector */}
        {allIters.length > 1 && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 9, color: TH.text3, textTransform: "uppercase", letterSpacing: 0.5 }}>Snapshot</span>
            <select
              value={currentIteration || allIters.length - 1}
              onChange={function(e) { if (onSelectIteration) onSelectIteration(parseInt(e.target.value)); }}
              style={{
                background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 3,
                padding: "3px 8px", color: TH.text0, fontSize: 10, fontFamily: TH.font, outline: "none",
              }}
            >
              {allIters.map(function(it, idx) {
                return (
                  <option key={idx} value={idx}>
                    {it.label || ("Iter " + (idx + 1) + (it.source ? " — " + it.source : ""))}
                  </option>
                );
              })}
            </select>
            {onRestore && currentIteration != null && currentIteration < allIters.length - 1 && (
              <button
                onClick={function() { onRestore(currentIteration); }}
                style={{
                  padding: "3px 8px", borderRadius: 3,
                  border: "1px solid " + TH.orange, background: TH.orangeDim,
                  color: TH.orange, fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: TH.font,
                }}
              >
                ↺ Restore
              </button>
            )}
          </div>
        )}
      </div>

      {/* Compare past version panel.
          When `comparing` is true, a side-by-side panel renders ABOVE the
          existing code/fix split. Layout:
            [Past version pane] [splitter] [Latest pane]
          A vdiff toggle replaces the two SyntaxBlocks with a single
          DiffBlock spanning the full width when active. */}
      {comparing && Array.isArray(pastSnapshots) && pastSnapshots.length > 0 && (function() {
        const safeIdx = Math.max(0, Math.min(selectedSnapshotIdx, pastSnapshots.length - 1));
        const snap = pastSnapshots[safeIdx];
        return (
          <div style={{
            marginBottom: 12, padding: 10,
            background: TH.bg0, border: "1px solid " + TH.blue,
            borderRadius: 4,
          }}>
            <div style={{
              display: "flex", gap: 10, alignItems: "center", marginBottom: 8,
              flexWrap: "wrap",
            }}>
              <span style={{
                fontSize: 10, color: TH.blue, fontWeight: 700,
                textTransform: "uppercase", letterSpacing: 0.6,
              }}>Compare with past version</span>
              <select
                value={safeIdx}
                onChange={function(e) { setSelectedSnapshotIdx(parseInt(e.target.value, 10)); }}
                style={{
                  background: TH.bg1, border: "1px solid " + TH.border, borderRadius: 3,
                  padding: "4px 8px", color: TH.text0, fontSize: 11, fontFamily: TH.font, outline: "none",
                  minWidth: 220,
                }}
              >
                {pastSnapshots.map(function(s, idx) {
                  // Prefix each entry with its 1-based position so the
                  // user can see the chronological order at a glance.
                  // Snapshots from reflow re-runs get a ↻
                  // marker so the user can spot them at a glance in
                  // the dropdown list. The label itself already carries
                  // the full provenance text — this just adds a visual
                  // hint that scans faster than reading the label.
                  const marker = s.reflow ? "↻ " : "";
                  return (
                    <option key={idx} value={idx}>
                      {(idx + 1) + ". " + marker + s.label + " (" + s.lineCount + " lines)"}
                    </option>
                  );
                })}
              </select>
              {/* vdiff toggle — switch between side-by-side and unified
                  diff rendering. The DiffBlock highlights additions/removals
                  with side colours. */}
              <button
                onClick={function() { setCompareDiffMode(!compareDiffMode); }}
                style={{
                  padding: "4px 10px", borderRadius: 3,
                  border: "1px solid " + (compareDiffMode ? TH.yellow : TH.border),
                  background: compareDiffMode ? TH.yellowDim : TH.bg1,
                  color: compareDiffMode ? TH.yellow : TH.text2,
                  fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: TH.font,
                }}
                title="Toggle vdiff-style line-aligned diff highlighting"
              >
                {compareDiffMode ? "✓ vdiff" : "vdiff"}
              </button>
              <span style={{ fontSize: 10, color: TH.text3, marginLeft: "auto" }}>
                step <strong style={{ color: TH.text2 }}>{snap.stepLabel}</strong>
                {" · iter "}<strong style={{ color: TH.text2 }}>{snap.iter}</strong>
              </span>
            </div>
            {compareDiffMode ? (
              <DiffBlock
                before={snap.code}
                after={code}
                maxH={maxH || 550}
              />
            ) : (
              <div ref={compareContainerRef} style={{ display: "flex", alignItems: "stretch", gap: 0 }}>
                <div style={{ flex: compareSplitRatio, minWidth: 0 }}>
                  <SyntaxBlock
                    code={snap.code}
                    label={"PAST: " + (safeIdx + 1) + ". " + snap.stepLabel + " — iter " + snap.iter}
                    maxH={maxH || 550}
                  />
                </div>
                {/* drag splitter */}
                <div
                  onMouseDown={handleCompareMouseDown}
                  style={{
                    width: 6, cursor: "col-resize", flexShrink: 0,
                    background: compareDragging ? TH.blue : "transparent",
                    transition: compareDragging ? "none" : "background 0.15s",
                    marginInline: 1,
                  }}
                  title="Drag to resize"
                />
                <div style={{ flex: 1 - compareSplitRatio, minWidth: 0 }}>
                  <SyntaxBlock
                    code={code}
                    label={"LATEST" + (label ? " (" + label + ")" : "")}
                    maxH={maxH || 550}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Annotation banners */}
      {fixSource && (
        <div style={{
          marginBottom: 8, padding: "6px 12px",
          background: TH.orangeDim, border: "1px solid rgba(251,146,60,.3)",
          borderRadius: 4, fontSize: 11, color: TH.orange,
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <span>⚠ Code modified: <strong>{fixSource}</strong></span>
          {originalCode && onRestore && (
            <button
              onClick={function() { onRestore(-1); }}
              style={{
                background: TH.bg0, border: "1px solid " + TH.orange, borderRadius: 3,
                padding: "2px 10px", color: TH.orange, fontSize: 10, fontWeight: 600,
                cursor: "pointer", fontFamily: TH.font,
              }}
            >
              ↺ Restore Original
            </button>
          )}
        </div>
      )}
      {manualImport && (
        <div style={{
          marginBottom: 8, padding: "6px 12px",
          background: TH.blueDim, border: "1px solid rgba(56,189,248,.3)",
          borderRadius: 4, fontSize: 11, color: TH.blue,
        }}>
          📁 Manually imported {label} — not LLM-generated{importedAt ? " (" + importedAt.substring(0, 16) + ")" : ""}
        </div>
      )}

      {/* Split container */}
      <div
        ref={containerRef}
        style={{
          display: "flex", border: "1px solid " + TH.border, borderRadius: 4,
          overflow: "hidden", maxHeight: maxH || 550, background: TH.bg0,
        }}
      >
        {/* Code panel */}
        {showCodePanel && (
          <div style={{
            flex: collapsed === "code" ? 0 : splitRatio,
            minWidth: 0, overflow: "auto",
            borderRight: showFixPanel && !collapsed ? "none" : "none",
          }}>
            <div style={{
              padding: "6px 10px", background: TH.bg1,
              borderBottom: "1px solid " + TH.border,
              display: "flex", alignItems: "center", gap: 6,
            }}>
              <span style={{ fontSize: 9, color: TH.text3, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {label || "Code"}
              </span>
              <span style={{ fontSize: 9, color: TH.text3 }}>
                {(code || "").split("\n").length} lines
              </span>
            </div>
            {editing && onChange ? (
              <textarea
                value={code || ""}
                onChange={function(e) { onChange(e.target.value); }}
                style={{
                  width: "100%", height: (maxH || 550) - 40,
                  background: TH.bg0, border: "none", padding: 12,
                  color: TH.text0, fontSize: 11.5, fontFamily: TH.font,
                  resize: "none", outline: "none", lineHeight: 1.6,
                }}
              />
            ) : (
              // Syntax-highlighted main code panel. Replaces the plain-text
              // CodeBlock with the same SystemVerilog
              // tokeniser used by the structured viewer and compare panel.
              // hideHeader=true because the wrapping <div> above already
              // renders the panel header. borderless=true because the
              // wrapping <div> also provides border styling.
              <SyntaxBlock code={code || ""} maxH={(maxH || 550) - 40} hideHeader borderless />
            )}
          </div>
        )}

        {/* Drag handle */}
        {showCodePanel && showFixPanel && !collapsed && (
          <div
            onMouseDown={handleMouseDown}
            style={{
              width: 6, cursor: "col-resize",
              background: dragging ? TH.accent : TH.border,
              flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
              transition: "background .15s",
            }}
          >
            <div style={{ width: 2, height: 24, borderRadius: 1, background: dragging ? TH.bg0 : TH.text3 }} />
          </div>
        )}

        {/* Fixes panel */}
        {showFixPanel && allFixes.length > 0 && (
          <div style={{ flex: collapsed === "fixes" ? 0 : (1 - splitRatio), minWidth: 0, overflow: "auto" }}>
            <div style={{ padding: "6px 10px", background: TH.bg1, borderBottom: "1px solid " + TH.border }}>
              <span style={{ fontSize: 9, color: TH.text3, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Fixes ({allFixes.length})
              </span>
            </div>
            <div style={{ padding: 10 }}>
              {allFixes.map(function(f, i) {
                // Crash hardening: in addition to the upstream normalisation,
                // coerce here. If anything reaches this map call as a raw
                // {id, desc} or other object, render it as JSON instead of
                // letting React explode with "Objects are not valid as a
                // React child".
                const _text = typeof f === "string" ? f : (f.text || f.description || JSON.stringify(f));
                const text = typeof _text === "string" ? _text : JSON.stringify(_text);
                const source = typeof f === "object" ? (f.source || f.stage || "") : "";
                // If the upstream pipeline tagged this fix
                // with the iter that produced it, append "iteration N" to
                // the source line so the user can see "fixed post lint
                // iteration 2" instead of just "Lint Fix".
                const iter = (typeof f === "object" && f != null && typeof f.iter === "number") ? f.iter : null;
                const sourceLine = source && iter != null ? source + " iteration " + iter : source;
                return (
                  <div key={i} style={{
                    display: "flex", gap: 8, padding: "8px 10px",
                    background: i % 2 === 0 ? TH.bg0 : TH.bg1,
                    borderRadius: 3, marginBottom: 2,
                  }}>
                    {/* 1-based chronological number. */}
                    <span style={{
                      color: TH.text2, flexShrink: 0, fontSize: 11,
                      fontWeight: 700, minWidth: 22, textAlign: "right",
                    }}>{i + 1}.</span>
                    <span style={{ color: TH.accent, flexShrink: 0, fontSize: 11 }}>✓</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, color: TH.text0, lineHeight: 1.5 }}>{text}</div>
                      {sourceLine && <div style={{ fontSize: 9, color: TH.text3, marginTop: 2 }}>{sourceLine}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {showFixPanel && allFixes.length === 0 && !collapsed && (
          <div style={{
            flex: 1 - splitRatio, minWidth: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: TH.text3, fontSize: 11,
          }}>
            No fixes applied
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ResumeDialog — checkpoint-detected modal
// ═══════════════════════════════════════════════════════════════════════════
//
// Props:
//   checkpoint  : the checkpoint object (null = dialog closed)
//   onResume    : callback(checkpoint) when user clicks Resume
//   onDiscard   : callback(projectId) when user clicks Discard
//
// Computes total and completed stage counts across all modules in the
// checkpoint, and shows a human-readable "time since save" string.
// Renders as a fixed-position modal with a backdrop. Returns null when
// `checkpoint` is null/undefined so the parent can simply conditionally
// render it without guarding.
export function ResumeDialog({ checkpoint, onResume, onDiscard }) {
  if (!checkpoint) return null;

  // Compute progress summary
  const modIds = Object.keys(checkpoint.modules || {});
  let totalStages = 0;
  let completedStages = 0;
  let furthestMod = null;
  let furthestStage = 0;
  modIds.forEach(function(mId) {
    const mod = checkpoint.modules[mId];
    const count = mod.completed ? mod.completed.size : 0;
    totalStages += ALL_STAGES.length;
    completedStages += count;
    if (count > furthestStage) { furthestStage = count; furthestMod = mId; }
  });
  const progressPct = totalStages > 0 ? Math.round((completedStages / totalStages) * 100) : 0;
  const nextStageId = furthestStage < ALL_STAGES.length ? furthestStage + 1 : ALL_STAGES.length;
  const nextStageMeta = ALL_STAGES.find(function(s) { return s.id === nextStageId; });

  const ts = checkpoint.timestamp;
  let relTime = "";
  try {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) relTime = "just now";
    else if (diff < 3600000) relTime = Math.round(diff / 60000) + " min ago";
    else if (diff < 86400000) relTime = Math.round(diff / 3600000) + " hr ago";
    else relTime = Math.round(diff / 86400000) + " day(s) ago";
  } catch (e) { relTime = ts; }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,.7)",
        zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center",
        animation: "fadeIn .3s",
      }}
      onClick={function(e) { if (e.target === e.currentTarget) { /* don't dismiss on bg click */ } }}
    >
      <div style={{
        background: TH.bg2, border: "1px solid " + TH.accent, borderRadius: 10,
        width: 480, padding: 28, boxShadow: "0 0 40px rgba(0,255,180,.15)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: TH.accentDim,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20,
          }}>🔄</div>
          <div>
            <div style={{ fontFamily: TH.fontD, fontWeight: 700, fontSize: 16, color: TH.text0 }}>
              Unfinished Project Detected
            </div>
            <div style={{ fontSize: 10, color: TH.text2, marginTop: 2 }}>Last saved {relTime}</div>
          </div>
        </div>

        <div style={{
          background: TH.bg0, borderRadius: 6, padding: 14, marginBottom: 16,
          border: "1px solid " + TH.border,
        }}>
          <div style={{
            fontSize: 11, color: TH.text2, marginBottom: 6,
            textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 700,
          }}>
            Project
          </div>
          <div style={{ fontSize: 13, color: TH.text0, marginBottom: 10, lineHeight: 1.5 }}>
            {(checkpoint.userDesc || "").substring(0, 150)}{(checkpoint.userDesc || "").length > 150 ? "…" : ""}
          </div>

          <div style={{ display: "flex", gap: 16, fontSize: 11 }}>
            <div>
              <span style={{ color: TH.text3 }}>Mode: </span>
              <span style={{ color: checkpoint.designMode === "system" ? TH.blue : TH.accent, fontWeight: 600 }}>
                {checkpoint.designMode === "system" ? "System" : "Module"}
              </span>
            </div>
            <div>
              <span style={{ color: TH.text3 }}>Modules: </span>
              <span style={{ color: TH.text0, fontWeight: 600 }}>{modIds.length}</span>
            </div>
            <div>
              <span style={{ color: TH.text3 }}>Progress: </span>
              <span style={{ color: TH.accent, fontWeight: 600 }}>{progressPct}%</span>
            </div>
          </div>

          {/* Progress bar */}
          <div style={{ marginTop: 10, height: 4, background: TH.bg3, borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 2,
              background: "linear-gradient(90deg," + TH.accent + "," + TH.blue + ")",
              width: progressPct + "%",
            }} />
          </div>

          <div style={{ fontSize: 10, color: TH.text2, marginTop: 8 }}>
            Resume from {furthestMod ? <span style={{ color: TH.accent }}>{furthestMod}</span> : "start"}
            {" — "}
            {nextStageMeta
              ? <span>Stage {nextStageId}: <span style={{ color: TH.blue }}>{nextStageMeta.label}</span></span>
              : "complete"}
          </div>
        </div>

        <div style={{
          padding: "8px 12px", background: TH.orangeDim, borderRadius: 5,
          border: "1px solid rgba(251,146,60,.2)", fontSize: 11, color: TH.orange,
          lineHeight: 1.5, marginBottom: 16,
        }}>
          Your API key is not stored in checkpoints. You'll need to re-enter it in Settings if using a cloud provider.
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={function() { onResume(checkpoint); }}
            style={{
              flex: 1, padding: "10px 0", borderRadius: 6,
              border: "1px solid " + TH.accent, background: TH.accentDim,
              color: TH.accent, fontWeight: 700, fontSize: 13,
              fontFamily: TH.font, cursor: "pointer", transition: "all .15s",
            }}
          >
            ▶ Resume
          </button>
          <button
            onClick={function() { onDiscard(checkpoint.projectId); }}
            style={{
              flex: 1, padding: "10px 0", borderRadius: 6,
              border: "1px solid " + TH.border, background: TH.bg3,
              color: TH.text1, fontWeight: 600, fontSize: 13,
              fontFamily: TH.font, cursor: "pointer", transition: "all .15s",
            }}
          >
            🗑 Discard
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SettingsPanel — global settings modal with 5 tabs
// ═══════════════════════════════════════════════════════════════════════════
//
// Props:
//   config               : project config object (state)
//   setConfig            : config updater function
//   onClose              : callback when modal is dismissed
//   importedPackages     : library of imported module/system packages
//   onDeletePackage      : callback (key) for removing a package
//   onRedownloadPackage  : callback (key) for re-downloading a package
//   onClearLibrary       : callback for clearing the whole library
//   checkpointIndex      : array of saved checkpoints
//   onDeleteCheckpoint   : callback (projectId) for removing a checkpoint
//   onClearCheckpoints   : callback for clearing all checkpoints
//   onSave               : optional callback invoked synchronously before
//                          onClose, used to flush settings to disk/checkpoint
//                          (avoids the "Save & Close" race)
//   onBackendVerified    : callback (boolean) after Test Backend runs
//
// Five tabs: Workflow (renders WorkflowTab), LLM (global provider + per-
// stage settings), CLI (backend URL + commands + iteration
// limits), Library (imported packages list), Checkpoints (saved-project
// list).
export function SettingsPanel({
  config, setConfig, onClose,
  importedPackages, onDeletePackage, onRedownloadPackage, onClearLibrary,
  checkpointIndex, onDeleteCheckpoint, onClearCheckpoints,
  onBackendVerified, onSave,
}) {
  const libCount  = importedPackages ? Object.keys(importedPackages).length : 0;
  const ckptCount = checkpointIndex ? checkpointIndex.length : 0;
  const [tab, setTab] = useState("llm");
  // Windows-style maximize button. Toggles a state that overrides the modal's
  // width/height to fill the viewport. Distinct
  // from the close (×) button — clicking maximize doesn't close. We
  // also support Esc-to-restore-from-maximized as a familiar shortcut.
  const [maximized, setMaximized] = useState(false);
  useEffect(function() {
    if (!maximized) return;
    function onKey(e) {
      // Esc restores from maximized (but doesn't close — the existing
      // backdrop click + × button handle close).
      if (e.key === "Escape") setMaximized(false);
    }
    document.addEventListener("keydown", onKey);
    return function() { document.removeEventListener("keydown", onKey); };
  }, [maximized]);

  // Save & Close calls onSave() synchronously rather than relying on a
  // useEffect to flush config to localStorage on unmount. If the user
  // closed the modal and then closed the tab in the same tick the effect
  // could fail to fire, losing changes. We now await any caller-supplied
  // onSave before closing so persistence is synchronous from the user's POV.
  async function handleSaveAndClose() {
    if (typeof onSave === "function") {
      try { await onSave(); }
      catch (e) { /* surfaced via useProject; do not block close */ }
    }
    onClose();
  }
  const prov = PROVIDERS.find(function(p) { return p.id === config.provider; });
  const [testStatus, setTestStatus] = useState(null);
  const [testing, setTesting] = useState(false);
  const [backendTestStatus, setBackendTestStatus] = useState(null);
  const [testingBackend, setTestingBackend] = useState(false);
  const [expandedStage, setExpandedStage] = useState(null);

  async function testConn() {
    setTesting(true);
    setTestStatus(null);
    try {
      const r = await callLLM({
        systemPrompt: "Respond with exactly: OK",
        userMessage: "Test.",
        maxTokens: 10,
        config: {
          provider: config.provider,
          model: config.model,
          apiKey: config.apiKey,
          temperature: config.temperature,
        },
      });
      setTestStatus({ ok: true, msg: "Connected — " + r.provider + " / " + r.model + " — " + r.latencyMs + "ms" });
    } catch (e) {
      setTestStatus({ ok: false, msg: e.message });
    }
    setTesting(false);
  }

  async function testBackend() {
    setTestingBackend(true);
    setBackendTestStatus(null);
    const result = await testBackendConnection(config.backendUrl);
    setBackendTestStatus(result);
    if (onBackendVerified) onBackendVerified(result.ok);
    setTestingBackend(false);
  }

  const useGlobal = config.useGlobalLLM !== false;
  const iS  = {
    width: "100%", background: TH.bg0, border: "1px solid " + TH.border,
    borderRadius: 4, padding: "7px 11px", color: TH.text0, fontSize: 12,
    outline: "none", fontFamily: TH.font,
  };
  const iSm = {
    background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 3,
    padding: "4px 6px", color: TH.text0, fontSize: 11, outline: "none",
    fontFamily: TH.font, width: "100%",
  };

  function getSS(key) { return (config.stageSettings || {})[key] || {}; }
  function setSS(stageKey, field, val) {
    setConfig(function(c) {
      const ss = Object.assign({}, c.stageSettings || {});
      const entry = Object.assign({}, ss[stageKey] || {});
      if (val === "" || val === null || val === undefined) {
        delete entry[field];
      } else {
        entry[field] = val;
      }
      if (Object.keys(entry).length === 0) delete ss[stageKey];
      else ss[stageKey] = entry;
      return Object.assign({}, c, { stageSettings: ss });
    });
  }
  function toggleDisabled(stageKey, knob) {
    setConfig(function(c) {
      const ss = Object.assign({}, c.stageSettings || {});
      const entry = Object.assign({}, ss[stageKey] || {});
      const dis = Object.assign({}, entry._disabled || {});
      dis[knob] = !dis[knob];
      entry._disabled = dis;
      ss[stageKey] = entry;
      return Object.assign({}, c, { stageSettings: ss });
    });
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,.65)",
        zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center",
        animation: "fadeIn .2s",
      }}
      onClick={function(e) { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={maximized ? {
        // Maximized — fills the viewport with a small margin so
        // the backdrop is still visible (matches Windows behavior where
        // maximized windows still respect taskbar/menubar).
        background: TH.bg2, border: "1px solid " + TH.border, borderRadius: 4,
        width: "calc(100vw - 16px)", maxWidth: "calc(100vw - 16px)",
        height:  "calc(100vh - 16px)", maxHeight: "calc(100vh - 16px)",
        overflow: "auto", padding: 24,
      } : {
        background: TH.bg2, border: "1px solid " + TH.border, borderRadius: 8,
        width: 700, maxHeight: "90vh", overflow: "auto", padding: 24,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <h2 style={{ fontFamily: TH.fontD, fontSize: 17, fontWeight: 700, color: TH.text0, margin: 0 }}>
            Settings
          </h2>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {/* Windows-style maximize/restore button. The icon
                is a square (□) when restorable size, double-square (❐)
                when already maximized (= "restore" hint). */}
            <button
              onClick={function() { setMaximized(function(m) { return !m; }); }}
              title={maximized ? "Restore (Esc)" : "Maximize"}
              aria-label={maximized ? "Restore window size" : "Maximize window"}
              style={{
                background: "none", border: "none", color: TH.text2,
                cursor: "pointer", fontSize: 16, padding: "0 6px",
                lineHeight: 1, height: 22,
              }}
            >{maximized ? "❐" : "▢"}</button>
            <button
              onClick={onClose}
              style={{ background: "none", border: "none", color: TH.text2, cursor: "pointer", fontSize: 18 }}
              aria-label="Close settings"
            >×</button>
          </div>
        </div>
        <SubTab
          tabs={[
            { id: "workflow",    label: "Workflow" },
            { id: "skills",      label: "Skills" },
            { id: "evals",       label: "Evals" },
            { id: "observer",    label: "Observer" },
            { id: "ui",          label: "UI" },
            { id: "llm",         label: "LLM" },
            { id: "sim",         label: "CLI" },
            { id: "library",     label: "Library (" + libCount + ")" },
            { id: "checkpoints", label: "Checkpoints (" + ckptCount + ")" },
            { id: "paths",       label: "Paths" },
          ]}
          active={tab}
          onChange={setTab}
        />

        {/* ═══════ WORKFLOW TAB ═══════ */}
        {tab === "workflow" && <WorkflowTab config={config} setConfig={setConfig} />}

        {/* ═══════ SKILLS TAB ═══════ */}
        {tab === "skills" && <SkillsTab config={config} setConfig={setConfig} />}

        {/* ═══════ EVALS TAB ═══════ */}
        {tab === "evals" && <EvalsTab config={config} setConfig={setConfig} />}

        {/* ═══════ OBSERVER TAB ═══════ */}
        {tab === "observer" && <ObserverTab config={config} />}

        {/* ═══════ UI TAB ═══════ */}
        {tab === "ui" && <ThemeTab config={config} setConfig={setConfig} />}

        {/* ═══════ LLM TAB ═══════ */}
        {tab === "llm" && (
          <div>
            {/* ── Global Toggle ── */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <button
                onClick={function() { setConfig(function(c) { return Object.assign({}, c, { useGlobalLLM: !useGlobal }); }); }}
                style={{
                  padding: "5px 14px", borderRadius: 4,
                  border: "1px solid " + (useGlobal ? TH.accent : TH.border),
                  background: useGlobal ? TH.accentDim : TH.bg0,
                  color: useGlobal ? TH.accent : TH.text2,
                  fontWeight: 600, fontSize: 11, fontFamily: TH.font, cursor: "pointer",
                }}
              >
                {useGlobal ? "✓ Global LLM" : "○ Global LLM"}
              </button>
              <span style={{ fontSize: 10, color: TH.text3 }}>
                {useGlobal ? "All stages use global provider/model/key below" : "Each stage can use its own provider/model/key"}
              </span>
            </div>

            {/* ── Global Provider Settings ── */}
            <div style={{
              opacity: useGlobal ? 1 : 0.4,
              pointerEvents: useGlobal ? "auto" : "none",
              padding: 14, borderRadius: 6, border: "1px solid " + TH.border,
              background: TH.bg1, marginBottom: 18,
            }}>
              <div style={{
                fontSize: 9, color: TH.text3, fontWeight: 700,
                textTransform: "uppercase", letterSpacing: 1, marginBottom: 10,
              }}>
                Global Provider
              </div>
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {PROVIDERS.map(function(p) {
                    return (
                      <Chip
                        key={p.id}
                        label={(p.local ? "🖥 " : "☁️ ") + p.label}
                        active={config.provider === p.id}
                        onClick={function() {
                          setConfig(function(c) { return Object.assign({}, c, { provider: p.id, model: p.model }); });
                        }}
                      />
                    );
                  })}
                </div>
              </div>
              {prov && !prov.local && (
                <div style={{ marginBottom: 10 }}>
                  <Label>API Key</Label>
                  <input
                    type="password"
                    value={config.apiKey}
                    onChange={function(e) { setConfig(function(c) { return Object.assign({}, c, { apiKey: e.target.value }); }); }}
                    placeholder={prov.label + " API key…"}
                    style={iS}
                  />
                </div>
              )}
              <div style={{ marginBottom: 10 }}>
                <Label>Model</Label>
                <input
                  value={config.model}
                  onChange={function(e) { setConfig(function(c) { return Object.assign({}, c, { model: e.target.value }); }); }}
                  style={iS}
                />
              </div>
              <div style={{
                padding: "8px 12px", borderRadius: 4,
                background: TH.accentDim, border: "1px solid rgba(0,255,180,.15)",
                fontSize: 10, color: TH.accent, lineHeight: 1.5, marginBottom: 10,
              }}>
                {"When Global LLM is enabled, all sampling parameters (temperature, top_p, top_k, seed) are left to the provider's defaults. Use Per-Stage Settings below for fine-grained control."}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="secondary" onClick={testConn} disabled={testing} style={{ fontSize: 10, padding: "4px 10px" }}>
                  {testing ? "Testing…" : "🔌 Test LLM"}
                </Btn>
              </div>
              {testStatus && (
                <div style={{
                  marginTop: 8, padding: "6px 10px", borderRadius: 4,
                  background: testStatus.ok ? TH.accentDim : TH.redDim,
                  border: "1px solid " + (testStatus.ok ? "rgba(0,255,180,.3)" : "rgba(248,113,113,.3)"),
                  fontSize: 10, color: testStatus.ok ? TH.accent : TH.red,
                }}>
                  {testStatus.msg}
                </div>
              )}
            </div>

            {/* ── Per-Stage Settings ── */}
            <div style={{
              fontSize: 9, color: TH.text3, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: 1, marginBottom: 8,
            }}>
              Per-Stage Settings
            </div>
            <div style={{ fontSize: 10, color: TH.text3, marginBottom: 10 }}>
              Click a stage to expand provider/sampling overrides. Empty fields use RTL Forge recommended defaults.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {getStageSettingKeys(config).map(function(item) {
                const ss = getSS(item.key);
                const rec = RECOMMENDED_STAGE_SETTINGS[item.key] || {};
                const dis = ss._disabled || {};
                const isExpanded = expandedStage === item.key;
                const effectiveProv = (!useGlobal && ss.provider) ? ss.provider : config.provider;
                const supports = PROVIDER_SUPPORTS[effectiveProv] || {};

                return (
                  <div key={item.key} style={{
                    background: TH.bg0, border: "1px solid " + (isExpanded ? TH.accent : TH.border),
                    borderRadius: 4, overflow: "hidden",
                  }}>
                    {/* Compact row */}
                    <div
                      onClick={function() { setExpandedStage(isExpanded ? null : item.key); }}
                      style={{
                        display: "grid", gridTemplateColumns: "110px 70px 55px 55px 1fr",
                        gap: 8, alignItems: "center", padding: "7px 10px", cursor: "pointer",
                      }}
                    >
                      <span style={{ fontSize: 11, color: TH.text0, fontWeight: 600 }}>{item.label}</span>
                      <span style={{ fontSize: 10, color: ss.maxTokens ? TH.accent : TH.text3 }}>
                        {ss.maxTokens || rec.maxTokens || "—"} tok
                      </span>
                      <span style={{
                        fontSize: 10,
                        color: dis.temperature ? TH.text3 : (ss.temperature != null ? TH.accent : TH.text3),
                      }}>
                        {dis.temperature
                          ? "T=auto"
                          : ("T=" + (ss.temperature != null
                              ? ss.temperature
                              : (rec.temperature != null ? rec.temperature : "auto")))}
                      </span>
                      <span style={{ fontSize: 10, color: !useGlobal && ss.provider ? TH.blue : TH.text3 }}>
                        {!useGlobal && ss.provider ? ss.provider : ""}
                      </span>
                      <span style={{ fontSize: 10, color: TH.text3, textAlign: "right" }}>
                        {isExpanded ? "▾" : "▸"}
                      </span>
                    </div>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div style={{
                        padding: "8px 10px 12px", borderTop: "1px solid " + TH.border,
                        display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px 10px",
                      }}>
                        <div>
                          <Label>Max Tokens</Label>
                          <input
                            type="number" min="500" step="500"
                            value={ss.maxTokens || ""}
                            placeholder={String(rec.maxTokens || 4096)}
                            onChange={function(e) {
                              const v = e.target.value.trim();
                              setSS(item.key, "maxTokens", v ? parseInt(v, 10) : null);
                            }}
                            style={iSm}
                          />
                        </div>
                        <div>
                          <Label>
                            <input
                              type="checkbox" checked={!dis.temperature}
                              onChange={function() { toggleDisabled(item.key, "temperature"); }}
                              style={{ accentColor: TH.accent, marginRight: 4, verticalAlign: "middle" }}
                            />
                            Temperature
                            {dis.temperature && (
                              <span style={{ color: TH.text3, fontSize: 9, marginLeft: 4 }}>(provider default)</span>
                            )}
                          </Label>
                          <input
                            type="number" min="0" max="2" step="0.01"
                            value={ss.temperature != null ? ss.temperature : ""}
                            placeholder={String(rec.temperature != null ? rec.temperature : "auto")}
                            onChange={function(e) {
                              const v = e.target.value.trim();
                              setSS(item.key, "temperature", v !== "" ? parseFloat(v) : null);
                            }}
                            style={Object.assign({}, iSm, dis.temperature ? { opacity: 0.3 } : {})}
                            disabled={dis.temperature}
                          />
                        </div>
                        <div>
                          <Label>
                            <input
                              type="checkbox" checked={!dis.top_p}
                              onChange={function() { toggleDisabled(item.key, "top_p"); }}
                              style={{ accentColor: TH.accent, marginRight: 4, verticalAlign: "middle" }}
                            />
                            top_p
                            {(!supports.top_p || dis.top_p) && (
                              <span style={{ color: TH.text3, fontSize: 9, marginLeft: 4 }}>
                                {!supports.top_p ? "(n/a)" : "(provider default)"}
                              </span>
                            )}
                          </Label>
                          <input
                            type="number" min="0" max="1" step="0.01"
                            value={ss.top_p != null ? ss.top_p : ""}
                            placeholder={String(rec.top_p || "")}
                            onChange={function(e) {
                              const v = e.target.value.trim();
                              setSS(item.key, "top_p", v !== "" ? parseFloat(v) : null);
                            }}
                            style={Object.assign({}, iSm, (!supports.top_p || dis.top_p) ? { opacity: 0.3 } : {})}
                            disabled={!supports.top_p || dis.top_p}
                          />
                        </div>
                        <div>
                          <Label>
                            <input
                              type="checkbox" checked={!dis.top_k}
                              onChange={function() { toggleDisabled(item.key, "top_k"); }}
                              style={{ accentColor: TH.accent, marginRight: 4, verticalAlign: "middle" }}
                            />
                            top_k
                            {(!supports.top_k || dis.top_k) && (
                              <span style={{ color: TH.text3, fontSize: 9, marginLeft: 4 }}>
                                {!supports.top_k ? "(n/a)" : "(provider default)"}
                              </span>
                            )}
                          </Label>
                          <input
                            type="number" min="1" step="1"
                            value={ss.top_k != null ? ss.top_k : ""}
                            placeholder={String(rec.top_k || "")}
                            onChange={function(e) {
                              const v = e.target.value.trim();
                              setSS(item.key, "top_k", v !== "" ? parseInt(v, 10) : null);
                            }}
                            style={Object.assign({}, iSm, (!supports.top_k || dis.top_k) ? { opacity: 0.3 } : {})}
                            disabled={!supports.top_k || dis.top_k}
                          />
                        </div>
                        <div>
                          <Label>
                            <input
                              type="checkbox" checked={!dis.seed}
                              onChange={function() { toggleDisabled(item.key, "seed"); }}
                              style={{ accentColor: TH.accent, marginRight: 4, verticalAlign: "middle" }}
                            />
                            Seed
                            {(!supports.seed || dis.seed) && (
                              <span style={{ color: TH.text3, fontSize: 9, marginLeft: 4 }}>
                                {!supports.seed ? "(n/a)" : "(provider default)"}
                              </span>
                            )}
                          </Label>
                          <input
                            type="number" min="0" step="1"
                            value={ss.seed != null ? ss.seed : ""}
                            placeholder={rec.seed != null ? String(rec.seed) : "null"}
                            onChange={function(e) {
                              const v = e.target.value.trim();
                              setSS(item.key, "seed", v !== "" ? parseInt(v, 10) : null);
                            }}
                            style={Object.assign({}, iSm, (!supports.seed || dis.seed) ? { opacity: 0.3 } : {})}
                            disabled={!supports.seed || dis.seed}
                          />
                        </div>
                        {!useGlobal && (
                          <div>
                            <Label>Provider</Label>
                            <select
                              value={ss.provider || ""}
                              onChange={function(e) { setSS(item.key, "provider", e.target.value || null); }}
                              style={iSm}
                            >
                              <option value="">Global ({config.provider})</option>
                              {PROVIDERS.map(function(pr) {
                                return <option key={pr.id} value={pr.id}>{pr.label}</option>;
                              })}
                            </select>
                          </div>
                        )}
                        {!useGlobal && (
                          <div>
                            <Label>Model</Label>
                            <input
                              value={ss.model || ""}
                              placeholder={"Global (" + config.model + ")"}
                              onChange={function(e) { setSS(item.key, "model", e.target.value || null); }}
                              style={iSm}
                            />
                          </div>
                        )}
                        {!useGlobal && (function() {
                          const sp = PROVIDERS.find(function(pr) { return pr.id === (ss.provider || config.provider); });
                          return sp && !sp.local ? (
                            <div>
                              <Label>API Key</Label>
                              <input
                                type="password"
                                value={ss.apiKey || ""}
                                placeholder="Use global key"
                                onChange={function(e) { setSS(item.key, "apiKey", e.target.value || null); }}
                                style={iSm}
                              />
                            </div>
                          ) : null;
                        })()}
                        <div style={{ gridColumn: "1 / -1" }}>
                          <button
                            onClick={function() {
                              setConfig(function(c) {
                                const ss2 = Object.assign({}, c.stageSettings || {});
                                delete ss2[item.key];
                                return Object.assign({}, c, { stageSettings: ss2 });
                              });
                            }}
                            style={{
                              padding: "3px 10px", borderRadius: 3,
                              border: "1px solid " + TH.border, background: TH.bg1,
                              color: TH.text2, fontSize: 10, fontFamily: TH.font, cursor: "pointer",
                            }}
                          >
                            ↺ Reset to Recommended
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 10 }}>
              <button
                onClick={function() {
                  setConfig(function(c) { return Object.assign({}, c, { stageSettings: {} }); });
                }}
                style={{
                  padding: "5px 12px", borderRadius: 4,
                  border: "1px solid " + TH.border, background: TH.bg0,
                  color: TH.text2, fontSize: 10, fontWeight: 600, fontFamily: TH.font, cursor: "pointer",
                }}
              >
                ↺ Reset All Stages to Recommended
              </button>
            </div>
          </div>
        )}

        {/* ═══════ SIMULATOR CLI TAB ═══════ */}
        {tab === "sim" && (
          <div>
            <div style={{ marginBottom: 14 }}>
              <Label>Backend Host & Port</Label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={(function() {
                    try { const u = new URL(config.backendUrl || "http://localhost"); return u.hostname; }
                    catch (e) { return config.backendUrl || ""; }
                  })()}
                  onChange={function(e) {
                    const host = e.target.value.trim();
                    let port = "3001";
                    try {
                      const u = new URL(config.backendUrl || "http://localhost:3001");
                      port = u.port || "3001";
                    } catch (ex) {}
                    setConfig(function(c) { return Object.assign({}, c, { backendUrl: host ? "http://" + host + ":" + port : "" }); });
                  }}
                  placeholder="localhost"
                  style={Object.assign({}, iS, { flex: 1 })}
                />
                <input
                  value={(function() {
                    try { const u = new URL(config.backendUrl || "http://localhost:3001"); return u.port || "3001"; }
                    catch (e) { return "3001"; }
                  })()}
                  onChange={function(e) {
                    const port = e.target.value.trim();
                    let host = "localhost";
                    try {
                      const u = new URL(config.backendUrl || "http://localhost:3001");
                      host = u.hostname || "localhost";
                    } catch (ex) {}
                    setConfig(function(c) { return Object.assign({}, c, { backendUrl: host ? "http://" + host + (port ? ":" + port : "") : "" }); });
                  }}
                  placeholder="3001"
                  style={Object.assign({}, iS, { width: 80, flex: "none" })}
                />
              </div>
              {config.backendUrl && (
                <div style={{ fontSize: 10, color: TH.text2, marginTop: 4 }}>
                  URL: <span style={{ color: TH.accent }}>{config.backendUrl}</span>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              <button
                onClick={testBackend}
                disabled={testingBackend || !config.backendUrl}
                style={{
                  padding: "6px 14px", borderRadius: 4,
                  border: "1px solid " + (config.backendUrl ? TH.accent : TH.border),
                  background: config.backendUrl ? TH.accentDim : TH.bg0,
                  color: config.backendUrl ? TH.accent : TH.text3,
                  fontWeight: 600, fontSize: 11, fontFamily: TH.font,
                  cursor: config.backendUrl ? "pointer" : "not-allowed",
                }}
              >
                {testingBackend ? "Testing…" : "🔌 Test Backend"}
              </button>
              {config.backendUrl && (
                <button
                  onClick={function() {
                    setConfig(function(c) { return Object.assign({}, c, { backendUrl: "" }); });
                    setBackendTestStatus(null);
                    if (onBackendVerified) onBackendVerified(null);
                  }}
                  style={{
                    padding: "6px 14px", borderRadius: 4,
                    border: "1px solid " + TH.border, background: TH.bg0,
                    color: TH.text2, fontSize: 11, fontFamily: TH.font, cursor: "pointer",
                  }}
                >
                  ✕ Disconnect
                </button>
              )}
            </div>
            {backendTestStatus && (
              <div style={{
                marginBottom: 14, padding: "8px 12px", borderRadius: 4,
                background: backendTestStatus.ok ? TH.accentDim : TH.redDim,
                border: "1px solid " + (backendTestStatus.ok ? "rgba(0,255,180,.3)" : "rgba(248,113,113,.3)"),
                fontSize: 11, color: backendTestStatus.ok ? TH.accent : TH.red, lineHeight: 1.5,
              }}>
                {backendTestStatus.msg}
              </div>
            )}

            {/* Iteration limits + timeout */}
            <div style={{
              fontSize: 9, color: TH.text3, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, marginTop: 6,
            }}>
              Pipeline Iteration Limits
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div>
                <Label>Lint Fix Iters</Label>
                <input
                  type="number" min="1" max="20"
                  value={config.maxLintIters == null ? 3 : config.maxLintIters}
                  onChange={function(e) {
                    setConfig(function(c) { return Object.assign({}, c, { maxLintIters: _clampIter(e.target.value, c.maxLintIters) }); });
                  }}
                  style={iS}
                />
              </div>
              <div>
                <Label>Verify Retry Iters</Label>
                <input
                  type="number" min="1" max="20"
                  value={config.maxVerifyIters == null ? 3 : config.maxVerifyIters}
                  onChange={function(e) {
                    setConfig(function(c) { return Object.assign({}, c, { maxVerifyIters: _clampIter(e.target.value, c.maxVerifyIters) }); });
                  }}
                  style={iS}
                />
              </div>
              <div>
                <Label>Judge Retry Iters</Label>
                <input
                  type="number" min="1" max="20"
                  value={config.maxJudgeIters == null ? 3 : config.maxJudgeIters}
                  onChange={function(e) {
                    setConfig(function(c) { return Object.assign({}, c, { maxJudgeIters: _clampIter(e.target.value, c.maxJudgeIters) }); });
                  }}
                  style={iS}
                />
              </div>
              <div>
                <Label>Sim Timeout (cycles)</Label>
                <input
                  type="number" min="1000" step="10000"
                  value={config.simTimeoutCycles == null ? 100000 : config.simTimeoutCycles}
                  onChange={function(e) {
                    setConfig(function(c) { return Object.assign({}, c, { simTimeoutCycles: _clampSimT(e.target.value, c.simTimeoutCycles) }); });
                  }}
                  style={iS}
                />
              </div>
            </div>

            {/* Review-loop iteration controls (only meaningful when the optional review stages are enabled, but always editable). */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
              <div>
                <Label>RTL Review Iters</Label>
                <input
                  type="number" min="1" max="10"
                  value={config.maxRtlReviewIters == null ? 2 : config.maxRtlReviewIters}
                  onChange={function(e) {
                    setConfig(function(c) { return Object.assign({}, c, { maxRtlReviewIters: _clampReview(e.target.value, c.maxRtlReviewIters) }); });
                  }}
                  style={iS}
                />
              </div>
              <div>
                <Label>Test Review Iters</Label>
                <input
                  type="number" min="1" max="10"
                  value={config.maxTestReviewIters == null ? 2 : config.maxTestReviewIters}
                  onChange={function(e) {
                    setConfig(function(c) { return Object.assign({}, c, { maxTestReviewIters: _clampReview(e.target.value, c.maxTestReviewIters) }); });
                  }}
                  style={iS}
                />
              </div>
              <div>
                <Label>Backend Request Timeout (s)</Label>
                <input
                  type="number" min="10" max="3600"
                  value={config.backendTimeoutSec == null ? 600 : config.backendTimeoutSec}
                  onChange={function(e) {
                    setConfig(function(c) { return Object.assign({}, c, { backendTimeoutSec: _clampNetT(e.target.value, c.backendTimeoutSec) }); });
                  }}
                  style={iS}
                />
              </div>
            </div>

            {/* Strict CLI mode — when ON, never fall back to LLM if backend is configured */}
            <div style={{
              display: "flex", alignItems: "center", gap: 10, marginBottom: 14,
              padding: "10px 14px", background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
            }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={config.strictCli !== false}
                  onChange={function() {
                    setConfig(function(c) { return Object.assign({}, c, { strictCli: c.strictCli !== false ? false : true }); });
                  }}
                  style={{ accentColor: TH.accent }}
                />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: config.strictCli !== false ? TH.accent : TH.text1 }}>
                    Strict CLI mode
                  </div>
                  <div style={{ fontSize: 10, color: TH.text2, lineHeight: 1.4 }}>
                    When a backend URL is configured, fail loudly on transient backend errors instead of silently falling back to LLM estimation.
                    Default OFF — enable to require real CLI execution for lint and verify; disable for LLM fallback on backend errors.
                  </div>
                </div>
              </label>
            </div>

            {/* Strict Judge CLI mode */}
            <div style={{
              display: "flex", alignItems: "center", gap: 10, marginBottom: 14,
              padding: "10px 14px", background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
            }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={!!config.strictJudgeCli}
                  onChange={function() {
                    setConfig(function(c) { return Object.assign({}, c, { strictJudgeCli: !c.strictJudgeCli }); });
                  }}
                  style={{ accentColor: TH.accent }}
                />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: config.strictJudgeCli ? TH.accent : TH.text1 }}>
                    Strict Judge CLI
                  </div>
                  <div style={{ fontSize: 10, color: TH.text2, lineHeight: 1.4 }}>
                    Force judge's re-verify iterations to use the CLI backend (Verilator). Without this, judge falls back to LLM-estimated
                    simulation when the backend is missing or errors — which means later judge iterations may use AI-guessed test results.
                    Enable to require real simulation throughout judge, even at the cost of erroring out when the backend is down.
                  </div>
                </div>
              </label>
            </div>


            {/* CLI retry count */}
            <div style={{ marginBottom: 14, display: "grid", gridTemplateColumns: "1fr 3fr", gap: 10, alignItems: "end" }}>
              <div>
                <Label>CLI Retry Attempts</Label>
                <input
                  type="number" min="0" max="5"
                  value={config.cliRetryCount == null ? 1 : config.cliRetryCount}
                  onChange={function(e) {
                    setConfig(function(c) { return Object.assign({}, c, { cliRetryCount: _clampRetry(e.target.value, c.cliRetryCount) }); });
                  }}
                  style={iS}
                />
              </div>
              <div style={{ fontSize: 10, color: TH.text2, lineHeight: 1.5 }}>
                Number of times to retry a failed CLI request before giving up (0 = never retry).
                Useful for transient backend timeouts during long Verilator builds.
              </div>
            </div>

            {/* Coverage settings */}
            <div style={{
              display: "flex", alignItems: "center", gap: 10, marginBottom: 14,
              padding: "10px 14px", background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
            }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={!!config.enableCoverage}
                  onChange={function() {
                    setConfig(function(c) { return Object.assign({}, c, { enableCoverage: !c.enableCoverage }); });
                  }}
                  style={{ accentColor: TH.accent }}
                />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: config.enableCoverage ? TH.accent : TH.text1 }}>Enable Coverage Collection</div>
                  <div style={{ fontSize: 10, color: TH.text2, lineHeight: 1.4 }}>
                    Adds --coverage to Verilator compile. After successful sim, runs verilator_coverage to generate a coverage report for real line/branch/toggle analysis.
                  </div>
                </div>
              </label>
            </div>

            <div style={{
              fontSize: 9, color: TH.text3, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: 1, marginBottom: 8,
            }}>
              Verilator Commands
            </div>
            <div style={{ marginBottom: 14 }}>
              <Label>Simulator Path</Label>
              <input
                value={config.simPath}
                onChange={function(e) { setConfig(function(c) { return Object.assign({}, c, { simPath: e.target.value }); }); }}
                placeholder="/usr/local/bin/verilator"
                style={iS}
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <Label>Lint Command</Label>
              <input
                value={config.lintCmd}
                onChange={function(e) { setConfig(function(c) { return Object.assign({}, c, { lintCmd: e.target.value }); }); }}
                placeholder="verilator --lint-only -Wall {RTL}"
                style={iS}
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <Label>Simulation Commands (one per line)</Label>
              <textarea
                value={config.simCmds}
                onChange={function(e) { setConfig(function(c) { return Object.assign({}, c, { simCmds: e.target.value }); }); }}
                placeholder={"verilator --binary -Wall -j 0 {RTL} {TB} -o sim\n./obj_dir/sim"}
                style={{
                  width: "100%", minHeight: 70,
                  background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4,
                  padding: 10, color: TH.text0, fontSize: 12, fontFamily: TH.font,
                  resize: "vertical", outline: "none",
                }}
              />
            </div>
            <div style={{
              padding: 10, borderRadius: 4,
              background: TH.blueDim, border: "1px solid rgba(56,189,248,.2)",
              fontSize: 10, color: TH.blue, lineHeight: 1.5,
            }}>
              {"Quick start: npm install express cors && node backend.js (starts on port 3001). The backend must have CORS enabled."}
            </div>
          </div>
        )}

        {/* ═══════ LIBRARY TAB ═══════ */}
        {tab === "library" && (
          <div>
            {libCount === 0 && (
              <div style={{ padding: 30, textAlign: "center", color: TH.text2, fontSize: 12 }}>
                No packages in library. Export a module or system to populate.
              </div>
            )}
            {libCount > 0 && (
              <div>
                <div style={{
                  display: "grid", gridTemplateColumns: "1fr 90px 55px 90px 70px",
                  gap: 0, fontSize: 11, borderBottom: "1px solid " + TH.border,
                  paddingBottom: 6, marginBottom: 6,
                }}>
                  <span style={{ color: TH.text3, fontWeight: 700, fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5 }}>Name</span>
                  <span style={{ color: TH.text3, fontWeight: 700, fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5 }}>Type</span>
                  <span style={{ color: TH.text3, fontWeight: 700, fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5 }}>Score</span>
                  <span style={{ color: TH.text3, fontWeight: 700, fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5 }}>Exported</span>
                  <span style={{ color: TH.text3, fontWeight: 700, fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5 }}>Actions</span>
                </div>
                {Object.keys(importedPackages).map(function(key) {
                  const entry = importedPackages[key];
                  const pkg = entry.pkg;
                  const isModule = entry.type === "module";
                  const name = isModule
                    ? (pkg.module ? pkg.module.modId : key)
                    : (pkg.system ? pkg.system.systemName : key);
                  const score = isModule
                    ? (pkg.artifacts && pkg.artifacts.judge ? pkg.artifacts.judge.score : null)
                    : (pkg.integration && pkg.integration.judge ? pkg.integration.judge.score : null);
                  const modCount = !isModule && pkg.modules ? Object.keys(pkg.modules).length : 0;
                  const dateStr = pkg.exportedAt ? pkg.exportedAt.substring(0, 10) : "—";
                  return (
                    <div key={key} style={{
                      display: "grid", gridTemplateColumns: "1fr 90px 55px 90px 70px",
                      gap: 0, alignItems: "center", padding: "5px 0",
                      borderBottom: "1px solid " + TH.bg1,
                    }}>
                      <span style={{
                        color: TH.accent, fontWeight: 600, fontSize: 11,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>{name}</span>
                      <Tag color={isModule ? TH.blue : TH.orange} bg={isModule ? TH.blueDim : TH.orangeDim}>
                        {isModule ? "module" : "system (" + modCount + " mod)"}
                      </Tag>
                      <span style={{
                        color: score != null ? (score >= 70 ? TH.accent : TH.red) : TH.text3,
                        fontWeight: 700, fontSize: 11,
                      }}>
                        {score != null ? score : "—"}
                      </span>
                      <span style={{ color: TH.text2, fontSize: 10 }}>{dateStr}</span>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button
                          onClick={function() { if (onRedownloadPackage) onRedownloadPackage(key); }}
                          title="Re-download"
                          style={{
                            background: "none", border: "1px solid " + TH.border, borderRadius: 3,
                            padding: "2px 6px", cursor: "pointer", color: TH.blue,
                            fontSize: 11, fontFamily: TH.font,
                          }}
                        >📤</button>
                        <button
                          onClick={function() { if (onDeletePackage) onDeletePackage(key); }}
                          title="Delete"
                          style={{
                            background: "none", border: "1px solid " + TH.border, borderRadius: 3,
                            padding: "2px 6px", cursor: "pointer", color: TH.red,
                            fontSize: 11, fontFamily: TH.font,
                          }}
                        >🗑</button>
                      </div>
                    </div>
                  );
                })}
                <div style={{ marginTop: 14 }}>
                  <button
                    onClick={function() { if (onClearLibrary) onClearLibrary(); }}
                    style={{
                      background: TH.redDim, border: "1px solid " + TH.red, borderRadius: 4,
                      padding: "5px 12px", cursor: "pointer", color: TH.red,
                      fontSize: 10, fontWeight: 600, fontFamily: TH.font,
                    }}
                  >
                    🗑 Clear Library
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══════ CHECKPOINTS TAB ═══════ */}
        {tab === "checkpoints" && (
          <div>
            {ckptCount === 0 && (
              <div style={{ padding: 30, textAlign: "center", color: TH.text2, fontSize: 12 }}>
                No saved checkpoints.
              </div>
            )}
            {ckptCount > 0 && (
              <div>
                {checkpointIndex.map(function(cp) {
                  let relTime = "";
                  try {
                    const diff = Date.now() - new Date(cp.timestamp).getTime();
                    if (diff < 60000) relTime = "just now";
                    else if (diff < 3600000) relTime = Math.round(diff / 60000) + "m ago";
                    else if (diff < 86400000) relTime = Math.round(diff / 3600000) + "h ago";
                    else relTime = Math.round(diff / 86400000) + "d ago";
                  } catch (e) { relTime = cp.timestamp || "—"; }
                  return (
                    <div key={cp.projectId} style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "8px 10px", background: TH.bg0, borderRadius: 5,
                      border: "1px solid " + TH.border, marginBottom: 6,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 11, color: TH.text0, fontWeight: 600,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                          {(cp.userDesc || "Unnamed").substring(0, 60)}
                        </div>
                        <div style={{ fontSize: 10, color: TH.text2, marginTop: 2 }}>
                          <span style={{ color: cp.designMode === "system" ? TH.blue : TH.accent }}>
                            {cp.designMode === "system" ? "System" : "Module"}
                          </span>
                          {" · "}{cp.moduleCount || 1} mod
                          {cp.completedStages != null && cp.totalStages
                            ? <span>{" · "}<span style={{ color: TH.accent }}>{cp.completedStages}/{cp.totalStages}</span> stages</span>
                            : ""}
                          {cp.furthestStage
                            ? <span>{" · last: "}<span style={{ color: TH.blue }}>{cp.furthestStage}</span></span>
                            : ""}
                          {" · "}{relTime}
                        </div>
                        {cp.completedStages != null && cp.totalStages > 0 && (
                          <div style={{ marginTop: 4, height: 3, background: TH.bg3, borderRadius: 2, overflow: "hidden" }}>
                            <div style={{
                              height: "100%", borderRadius: 2, background: TH.accent,
                              width: Math.round((cp.completedStages / cp.totalStages) * 100) + "%",
                            }} />
                          </div>
                        )}
                      </div>
                      <button
                        onClick={function() { if (onDeleteCheckpoint) onDeleteCheckpoint(cp.projectId); }}
                        style={{
                          background: "none", border: "1px solid " + TH.border, borderRadius: 3,
                          padding: "3px 8px", cursor: "pointer", color: TH.red,
                          fontSize: 11, fontFamily: TH.font,
                        }}
                      >🗑</button>
                    </div>
                  );
                })}
                <div style={{ marginTop: 14 }}>
                  <button
                    onClick={function() { if (onClearCheckpoints) onClearCheckpoints(); }}
                    style={{
                      background: TH.redDim, border: "1px solid " + TH.red, borderRadius: 4,
                      padding: "5px 12px", cursor: "pointer", color: TH.red,
                      fontSize: 10, fontWeight: 600, fontFamily: TH.font,
                    }}
                  >
                    🗑 Clear All
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══════ PATHS TAB ═══════ */}
        {tab === "paths" && (
          <div>
            <div style={{ marginBottom: 18 }}>
              <Label>Component Library Directory</Label>
              <div style={{ fontSize: 10, color: TH.text2, marginBottom: 6 }}>
                Path to a directory containing exported RTL Forge component/package files (.rtlpkg.json, .rtlsyspkg.json). Components found here will appear in the Library tab.
              </div>
              <DirPickerInput
                value={config.libraryPath || ""}
                onChange={function(e) { setConfig(function(c) { return Object.assign({}, c, { libraryPath: e.target.value }); }); }}
                placeholder="/path/to/my/rtl-library"
                style={iS}
                label="Component library directory"
              />
            </div>
            <div style={{ marginBottom: 18 }}>
              <Label>Settings Save Directory</Label>
              <div style={{ fontSize: 10, color: TH.text2, marginBottom: 6 }}>
                Directory where RTL Forge settings and checkpoints are persisted. Leave empty to use browser localStorage (default).
              </div>
              <DirPickerInput
                value={config.settingsDir || ""}
                onChange={function(e) { setConfig(function(c) { return Object.assign({}, c, { settingsDir: e.target.value }); }); }}
                placeholder="(browser localStorage)"
                style={iS}
                label="Settings save directory"
              />
            </div>
            <div style={{
              padding: 10, borderRadius: 4,
              background: TH.blueDim, border: "1px solid rgba(56,189,248,.2)",
              fontSize: 10, color: TH.blue, lineHeight: 1.5,
            }}>
              {"Settings are automatically saved to browser localStorage and restored when you reopen the app. API keys are never persisted for security. " +
               "Note: due to browser sandboxing, the folder picker can only return the folder's name in plain browsers — to get absolute paths, run RTL Forge in the Electron/Tauri desktop wrapper."}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
          <Btn onClick={handleSaveAndClose}>Save & Close</Btn>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DecompReview — multi-module decomposition review screen
// ═══════════════════════════════════════════════════════════════════════════
//
// The largest of the panels. Shown after a system-level decomposition
// completes, before running any pipelines. Lets the user review the
// auto-decomposed module hierarchy, edit module metadata (name,
// description, parameters), add/remove modules and instances, accept
// library matches for reuse, and validate + confirm before running.
//
// Props:
//   modules          : { [modId]: moduleObj } state
//   setModules       : updater for modules
//   instances        : { [instId]: instanceObj } state
//   setInstances     : updater for instances
//   decomposition    : initial decomposition from the LLM
//   decompError      : error message from the decomposition step (if any)
//   onConfirm        : callback when validation passes + user clicks Confirm
//   onRedecompose    : callback to re-run the decomposition LLM call
//   onBack           : callback to go back to the previous step
//   onImport         : callback to import an existing package
//   libraryMatches   : array of potential library reuses from signature match
//   importedPackages : library of imported module/system packages (unused in render, kept for API symmetry)
//   onApplyMatches   : callback (selected[]) with the selected library matches
export function DecompReview({
  modules, setModules, instances, setInstances,
  decomposition, decompError, onConfirm, onRedecompose, onBack, onImport,
  libraryMatches, importedPackages, onApplyMatches,
}) {
  const [selectedMod, setSelectedMod] = useState(null);
  const [addingModule, setAddingModule] = useState(false);
  const [newModId, setNewModId] = useState("");
  const [newModDesc, setNewModDesc] = useState("");
  const [addingInstance, setAddingInstance] = useState(null); // modId we're adding an instance for
  const [newInstName, setNewInstName] = useState("");
  const [newInstParent, setNewInstParent] = useState("");
  const [newInstParams, setNewInstParams] = useState("");
  const [validationErrors, setValidationErrors] = useState([]);

  // Library match checkbox + mode state — React-controlled so re-renders
  // don't reset user selections. Initialised from libraryMatches.
  const [matchChecked, setMatchChecked] = useState({});
  const [matchModes, setMatchModes] = useState({});
  // Re-seed when libraryMatches identity changes (new decomposition)
  useEffect(function() {
    if (!libraryMatches || libraryMatches.length === 0) return;
    const initChecked = {};
    const initModes = {};
    libraryMatches.forEach(function(m) {
      initChecked[m.decompModId] = m.confidence >= 0.9 && m.interfaceCompatible;
      initModes[m.decompModId] = m.suggestedMode;
    });
    setMatchChecked(initChecked);
    setMatchModes(initModes);
  }, [libraryMatches]);

  const modIds = Object.keys(modules);
  const topModule = decomposition ? decomposition.topModule : null;

  // Compute effective levels from instances
  const effectiveLevels = computeEffectiveLevels(modules, instances, topModule);

  // Sort by effective level, then alphabetically
  const sortedModIds = modIds.slice().sort(function(a, b) {
    const la = effectiveLevels[a], lb = effectiveLevels[b];
    if (la !== lb) return la - lb;
    return a.localeCompare(b);
  });

  // Helpers
  const iS = {
    width: "100%", background: TH.bg0, border: "1px solid " + TH.border,
    borderRadius: 4, padding: "7px 11px", color: TH.text0, fontSize: 12,
    outline: "none", fontFamily: TH.font,
  };

  function updateModField(mId, field, value) {
    setModules(function(prev) {
      const n = Object.assign({}, prev);
      n[mId] = Object.assign({}, n[mId], { [field]: value });
      return n;
    });
  }

  function deleteModule(mId) {
    setModules(function(prev) {
      const n = Object.assign({}, prev);
      delete n[mId];
      return n;
    });
    // Remove instances referencing this module
    setInstances(function(prev) {
      const n = {};
      Object.entries(prev).forEach(function(entry) {
        if (entry[1].moduleId !== mId && entry[1].parentModuleId !== mId) n[entry[0]] = entry[1];
      });
      return n;
    });
    if (selectedMod === mId) setSelectedMod(null);
  }

  function deleteInstance(instId) {
    setInstances(function(prev) {
      const n = Object.assign({}, prev);
      delete n[instId];
      return n;
    });
  }

  function updateInstance(instId, field, value) {
    setInstances(function(prev) {
      const n = Object.assign({}, prev);
      n[instId] = Object.assign({}, n[instId], { [field]: value });
      return n;
    });
  }

  function addModule() {
    const id = newModId.trim().replace(/\s+/g, "_").toLowerCase();
    if (!id || modules[id]) return;
    setModules(function(prev) {
      const n = Object.assign({}, prev);
      n[id] = Object.assign(blankModule(), { name: id, description: newModDesc || "New module", level: 1, params: [] });
      return n;
    });
    setNewModId("");
    setNewModDesc("");
    setAddingModule(false);
    setSelectedMod(id);
  }

  function addInstance(forModId) {
    const name = newInstName.trim()
      || ("u_" + forModId + "_" + Object.values(instances).filter(function(i) { return i.moduleId === forModId; }).length);
    const parent = newInstParent || topModule || modIds[0];
    let overrides = {};
    try { if (newInstParams.trim()) overrides = JSON.parse(newInstParams); }
    catch (e) { /* ignore bad JSON */ }
    const instId = name;
    setInstances(function(prev) {
      const n = Object.assign({}, prev);
      n[instId] = {
        instId: instId, moduleId: forModId, parentModuleId: parent,
        instanceName: name, paramOverrides: overrides, description: "",
      };
      return n;
    });
    setNewInstName("");
    setNewInstParent("");
    setNewInstParams("");
    setAddingInstance(null);
  }

  function updateParamDefault(mId, paramIdx, value) {
    setModules(function(prev) {
      const n = Object.assign({}, prev);
      const mod = Object.assign({}, n[mId]);
      const params = (mod.params || []).slice();
      params[paramIdx] = Object.assign({}, params[paramIdx], {
        default: isNaN(Number(value)) ? value : Number(value),
      });
      mod.params = params;
      n[mId] = mod;
      return n;
    });
  }

  function addParam(mId) {
    setModules(function(prev) {
      const n = Object.assign({}, prev);
      const mod = Object.assign({}, n[mId]);
      mod.params = (mod.params || []).concat([{ name: "NEW_PARAM", type: "parameter", default: 0, description: "" }]);
      n[mId] = mod;
      return n;
    });
  }

  function deleteParam(mId, paramIdx) {
    setModules(function(prev) {
      const n = Object.assign({}, prev);
      const mod = Object.assign({}, n[mId]);
      mod.params = (mod.params || []).filter(function(_, i) { return i !== paramIdx; });
      n[mId] = mod;
      return n;
    });
  }

  function updateParamField(mId, paramIdx, field, value) {
    setModules(function(prev) {
      const n = Object.assign({}, prev);
      const mod = Object.assign({}, n[mId]);
      const params = (mod.params || []).slice();
      params[paramIdx] = Object.assign({}, params[paramIdx], { [field]: value });
      mod.params = params;
      n[mId] = mod;
      return n;
    });
  }

  function validate() {
    const errs = [];
    modIds.forEach(function(mId) {
      if (!modules[mId].description || !modules[mId].description.trim()) {
        errs.push("Module \"" + mId + "\" has no description.");
      }
    });
    Object.values(instances).forEach(function(inst) {
      if (!modules[inst.moduleId]) {
        errs.push("Instance \"" + inst.instId + "\" references unknown module \"" + inst.moduleId + "\".");
      }
      if (!modules[inst.parentModuleId]) {
        errs.push("Instance \"" + inst.instId + "\" has unknown parent \"" + inst.parentModuleId + "\".");
      }
    });
    if (topModule && !modules[topModule]) {
      errs.push("Top module \"" + topModule + "\" not found in modules.");
    }
    // Non-top modules with no instances
    modIds.forEach(function(mId) {
      if (mId === topModule) return;
      const hasInst = Object.values(instances).some(function(inst) { return inst.moduleId === mId; });
      if (!hasInst) {
        errs.push("Module \"" + mId + "\" has no instances (orphan). Add an instance or remove it.");
      }
    });
    setValidationErrors(errs);
    return errs.length === 0;
  }

  function handleConfirm() {
    if (validate()) onConfirm();
  }

  const sel = selectedMod && modules[selectedMod] ? modules[selectedMod] : null;
  const selInstances = selectedMod
    ? Object.values(instances).filter(function(inst) { return inst.moduleId === selectedMod; })
    : [];
  const selChildren = selectedMod
    ? Object.values(instances).filter(function(inst) { return inst.parentModuleId === selectedMod; })
    : [];

  return (
    <div style={{ maxWidth: 820, margin: "auto", padding: "30px 24px", animation: "fadeIn .4s" }}>
      {/* Top bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 20, flexWrap: "wrap", gap: 10,
      }}>
        <div>
          <h2 style={{ fontFamily: TH.fontD, fontSize: 20, fontWeight: 800, color: TH.text0, margin: "0 0 4px" }}>
            System Decomposition
          </h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {decomposition && <Tag color={TH.accent} bg={TH.accentDim}>{decomposition.systemName}</Tag>}
            <Tag color={TH.blue} bg={TH.blueDim}>
              {modIds.length} module{modIds.length !== 1 ? "s" : ""}
            </Tag>
            <Tag color={TH.yellow} bg={TH.yellowDim}>
              {Object.keys(instances).length} instance{Object.keys(instances).length !== 1 ? "s" : ""}
            </Tag>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn variant="secondary" onClick={function() { setAddingModule(true); }} style={{ fontSize: 11 }}>+ Add Module</Btn>
          <Btn variant="secondary" onClick={onImport} style={{ fontSize: 11 }}>📥 Import</Btn>
          <Btn variant="secondary" onClick={onRedecompose} style={{ fontSize: 11 }}>⟲ Re-decompose</Btn>
          <Btn variant="secondary" onClick={onBack} style={{ fontSize: 11 }}>← Back</Btn>
          <Btn onClick={handleConfirm} style={{ fontSize: 12 }}>▶ Confirm & Start</Btn>
        </div>
      </div>

      {decompError && <div style={{ marginBottom: 12 }}><ErrorBox msg={decompError} /></div>}
      {validationErrors.length > 0 && (
        <div style={{
          marginBottom: 12, padding: "10px 14px",
          background: TH.redDim, border: "1px solid " + TH.red, borderRadius: 6,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: TH.red, marginBottom: 4 }}>Validation errors:</div>
          {validationErrors.map(function(e, i) {
            return <div key={i} style={{ fontSize: 11, color: TH.red, padding: "2px 0" }}>• {e}</div>;
          })}
        </div>
      )}

      {/* Add module form */}
      {addingModule && (
        <div style={{
          background: TH.bg0, border: "1px solid " + TH.accent, borderRadius: 6,
          padding: 14, marginBottom: 14,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: TH.accent, marginBottom: 8 }}>Add New Module</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ minWidth: 160 }}>
              <Label>Module ID (snake_case)</Label>
              <input
                value={newModId}
                onChange={function(e) { setNewModId(e.target.value); }}
                placeholder="my_module"
                style={iS}
              />
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <Label>Description</Label>
              <input
                value={newModDesc}
                onChange={function(e) { setNewModDesc(e.target.value); }}
                placeholder="What does this module do?"
                onKeyDown={function(e) { if (e.key === "Enter") addModule(); }}
                style={iS}
              />
            </div>
            <Btn onClick={addModule} disabled={!newModId.trim()} style={{ fontSize: 11 }}>Add</Btn>
            <Btn variant="secondary" onClick={function() { setAddingModule(false); }} style={{ fontSize: 11 }}>Cancel</Btn>
          </div>
        </div>
      )}

      {/* Library match banner */}
      {libraryMatches && libraryMatches.length > 0 && (
        <div style={{
          marginBottom: 14, background: TH.bg0,
          border: "1px solid " + TH.blue, borderRadius: 6, padding: 14,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: TH.blue, marginBottom: 10 }}>
            📥 {libraryMatches.length} module{libraryMatches.length !== 1 ? "s" : ""} match your library
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            {libraryMatches.map(function(m) {
              const isChecked = !!matchChecked[m.decompModId];
              const modeVal = matchModes[m.decompModId] || m.suggestedMode;
              return (
                <div key={m.decompModId} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "6px 10px", background: TH.bg1, borderRadius: 4,
                  border: "1px solid " + TH.border,
                }}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={function(e) {
                      setMatchChecked(function(prev) {
                        const n = Object.assign({}, prev);
                        n[m.decompModId] = e.target.checked;
                        return n;
                      });
                    }}
                    style={{ accentColor: TH.accent, flexShrink: 0 }}
                  />
                  <span style={{ fontSize: 11, fontWeight: 700, color: TH.accent, minWidth: 120 }}>{m.decompModId}</span>
                  <Tag
                    color={m.matchType === "exact_id" ? TH.accent : (m.matchType === "signature_match" ? TH.blue : TH.yellow)}
                    bg={m.matchType === "exact_id" ? TH.accentDim : (m.matchType === "signature_match" ? TH.blueDim : TH.yellowDim)}
                  >
                    {m.matchType === "exact_id" ? "exact match" : (m.matchType === "signature_match" ? "signature" : "name similar")}
                  </Tag>
                  {m.overall && (
                    <Tag
                      color={m.overall === "PASS" ? TH.accent : TH.red}
                      bg={m.overall === "PASS" ? TH.accentDim : TH.redDim}
                    >
                      {m.overall}{m.score != null ? "(" + m.score + ")" : ""}
                    </Tag>
                  )}
                  {!m.interfaceCompatible && <span style={{ fontSize: 10, color: TH.yellow }}>⚠ {m.reason}</span>}
                  {m.libraryType === "system" && (
                    <select
                      value={modeVal}
                      onChange={function(e) {
                        setMatchModes(function(prev) {
                          const n = Object.assign({}, prev);
                          n[m.decompModId] = e.target.value;
                          return n;
                        });
                      }}
                      style={{
                        background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 3,
                        padding: "2px 6px", color: TH.text0, fontSize: 10, fontFamily: TH.font, outline: "none",
                      }}
                    >
                      <option value="blackbox">blackbox</option>
                      <option value="exploded">exploded</option>
                    </select>
                  )}
                  {m.libraryType === "module" && <Tag color={TH.text2} bg={TH.bg3}>{m.suggestedMode}</Tag>}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn
              onClick={function() {
                const selected = [];
                libraryMatches.forEach(function(m) {
                  if (matchChecked[m.decompModId]) {
                    const mode = matchModes[m.decompModId] || m.suggestedMode;
                    selected.push({ match: m, mode: mode });
                  }
                });
                if (onApplyMatches) onApplyMatches(selected);
              }}
              style={{ fontSize: 11 }}
            >
              📥 Apply Selected
            </Btn>
            <Btn variant="secondary" onClick={function() { if (onApplyMatches) onApplyMatches([]); }} style={{ fontSize: 11 }}>
              Skip All
            </Btn>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 16, minHeight: 400 }}>
        {/* ─── Panel A: Hierarchy Tree ─── */}
        <div style={{
          width: 260, flexShrink: 0, background: TH.bg0,
          border: "1px solid " + TH.border, borderRadius: 6, overflow: "auto",
        }}>
          <div style={{
            padding: "10px 12px", borderBottom: "1px solid " + TH.border,
            fontSize: 10, color: TH.text3, textTransform: "uppercase",
            letterSpacing: 1, fontWeight: 700,
          }}>
            Module Hierarchy
          </div>
          {sortedModIds.map(function(mId) {
            const mod = modules[mId];
            const level = effectiveLevels[mId] || 0;
            const isSel = mId === selectedMod;
            const instOfCount = Object.values(instances).filter(function(i) { return i.moduleId === mId; }).length;
            const childCount = Object.values(instances).filter(function(i) { return i.parentModuleId === mId; }).length;
            const isTop = mId === topModule;
            const parentLevels = Object.values(instances)
              .filter(function(inst) { return inst.moduleId === mId; })
              .map(function(inst) { return effectiveLevels[inst.parentModuleId] || 0; });
            const isMultiLevel = parentLevels.length > 0
              && Math.max.apply(null, parentLevels) > Math.min.apply(null, parentLevels);
            return (
              <button
                key={mId}
                onClick={function() { setSelectedMod(mId); }}
                style={{
                  display: "flex", alignItems: "center", gap: 6, width: "100%",
                  padding: "8px 10px", paddingLeft: 10 + level * 18,
                  border: "none",
                  borderLeft: isSel ? "3px solid " + TH.accent : "3px solid transparent",
                  background: isSel ? TH.bg2 : "transparent",
                  cursor: "pointer", fontFamily: TH.font, transition: "all .12s",
                  borderBottom: "1px solid " + TH.bg1,
                }}
              >
                {level > 0 && <span style={{ color: TH.text3, fontSize: 10 }}>└</span>}
                <span style={{
                  fontSize: 11, fontWeight: isSel ? 700 : 500,
                  color: isSel ? TH.accent : TH.text0,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  flex: 1, textAlign: "left",
                }}>{mId}</span>
                {isTop && <span style={{ fontSize: 8, color: TH.orange, fontWeight: 700 }}>TOP</span>}
                {isMultiLevel && (
                  <span
                    style={{ fontSize: 8, color: TH.blue, fontWeight: 700 }}
                    title="Used at multiple hierarchy levels"
                  >⬡</span>
                )}
                {instOfCount > 1 && <span style={{ fontSize: 9, color: TH.blue, fontWeight: 700 }}>×{instOfCount}</span>}
                {childCount > 0 && <span style={{ fontSize: 9, color: TH.yellow }}>⊞{childCount}</span>}
              </button>
            );
          })}
          {modIds.length === 0 && (
            <div style={{ padding: 20, color: TH.text3, fontSize: 11, textAlign: "center" }}>No modules</div>
          )}
        </div>

        {/* ─── Panel B: Selected Module Detail ─── */}
        <div style={{
          flex: 1, background: TH.bg0,
          border: "1px solid " + TH.border, borderRadius: 6, overflow: "auto",
        }}>
          {!sel ? (
            <div style={{ padding: 40, textAlign: "center", color: TH.text2, fontSize: 12 }}>
              Select a module from the tree
            </div>
          ) : (
            <div style={{ padding: 16 }}>
              {/* Module header */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                <span style={{ fontFamily: TH.fontD, fontSize: 16, fontWeight: 800, color: TH.accent }}>
                  {selectedMod}
                </span>
                <Tag>L{sel.level}</Tag>
                {selectedMod === topModule && <Tag color={TH.orange} bg={TH.orangeDim}>top</Tag>}
                {selectedMod !== topModule && (
                  <Btn
                    variant="danger"
                    onClick={function() { deleteModule(selectedMod); }}
                    style={{ fontSize: 10, padding: "3px 10px", marginLeft: "auto" }}
                  >
                    Delete Module
                  </Btn>
                )}
              </div>

              {/* Editable name */}
              <div style={{ marginBottom: 10 }}>
                <Label>Display Name</Label>
                <input
                  value={sel.name || ""}
                  onChange={function(e) { updateModField(selectedMod, "name", e.target.value); }}
                  style={iS}
                />
              </div>

              {/* Editable description */}
              <div style={{ marginBottom: 10 }}>
                <Label>Description</Label>
                <textarea
                  value={sel.description || ""}
                  onChange={function(e) { updateModField(selectedMod, "description", e.target.value); }}
                  style={Object.assign({}, iS, { minHeight: 60, resize: "vertical" })}
                />
              </div>

              {/* Parameters */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <Label>Parameters</Label>
                  <Btn variant="secondary" onClick={function() { addParam(selectedMod); }} style={{ fontSize: 10, padding: "2px 8px" }}>
                    + Param
                  </Btn>
                </div>
                {(sel.params || []).length === 0 && (
                  <div style={{ fontSize: 11, color: TH.text3, padding: 8 }}>No parameters</div>
                )}
                {(sel.params || []).map(function(pr, pi) {
                  return (
                    <div key={pi} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                      <input
                        value={pr.name}
                        onChange={function(e) { updateParamField(selectedMod, pi, "name", e.target.value); }}
                        style={Object.assign({}, iS, { width: 110, fontSize: 11, padding: "4px 8px" })}
                        placeholder="NAME"
                      />
                      <input
                        value={pr.default}
                        onChange={function(e) { updateParamDefault(selectedMod, pi, e.target.value); }}
                        style={Object.assign({}, iS, { width: 70, fontSize: 11, padding: "4px 8px" })}
                        placeholder="default"
                      />
                      <input
                        value={pr.description || ""}
                        onChange={function(e) { updateParamField(selectedMod, pi, "description", e.target.value); }}
                        style={Object.assign({}, iS, { flex: 1, minWidth: 100, fontSize: 11, padding: "4px 8px" })}
                        placeholder="description"
                      />
                      <button
                        onClick={function() { deleteParam(selectedMod, pi); }}
                        style={{ background: "none", border: "none", color: TH.red, cursor: "pointer", fontSize: 13, padding: "0 4px" }}
                      >×</button>
                    </div>
                  );
                })}
              </div>

              {/* Instances OF this module */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <Label>Instances of {selectedMod}</Label>
                  <Btn
                    variant="secondary"
                    onClick={function() {
                      setAddingInstance(selectedMod);
                      setNewInstName("");
                      setNewInstParent(topModule || "");
                      setNewInstParams("");
                    }}
                    style={{ fontSize: 10, padding: "2px 8px" }}
                  >
                    + Instance
                  </Btn>
                </div>
                {selInstances.length === 0 && selectedMod !== topModule && (
                  <div style={{ fontSize: 11, color: TH.yellow, padding: 8 }}>
                    ⚠ No instances — this module is an orphan
                  </div>
                )}
                {selInstances.map(function(inst) {
                  return (
                    <div key={inst.instId} style={{
                      background: TH.bg1, border: "1px solid " + TH.border, borderRadius: 4,
                      padding: "8px 10px", marginBottom: 4,
                    }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                        <span style={{ color: TH.yellow, fontWeight: 600, fontSize: 11 }}>{inst.instanceName}</span>
                        <span style={{ color: TH.text3, fontSize: 10 }}>in</span>
                        <Tag>{inst.parentModuleId}</Tag>
                        <button
                          onClick={function() { deleteInstance(inst.instId); }}
                          style={{ background: "none", border: "none", color: TH.red, cursor: "pointer", fontSize: 12, marginLeft: "auto" }}
                        >×</button>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <div style={{ flex: 1, minWidth: 140 }}>
                          <div style={{ fontSize: 9, color: TH.text3, marginBottom: 2 }}>paramOverrides (JSON)</div>
                          <input
                            value={JSON.stringify(inst.paramOverrides || {})}
                            onChange={function(e) {
                              try { updateInstance(inst.instId, "paramOverrides", JSON.parse(e.target.value)); }
                              catch (ex) { /* ignore bad JSON while typing */ }
                            }}
                            style={Object.assign({}, iS, { fontSize: 10, padding: "4px 8px" })}
                          />
                        </div>
                        <div style={{ flex: 1, minWidth: 140 }}>
                          <div style={{ fontSize: 9, color: TH.text3, marginBottom: 2 }}>description</div>
                          <input
                            value={inst.description || ""}
                            onChange={function(e) { updateInstance(inst.instId, "description", e.target.value); }}
                            style={Object.assign({}, iS, { fontSize: 10, padding: "4px 8px" })}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Add instance form */}
                {addingInstance === selectedMod && (
                  <div style={{
                    background: TH.bg1, border: "1px solid " + TH.accent, borderRadius: 4,
                    padding: 10, marginTop: 6,
                  }}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
                      <div>
                        <div style={{ fontSize: 9, color: TH.text3, marginBottom: 2 }}>Instance name</div>
                        <input
                          value={newInstName}
                          onChange={function(e) { setNewInstName(e.target.value); }}
                          placeholder={"u_" + selectedMod + "_0"}
                          style={Object.assign({}, iS, { width: 130, fontSize: 10, padding: "4px 8px" })}
                        />
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: TH.text3, marginBottom: 2 }}>Parent module</div>
                        <select
                          value={newInstParent}
                          onChange={function(e) { setNewInstParent(e.target.value); }}
                          style={Object.assign({}, iS, { width: 130, fontSize: 10, padding: "4px 8px" })}
                        >
                          {modIds.filter(function(m) { return m !== selectedMod; }).map(function(m) {
                            return <option key={m} value={m}>{m}</option>;
                          })}
                        </select>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: TH.text3, marginBottom: 2 }}>paramOverrides (JSON)</div>
                        <input
                          value={newInstParams}
                          onChange={function(e) { setNewInstParams(e.target.value); }}
                          placeholder='{"DEPTH":16}'
                          style={Object.assign({}, iS, { width: 150, fontSize: 10, padding: "4px 8px" })}
                        />
                      </div>
                      <Btn onClick={function() { addInstance(selectedMod); }} style={{ fontSize: 10, padding: "4px 10px" }}>
                        Add
                      </Btn>
                      <Btn variant="secondary" onClick={function() { setAddingInstance(null); }} style={{ fontSize: 10, padding: "4px 10px" }}>
                        Cancel
                      </Btn>
                    </div>
                  </div>
                )}
              </div>

              {/* Children instantiated BY this module */}
              {selChildren.length > 0 && (
                <div>
                  <Label>Children instantiated by {selectedMod}</Label>
                  {selChildren.map(function(inst) {
                    return (
                      <div key={inst.instId} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0", fontSize: 11 }}>
                        <span style={{ color: TH.yellow }}>{inst.instanceName}</span>
                        <span style={{ color: TH.text3 }}>→</span>
                        <span
                          style={{ color: TH.accent, cursor: "pointer", textDecoration: "underline" }}
                          onClick={function() { setSelectedMod(inst.moduleId); }}
                        >
                          {inst.moduleId}
                        </span>
                        {inst.paramOverrides && Object.keys(inst.paramOverrides).length > 0 && (
                          <span style={{ color: TH.blue, fontSize: 10 }}>
                            {"#(" + Object.entries(inst.paramOverrides).map(function(e) { return e[0] + "=" + e[1]; }).join(", ") + ")"}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ─── Panel C: Interconnects (read-only) ─── */}
      {decomposition && decomposition.interconnects && decomposition.interconnects.length > 0 && (
        <div style={{
          marginTop: 16, background: TH.bg0,
          border: "1px solid " + TH.border, borderRadius: 6, padding: 14,
        }}>
          <div style={{
            fontSize: 10, color: TH.text3, textTransform: "uppercase",
            letterSpacing: 1, marginBottom: 8, fontWeight: 700,
          }}>
            Interconnects
          </div>
          {decomposition.interconnects.map(function(ic, i) {
            return (
              <div key={i} style={{
                display: "flex", gap: 8, alignItems: "center", padding: "5px 0",
                borderBottom: i < decomposition.interconnects.length - 1 ? "1px solid " + TH.bg1 : "none",
                flexWrap: "wrap",
              }}>
                <span style={{ color: TH.accent, fontWeight: 600, fontSize: 11 }}>{ic.from}</span>
                <span style={{ color: TH.text3, fontSize: 11 }}>→</span>
                <span style={{ color: TH.accent, fontWeight: 600, fontSize: 11 }}>{ic.to}</span>
                <Tag color={TH.blue} bg={TH.blueDim}>{ic.protocol}</Tag>
                <span style={{ color: TH.text2, fontSize: 10 }}>{ic.description}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
