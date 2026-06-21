// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Acceptance ledger core (Phase 1): per-requirement status + green + progress.

import { describe, it, expect } from "vitest";
import {
  deriveLedger, buildLedgerForState, formatLedgerProgress, isReqInGate,
  unmetMustRequirements, attributeMutationKills,
} from "../src/pipeline/acceptanceLedger.js";
import { promptRTLFromVerifyFail, promptTBFromVerifyFail } from "../src/prompts/verify.js";

const REQS = [
  { id: "REQ-INTF-001", pri: "Must",   cat: "Interface",     desc: "ports present" },
  { id: "REQ-FUNC-001", pri: "Must",   cat: "Functionality", desc: "wraps at MAX" },
  { id: "REQ-FUNC-002", pri: "Should", cat: "Functionality", desc: "increments" },
  { id: "REQ-TIM-001",  pri: "Must",   cat: "Timing",        desc: "1-cycle latency" },
];

describe("deriveLedger — status per requirement", () => {
  it("tested-passing / tested-failing / untested / structural", () => {
    const tests = [
      { name: "t_wrap", st: "PASS", req: "REQ-FUNC-001" },
      { name: "t_inc",  st: "FAIL", req: "REQ-FUNC-002" },
    ];
    const led = deriveLedger(REQS, tests, { estimated: false, compiled: true });
    const by = Object.fromEntries(led.requirements.map((e) => [e.id, e]));
    expect(by["REQ-FUNC-001"].status).toBe("tested-passing");
    expect(by["REQ-FUNC-001"].green).toBe(true);
    expect(by["REQ-FUNC-002"].status).toBe("tested-failing");
    expect(by["REQ-FUNC-002"].green).toBe(false);
    expect(by["REQ-INTF-001"].status).toBe("structural");   // interface + compiled, no test
    expect(by["REQ-INTF-001"].green).toBe(true);
    expect(by["REQ-TIM-001"].status).toBe("untested");      // not structural, no test
    expect(by["REQ-TIM-001"].green).toBe(false);
  });

  it("an estimated pass is NOT green (tested-passing-estimated)", () => {
    const tests = [{ name: "t_wrap", st: "PASS", req: "REQ-FUNC-001" }];
    const led = deriveLedger(REQS, tests, { estimated: true, compiled: true });
    const e = led.requirements.find((x) => x.id === "REQ-FUNC-001");
    expect(e.status).toBe("tested-passing-estimated");
    expect(e.green).toBe(false);
  });

  it("structural requires compiled === true", () => {
    const led = deriveLedger(REQS, [], { estimated: false, compiled: false });
    expect(led.requirements.find((x) => x.id === "REQ-INTF-001").status).toBe("untested");
  });

  it("matches req ids case-insensitively and records covering/failing tests", () => {
    const tests = [
      { name: "a", st: "PASS", req: "req-func-001" },
      { name: "b", st: "FAIL", req: "REQ-FUNC-001" },
    ];
    const e = deriveLedger(REQS, tests, { compiled: true }).requirements.find((x) => x.id === "REQ-FUNC-001");
    expect(e.status).toBe("tested-failing");
    expect(e.coveringTests).toEqual(["a", "b"]);
    expect(e.failingTests).toEqual(["b"]);
  });

  it("progress totals + done (all Must green)", () => {
    const tests = [
      { name: "t_wrap", st: "PASS", req: "REQ-FUNC-001" },
      { name: "t_tim",  st: "PASS", req: "REQ-TIM-001" },
    ];
    // INTF structural-green, FUNC-001 + TIM-001 tested-green → all 3 Must green.
    const p = deriveLedger(REQS, tests, { compiled: true }).progress;
    expect(p).toMatchObject({ greenMust: 3, totalMust: 3, done: true });
    expect(p.greenAll).toBe(3);   // REQ-FUNC-002 (Should) is untested
    expect(p.totalAll).toBe(4);

    const p2 = deriveLedger(REQS, [], { compiled: true }).progress;
    expect(p2).toMatchObject({ greenMust: 1, totalMust: 3, done: false }); // only INTF structural
  });
});

