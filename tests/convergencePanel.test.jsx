// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Convergence timeline (docs/improvement-roadmap.md #9) — pure series + panel.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { buildConvergenceSeries } from "../src/react/convergenceSeries.js";
import { ConvergencePanel, stagesFromStageData } from "../src/react/components/convergencePanel.jsx";

const LINT_IMPROVING = { iterations: [
  { iter: 1, errors: 22, warnings: 3 },
  { iter: 2, errors: 9,  warnings: 2 },
  { iter: 3, errors: 1,  warnings: 2 },
] };

describe("buildConvergenceSeries", () => {
  it("derives a lint row with chain + improving trend", () => {
    const { rows } = buildConvergenceSeries({ lint: LINT_IMPROVING });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "lint", chain: "22→9→1", trend: "improving", converged: false });
    expect(rows[0].points[0].detail).toBe("22e/3w");
  });

  it("flags stuck and regressing, and converged at 0", () => {
    const stuck = buildConvergenceSeries({ lint: { iterations: [{ iter: 1, errors: 5 }, { iter: 2, errors: 5 }] } });
    expect(stuck.rows[0].trend).toBe("stuck");
    const reg = buildConvergenceSeries({ lint: { iterations: [{ iter: 1, errors: 2 }, { iter: 2, errors: 8 }] } });
    expect(reg.rows[0].trend).toBe("regressing");
    const conv = buildConvergenceSeries({ lint: { iterations: [{ iter: 1, errors: 4 }, { iter: 2, errors: 0 }] } });
    expect(conv.rows[0].converged).toBe(true);
  });

  it("derives verify (fail count) and judge (unmet) rows", () => {
    const { rows } = buildConvergenceSeries({
      verify: { verifyHistory: [{ iter: 1, pass: 3, total: 7 }, { iter: 2, pass: 6, total: 7 }] },
      judge:  { judgeHistory:  [{ iter: 1, unmet: 2, total: 9 }] },
    });
    const v = rows.find((r) => r.key === "verify");
    expect(v.chain).toBe("4→1");
    expect(v.trend).toBe("improving");
    expect(rows.find((r) => r.key === "judge").points[0].detail).toBe("2/9 unmet");
  });

  it("emits generation chips for syntax repairs and best-of-N", () => {
    const { chips } = buildConvergenceSeries({
      rtl_generate: { _syntaxRepairs: [{ rule: "a", count: 2 }, { rule: "b", count: 1 }], _bestOfN: { n: 3, winner: 1 } },
    });
    expect(chips.map((c) => c.label)).toEqual([
      "RTL gen: 3 syntax repair(s)",
      "RTL gen: best-of-3 picked #1",
    ]);
  });

  it("empty stages → no rows, no chips", () => {
    const r = buildConvergenceSeries({});
    expect(r.rows).toEqual([]);
    expect(r.chips).toEqual([]);
  });
});

describe("ConvergencePanel", () => {
  it("renders rows from id-keyed stageData (stage id 6 = lint)", () => {
    render(<ConvergencePanel stageData={{ 6: LINT_IMPROVING }} />);
    expect(screen.getByText("22→9→1")).toBeTruthy();
    expect(screen.getByLabelText("trend improving")).toBeTruthy();
    expect(screen.getByText("Convergence")).toBeTruthy();
  });

  it("renders nothing when no looping stage has data", () => {
    const { container } = render(<ConvergencePanel stageData={{ 2: { requirements: [] } }} />);
    expect(container.firstChild).toBeNull();
  });

  it("stagesFromStageData maps ids to keys", () => {
    const s = stagesFromStageData({ 6: LINT_IMPROVING, 8: { verifyHistory: [] } });
    expect(s.lint).toBe(LINT_IMPROVING);
    expect(s.verify).toBeTruthy();
  });
});
