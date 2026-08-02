// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// synthesisedTrace per-requirement evidence (run 43 demo rehearsal): the
// category criterion is a bucket verdict — req_func_must at 97% (3 of 4
// fully green) stamped ALL four FUNC requirements "violated" and the GUI
// verdict headline read "0/10 requirements covered" over a 93%-passing run.
// The acceptance ledger's per-req status wins when it names the requirement.

import { describe, it, expect } from "vitest";
import { synthesisedTrace } from "../src/pipeline/nodes/judge.js";

describe("synthesisedTrace ledger-first (run 43)", () => {
  const REQS = [
    { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must" },
    { id: "REQ-FUNC-002", cat: "Functionality", pri: "Must" },
    { id: "REQ-FUNC-003", cat: "Functionality", pri: "Must" },
    { id: "REQ-FUNC-004", cat: "Functionality", pri: "Must" },
  ];
  const VERDICT = { results: [
    { id: "req_func_must", enabled: true, status: "FAIL", measured: 97, threshold: 100,
      detail: "3/4 func/must requirements fully green" },
  ] };
  const led = (id, status, green) => ({ id, status, green, coveringTests: green ? ["t1"] : [] });

  it("green ledger entries are ok even when the category criterion FAILs", () => {
    const state = { spec: { requirements: REQS },
      verify: { total: 54, fail: 4, _ledger: { requirements: [
        led("REQ-FUNC-001", "tested-failing", false),
        led("REQ-FUNC-002", "tested-passing", true),
        led("REQ-FUNC-003", "tested-passing", true),
        led("REQ-FUNC-004", "tested-passing", true),
      ] } } };
    const t = synthesisedTrace(state, VERDICT);
    expect(t.filter((x) => x.ok).map((x) => x.req))
      .toEqual(["REQ-FUNC-002", "REQ-FUNC-003", "REQ-FUNC-004"]);
    expect(t.find((x) => x.req === "REQ-FUNC-001").status).toBe("violated");
  });

  it("estimated evidence does NOT upgrade to covered — category verdict governs", () => {
    const state = { spec: { requirements: [REQS[0]] },
      verify: { total: 5, fail: 0, _ledger: { requirements: [
        led("REQ-FUNC-001", "tested-passing-estimated", false),
      ] } } };
    const t = synthesisedTrace(state, VERDICT);
    expect(t[0].ok).toBe(false);   // falls through to the FAILing category criterion
  });

  it("no ledger → the old category-bucket behaviour is unchanged", () => {
    const state = { spec: { requirements: REQS }, verify: { total: 10, fail: 1 } };
    const t = synthesisedTrace(state, VERDICT);
    expect(t.every((x) => !x.ok)).toBe(true);   // category FAIL stamps all
  });
});
