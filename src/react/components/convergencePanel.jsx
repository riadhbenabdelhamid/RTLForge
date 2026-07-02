// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// ConvergencePanel — is this run converging or thrashing? (roadmap #9)
//
// One compact row per looping stage: the badness chain across iterations
// (lint 22→9→1, verify 4→1 fail, judge unmet) with a trend chip, plus
// generation chips (syntax repairs, best-of-N pick). Renders from stageData —
// works live AND on restored checkpoints. Pure derivation lives in
// ../convergenceSeries.js; this component only renders. Renders nothing until
// a looping stage has at least one iteration.
// ═══════════════════════════════════════════════════════════════════════════

import { useMemo } from "react";
import { TH } from "../../constants/theme.js";
import { STAGE_KEY } from "../../constants/stages.js";
import { buildConvergenceSeries } from "../convergenceSeries.js";
import { listBrowserEvents } from "../../observer/browserObserver.js";
import { eventsToSummaries } from "../../observer/trends.js";
import { runEta, formatEta } from "../../observer/eta.js";

const TREND = {
  improving:  { icon: "▼", color: () => TH.green || TH.accent, title: "improving — badness falling" },
  regressing: { icon: "▲", color: () => TH.red,               title: "regressing — badness rising" },
  stuck:      { icon: "▶", color: () => TH.yellow,            title: "stuck — no change in the last iteration" },
  single:     { icon: "·", color: () => TH.text3,             title: "one data point so far" },
};

/** Map id-keyed stageData → key-named stage objects for the pure builder. */
export function stagesFromStageData(stageData) {
  const out = {};
  for (const id of Object.keys(stageData || {})) {
    const key = STAGE_KEY[id];
    if (key) out[key] = stageData[id];
  }
  return out;
}

/**
 * Per-model ETA chip for the pipeline progress strip (roadmap #10): sum of
 * per-stage median spans over prior runs of the SAME model (run_summary
 * events → stageSpans). Renders nothing below 2 samples — never fabricates.
 */
export function RunEta({ config, activeStages, currentStageId }) {
  const model = config && config.model;
  const eta = useMemo(function() {
    try {
      const remaining = (activeStages || [])
        .filter(function(s) { return s.id >= (currentStageId || 0); })
        .map(function(s) { return s.key; });
      if (remaining.length === 0) return null;
      const events = listBrowserEvents((config && config.workflow) || "rtl",
        { kind: "run_summary", includeDismissed: true, limit: 200 });
      const summaries = eventsToSummaries(events)
        .sort(function(a, b) { return (a.ts || 0) - (b.ts || 0); });
      return runEta(summaries, model, remaining);
    } catch (_e) { return null; }
  }, [model, currentStageId, activeStages, config]);
  if (!eta) return null;
  return (
    <span style={{ color: TH.text3 }}
      title={"median of " + eta.basedOnRuns + " prior run(s) on " + model + "; "
        + eta.stagesKnown + "/" + eta.stagesTotal + " remaining stages have history"}>
      {" · "}{formatEta(eta.ms)} left
    </span>
  );
}

export function ConvergencePanel({ stageData }) {
  const { rows, chips } = buildConvergenceSeries(stagesFromStageData(stageData));
  if (rows.length === 0 && chips.length === 0) return null;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
      padding: "4px 20px", background: TH.bg0,
      borderBottom: "1px solid " + TH.border, fontSize: 10,
    }}>
      <span style={{ color: TH.text3, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, fontSize: 9 }}>
        Convergence
      </span>
      {rows.map(function(r) {
        const t = TREND[r.trend] || TREND.single;
        const last = r.points[r.points.length - 1];
        return (
          <span key={r.key} title={r.label + ": " + r.points.map((p) => p.detail).join(" → ") + " — " + t.title}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, color: TH.text2 }}>
            <span style={{ color: TH.text1, fontWeight: 600 }}>{r.label}</span>
            <span style={{ fontFamily: TH.fontMono || "monospace", color: r.converged ? (TH.green || TH.accent) : TH.text1 }}>
              {r.chain}
            </span>
            <span style={{ color: t.color(), fontWeight: 700 }} aria-label={"trend " + r.trend}>{t.icon}</span>
            <span style={{ color: TH.text3 }}>{last.detail}</span>
          </span>
        );
      })}
      {chips.map(function(c, i) {
        return (
          <span key={c.stage + i} style={{
            padding: "1px 7px", borderRadius: 3, background: TH.accentDim,
            color: TH.accent, fontWeight: 600, fontSize: 9,
          }}>{c.label}</span>
        );
      })}
    </div>
  );
}
