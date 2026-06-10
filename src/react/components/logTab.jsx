// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// LogTab — Per-stage Log panel
//
// Per the user spec ("there should be a log in each step"):
//   • Last tab in every stage (right of all existing tabs)
//   • Captures LLM exchanges (prompts/responses/tokens), CLI executions,
//     skill applications, prompt overrides, and state transitions
//   • User-configurable filter — toggle which event types appear
//   • Each row defaults to TRUNCATED prompt/response (200-char preview)
//     with "show full" toggle per row
//   • Download button at the end of each step — picks .log or .json
//
// Data source: stageData[id]._log (populated by runStage.js from each
// node's _llms ledger + any direct logger pushes).
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from "react";
import { TH } from "../../constants/theme.js";
import { logToText, logToJson } from "../../projectState/stageLogger.js";

const EVENT_TYPES = [
  { id: "llm",    label: "LLM",    color: "#5fa1d8", desc: "LLM API calls (prompts, responses, tokens)" },
  { id: "cli",    label: "CLI",    color: "#ee9a40", desc: "Backend command executions (Verilator, etc.)" },
  { id: "skill",  label: "Skill",  color: "#a78bfa", desc: "Skill overlays applied to prompts" },
  { id: "prompt", label: "Prompt", color: "#c8b46f", desc: "Prompt override resolutions" },
  { id: "state",  label: "State",  color: "#74c69d", desc: "Iteration / loop-back transitions" },
  { id: "result", label: "Result", color: "#f87171", desc: "Final stage outcome" },
];
const DEFAULT_VISIBLE = new Set(EVENT_TYPES.map(function(t) { return t.id; }));

