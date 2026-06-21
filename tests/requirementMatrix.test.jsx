// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Phase 5b (surface): the acceptance ledger rendered as a requirement matrix,
// reused by VerifyStage (live) and JudgeStage (snapshot).

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { RequirementMatrix, VerifyStage, JudgeStage } from "../src/react/components/stages.jsx";

const LEDGER = {
  requirements: [
    { id: "REQ-INTF-001", pri: "Must", cat: "Interface", desc: "ports", status: "structural", green: true, inGate: true, coveringTests: [], failingTests: [] },
    { id: "REQ-FUNC-001", pri: "Must", cat: "Functionality", desc: "wraps", status: "tested-failing", green: false, inGate: false, coveringTests: ["t_wrap"], failingTests: ["t_wrap"] },
    { id: "REQ-FUNC-002", pri: "Should", cat: "Functionality", desc: "est", status: "tested-passing-estimated", green: false, inGate: false, coveringTests: ["t_est"], failingTests: [] },
  ],
  progress: { greenMust: 1, totalMust: 2, greenAll: 1, totalAll: 3, done: false },
};

describe("RequirementMatrix", () => {
  it("renders a row per requirement with the greenMust headline + status chips", () => {
    const txt = render(<RequirementMatrix ledger={LEDGER} />).container.textContent;
    expect(txt).toMatch(/1\/2 Must green/);
    expect(txt).toMatch(/REQ-INTF-001/);
    expect(txt).toMatch(/REQ-FUNC-001/);
    expect(txt).toMatch(/structural/);
    expect(txt).toMatch(/fail/);
    expect(txt).toMatch(/est\. pass/);
  });

  it("shows an `in gate` badge only on gated requirements", () => {
    const txt = render(<RequirementMatrix ledger={LEDGER} />).container.textContent;
    expect((txt.match(/in gate/g) || []).length).toBe(1);   // only REQ-INTF-001
  });

  it("renders the acceptance chip when supplied", () => {
    const txt = render(
      <RequirementMatrix ledger={LEDGER} acceptance={{ enabledCriteria: 3, passedCriteria: 2 }} />
    ).container.textContent;
    expect(txt).toMatch(/2\/3 criteria/);
  });

  it("renders nothing for an empty ledger", () => {
    expect(render(<RequirementMatrix ledger={{ requirements: [], progress: {} }} />).container.textContent).toBe("");
  });

  it("shows the Strength column + 'N Must strong' only when mutation data exists", () => {
    const strong = {
      requirements: [
        { id: "REQ-FUNC-001", pri: "Must", cat: "Functionality", status: "tested-passing", green: true, strength: "strong", mutationKills: 1, coveringTests: ["a"], failingTests: [] },
        { id: "REQ-FUNC-002", pri: "Must", cat: "Functionality", status: "tested-passing", green: true, strength: "unproven", mutationKills: 0, coveringTests: ["b"], failingTests: [] },
      ],
      progress: { greenMust: 2, totalMust: 2, done: true, strongMust: 1, testedPassingMust: 2 },
    };
    const withStrength = render(<RequirementMatrix ledger={strong} />).container.textContent;
    expect(withStrength).toMatch(/Strength/);
    expect(withStrength).toMatch(/✓ strong/);
    expect(withStrength).toMatch(/strength\?/);
    expect(withStrength).toMatch(/1\/2 Must strong/);
    // Phase-5 ledger (no strength) → no Strength column.
    expect(render(<RequirementMatrix ledger={LEDGER} />).container.textContent).not.toMatch(/Must strong/);
  });
});

describe("VerifyStage Requirements tab", () => {
  const base = (over) => Object.assign({ pass: 0, fail: 0, total: 0, cov: {}, tests: [], log: "", verifyHistory: [] }, over);

  it("exposes a Requirements tab only when _ledger is present, and renders the matrix on click", () => {
    const { container } = render(<VerifyStage data={base({ _ledger: LEDGER })} />);
    expect(container.textContent).toMatch(/Requirements/);
    const tab = Array.from(container.querySelectorAll("button, div")).find((el) => el.textContent === "Requirements");
    if (tab) fireEvent.click(tab);
    expect(container.textContent).toMatch(/REQ-FUNC-001/);

    const noLedger = render(<VerifyStage data={base({})} />).container.textContent;
    expect(noLedger).not.toMatch(/1\/2 Must green/);
  });
});

describe("JudgeStage Traceability prefers the matrix, falls back to the trace table", () => {
  it("renders the matrix when _ledger is present", () => {
    const { container } = render(<JudgeStage data={{ overall: "FAIL", score: 50, trace: [], recs: [], judgeHistory: [], _ledger: LEDGER }} />);
    const tab = Array.from(container.querySelectorAll("button, div")).find((el) => el.textContent === "Traceability");
    if (tab) fireEvent.click(tab);
    expect(container.textContent).toMatch(/REQ-INTF-001/);
    expect(container.textContent).toMatch(/1\/2 Must green/);
  });

  it("falls back to the legacy trace table without a ledger", () => {
    const data = { overall: "PASS", score: 100, recs: [], judgeHistory: [], trace: [{ req: "REQ-LEGACY-001", ok: true, status: "ok", note: "covered" }] };
    const { container } = render(<JudgeStage data={data} />);
    const tab = Array.from(container.querySelectorAll("button, div")).find((el) => el.textContent === "Traceability");
    if (tab) fireEvent.click(tab);
    expect(container.textContent).toMatch(/REQ-LEGACY-001/);
    expect(container.textContent).not.toMatch(/Must green/);
  });
});
