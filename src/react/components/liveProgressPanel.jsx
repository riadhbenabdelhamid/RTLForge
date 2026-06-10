// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// LiveProgressPanel — in-flight stage progress view
//
// Renders in-flight progress for a stage that's currently running.
// Replaces the "No data yet." placeholder while a stage is in flight.
//
// Input: the stage's events array (from useProject's liveProgress map).
// Each event is shaped by stageLogger.js:
//   { ts, type, depth, parentStageKey, parentIter, ...payload }
// Type-specific fields:
//   - llm    : { stage, model, tokensIn?, tokensOut?, latencyMs? }
//   - cli    : { cmd?, exitCode?, durationMs? }
//   - skill  : { stageKey, skillCount }
//   - prompt : { stageKey, override }
//   - state  : { iter?, message }
//   - result : { ... }
//
// The panel shows:
//   - A "currently doing" headline (the latest non-state event, or the
//     latest state message if that's all there is)
//   - Counters: N LLM, M CLI, K skill events
//   - Elapsed time since startedAtMs
//   - A tail of the most recent 8 events for context
//
// When the stage finishes (data arrives), this panel auto-collapses
// to a side button — handled by the caller via collapsed/onToggle.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useState } from "react";
import { TH } from "../../constants/theme.js";

const MAX_TAIL = 8;

function fmtElapsed(ms) {
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m + "m " + s + "s";
}

function summarizeEvent(e) {
  if (!e || !e.type) return { headline: "...", detail: "" };
  switch (e.type) {
    case "llm": {
      const stage = e.stage || "LLM call";
      const tIn   = e.tokensIn  != null ? e.tokensIn  : null;
      const tOut  = e.tokensOut != null ? e.tokensOut : null;
      const ms    = e.latencyMs != null ? e.latencyMs : null;
      let detail = "";
      if (tIn != null || tOut != null) {
        detail = "in=" + (tIn || 0) + " out=" + (tOut || 0);
      }
      if (ms != null) detail += (detail ? " · " : "") + ms + "ms";
      return { headline: stage, detail: detail };
    }
    case "cli": {
      const cmd = e.cmd || e.command || "CLI";
      const dur = e.durationMs != null ? (" · " + e.durationMs + "ms") : "";
      const ec  = e.exitCode != null ? (" · exit " + e.exitCode) : "";
      return { headline: cmd.length > 60 ? (cmd.slice(0, 57) + "...") : cmd, detail: dur + ec };
    }
    case "skill":  return { headline: "Skill overlay applied", detail: e.skillCount ? (e.skillCount + " skill(s)") : "" };
    case "prompt": return { headline: "Prompt override resolved", detail: e.override || "" };
    case "state":  return { headline: e.message || "state event", detail: e.iter != null ? ("iter " + e.iter) : "" };
    case "result": return { headline: "Result captured", detail: "" };
    default:       return { headline: e.type, detail: "" };
  }
}

