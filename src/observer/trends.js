// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// observer/trends — cost/success trend aggregation (Slice C of task #21)
//
// PURE + browser-safe (no node imports). Two responsibilities, kept separate
// so each is trivially testable:
//
//   summarizeRun()         — fold a finished run's stageData + eval-gate
//                            verdict into a `run_summary` payload. This is the
//                            deterministic, LLM-free record persisted after a
//                            run (CLI → SQLite, GUI → localStorage).
//   costSuccessTrend()     — bucket many run_summary rows into a cost +
//                            gate-PASS-rate trend over time.
//
// "Success" is the EVAL GATE verdict (overall === "PASS") — the user's
// definition of "done" — so the trend answers "are my runs converging on
// green (and getting cheaper) over time". Trends reflect only runs recorded
// after the feature ships (no backfill); `ask` sessions are not pipeline runs
// and are excluded.
// ═══════════════════════════════════════════════════════════════════════════

function round4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }
function num(x)    { return typeof x === "number" ? x : (parseFloat(x) || 0); }

/**
 * Build the runEvalGate-shaped synthetic state from a module's stageData map.
 * Mirrors the unboxing in term/commands/evals.js so the gate sees the same
 * shape it sees inside judge.js (a flat object keyed by stage name).
 */
export function synthStateFromStageData(stageData) {
  const sd = stageData || {};
  return {
    spec:          sd[2]  || {},
    rtl_generate:  sd[4]  || {},
    formal_props:  sd[5]  || {},
    lint:          sd[6]  || {},
    test_generate: sd[7]  || {},
    verify:        sd[8]  || {},
    judge:         sd[9]  || {},
    rtl_review:    sd[10] || {},
    test_review:   sd[11] || {},
    lint_test:     sd[12] || {},
  };
}

/** Sum LLM tokens across every stage's call ledger (_llms, or legacy _llm). */
export function sumTokens(stageData) {
  const sd = stageData || {};
  let tokensIn = 0, tokensOut = 0;
  for (const key of Object.keys(sd)) {
    const r = sd[key];
    if (!r) continue;
    const llms = Array.isArray(r._llms) ? r._llms : (r._llm ? [r._llm] : []);
    for (const call of llms) {
      if (!call) continue;
      if (typeof call.tokensIn  === "number") tokensIn  += call.tokensIn;
      if (typeof call.tokensOut === "number") tokensOut += call.tokensOut;
    }
  }
  return { tokensIn: tokensIn, tokensOut: tokensOut };
}

/**
 * Fold a finished run into a run_summary payload (the `extracted` body of the
 * persisted observer event). Pure — `estimateCost` is injected.
 *
 * @param {object}   opts
 * @param {object}   opts.stageData      module stageData map (keyed by stage id)
 * @param {object}   opts.verdict        runEvalGate output ({ overall, score })
 * @param {Function} [opts.estimateCost] (tIn, tOut, provider) → USD
 * @param {string}   [opts.provider]
 * @param {string}   [opts.model]
 * @param {string}   [opts.sha]
 * @param {number}   [opts.ts]
 */
export function summarizeRun(opts) {
  const o = opts || {};
  const tk = sumTokens(o.stageData);
  const est = typeof o.estimateCost === "function" ? o.estimateCost : function() { return 0; };
  const v = o.verdict || {};
  return {
    ts:        o.ts || Date.now(),
    costUSD:   round4(est(tk.tokensIn, tk.tokensOut, o.provider)),
    tokensIn:  tk.tokensIn,
    tokensOut: tk.tokensOut,
    gatePass:  v.overall === "PASS",
    gateScore: typeof v.score === "number" ? v.score : null,
    model:     o.model || null,
    sha:       o.sha || null,
  };
}

/**
 * Normalize persisted observer events (or bare payloads) into the flat
 * summary shape costSuccessTrend consumes. Reads from `extracted` when the
 * input is a full event row.
 */