describe("isReqInGate", () => {
  it("true when the matching category×priority criterion is enabled", () => {
    const cfg = { req_func_must: { enabled: true, threshold: 100 } };
    expect(isReqInGate({ pri: "Must", cat: "Functionality" }, cfg)).toBe(true);
    expect(isReqInGate({ pri: "Should", cat: "Functionality" }, cfg)).toBe(false);
  });
  it("true for Must when req_must_attributed or req_must_green is enabled", () => {
    expect(isReqInGate({ pri: "Must", cat: "Timing" }, { req_must_green: { enabled: true } })).toBe(true);
    expect(isReqInGate({ pri: "Should", cat: "Timing" }, { req_must_green: { enabled: true } })).toBe(false);
  });
});

describe("buildLedgerForState", () => {
  it("derives estimated/compiled/inGate from a pipeline state", () => {
    const state = {
      spec: { requirements: REQS },
      verify: { cli: true, pass: 1, tests: [{ name: "t_wrap", st: "PASS", req: "REQ-FUNC-001" }] },
    };
    const led = buildLedgerForState(state, { req_func_must: { enabled: true } });
    const e = led.requirements.find((x) => x.id === "REQ-FUNC-001");
    expect(e.status).toBe("tested-passing");      // cli:true → not estimated
    expect(e.inGate).toBe(true);                  // req_func_must enabled
    expect(led.requirements.find((x) => x.id === "REQ-INTF-001").status).toBe("structural");
  });

  it("treats an LLM-estimated verify (cli !== true) as estimated", () => {
    const state = { spec: { requirements: REQS }, verify: { pass: 1, tests: [{ name: "t", st: "PASS", req: "REQ-FUNC-001" }] } };
    expect(buildLedgerForState(state, {}).requirements.find((x) => x.id === "REQ-FUNC-001").status)
      .toBe("tested-passing-estimated");
  });

  it("no verify run → structural reqs stay untested (compiled false)", () => {
    const led = buildLedgerForState({ spec: { requirements: REQS } }, {});
    expect(led.requirements.find((x) => x.id === "REQ-INTF-001").status).toBe("untested");
  });

  it("a compilation FAIL means not compiled", () => {
    const state = { spec: { requirements: REQS }, verify: { cli: true, tests: [{ name: "compilation", st: "FAIL" }] } };
    expect(buildLedgerForState(state, {}).requirements.find((x) => x.id === "REQ-INTF-001").status).toBe("untested");
  });
});

describe("formatLedgerProgress", () => {
  it("renders the one-line summary", () => {
    expect(formatLedgerProgress({ greenMust: 3, totalMust: 5, greenAll: 7, totalAll: 12 }))
      .toBe("3/5 Must green · 7/12 all");
    expect(formatLedgerProgress(null)).toBe("0/0 Must green · 0/0 all");
  });
});

