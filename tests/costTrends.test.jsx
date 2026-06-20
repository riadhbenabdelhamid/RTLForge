// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Slice C (platform polish #21): the GUI Run-trends panel + the browser writer.

import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { CostSuccessTrends } from "../src/react/components/costTrends.jsx";
import { recordRunSummaryBrowser } from "../src/observer/browserObserver.js";

function seed(summary) {
  recordRunSummaryBrowser(summary, { config: { workflow: "rtl" }, moduleId: "m" });
}

describe("CostSuccessTrends", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear();
  });

  it("renders nothing when no run_summary events exist", () => {
    const { container } = render(<CostSuccessTrends workflow="rtl" />);
    expect(container.textContent).toBe("");
  });

  it("renders totals + per-bucket rows from recorded runs", () => {
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    seed({ ts: base,            costUSD: 0.10, gatePass: true,  gateScore: 90 });
    seed({ ts: base + 3600000,  costUSD: 0.30, gatePass: false, gateScore: 40 });
    const { container } = render(<CostSuccessTrends workflow="rtl" />);
    const txt = container.textContent;
    expect(txt).toMatch(/Run trends/);
    expect(txt).toMatch(/2 runs/);
    expect(txt).toMatch(/50% gate-PASS/);
    expect(txt).toMatch(/\$0\.4000 total/);
  });

  it("ignores events from other workflows", () => {
    recordRunSummaryBrowser({ ts: Date.now(), costUSD: 1, gatePass: true },
      { config: { workflow: "fpga" }, moduleId: "m" });
    const { container } = render(<CostSuccessTrends workflow="rtl" />);
    expect(container.textContent).toBe("");
  });
});

describe("recordRunSummaryBrowser", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear();
  });

  it("does not write when trackRunSummaries === false", () => {
    recordRunSummaryBrowser({ ts: 1, costUSD: 1, gatePass: true },
      { config: { workflow: "rtl", trackRunSummaries: false }, moduleId: "m" });
    const { container } = render(<CostSuccessTrends workflow="rtl" />);
    expect(container.textContent).toBe("");
  });
});