export function LiveProgressPanel({ stageId, progress, onClear }) {
  const events = (progress && progress.events) || [];
  const startedAtMs = (progress && progress.startedAtMs) || Date.now();
  // Re-render every second so the elapsed clock ticks even without
  // new events.
  const [, setTick] = useState(0);
  useEffect(function() {
    const id = setInterval(function() { setTick(function(t) { return t + 1; }); }, 1000);
    return function() { clearInterval(id); };
  }, []);

  const elapsedMs = Date.now() - startedAtMs;
  const llmCount = (progress && progress.llmCount) || 0;
  const cliCount = (progress && progress.cliCount) || 0;
  const skillCount = events.filter(function(e) { return e.type === "skill"; }).length;
  const latestEvent = events.length > 0 ? events[events.length - 1] : null;
  const latestSummary = latestEvent ? summarizeEvent(latestEvent) : null;
  const tail = events.slice(-MAX_TAIL).reverse();

  return (
    <div style={{
      padding: 24, fontFamily: TH.font, color: TH.text1,
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      {/* Headline */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 16px",
        background: TH.bg0, border: "1px solid " + TH.yellow, borderRadius: 6,
      }}>
        {/* Pulsing dot to convey "live" */}
        <span style={{
          width: 10, height: 10, borderRadius: "50%",
          background: TH.yellow,
          animation: "pulse 1.2s infinite",
          flexShrink: 0,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 9, color: TH.text3, textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 }}>
            Currently Running · {fmtElapsed(elapsedMs)} elapsed
          </div>
          <div style={{
            fontSize: 13, color: TH.text0, fontWeight: 600,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {latestSummary ? latestSummary.headline : "Starting..."}
          </div>
          {latestSummary && latestSummary.detail && (
            <div style={{ fontSize: 10, color: TH.text2, fontFamily: TH.fontMono, marginTop: 2 }}>
              {latestSummary.detail}
            </div>
          )}
        </div>
      </div>

      {/* Counters */}
      <div style={{ display: "flex", gap: 8, fontSize: 10, color: TH.text2 }}>
        <span style={{
          padding: "4px 10px", borderRadius: 3,
          background: TH.bg0, border: "1px solid " + TH.border,
          fontFamily: TH.fontMono,
        }}>
          {llmCount} LLM call{llmCount === 1 ? "" : "s"}
        </span>
        <span style={{
          padding: "4px 10px", borderRadius: 3,
          background: TH.bg0, border: "1px solid " + TH.border,
          fontFamily: TH.fontMono,
        }}>
          {cliCount} CLI exec{cliCount === 1 ? "" : "s"}
        </span>
        {skillCount > 0 && (
          <span style={{
            padding: "4px 10px", borderRadius: 3,
            background: TH.bg0, border: "1px solid " + TH.border,
            fontFamily: TH.fontMono,
          }}>
            {skillCount} skill overlay{skillCount === 1 ? "" : "s"}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {typeof onClear === "function" && events.length > 0 && (
          <button
            onClick={onClear}
            style={{
              padding: "3px 8px", fontSize: 9,
              background: "transparent", border: "1px solid " + TH.text3,
              color: TH.text2, borderRadius: 3, cursor: "pointer",
            }}
            title="Clear in-flight events from this panel"
          >
            CLEAR
          </button>
        )}
      </div>

      {/* Event tail */}
      {tail.length > 0 && (
        <div style={{
          background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
          padding: 0, overflow: "hidden",
        }}>
          <div style={{
            padding: "6px 14px",
            background: TH.bg1,
            fontSize: 9, color: TH.text3,
            textTransform: "uppercase", letterSpacing: 1,
            borderBottom: "1px solid " + TH.border,
          }}>
            Recent activity (most recent first, last {tail.length} of {events.length})
          </div>
          {tail.map(function(e, i) {
            const summary = summarizeEvent(e);
            const ageS = Math.round((Date.now() - (e.ts || Date.now())) / 1000);
            const ageLabel = ageS < 60 ? (ageS + "s ago") : (Math.floor(ageS / 60) + "m " + (ageS % 60) + "s ago");
            const typeColor = e.type === "llm" ? TH.blue
              : e.type === "cli" ? TH.accent
              : e.type === "skill" ? TH.orange
              : e.type === "state" ? TH.text2
              : TH.text3;
            return (
              <div key={i} style={{
                padding: "5px 14px",
                borderTop: i === 0 ? "none" : "1px solid " + TH.border,
                display: "flex", alignItems: "center", gap: 10,
                fontSize: 10,
              }}>
                <span style={{
                  fontSize: 8, padding: "1px 5px", borderRadius: 2,
                  background: TH.bg1, border: "1px solid " + typeColor,
                  color: typeColor, fontFamily: TH.fontMono, fontWeight: 600,
                  minWidth: 36, textAlign: "center",
                }}>
                  {e.type}
                </span>
                <span style={{
                  flex: 1, color: TH.text1, fontFamily: TH.fontMono,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {summary.headline}
                </span>
                {summary.detail && (
                  <span style={{ color: TH.text3, fontFamily: TH.fontMono, fontSize: 9 }}>
                    {summary.detail}
                  </span>
                )}
                <span style={{ color: TH.text3, fontFamily: TH.fontMono, fontSize: 9, minWidth: 60, textAlign: "right" }}>
                  {ageLabel}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Collapsed-side sidebar pill ──────────────────────────────────────
//
// When a stage completes (data arrives), the live panel auto-collapses
// to this small pill on the right edge of the stage content area.
// Click to re-expand.
export function LiveProgressCollapsedPill({ stageId, progress, onExpand }) {
  const llm = (progress && progress.llmCount) || 0;
  const cli = (progress && progress.cliCount) || 0;
  const events = (progress && progress.events) || [];
  if (events.length === 0) return null;
  return (
    <button
      onClick={onExpand}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "4px 10px",
        background: TH.bg1, border: "1px solid " + TH.border,
        color: TH.text2, fontSize: 10, fontFamily: TH.fontMono,
        borderRadius: 3, cursor: "pointer",
      }}
      title="Show in-flight activity that occurred during this run"
    >
      <span style={{ fontSize: 8, color: TH.accent }}>▸</span>
      Live activity ({events.length} events, {llm} LLM, {cli} CLI)
    </button>
  );
}
