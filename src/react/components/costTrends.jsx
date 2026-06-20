// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// react/components/costTrends — GUI cost/success trend panel (Slice C of #21)
//
// Reads the run_summary events the run loop records to localStorage
// (recordRunSummaryBrowser) and renders the SAME aggregation the CLI's
// `observe trends` prints: gate-PASS rate + average cost per run, bucketed by
// day / week / run. Read-only; renders nothing until at least one run is
// recorded, so it never clutters a fresh install or the observer-disabled view.
//
// "Success" = the eval-gate verdict (the user's definition of "done"), so the
// trend answers "are my runs converging on green — and getting cheaper?".
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useMemo } from "react";
import { TH } from "../../constants/theme.js";
import { Tag } from "./atoms.jsx";
import { listBrowserEvents } from "../../observer/browserObserver.js";
import { eventsToSummaries, costSuccessTrend } from "../../observer/trends.js";

const SPARK = "▁▂▃▄▅▆▇█";
function sparkChar(v) {
  const cl = Math.max(0, Math.min(100, v || 0));
  return SPARK[Math.min(SPARK.length - 1, Math.round((cl / 100) * (SPARK.length - 1)))];
}

export function CostSuccessTrends({ workflow, refreshTick }) {
  const wf = workflow || "rtl";
  const [by, setBy] = useState("day");

  const trend = useMemo(function() {
    const events = listBrowserEvents(wf, { kind: "run_summary", includeDismissed: true, limit: 5000 });
    return costSuccessTrend(eventsToSummaries(events), { by: by });
  }, [wf, by, refreshTick]);

  // Nothing recorded yet → render nothing (keeps fresh/disabled views clean).
  if (!trend || trend.totals.runs === 0) return null;

  return (
    <div style={{
      marginBottom: 12, padding: "10px 12px",
      background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: TH.text0 }}>Run trends</div>
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 11, color: TH.text2 }}>by:</label>
        <select
          value={by}
          onChange={function(e) { setBy(e.target.value); }}
          style={{
            background: TH.bg1, border: "1px solid " + TH.border, color: TH.text0,
            fontSize: 11, padding: "2px 6px", borderRadius: 3, fontFamily: TH.font,
          }}
        >
          <option value="day">day</option>
          <option value="week">week</option>
          <option value="run">run</option>
        </select>
      </div>

      {/* Totals line */}
      <div style={{ fontSize: 10, color: TH.text2, marginBottom: 8 }}>
        <Tag>{trend.totals.runs} runs</Tag>{" "}
        <Tag color={trend.totals.successRate >= 50 ? TH.accent : TH.yellow} bg={TH.bg1}>
          {trend.totals.successRate}% gate-PASS
        </Tag>{" "}
        <Tag>${trend.totals.totalCostUSD.toFixed(4)} total</Tag>{" "}
        <Tag>${trend.totals.avgCostUSD.toFixed(4)}/run</Tag>
      </div>

      {/* Success sparkline */}
      <div style={{ fontSize: 14, fontFamily: TH.fontMono, color: TH.accent, letterSpacing: 1, marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: TH.text3 }}>success </span>
        {trend.buckets.map(function(b) { return sparkChar(b.successRate); }).join("")}
      </div>

      {/* Per-bucket table */}
      <table style={{ width: "100%", fontSize: 11, color: TH.text1, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ color: TH.text2, textAlign: "left" }}>
            <th style={thStyle()}>{by === "run" ? "When" : "Period"}</th>
            <th style={thStyle("right")}>Runs</th>
            <th style={thStyle("right")}>Success</th>
            <th style={thStyle("right")}>Avg cost</th>
          </tr>
        </thead>
        <tbody>
          {trend.buckets.map(function(b, i) {
            return (
              <tr key={i} style={{ borderTop: "1px solid " + TH.border }}>
                <td style={tdStyle()}>{b.label}</td>
                <td style={tdStyle("right")}>{b.runs}</td>
                <td style={tdStyle("right")}>
                  <span style={{ color: b.successRate >= 50 ? TH.accent : TH.yellow }}>{b.successRate}%</span>
                </td>
                <td style={tdStyle("right")}>${b.avgCostUSD.toFixed(4)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function thStyle(align) {
  return { padding: "3px 6px", fontWeight: 500, textAlign: align || "left", fontFamily: TH.fontMono };
}
function tdStyle(align) {
  return { padding: "3px 6px", textAlign: align || "left", fontFamily: TH.fontMono };
}