describe("Phase 6 — attributeMutationKills + strength", () => {
  const tests = [
    { name: "t_wrap", st: "PASS", req: "REQ-FUNC-001" },
    { name: "t_inc",  st: "PASS", req: "REQ-FUNC-001" },
    { name: "t_idle", st: "PASS", req: "REQ-FUNC-002" },
  ];

  it("attributeMutationKills credits ≤1 per mutant per req, ignores unattributed", () => {
    const killers = [
      { id: "m1", line: 5, killedBy: ["t_wrap", "t_inc"] },   // both map to FUNC-001 → 1
      { id: "m2", line: 9, killedBy: ["t_idle"] },             // FUNC-002 → 1
      { id: "m3", line: 3, killedBy: ["unknown_test"] },       // unattributed → 0
    ];
    const byReq = attributeMutationKills(killers, tests).byReq;
    expect(byReq).toEqual({ "REQ-FUNC-001": 1, "REQ-FUNC-002": 1 });
  });

  it("deriveLedger marks strong (killed) / unproven (no kills); estimated → n/a", () => {
    const reqs = [
      { id: "REQ-FUNC-001", pri: "Must", cat: "Functionality", desc: "a" },
      { id: "REQ-FUNC-002", pri: "Must", cat: "Functionality", desc: "b" },
    ];
    const mutation = { killers: [{ id: "m1", line: 5, killedBy: ["t_wrap"] }] }; // only FUNC-001
    const led = deriveLedger(reqs, tests, { compiled: true, mutation });
    const by = Object.fromEntries(led.requirements.map((e) => [e.id, e]));
    expect(by["REQ-FUNC-001"]).toMatchObject({ status: "tested-passing", green: true, strength: "strong", mutationKills: 1 });
    expect(by["REQ-FUNC-002"]).toMatchObject({ status: "tested-passing", green: true, strength: "unproven", mutationKills: 0 });
    expect(led.progress).toMatchObject({ strongMust: 1, testedPassingMust: 2 });

    // Estimated pass → not tested-passing → strength n/a (never proven).
    const est = deriveLedger(reqs, tests, { estimated: true, compiled: true, mutation });
    expect(est.requirements.every((e) => e.strength === "n/a")).toBe(true);
  });

  it("strength is orthogonal to green — never downgrades a green req", () => {
    const reqs = [{ id: "REQ-FUNC-001", pri: "Must", cat: "Functionality", desc: "a" }];
    const led = deriveLedger(reqs, tests, { compiled: true, mutation: { killers: [] } }); // no kills
    expect(led.requirements[0].green).toBe(true);          // still green
    expect(led.requirements[0].strength).toBe("unproven"); // but not proven
  });

  it("no mutation data → strength n/a everywhere", () => {
    const reqs = [{ id: "REQ-FUNC-001", pri: "Must", cat: "Functionality", desc: "a" }];
    expect(deriveLedger(reqs, tests, { compiled: true }).requirements[0].strength).toBe("n/a");
  });
});

describe("Phase 3 — unmetMustRequirements + verify-fail target injection", () => {
  const spec = { requirements: [
    { id: "REQ-FUNC-001", pri: "Must",   cat: "Functionality", desc: "wraps" },
    { id: "REQ-TIM-001",  pri: "Must",   cat: "Timing",        desc: "1-cycle" },   // untested
    { id: "REQ-FUNC-002", pri: "Should", cat: "Functionality", desc: "inc" },
  ]};

  it("lists unmet Must reqs (failing before untested), excludes green + Should", () => {
    const led = deriveLedger(spec.requirements, [{ name: "t", st: "FAIL", req: "REQ-FUNC-001" }], { compiled: true });
    const unmet = unmetMustRequirements(led);
    expect(unmet.map((r) => r.id)).toEqual(["REQ-FUNC-001", "REQ-TIM-001"]);
    expect(unmet.map((r) => r.status)).toEqual(["tested-failing", "untested"]);
  });

  it("verify-fail prompts surface the untested Must req (which the failing-tests list misses)", () => {
    const vr = { cli: true, tests: [{ name: "t", st: "FAIL", req: "REQ-FUNC-001" }], log: "" };
    const rtl = promptRTLFromVerifyFail("module m; endmodule", vr, spec, {}, []).userMessage;
    expect(rtl).toMatch(/NOT YET GREEN/);
    expect(rtl).toMatch(/REQ-TIM-001 \[untested\]/);
    const tb = promptTBFromVerifyFail("module tb; endmodule", "module m; endmodule", vr, spec, {}, []).userMessage;
    expect(tb).toMatch(/REQ-TIM-001 \[untested\]/);
  });

  it("adds NO target section when every Must req is green (byte-identical path)", () => {
    const allGreen = { requirements: [{ id: "REQ-FUNC-001", pri: "Must", cat: "Functionality", desc: "x" }] };
    const vr = { cli: true, tests: [{ name: "t", st: "PASS", req: "REQ-FUNC-001" }], log: "" };
    expect(promptRTLFromVerifyFail("m", vr, allGreen, {}, []).userMessage).not.toMatch(/NOT YET GREEN/);
    expect(promptTBFromVerifyFail("tb", "m", vr, allGreen, {}, []).userMessage).not.toMatch(/NOT YET GREEN/);
  });
});