export function eventsToSummaries(events) {
  return (events || []).map(function(e) {
    const ex = (e && e.extracted) || e || {};
    return {
      ts:        (e && typeof e.ts === "number") ? e.ts : num(ex.ts),
      costUSD:   num(ex.costUSD),
      tokensIn:  num(ex.tokensIn),
      tokensOut: num(ex.tokensOut),
      gatePass:  !!ex.gatePass,
      gateScore: ex.gateScore == null ? null : num(ex.gateScore),
      model:     ex.model || null,
      sha:       ex.sha || null,
    };
  });
}

/** Bucket label for a timestamp under the chosen granularity. */
function bucketKey(ts, by) {
  const d = new Date(ts);
  if (by === "run")  return d.toISOString().replace("T", " ").slice(0, 19);
  if (by === "week") {
    // Monday-start week (UTC); label = the Monday's date.
    const dow = d.getUTCDay();              // 0=Sun … 6=Sat
    const back = dow === 0 ? 6 : dow - 1;
    const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
    return mon.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);       // day
}

/**
 * Aggregate run_summary rows into a cost + gate-PASS-rate trend.
 *
 * @param {Array}  summaries  flat summary rows (see eventsToSummaries)
 * @param {object} [opts]
 * @param {string} [opts.by="day"]  "run" | "day" | "week"
 * @param {number} [opts.since]     drop rows with ts < since (ms epoch)
 * @returns {{ by, buckets: Array, totals: object }}
 *          bucket = { label, runs, totalCostUSD, avgCostUSD, passes, fails, successRate }
 */
export function costSuccessTrend(summaries, opts) {
  const o = opts || {};
  const by = o.by || "day";
  let rows = (summaries || []).filter(function(s) { return s && typeof s.ts === "number" && s.ts > 0; });
  if (o.since != null) rows = rows.filter(function(s) { return s.ts >= o.since; });
  rows.sort(function(a, b) { return a.ts - b.ts; });

  const totalRuns   = rows.length;
  const totalPasses = rows.filter(function(s) { return s.gatePass; }).length;
  const totalCost   = rows.reduce(function(a, s) { return a + (s.costUSD || 0); }, 0);
  const totals = {
    runs:         totalRuns,
    passes:       totalPasses,
    fails:        totalRuns - totalPasses,
    successRate:  totalRuns ? Math.round((totalPasses / totalRuns) * 100) : 0,
    totalCostUSD: round4(totalCost),
    avgCostUSD:   totalRuns ? round4(totalCost / totalRuns) : 0,
  };

  let buckets;
  if (by === "run") {
    // One bucket per run, oldest-first — no grouping.
    buckets = rows.map(function(s) {
      return {
        label:        bucketKey(s.ts, "run"),
        runs:         1,
        totalCostUSD: round4(s.costUSD || 0),
        avgCostUSD:   round4(s.costUSD || 0),
        passes:       s.gatePass ? 1 : 0,
        fails:        s.gatePass ? 0 : 1,
        successRate:  s.gatePass ? 100 : 0,
      };
    });
  } else {
    const byKey = new Map();
    for (const s of rows) {
      const key = bucketKey(s.ts, by);
      let b = byKey.get(key);
      if (!b) { b = { label: key, _ts: s.ts, runs: 0, totalCostUSD: 0, passes: 0, fails: 0 }; byKey.set(key, b); }
      b.runs += 1;
      b.totalCostUSD += (s.costUSD || 0);
      if (s.gatePass) b.passes += 1; else b.fails += 1;
    }
    buckets = Array.from(byKey.values()).sort(function(a, b) { return a._ts - b._ts; });
    for (const b of buckets) {
      b.avgCostUSD   = b.runs ? round4(b.totalCostUSD / b.runs) : 0;
      b.totalCostUSD = round4(b.totalCostUSD);
      b.successRate  = b.runs ? Math.round((b.passes / b.runs) * 100) : 0;
      delete b._ts;
    }
  }

  return { by: by, buckets: buckets, totals: totals };
}
