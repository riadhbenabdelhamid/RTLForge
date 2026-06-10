// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// metricsTabs — Duration + Tokens panels for JudgeStage
//
// Two distinct tabs, deliberately styled differently per the user's
// answer to "should they share the same visual style?":
//
//   Duration tab → orange accent palette (warm, time-themed)
//   Tokens tab   → blue accent palette (cool, data-themed)
//
// Both read from the same buildRunMetrics() helper, but each emphasizes
// different fields. The pie charts use distinct color sequences so a
// user glancing at one screen can tell which one they're looking at.
//
// METHODOLOGY NOTES (rendered as footers in each tab):
//
//   Duration:
//     • Per-call timestamps: callLLM records Date.now() at HTTP request
//       issue (startedAtMs) and at response completion (endedAtMs).
//     • Per-call duration: performance.now() monotonic delta, immune to
//       wall-clock adjustments.
//     • Overall: uses the wall-clock window (earliest start → latest
//       end) when both ends are known. Falls back to a sum of monotonic
//       durations when timestamps are missing (e.g. legacy CLI runs).
//
//   Tokens:
//     • Reported VERBATIM from provider telemetry (tokensIn, tokensOut)
//       in the API response.
//     • For Anthropic: cache_read_input_tokens and cache_creation_input_tokens
//       are summed into the input total so prompt-caching doesn't show
//       as "0 input tokens".
//     • When a call lacks provider telemetry (rare; some misconfigured
//       LM Studio / Ollama setups, certain proxies), the value renders
//       as "—" and the run shows an explicit "telemetry incomplete"
//       warning. We do NOT fabricate counts via char/4 estimation —
//       in this tool, token counts are either real or absent.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from "react";
import { TH } from "../../constants/theme.js";
import { Tag } from "./atoms.jsx";
import {
  buildRunMetrics, fmtDuration, fmtTime, fmtTokens,
  durationPalette, tokenPalette, rampPalette,
} from "./runMetrics.js";
import { ALL_STAGES } from "../../constants/stages.js";

// Default visible stages, in pipeline order. The Duration/Tokens tabs
// filter buildRunMetrics output to this list so optional stages (e.g.
// formal_props when disabled) don't appear with blank rows.
const STAGE_DESCRIPTORS = ALL_STAGES.map(function(s) {
  return { id: s.id, key: s.key, label: s.label };
});

// ─── Pie chart ──────────────────────────────────────────────────────────
// Lightweight SVG pie. Takes an array of {label, value, color} and
// renders proportional wedges. No external deps. Labels render
// alongside in a legend column.
function PieChart({ slices, total, accentColor, size }) {
  const r = size / 2;
  const cx = r, cy = r;
  let cumAngle = -Math.PI / 2;  // 12 o'clock start
  const totalSafe = total > 0 ? total : 1;
  const paths = slices.map(function(s, i) {
    const angle = (s.value / totalSafe) * 2 * Math.PI;
    const x0 = cx + r * Math.cos(cumAngle);
    const y0 = cy + r * Math.sin(cumAngle);
    const x1 = cx + r * Math.cos(cumAngle + angle);
    const y1 = cy + r * Math.sin(cumAngle + angle);
    const largeArc = angle > Math.PI ? 1 : 0;
    const d = (s.value > 0)
      ? "M " + cx + " " + cy +
        " L " + x0.toFixed(2) + " " + y0.toFixed(2) +
        " A " + r + " " + r + " 0 " + largeArc + " 1 " +
                x1.toFixed(2) + " " + y1.toFixed(2) +
        " Z"
      : null;
    cumAngle += angle;
    return { d: d, color: s.color, key: "wedge-" + i };
  });
  return (
    <svg width={size} height={size} viewBox={"0 0 " + size + " " + size}>
      {paths.map(function(p) {
        return p.d
          ? <path key={p.key} d={p.d} fill={p.color} stroke={TH.bg0} strokeWidth={1} />
          : null;
      })}
      {total === 0 && (
        <circle cx={cx} cy={cy} r={r - 2} fill="none" stroke={TH.border} strokeDasharray="3,3" strokeWidth={1} />
      )}
    </svg>
  );
}

// Color palettes follow a dark→light ramp tied to the value's rank: the
// smallest slice gets the darkest shade, the
// largest gets the lightest. This makes the pie chart visually
// communicate magnitude even before reading the legend numbers.
//
// rampPalette + durationPalette + tokenPalette are imported from
// runMetrics.js to keep the helper module self-contained and unit-
// testable from .mjs verifiers (which can't import .jsx files).

