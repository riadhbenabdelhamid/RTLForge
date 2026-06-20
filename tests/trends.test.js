// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Slice C (platform polish #21): pure cost/success trend aggregation.

import { describe, it, expect } from "vitest";
import {
  summarizeRun, sumTokens, synthStateFromStageData,
  eventsToSummaries, costSuccessTrend,
} from "../src/observer/trends.js";

const DAY = 86400000;
const estimate = (tIn, tOut) => tIn * 0.000001 + tOut * 0.000002; // $/token, trivial

describe("sumTokens / synthStateFromStageData", () => {
  it("sums _llms across stages and falls back to legacy _llm", () => {
    const sd = {
      2: { _llms: [{ tokensIn: 100, tokensOut: 50 }, { tokensIn: 10, tokensOut: 5 }] },
      4: { _llm: { tokensIn: 200, tokensOut: 100 } },
      6: { /* no llm */ },
    };
    expect(sumTokens(sd)).toEqual({ tokensIn: 310, tokensOut: 155 });
  });

  it("unboxes stageData into the gate's flat state shape (no architect)", () => {
    const s = synthStateFromStageData({ 2: { a: 1 }, 8: { pass: 3 }, 9: { overall: "PASS" } });
    expect(s.spec).toEqual({ a: 1 });
    expect(s.verify).toEqual({ pass: 3 });
    expect(s.judge).toEqual({ overall: "PASS" });
    expect(s).not.toHaveProperty("architect");
  });
});

describe("summarizeRun", () => {
  it("folds tokens + cost + gate verdict into a run_summary payload", () => {
    const sd = { 4: { _llms: [{ tokensIn: 1000, tokensOut: 500 }] } };
    const r = summarizeRun({
      stageData: sd, verdict: { overall: "PASS", score: 92 },
      estimateCost: estimate, provider: "anthropic", model: "claude-x", ts: 1000,
    });
    expect(r).toMatchObject({
      ts: 1000, tokensIn: 1000, tokensOut: 500,
      gatePass: true, gateScore: 92, model: "claude-x",
    });
    expect(r.costUSD).toBeCloseTo(0.002, 6); // 1000*1e-6 + 500*2e-6
  });

  it("marks a failing gate and tolerates a missing estimator", () => {
    const r = summarizeRun({ stageData: {}, verdict: { overall: "FAIL", score: 40 }, ts: 1 });
    expect(r.gatePass).toBe(false);
    expect(r.gateScore).toBe(40);
    expect(r.costUSD).toBe(0);
  });
});

describe("costSuccessTrend", () => {
  const mk = (ts, pass, cost) => ({ ts, gatePass: pass, costUSD: cost });

  it("buckets by day with success rate and average cost", () => {
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    const sums = [
      mk(base, true, 0.10),
      mk(base + 3600000, false, 0.30),      // same day
      mk(base + DAY, true, 0.20),           // next day
    ];
    const t = costSuccessTrend(sums, { by: "day" });
    expect(t.buckets).toHaveLength(2);
    expect(t.buckets[0]).toMatchObject({ runs: 2, passes: 1, fails: 1, successRate: 50 });
    expect(t.buckets[0].avgCostUSD).toBeCloseTo(0.20, 6);
    expect(t.buckets[1]).toMatchObject({ runs: 1, successRate: 100 });
    expect(t.totals).toMatchObject({ runs: 3, passes: 2, successRate: 67, totalCostUSD: 0.60 });
  });

  it("by:'run' emits one bucket per run, oldest-first", () => {
    const sums = [mk(2000, true, 0.1), mk(1000, false, 0.2)];
    const t = costSuccessTrend(sums, { by: "run" });
    expect(t.buckets).toHaveLength(2);
    expect(t.buckets[0].successRate).toBe(0);   // ts=1000 sorts first
    expect(t.buckets[1].successRate).toBe(100);
  });

  it("by:'week' groups into Monday-start weeks", () => {
    // 2026-01-01 is a Thursday → week of Mon 2025-12-29.
    const thu = Date.UTC(2026, 0, 1, 0, 0, 0);
    const fri = Date.UTC(2026, 0, 2, 0, 0, 0);
    const nextMon = Date.UTC(2026, 0, 5, 0, 0, 0);
    const t = costSuccessTrend([mk(thu, true, 0.1), mk(fri, true, 0.1), mk(nextMon, false, 0.1)], { by: "week" });
    expect(t.buckets).toHaveLength(2);
    expect(t.buckets[0]).toMatchObject({ label: "2025-12-29", runs: 2 });
    expect(t.buckets[1]).toMatchObject({ label: "2026-01-05", runs: 1 });
  });

  it("filters by since and ignores invalid timestamps", () => {
    const t = costSuccessTrend(
      [{ ts: 1000, gatePass: true, costUSD: 0.1 }, { ts: 5000, gatePass: false, costUSD: 0.1 }, { ts: 0 }, null],
      { by: "run", since: 4000 },
    );
    expect(t.totals.runs).toBe(1);
    expect(t.buckets).toHaveLength(1);
  });

  it("returns empty totals for no input", () => {
    expect(costSuccessTrend([], {}).totals).toMatchObject({ runs: 0, successRate: 0, totalCostUSD: 0 });
  });
});

describe("eventsToSummaries", () => {
  it("reads from event.extracted and event.ts", () => {
    const out = eventsToSummaries([
      { ts: 100, extracted: { costUSD: 0.5, tokensIn: 9, gatePass: true, gateScore: 80 } },
    ]);
    expect(out[0]).toMatchObject({ ts: 100, costUSD: 0.5, tokensIn: 9, gatePass: true, gateScore: 80 });
  });
});
