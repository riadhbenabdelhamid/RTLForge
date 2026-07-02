// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Per-model ETA (docs/improvement-roadmap.md #10).

import { describe, it, expect } from "vitest";
import { stageEta, runEta, formatEta } from "../src/observer/eta.js";
import { stageSpansFromStageData, summarizeRun, eventsToSummaries } from "../src/observer/trends.js";

const runs = (spansList, model = "M") =>
  spansList.map((stageSpans, i) => ({ ts: i, model, stageSpans }));

describe("stageEta", () => {
  it("median over the window of the SAME model's runs", () => {
    const s = runs([{ spec: 10000 }, { spec: 20000 }, { spec: 30000 }]);
    expect(stageEta(s, "M", "spec")).toEqual({ ms: 20000, samples: 3 });
  });
  it("never fabricates: below minSamples → null; other models ignored", () => {
    expect(stageEta(runs([{ spec: 10000 }]), "M", "spec")).toBe(null);
    const mixed = [...runs([{ spec: 9 }], "OTHER"), ...runs([{ spec: 10000 }], "M")];
    expect(stageEta(mixed, "M", "spec")).toBe(null);
  });
  it("window keeps only the most recent runs", () => {
    const s = runs([{ spec: 1 }, { spec: 1 }, { spec: 100 }, { spec: 100 }, { spec: 100 }, { spec: 100 }, { spec: 100 }]);
    expect(stageEta(s, "M", "spec", { window: 5 }).ms).toBe(100);
  });
});

describe("runEta", () => {
  const s = runs([
    { spec: 10000, lint: 30000 },
    { spec: 20000, lint: 50000 },
  ]);
  it("sums known-stage medians and reports coverage", () => {
    expect(runEta(s, "M", ["spec", "lint", "verify"]))
      .toEqual({ ms: 55000, stagesKnown: 2, stagesTotal: 3, basedOnRuns: 2 });
  });
  it("null when NO stage has history", () => {
    expect(runEta(s, "M", ["verify", "judge"])).toBe(null);
    expect(runEta([], "M", ["spec"])).toBe(null);
  });
});

describe("formatEta", () => {
  it("coarse humane units", () => {
    expect(formatEta(40000)).toBe("~40 s");
    expect(formatEta(7 * 60000)).toBe("~7 min");
    expect(formatEta(null)).toBe("");
  });
});

describe("stageSpans plumbing", () => {
  const stageData = {
    2: { _llms: [{ startedAtMs: 1000, endedAtMs: 4000, latencyMs: 3000, tokensIn: 1, tokensOut: 1 }] },
    6: { _llms: [
      { startedAtMs: 10000, endedAtMs: 12000 },
      { startedAtMs: 15000, endedAtMs: 19000 },    // span = first-start → last-end (covers CLI gaps)
    ] },
    9: { _llms: [{ latencyMs: 500 }] },            // no wall-clock stamps → latency fallback
  };
  it("derives per-stage wall spans keyed by stage key", () => {
    const spans = stageSpansFromStageData(stageData);
    expect(spans.spec).toBe(3000);
    expect(spans.lint).toBe(9000);
    expect(spans.judge).toBe(500);
  });
  it("summarizeRun embeds spans and eventsToSummaries carries them through", () => {
    const summary = summarizeRun({ stageData, verdict: { overall: "PASS" }, model: "M" });
    expect(summary.stageSpans.lint).toBe(9000);
    const rows = eventsToSummaries([{ ts: 1, extracted: summary }]);
    expect(rows[0].stageSpans.lint).toBe(9000);
    expect(rows[0].model).toBe("M");
  });
});