export function LogTab({ stageData, stageId, stageKey, stageLabel, data }) {
  // Resolve log events from either (a) stageData[stageId]._log
  // (JudgeStage path) or (b) data._log directly (other stages where
  // we don't have the full stageData blob).
  let events = [];
  if (data && Array.isArray(data._log)) {
    events = data._log;
  } else if (stageData && stageId != null) {
    const result = stageData[stageId];
    if (result && Array.isArray(result._log)) events = result._log;
  }

  // Q1 — user-configurable filter
  const [visible, setVisible] = useState(DEFAULT_VISIBLE);
  function toggleType(id) {
    setVisible(function(s) {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const filtered = events.filter(function(e) { return visible.has(e.type); });

  // Q2 — download button + format picker
  const [showDownload, setShowDownload] = useState(false);
  function download(format) {
    const text = (format === "json") ? logToJson(filtered) : logToText(filtered);
    const mime = (format === "json") ? "application/json" : "text/plain";
    const ext  = (format === "json") ? "json" : "log";
    const blob = new Blob([text], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = "rtlforge-" + (stageKey || "stage") + "-" + Date.now() + "." + ext;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setShowDownload(false);
  }

  if (events.length === 0) {
    return (
      <div style={{
        padding: 24, textAlign: "center", color: TH.text2, fontSize: 12,
        fontStyle: "italic",
        background: TH.bg0, border: "1px dashed " + TH.border, borderRadius: 6,
        margin: "16px 4px",
      }}>
        No log events captured for this stage yet.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 4px" }}>
      {/* ── Filter toolbar ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "10px 14px",
        background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
      }}>
        <span style={{ fontSize: 9, color: TH.text3, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
          Filter
        </span>
        {EVENT_TYPES.map(function(t) {
          const count = events.filter(function(e) { return e.type === t.id; }).length;
          const isOn = visible.has(t.id);
          return (
            <button
              key={t.id}
              onClick={function() { toggleType(t.id); }}
              title={t.desc + " (" + count + " event" + (count === 1 ? "" : "s") + ")"}
              style={{
                background: isOn ? t.color : TH.bg1,
                color: isOn ? "#000" : TH.text2,
                border: "1px solid " + (isOn ? t.color : TH.border),
                borderRadius: 3, padding: "3px 8px",
                fontSize: 10, fontWeight: 700, fontFamily: TH.font,
                cursor: count > 0 ? "pointer" : "not-allowed",
                opacity: count > 0 ? 1 : 0.4,
              }}
              disabled={count === 0}
            >
              {t.label} <span style={{ opacity: 0.7, fontWeight: 400 }}>({count})</span>
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: TH.text2 }}>
          {filtered.length} of {events.length} event{events.length === 1 ? "" : "s"}
        </span>
        {/* Download button */}
        <div style={{ position: "relative" }}>
          <button
            onClick={function() { setShowDownload(function(s) { return !s; }); }}
            style={{
              background: TH.accent, color: "#000",
              border: "1px solid " + TH.accent, borderRadius: 3,
              padding: "4px 12px", fontSize: 11, fontWeight: 700,
              fontFamily: TH.font, cursor: "pointer",
            }}
          >Download ↓</button>
          {showDownload && (
            <div style={{
              position: "absolute", top: "100%", right: 0, marginTop: 4,
              background: TH.bg1, border: "1px solid " + TH.border, borderRadius: 4,
              padding: 6, display: "flex", flexDirection: "column", gap: 4,
              zIndex: 10, minWidth: 160,
              boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            }}>
              <button
                onClick={function() { download("log"); }}
                style={dlBtnStyle()}
              >Plain log (.log)</button>
              <button
                onClick={function() { download("json"); }}
                style={dlBtnStyle()}
              >Structured (.json)</button>
            </div>
          )}
        </div>
      </div>

      {/* ── Events list ── */}
      <div style={{
        background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
        overflow: "hidden",
      }}>
        {filtered.length === 0 ? (
          <div style={{
            padding: 24, textAlign: "center", color: TH.text2, fontSize: 12,
            fontStyle: "italic",
          }}>
            All event types filtered out. Toggle filter buttons above to show events.
          </div>
        ) : (
          filtered.map(function(e, i) {
            return <LogEventRow key={i} event={e} />;
          })
        )}
      </div>

      {/* ── Methodology footer ── */}
      <div style={{
        fontSize: 10, color: TH.text2,
        padding: "10px 14px",
        background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4,
      }}>
        <strong style={{ color: TH.accent }}>About this log</strong>
        <div style={{ marginTop: 4, lineHeight: 1.5 }}>
          • <strong>LLM</strong> events come from <code>callLLM</code>'s
          per-call response (provider telemetry, never estimated).<br />
          • <strong>CLI</strong> events come from real backend executions
          (Verilator/Yosys/etc.) when a backend URL is configured.<br />
          • Prompt and response text is captured in full; the UI renders
          truncated previews by default with a <strong>"show full"</strong>{" "}
          toggle per row. The downloaded <strong>.json</strong> always
          contains the full text.<br />
          • The <strong>.log</strong> format is a flat timestamped stream
          suited to <code>grep</code>; <strong>.json</strong> is for
          machine consumption.
        </div>
      </div>
    </div>
  );
}

function LogEventRow({ event }) {
  const [expanded, setExpanded] = useState(false);
  const t = EVENT_TYPES.find(function(et) { return et.id === event.type; });
  const color = (t && t.color) || TH.text2;
  const label = (t && t.label) || event.type.toUpperCase();
  const ts = new Date(event.ts).toLocaleTimeString();

  return (
    <div style={{ borderTop: "1px solid " + TH.border }}>
      <div style={{
        display: "grid", gridTemplateColumns: "70px 60px 1fr auto",
        gap: 10, alignItems: "center", padding: "6px 14px",
        cursor: hasDetails(event) ? "pointer" : "default",
      }}
        onClick={function() { if (hasDetails(event)) setExpanded(function(x) { return !x; }); }}
      >
        <span style={{ fontSize: 10, color: TH.text3, fontFamily: TH.fontMono }}>
          {ts}
        </span>
        <span style={{
          fontSize: 9, color: "#000", background: color,
          padding: "1px 5px", borderRadius: 2, fontWeight: 700,
          textAlign: "center", letterSpacing: 0.5,
        }}>
          {label}
        </span>
        <span style={{ fontSize: 11, color: TH.text1, overflow: "hidden", textOverflow: "ellipsis" }}>
          {summarizeEvent(event)}
        </span>
        {hasDetails(event) && (
          <span style={{ fontSize: 10, color: TH.text3 }}>
            {expanded ? "▾" : "▸"}
          </span>
        )}
      </div>
      {expanded && hasDetails(event) && (
        <div style={{
          padding: "8px 14px 12px 90px", background: TH.bg1,
          fontSize: 10, color: TH.text1, fontFamily: TH.fontMono,
          lineHeight: 1.5,
        }}>
          <EventDetail event={event} />
        </div>
      )}
    </div>
  );
}

function hasDetails(event) {
  if (event.type === "llm") return !!(event.systemPrompt || event.userMessage || event.response);
  if (event.type === "cli") return !!(event.stdout || event.stderr);
  return false;
}

function summarizeEvent(event) {
  if (event.type === "llm") {
    const parts = [];
    if (event.iter != null) parts.push("iter " + event.iter);
    if (event.model) parts.push(event.model);
    if (event.tokensIn != null) parts.push(event.tokensIn + " ↓ / " + (event.tokensOut != null ? event.tokensOut : "—") + " ↑");
    if (event.latencyMs != null) parts.push(event.latencyMs + "ms");
    return parts.join("  ·  ");
  }
  if (event.type === "cli") {
    const cmd = event.command || "";
    const short = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
    return short + " (exit " + (event.exitCode != null ? event.exitCode : "?") + ")";
  }
  if (event.type === "skill")  return (event.skillId || "?") + " — mode: " + (event.mode || "?");
  if (event.type === "prompt") return "Stage " + (event.stageKey || "?") + " — " + (event.sectionCount || 0) + " section(s), mode: " + (event.mode || "?");
  if (event.type === "state")  return (event.iter != null ? "iter " + event.iter + " — " : "") + (event.message || "");
  if (event.type === "result") return (event.status || "?") + " — " + (event.summary || "");
  return JSON.stringify(event).slice(0, 100);
}

function EventDetail({ event }) {
  if (event.type === "llm") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <CollapsibleText label="System Prompt" text={event.systemPrompt || ""} truncated={event.promptTruncated} />
        <CollapsibleText label="User Message"  text={event.userMessage  || ""} truncated={event.promptTruncated} />
        <CollapsibleText label="Response"      text={event.response     || ""} truncated={event.responseTruncated} />
        {event.startedAtMs && (
          <div style={{ fontSize: 9, color: TH.text3 }}>
            {"started: " + new Date(event.startedAtMs).toISOString() + " · ended: " + new Date(event.endedAtMs).toISOString()}
          </div>
        )}
      </div>
    );
  }
  if (event.type === "cli") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {event.stdout && <CollapsibleText label="stdout" text={event.stdout} truncated={event.stdout.length > 200} />}
        {event.stderr && <CollapsibleText label="stderr" text={event.stderr} truncated={event.stderr.length > 200} />}
      </div>
    );
  }
  return null;
}

function CollapsibleText({ label, text, truncated }) {
  const [showFull, setShowFull] = useState(!truncated);
  const display = showFull ? text : text.slice(0, 200);

  return (
    <div>
      <div style={{
        fontSize: 9, color: TH.text3, fontWeight: 700, textTransform: "uppercase",
        letterSpacing: 1, marginBottom: 4,
      }}>
        {label}
        {truncated && (
          <button
            onClick={function(e) { e.stopPropagation(); setShowFull(function(s) { return !s; }); }}
            style={{
              marginLeft: 8, padding: "0 6px", fontSize: 9, fontWeight: 700,
              background: "none", border: "1px solid " + TH.border,
              color: TH.accent, cursor: "pointer", borderRadius: 2,
            }}
          >{showFull ? "show less" : "show full"}</button>
        )}
      </div>
      <pre style={{
        margin: 0, padding: "6px 10px",
        background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 3,
        fontFamily: TH.fontMono, fontSize: 10, color: TH.text1,
        whiteSpace: "pre-wrap", wordBreak: "break-word",
        maxHeight: showFull ? "none" : 60,
        overflow: "hidden",
      }}>
        {display}
        {!showFull && truncated && <span style={{ color: TH.text3 }}>...</span>}
      </pre>
    </div>
  );
}

function dlBtnStyle() {
  return {
    background: TH.bg0, border: "1px solid " + TH.border,
    color: TH.text0, fontSize: 11, fontWeight: 600,
    padding: "4px 10px", borderRadius: 3, cursor: "pointer",
    textAlign: "left", fontFamily: TH.font,
  };
}