// ═══════════════════════════════════════════════════════════════════════
// DurationTab
// ═══════════════════════════════════════════════════════════════════════
export function DurationTab({ stageData }) {
  const metrics = buildRunMetrics(stageData, STAGE_DESCRIPTORS);
  const { stages, overall } = metrics;

  if (stages.length === 0) {
    return (
      <div style={emptyState()}>
        No LLM calls captured yet for this run.
      </div>
    );
  }

  const durationValues = stages.map(function(s) { return s.total.durationMs; });
  const colors = durationPalette(durationValues);
  const slices = stages.map(function(s, i) {
    return { label: s.label, value: s.total.durationMs, color: colors[i] };
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: "16px 4px" }}>
      {/* ── Headline ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16,
        padding: 14,
        background: TH.bg0, border: "1px solid " + TH.orange, borderRadius: 6,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontSize: 28, fontWeight: 800, color: TH.orange, fontFamily: TH.fontD }}>
            {fmtDuration(overall.durationMs)}
          </span>
          <span style={{ fontSize: 10, color: TH.text2 }}>total elapsed</span>
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: TH.text2 }}>
          {overall.calls} LLM calls across {stages.length} stages
          {overall.durationMethod === "monotonic-sum" && (
            <Tag color={TH.yellow} bg={TH.yellowDim}>cumulative (no wall-clock)</Tag>
          )}
        </div>
      </div>

      {/* ── Pie + legend ── */}
      <div style={{
        display: "flex", gap: 18, alignItems: "flex-start",
        background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6, padding: 14,
      }}>
        <PieChart slices={slices} total={overall.cumulativeDurationMs} accentColor={TH.orange} size={180} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 9, color: TH.text3, fontWeight: 700,
            textTransform: "uppercase", letterSpacing: 1, marginBottom: 8,
          }}>
            Time per stage
          </div>
          {stages.map(function(s, i) {
            const pct = overall.cumulativeDurationMs > 0
              ? (s.total.durationMs / overall.cumulativeDurationMs) * 100 : 0;
            return (
              <div key={s.key} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "3px 0",
                fontSize: 11,
              }}>
                <span style={{
                  width: 12, height: 12, borderRadius: 2,
                  background: colors[i], flexShrink: 0,
                }} />
                <span style={{ color: TH.text0, fontWeight: 600, minWidth: 100 }}>
                  {s.label}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: TH.fontMono, color: TH.text1 }}>
                  {fmtDuration(s.total.durationMs)}
                </span>
                <span style={{ fontFamily: TH.fontMono, color: TH.text3, minWidth: 50, textAlign: "right" }}>
                  {pct.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Per-call drill-down table ── */}
      <div style={{ background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6, overflow: "hidden" }}>
        <div style={{
          padding: "8px 14px", background: TH.bg1,
          borderBottom: "1px solid " + TH.border,
          fontSize: 9, color: TH.text3, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: 1,
        }}>
          Per-call breakdown
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: TH.fontMono }}>
          <thead>
            <tr style={{ background: TH.bg1 }}>
              <th style={dTh()}>Stage</th>
              <th style={dTh()}>Iter / Round</th>
              <th style={dTh()}>Start</th>
              <th style={dTh()}>End</th>
              <th style={dThR()}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {stages.map(function(s) {
              return s.calls.map(function(c, idx) {
                return (
                  <tr key={s.key + "-" + idx} style={{ borderTop: "1px solid " + TH.border }}>
                    <td style={dTd()}>
                      <span style={{ color: TH.text0, fontWeight: idx === 0 ? 700 : 400 }}>
                        {idx === 0 ? s.label : ""}
                      </span>
                    </td>
                    <td style={dTd()}>
                      <span style={{ color: TH.text1 }}>
                        {c.stage}{c.iter != null ? " · iter " + c.iter : ""}
                      </span>
                    </td>
                    <td style={dTd()}>{fmtTime(c.startedAtMs)}</td>
                    <td style={dTd()}>{fmtTime(c.endedAtMs)}</td>
                    <td style={dTdR()}>{fmtDuration(c.durationMs)}</td>
                  </tr>
                );
              });
            })}
          </tbody>
          <tfoot>
            <tr style={{ background: TH.bg1, fontWeight: 700 }}>
              <td style={dTd()} colSpan={4}>TOTAL ELAPSED</td>
              <td style={dTdR()}>{fmtDuration(overall.durationMs)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ── Methodology footer ── */}
      <div style={methodologyFooter()}>
        <strong style={{ color: TH.orange }}>How timing is measured</strong>
        <div style={{ marginTop: 4, lineHeight: 1.5 }}>
          • <strong>Start / End</strong> are wall-clock timestamps captured by
          callLLM using <code>Date.now()</code> at HTTP request issue and at
          response completion. They reflect when the request actually left
          the client and when the last byte arrived.<br />
          • <strong>Duration</strong> is the per-call <code>performance.now()</code>
          monotonic delta — immune to system-clock adjustments and the
          most accurate single-call measurement.<br />
          • <strong>Total elapsed</strong>: uses the wall-clock window
          (earliest start → latest end) when all calls have timestamps.
          Falls back to the sum of monotonic durations when wall-clock
          data is unavailable (shown with a "cumulative" tag above).<br />
          • Streaming calls record start at the first request byte sent and
          end when the stream's final chunk arrives.
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TokensTab
// ═══════════════════════════════════════════════════════════════════════
export function TokensTab({ stageData }) {
  const metrics = buildRunMetrics(stageData, STAGE_DESCRIPTORS);
  const { stages, overall } = metrics;

  if (stages.length === 0) {
    return (
      <div style={emptyState()}>
        No LLM calls captured yet for this run.
      </div>
    );
  }

  // Each pie ranks by its own values so the darkest shade always lands on the
  // smallest slice in each chart.
  const tokensInValues  = stages.map(function(s) { return s.total.tokensIn  || 0; });
  const tokensOutValues = stages.map(function(s) { return s.total.tokensOut || 0; });
  const colorsIn  = tokenPalette(tokensInValues);
  const colorsOut = tokenPalette(tokensOutValues);
  const slicesIn  = stages.map(function(s, i) { return { label: s.label, value: s.total.tokensIn,  color: colorsIn[i]  }; });
  const slicesOut = stages.map(function(s, i) { return { label: s.label, value: s.total.tokensOut, color: colorsOut[i] }; });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: "16px 4px" }}>
      {/* ── Headline ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 24,
        padding: 14,
        background: TH.bg0, border: "1px solid " + TH.blue, borderRadius: 6,
      }}>
        <div>
          <div style={{ fontSize: 9, color: TH.text3, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
            Input
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 4 }}>
            <span style={{ fontSize: 22, fontWeight: 800, color: TH.blue, fontFamily: TH.fontD }}>
              {fmtTokens(overall.tokensIn)}
            </span>
            <span style={{ fontSize: 10, color: TH.text2 }}>tokens</span>
          </div>
        </div>
        <div style={{ width: 1, alignSelf: "stretch", background: TH.border }} />
        <div>
          <div style={{ fontSize: 9, color: TH.text3, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
            Output
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 4 }}>
            <span style={{ fontSize: 22, fontWeight: 800, color: TH.accent, fontFamily: TH.fontD }}>
              {fmtTokens(overall.tokensOut)}
            </span>
            <span style={{ fontSize: 10, color: TH.text2 }}>tokens</span>
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: TH.text2 }}>
          {overall.calls} LLM calls
          {overall.anyMissing && (
            <Tag color={TH.yellow} bg={TH.yellowDim}>
              {overall.callsMissing}/{overall.calls} missing telemetry
            </Tag>
          )}
        </div>
      </div>

      {/* ── Two pie charts side by side ── */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12,
      }}>
        <PiePanel
          title="Input tokens per stage"
          slices={slicesIn}
          total={overall.tokensIn}
          stages={stages}
          colors={colorsIn}
          color={TH.blue}
          kind="in"
        />
        <PiePanel
          title="Output tokens per stage"
          slices={slicesOut}
          total={overall.tokensOut}
          stages={stages}
          colors={colorsOut}
          color={TH.accent}
          kind="out"
        />
      </div>

      {/* ── Per-call drill-down table ── */}
      <div style={{ background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6, overflow: "hidden" }}>
        <div style={{
          padding: "8px 14px", background: TH.bg1,
          borderBottom: "1px solid " + TH.border,
          fontSize: 9, color: TH.text3, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: 1,
        }}>
          Per-call breakdown
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: TH.fontMono }}>
          <thead>
            <tr style={{ background: TH.bg1 }}>
              <th style={dTh()}>Stage</th>
              <th style={dTh()}>Iter / Round</th>
              <th style={dTh()}>Model</th>
              <th style={dThR()}>Tokens In</th>
              <th style={dThR()}>Tokens Out</th>
            </tr>
          </thead>
          <tbody>
            {stages.map(function(s) {
              return s.calls.map(function(c, idx) {
                return (
                  <tr key={s.key + "-" + idx} style={{ borderTop: "1px solid " + TH.border }}>
                    <td style={dTd()}>
                      <span style={{ color: TH.text0, fontWeight: idx === 0 ? 700 : 400 }}>
                        {idx === 0 ? s.label : ""}
                      </span>
                    </td>
                    <td style={dTd()}>
                      <span style={{ color: TH.text1 }}>
                        {c.stage}{c.iter != null ? " · iter " + c.iter : ""}
                      </span>
                    </td>
                    <td style={dTd()}>
                      <span style={{ color: TH.text2 }}>{c.model || "—"}</span>
                    </td>
                    <td style={dTdR()}>{fmtTokens(c.tokensIn)}</td>
                    <td style={dTdR()}>{fmtTokens(c.tokensOut)}</td>
                  </tr>
                );
              });
            })}
          </tbody>
          <tfoot>
            <tr style={{ background: TH.bg1, fontWeight: 700 }}>
              <td style={dTd()} colSpan={3}>TOTAL</td>
              <td style={dTdR()}>{fmtTokens(overall.tokensIn)}</td>
              <td style={dTdR()}>{fmtTokens(overall.tokensOut)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ── Methodology footer ── */}
      <div style={methodologyFooter()}>
        <strong style={{ color: TH.blue }}>How tokens are counted</strong>
        <div style={{ marginTop: 4, lineHeight: 1.5 }}>
          • <strong>Provider telemetry only</strong>: numbers come directly
          from each LLM provider's <code>usage</code> response — never
          estimated. Anthropic, OpenAI, and Groq always return them.<br />
          • <strong>Anthropic prompt caching</strong>: when caching is in
          use, the input total sums <code>input_tokens</code> +{" "}
          <code>cache_read_input_tokens</code> +{" "}
          <code>cache_creation_input_tokens</code> so cached prompts don't
          appear as 0 input.<br />
          • <strong>Missing telemetry</strong>: if a provider omits the
          usage block (rare; some misconfigured local proxies), that call
          renders as "—" rather than an estimated number. This tool does
          not fabricate counts via char/token heuristics — they're
          tokenizer-dependent and routinely 10-40% wrong.<br />
          {overall.anyMissing && (
            <span style={{ color: TH.yellow }}>
              • Telemetry incomplete: {overall.callsMissing} of{" "}
              {overall.calls} call(s) didn't return usage data. Stage
              and run totals above reflect only the calls that did report.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function PiePanel({ title, slices, total, stages, colors, color, kind }) {
  return (
    <div style={{
      background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6, padding: 14,
    }}>
      <div style={{
        fontSize: 9, color: color, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: 1, marginBottom: 10,
      }}>
        {title}
      </div>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
        <PieChart slices={slices} total={total} accentColor={color} size={140} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {stages.map(function(s, i) {
            const v = kind === "in" ? s.total.tokensIn : s.total.tokensOut;
            const pct = total > 0 ? (v / total) * 100 : 0;
            return (
              <div key={s.key} style={{
                display: "flex", alignItems: "center", gap: 6, padding: "2px 0",
                fontSize: 10,
              }}>
                <span style={{
                  width: 10, height: 10, borderRadius: 2,
                  background: colors[i], flexShrink: 0,
                }} />
                <span style={{ color: TH.text0, fontWeight: 600, minWidth: 78 }}>
                  {s.label}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: TH.fontMono, color: TH.text1 }}>
                  {fmtTokens(v)}
                </span>
                <span style={{ fontFamily: TH.fontMono, color: TH.text3, minWidth: 40, textAlign: "right" }}>
                  {pct.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── shared style snippets ─────────────────────────────────────────────
function dTh() {
  return {
    padding: "6px 14px", textAlign: "left",
    fontSize: 9, color: TH.text3, fontWeight: 700,
    textTransform: "uppercase", letterSpacing: 1,
  };
}
function dThR() { return Object.assign(dTh(), { textAlign: "right" }); }
function dTd() {
  return {
    padding: "5px 14px", color: TH.text1, fontFamily: TH.fontMono, fontSize: 11,
  };
}
function dTdR() { return Object.assign(dTd(), { textAlign: "right" }); }
function emptyState() {
  return {
    padding: 24, textAlign: "center",
    color: TH.text2, fontSize: 12, fontStyle: "italic",
    background: TH.bg0, border: "1px dashed " + TH.border, borderRadius: 6,
    margin: "16px 4px",
  };
}
function methodologyFooter() {
  return {
    fontSize: 10, color: TH.text2,
    padding: "10px 14px",
    background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TraceTab — Hierarchical execution trace
//
// Renders a structured walk through the pipeline run: every stage shown
// in pipeline order, each stage expandable to reveal its internal
// iterations, and judge iterations annotated with WHY they fired (the
// triage decision: spec / rtl / tb / verify, plus the failing criteria
// that drove that decision).
//
// Data sources:
//   • stageData[id]._llms              — per-stage LLM-call ledger
//                                        (provides timing for each call)
//   • stageData[9].judgeHistory[]      — judge iteration records with
//                                        triageTarget + failing criteria
//
// Visual model (color-coded for skim-ability):
//   • Stage row     — pipeline-blue accent
//   • Iteration row — indented under its parent stage, neutral
//   • Reason row    — indented yellow background, italic; only present
//                     for entries that have a triage decision attached
//
// User feedback principle from the spec: "cleanly reported so it is
// easy to understand and follow." Hence:
//   • Indentation makes the tree visually obvious without ASCII art
//   • Reasons are FIRST-CLASS rows (not tooltips) so they read inline
//   • Status pills on each row let the user scan PASS/FAIL/loop-back
// ═══════════════════════════════════════════════════════════════════════
export function TraceTab({ data, stageData, onSelectRun }) {
  const judgeHistory = (data && Array.isArray(data.judgeHistory)) ? data.judgeHistory : [];

  // Flatten toggle. When ON, all nested chain entries are flattened into a
  // single linear sequence (handy when
  // the recursion is deep and the user wants to scan call order).
  // When OFF (default), each chain entry renders as a nested sub-row
  // under its owning iteration so the hierarchy is visible.
  const [flatten, setFlatten] = useState(false);

  // Build per-stage entries from stageData. Order follows STAGE_DESCRIPTORS
  // (pipeline order), so the user reads top-to-bottom matching run order.
  const events = [];
  for (const sd of STAGE_DESCRIPTORS) {
    const result = stageData ? stageData[sd.id] : null;
    if (!result) continue;
    const llms = Array.isArray(result._llms)
      ? result._llms
      : (result._llm ? [result._llm] : []);
    if (llms.length === 0) continue;

    // Group LLM calls by iter / sub-stage label. We treat the FIRST
    // call as the stage's primary execution and subsequent calls as
    // internal iterations or fix-loop rounds. The `stage` field on
    // each _llms entry carries human-readable labels like
    // "lint-iter1", "rtl-fix-iter1", "judge-triage-2".
    const stageEvent = {
      kind: "stage",
      id: sd.id,
      key: sd.key,
      label: sd.label,
      // Pull a status from the stage's result. Different stages express
      // status differently — we cover the common cases.
      status: deriveStageStatus(sd.key, result),
      startedAtMs: null,
      endedAtMs: null,
      iterations: [],
      // Attach the stage's chain history (if any) so the renderer can show
      // nested K-to-X reflow recursions.
      chain: result._chain || null,
    };
    llms.forEach(function(c) {
      if (c.startedAtMs != null && (stageEvent.startedAtMs == null || c.startedAtMs < stageEvent.startedAtMs)) {
        stageEvent.startedAtMs = c.startedAtMs;
      }
      if (c.endedAtMs != null && (stageEvent.endedAtMs == null || c.endedAtMs > stageEvent.endedAtMs)) {
        stageEvent.endedAtMs = c.endedAtMs;
      }
      stageEvent.iterations.push({
        kind: "iter",
        label: c.stage || sd.key,
        startedAtMs: c.startedAtMs,
        endedAtMs: c.endedAtMs,
        durationMs: c.latencyMs || 0,
        tokensIn: c.tokensIn || 0,
        tokensOut: c.tokensOut || 0,
        model: c.model || "",
        // These stamps were added by reflowRunner. They let us identify which
        // chain (and which iteration of the
        // chain's owner) this LLM call belongs to.
        _depth: c._depth || 0,
        _parentStageKey: c._parentStageKey || null,
        _parentIter: c._parentIter || null,
      });
    });
    // Special: judge stage carries the iteration history (with reasons)
    if (sd.key === "judge" && judgeHistory.length > 0) {
      // Re-walk the iterations array and annotate each with reason
      // from judgeHistory. We pair them by iter number embedded in the
      // stage string ("judge-triage-<N>", etc.).
      stageEvent.judgeHistory = judgeHistory;
      // Judge stores chain history per-iteration (each historyEntry._chain is a
      // flat array of entries). Combine
      // them into a passes shape so TraceChainBlock can render
      // "judge-iter-N · N entries" rows.
      const judgePasses = [];
      for (const h of judgeHistory) {
        if (h._chain && h._chain.length > 0) {
          judgePasses.push({
            iter:    h.iter,
            mode:    h._reflowMode || "smart",
            entries: h._chain,
          });
        }
      }
      if (judgePasses.length > 0) {
        stageEvent.chain = judgePasses;
      }
    }
    events.push(stageEvent);
  }

  if (events.length === 0) {
    return (
      <div style={emptyState()}>
        No execution events captured yet for this run.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "16px 4px" }}>
      {/* Header strip */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: 12,
        background: TH.bg0, border: "1px solid " + TH.accent, borderRadius: 6,
      }}>
        <span style={{ fontSize: 9, color: TH.text3, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
          Execution Trace
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: TH.text2 }}>
          {events.length} stages · {events.reduce(function(a, e) { return a + e.iterations.length; }, 0)} LLM calls
          {judgeHistory.length > 0 && (
            <span> · {judgeHistory.length} judge iteration{judgeHistory.length === 1 ? "" : "s"}</span>
          )}
        </span>
        {/* flatten toggle */}
        <button
          onClick={function() { setFlatten(function(f) { return !f; }); }}
          style={{
            fontSize: 10, padding: "4px 10px",
            background: flatten ? TH.accent : TH.bg1,
            color: flatten ? TH.bg0 : TH.text1,
            border: "1px solid " + TH.accent,
            borderRadius: 3, cursor: "pointer",
            fontFamily: TH.fontMono, fontWeight: 600,
          }}
          title={flatten
            ? "Hierarchical: chain entries shown nested under their owner iteration"
            : "Flat: every LLM call shown in time order, no nesting"
          }
        >
          {flatten ? "FLAT" : "TREE"}
        </button>
      </div>

      {/* Trace tree */}
      <div style={{
        background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
        padding: 0, overflow: "hidden",
      }}>
        {events.map(function(ev, idx) {
          return <TraceStageRow key={ev.key + "-" + idx} stage={ev} flatten={flatten} onSelectRun={onSelectRun} />;
        })}
      </div>

      {/* Legend */}
      <div style={{
        fontSize: 10, color: TH.text2,
        padding: "10px 14px",
        background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4,
      }}>
        <strong style={{ color: TH.accent }}>How to read this trace</strong>
        <div style={{ marginTop: 4, lineHeight: 1.5 }}>
          • Each <strong>stage</strong> is one row at the top level.
          Click to collapse/expand its internal iterations.<br />
          • <strong>Iterations</strong> appear indented under their stage.
          For Lint, Verify, and Review stages, multiple iterations mean
          the stage looped back internally (e.g. lint→fix→re-lint).<br />
          • <strong>Judge iterations</strong> show the eval verdict that
          drove the loop-back PLUS the triage decision (which earlier
          stage was selected for re-run) and the reason the gate
          rejected this iteration's output.<br />
          • Timestamps come from <code>Date.now()</code> at LLM request
          issue / response receipt (same wall-clock source as the
          Duration tab).
        </div>
      </div>
    </div>
  );
}

function TraceStageRow({ stage, flatten, onSelectRun }) {
  // Stages open-by-default for the user's main loop areas; closed for
  // single-call stages to reduce clutter.
  const defaultOpen = /^(lint|lint_test|verify|judge|rtl_review|test_review)$/.test(stage.key);
  const [open, setOpen] = useState(defaultOpen);
  // When NOT flattened, separate "own" iterations (LLM calls made by this stage
  // directly) from "chain-derived" ones
  // (calls that happened inside a K-to-X chain run by this stage).
  // Chain-derived rows are rendered nested under their owning chain
  // entry instead of as flat siblings.
  const ownIters    = flatten ? stage.iterations : stage.iterations.filter(function(it) { return (it._depth || 0) === 0; });
  const chainIters  = flatten ? []                : stage.iterations.filter(function(it) { return (it._depth || 0) > 0; });
  const hasIters    = ownIters.length > 0 || (stage.chain && stage.chain.length > 0);
  const dur = (stage.endedAtMs && stage.startedAtMs)
    ? (stage.endedAtMs - stage.startedAtMs) : null;

  // Color the status pill based on status kind. Default is neutral.
  const statusColor = stage.status && /(?:FAIL|fail)/.test(stage.status) ? TH.red
    : (stage.status && /(?:PASS|pass)/.test(stage.status) ? TH.accent : TH.text2);

  return (
    <div style={{ borderTop: "1px solid " + TH.border }}>
      <div
        onClick={function() { if (hasIters) setOpen(function(o) { return !o; }); }}
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 14px",
          background: TH.bg1,
          cursor: hasIters ? "pointer" : "default",
        }}
      >
        <span style={{ width: 12, fontSize: 10, color: TH.text2 }}>
          {hasIters ? (open ? "▾" : "▸") : "•"}
        </span>
        <span style={{
          color: TH.blue, fontWeight: 700, fontFamily: TH.fontD, fontSize: 12,
          minWidth: 130,
        }}>
          {stage.label}
        </span>
        {stage.status && (
          <span style={{
            fontSize: 9, padding: "1px 6px", borderRadius: 3,
            background: TH.bg0, border: "1px solid " + statusColor,
            color: statusColor, fontWeight: 700,
          }}>{stage.status}</span>
        )}
        {hasIters && (
          <span style={{ fontSize: 10, color: TH.text3 }}>
            {stage.iterations.length} call{stage.iterations.length === 1 ? "" : "s"}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {dur != null && (
          <span style={{ fontSize: 10, color: TH.text2, fontFamily: TH.fontMono }}>
            {fmtDuration(dur)}
          </span>
        )}
        {stage.startedAtMs != null && (
          <span style={{ fontSize: 9, color: TH.text3, fontFamily: TH.fontMono }}>
            {fmtTime(stage.startedAtMs)}
          </span>
        )}
      </div>
      {open && hasIters && (
        <div style={{ background: TH.bg0 }}>
          {ownIters.map(function(it, i) {
            // For judge, attach the matching history entry's reason
            const judgeMeta = stage.judgeHistory
              ? matchJudgeMeta(it.label, stage.judgeHistory)
              : null;
            return (
              <TraceIterRow
                key={"own-" + i}
                iter={it}
                iterIdx={i}
                isFirstStage={i === 0}
                judgeMeta={judgeMeta}
              />
            );
          })}
          {/* chain-derived iterations from K-to-X reflows */}
          {!flatten && stage.chain && stage.chain.length > 0 && (
            <TraceChainBlock chain={stage.chain} ownerKey={stage.key} chainIters={chainIters} depth={1} onSelectRun={onSelectRun} />
          )}
          {/* In flatten mode, chain-derived iters were already merged into ownIters above */}
        </div>
      )}
    </div>
  );
}

// ─── TraceChainBlock ───────────────────────────────────────────────────
//
// Renders a stage's _chain array as nested expandable rows under that
// stage's main iteration list. Each chain pass (one entry of the
// outer array) contains an `entries` field listing what sub-stages
// ran, plus per-entry events that may themselves contain further-
// nested chain calls (those carry _depth > current).
//
// For judge.judgeHistory, the chain field on each history entry is a
// flat list (no iter/mode wrapper), so we adapt: if the chain looks
// like `[{stageKey, reason, status, ...}, ...]` we treat it as a single
// pass. If it looks like `[{iter, mode, entries: [...]}, ...]` (lint/
// verify/review shape) we render one block per pass.
//
// The `depth` prop controls indentation; recursive calls increment it
// when entries themselves carry their own chain history.
function TraceChainBlock({ chain, ownerKey, chainIters, depth, onSelectRun }) {
  // Detect shape: judge passes a flat array of {stageKey, ...} entries;
  // lint/verify/review pass {iter, mode, entries: [...]}.
  const passes = (chain.length > 0 && chain[0].entries)
    ? chain
    : [{ iter: 1, mode: "smart", entries: chain }];
  return (
    <>
      {passes.map(function(pass, pi) {
        return (
          <TraceChainPass
            key={"chain-" + pi}
            pass={pass}
            passIdx={pi}
            ownerKey={ownerKey}
            chainIters={chainIters}
            depth={depth}
            onSelectRun={onSelectRun}
          />
        );
      })}
    </>
  );
}

function TraceChainPass({ pass, passIdx, ownerKey, chainIters, depth, onSelectRun }) {
  const [open, setOpen] = useState(true);
  const entries = pass.entries || [];
  const indent = 24 + depth * 16;
  return (
    <div>
      <div
        onClick={function() { setOpen(function(o) { return !o; }); }}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 14px 6px " + indent + "px",
          background: TH.bg1,
          borderTop: "1px solid " + TH.border,
          cursor: "pointer",
        }}
        title="K-to-X reflow chain — click to expand/collapse"
      >
        <span style={{ fontSize: 10, color: TH.orange }}>
          {open ? "▾" : "▸"}
        </span>
        <span style={{
          fontSize: 9, padding: "1px 6px", borderRadius: 3,
          background: TH.bg0, border: "1px solid " + TH.orange,
          color: TH.orange, fontWeight: 700, fontFamily: TH.fontMono,
        }}>
          REFLOW
        </span>
        <span style={{ fontSize: 10, color: TH.text2, fontFamily: TH.fontMono }}>
          {ownerKey}-iter-{pass.iter || passIdx + 1} · {pass.mode || "smart"} mode · {entries.length} entries
        </span>
      </div>
      {open && (
        <div>
          {entries.map(function(entry, ei) {
            // Find the matching chain-derived LLM iter for this entry
            // (by stageKey + parentIter); each entry may have ≥1 LLM
            // calls if the sub-stage emitted multiple.
            const matchedIters = (chainIters || []).filter(function(it) {
              return it._parentStageKey === ownerKey
                && it._parentIter === (pass.iter || passIdx + 1)
                && new RegExp("^" + entry.stageKey + "@").test(it.label);
            });
            return (
              <TraceChainEntry
                key={"entry-" + ei}
                entry={entry}
                entryIdx={ei}
                matchedIters={matchedIters}
                depth={depth + 1}
                onSelectRun={onSelectRun}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function TraceChainEntry({ entry, entryIdx, matchedIters, depth, onSelectRun }) {
  const [open, setOpen] = useState(true);
  const hasNested = matchedIters && matchedIters.length > 0;
  const indent = 24 + depth * 16;
  // Reason → color
  const reasonColor = entry.reason === "triage"     ? TH.orange
    : entry.reason === "always"     ? TH.accent
    : entry.reason === "downstream" ? TH.text1
    : entry.reason === "skipped"    ? TH.text3
    : entry.reason === "error"      ? TH.red
    : TH.text2;
  return (
    <div>
      <div
        onClick={function() { if (hasNested) setOpen(function(o) { return !o; }); }}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "5px 14px 5px " + indent + "px",
          borderTop: entryIdx > 0 ? "1px solid " + TH.border : "none",
          cursor: hasNested ? "pointer" : "default",
          background: entry.status === "skipped" ? "rgba(128,128,128,0.04)"
            : entry.status === "error"   ? "rgba(255,80,80,0.06)"
            : "transparent",
        }}
      >
        <span style={{ width: 10, fontSize: 9, color: TH.text3 }}>
          {hasNested ? (open ? "▾" : "▸") : "•"}
        </span>
        <span style={{
          fontSize: 9, padding: "1px 5px", borderRadius: 3,
          background: TH.bg0, border: "1px solid " + reasonColor,
          color: reasonColor, fontFamily: TH.fontMono, fontWeight: 600,
          minWidth: 70, textAlign: "center",
        }}>
          {entry.reason}
        </span>
        <span style={{
          fontSize: 11, color: TH.text1, fontFamily: TH.fontMono,
          minWidth: 130,
        }}>
          {entry.stageKey}
        </span>
        <span style={{
          fontSize: 9, padding: "1px 5px", borderRadius: 3,
          background: TH.bg0,
          border: "1px solid " + (entry.status === "ran" ? TH.accent
            : entry.status === "skipped" ? TH.text3
            : entry.status === "error"   ? TH.red
            : TH.text2),
          color: entry.status === "ran" ? TH.accent
            : entry.status === "skipped" ? TH.text3
            : entry.status === "error"   ? TH.red
            : TH.text2,
          fontFamily: TH.fontMono,
        }}>
          {entry.status || "?"}
        </span>
        <span style={{ flex: 1 }} />
        {/* Navigate to this specific run.
            Visible when:
              • the entry has a runId stamped by the runner (chain
                entries that succeeded; null means publish was unwired
                or the entry was skipped/errored without recording)
              • the entry has a numeric stageId
              • a navigation callback is wired (onSelectRun)
            Clicking writes the selection into the shared
            selectedRunByMod state, which both the stage panel's
            dropdown and the trace tab observe. */}
        {typeof onSelectRun === "function"
          && entry.runId != null
          && typeof entry.stageId === "number" && (
          <button
            onClick={function(e) {
              e.stopPropagation();  // don't toggle expand/collapse
              onSelectRun(entry.stageId, entry.runId);
            }}
            style={{
              padding: "2px 8px", fontSize: 9,
              background: TH.bg0, color: TH.accent,
              border: "1px solid " + TH.accent, borderRadius: 3,
              cursor: "pointer", fontFamily: TH.fontMono, fontWeight: 600,
            }}
            title={"View this run's snapshot in the stage panel (runId " + entry.runId + ")"}
          >
            OPEN ↗
          </button>
        )}
        {entry.llmCount > 0 && (
          <span style={{ fontSize: 9, color: TH.text3, fontFamily: TH.fontMono }}>
            {entry.llmCount} LLM
          </span>
        )}
        {entry.durationMs > 0 && (
          <span style={{ fontSize: 10, color: TH.text2, fontFamily: TH.fontMono, minWidth: 60, textAlign: "right" }}>
            {fmtDuration(entry.durationMs)}
          </span>
        )}
      </div>
      {entry.error && (
        <div style={{
          padding: "4px 14px 6px " + (indent + 20) + "px",
          fontSize: 10, color: TH.red, fontFamily: TH.fontMono, fontStyle: "italic",
        }}>
          ⚠ {entry.error}
        </div>
      )}
      {/* Nested LLM calls from this entry (the chain-derived iters that
          came from running this stage as part of the chain). */}
      {open && hasNested && (
        <div>
          {matchedIters.map(function(it, i) {
            return (
              <TraceNestedIterRow
                key={"nested-" + i}
                iter={it}
                indent={indent + 16}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function TraceNestedIterRow({ iter, indent }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "4px 14px 4px " + indent + "px",
      borderTop: "1px dotted " + TH.border,
    }}>
      <span style={{ fontSize: 9, color: TH.text3 }}>→</span>
      <span style={{
        fontSize: 10, color: TH.text1, fontFamily: TH.fontMono,
        minWidth: 200,
      }}>
        {iter.label}
      </span>
      {iter.model && (
        <span style={{ fontSize: 9, color: TH.text3, fontFamily: TH.fontMono }}>
          {iter.model}
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 9, color: TH.text2, fontFamily: TH.fontMono }}>
        {iter.tokensIn.toLocaleString()} ↓ / {iter.tokensOut.toLocaleString()} ↑
      </span>
      <span style={{ fontSize: 10, color: TH.text1, fontFamily: TH.fontMono, minWidth: 60, textAlign: "right" }}>
        {fmtDuration(iter.durationMs)}
      </span>
    </div>
  );
}

function TraceIterRow({ iter, iterIdx, isFirstStage, judgeMeta }) {
  // Loop-back detection: stages with "fix" / "regen" / "iter[2+]" in
  // their label re-entered an earlier step or iterated internally.
  const isLoopback = /-(fix|regen)-/.test(iter.label) || /-iter[2-9]/.test(iter.label);
  const labelColor = isLoopback ? TH.orange : TH.text1;

  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "6px 14px 6px 36px",
        borderTop: iterIdx > 0 ? "1px solid " + TH.border : "none",
      }}>
        <span style={{ fontSize: 10, color: isLoopback ? TH.orange : TH.text3 }}>
          {isLoopback ? "↺" : "→"}
        </span>
        <span style={{
          fontSize: 11, color: labelColor, fontFamily: TH.fontMono,
          fontWeight: isLoopback ? 700 : 400,
          minWidth: 200,
        }}>
          {iter.label}
        </span>
        {iter.model && (
          <span style={{ fontSize: 9, color: TH.text3, fontFamily: TH.fontMono }}>
            {iter.model}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: TH.text2, fontFamily: TH.fontMono }}>
          {iter.tokensIn.toLocaleString()} ↓ / {iter.tokensOut.toLocaleString()} ↑
        </span>
        <span style={{ fontSize: 10, color: TH.text1, fontFamily: TH.fontMono, minWidth: 60, textAlign: "right" }}>
          {fmtDuration(iter.durationMs)}
        </span>
        <span style={{ fontSize: 9, color: TH.text3, fontFamily: TH.fontMono, minWidth: 90, textAlign: "right" }}>
          {fmtTime(iter.startedAtMs)}
        </span>
      </div>
      {judgeMeta && (
        <div style={{
          padding: "6px 14px 8px 60px",
          background: TH.yellowDim || "rgba(255, 200, 0, 0.06)",
          borderTop: "1px dashed " + TH.border,
          fontSize: 10, color: TH.text1, fontStyle: "italic",
          lineHeight: 1.5,
        }}>
          <strong style={{ color: TH.yellow }}>Reason:</strong>{" "}
          {judgeMeta.reason || judgeMeta.summary}
          {judgeMeta.triageTarget && (
            <span style={{ marginLeft: 10, fontStyle: "normal" }}>
              <span style={{ color: TH.text3 }}>→ next:</span>{" "}
              <span style={{ color: TH.orange, fontWeight: 700, fontFamily: TH.fontMono }}>
                {judgeMeta.triageTarget}
              </span>
            </span>
          )}
          {judgeMeta.failingIds && judgeMeta.failingIds.length > 0 && (
            <div style={{ marginTop: 4, color: TH.text2, fontStyle: "normal", fontSize: 9 }}>
              Failing criteria: {judgeMeta.failingIds.slice(0, 6).join(", ")}
              {judgeMeta.failingIds.length > 6 ? " (+" + (judgeMeta.failingIds.length - 6) + " more)" : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── tiny helpers ──────────────────────────────────────────────────────

function deriveStageStatus(key, result) {
  if (!result) return null;
  if (key === "lint" || key === "lint_test") {
    return result.status ? "Lint: " + result.status : null;
  }
  if (key === "verify") {
    if (result.total != null) return result.pass + "/" + result.total + " tests";
    return null;
  }
  if (key === "judge") {
    return result.overall || null;
  }
  if (key === "rtl_review" || key === "test_review") {
    return result.overallSeverity ? "Review: " + result.overallSeverity : null;
  }
  return null;
}

// Match an iteration label ("judge-triage-2") to its history entry
// (history[1] since judgeHistory is 0-indexed and "judge-triage-N"
// has iter=N which is 1-indexed in the prompt logs).
function matchJudgeMeta(label, judgeHistory) {
  // Extract trailing iter number
  const m = label.match(/-(\d+)$/);
  if (!m) return null;
  const iter = parseInt(m[1], 10);
  const entry = judgeHistory.find(function(h) { return h.iter === iter; });
  if (!entry) return null;
  // Synthesize a human-readable reason from the verdict + triage
  const verdict = entry.eval || {};
  const failedCount = verdict.failed != null ? verdict.failed : (verdict.failingIds ? verdict.failingIds.length : 0);
  const summary = verdict.overall === "PASS"
    ? "Gate PASS — accepted."
    : ("Gate FAIL — " + failedCount + " criteria below threshold (score " + (verdict.score || 0) + ").");
  return {
    summary: summary,
    reason: summary,
    triageTarget: entry.triageTarget,
    failingIds: verdict.failingIds || [],
  };
}

