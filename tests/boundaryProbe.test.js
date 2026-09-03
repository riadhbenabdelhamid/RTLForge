// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
// Boundary measurement (run 55). The requirement said "more than 20 clock
// cycles", its own parenthetical restated that as "counter reached 21 or more",
// the RTL implemented `fall_counter > 20`, and the generated testbench's OWN
// reference model contained the identical `ref_fall_count > 20`. Design and
// oracle agreed, verify reported 128/128, judge passed at 100, and the shipped
// design faulted one cycle late. This gate measures the transition point
// instead of trusting any oracle.
import { describe, it, expect } from "vitest";
import {
  extractThresholds, validatePrimitives, buildProbeSource, verdictOf,
  describeBoundary, runBoundaryGate,
} from "../src/pipeline/boundaryProbe.js";
import { runEvalGate, triageTargetsFor } from "../src/eval/gate.js";
import { defaultEvalConfig } from "../src/eval/criteria.js";

// Verbatim from run 56 (project a5b171e3).
const FSM_REQS = [
  { id: "REQ-FUNC-004", pri: "Must", desc: "The module shall fault (transition to fault state with all outputs 0) when a descending unit reaches the floor (floor=1) and the descent duration exceeded 20 clock cycles (counter reached 21 or more)." },
  { id: "REQ-FUNC-005", pri: "Must", desc: "The module shall treat fault as a terminal state where all four outputs are 0 and only areset can exit." },
  { id: "REQ-FUNC-010", pri: "Should", desc: "The module shall use an 8-bit saturating descent cycle counter that saturates at 255 and never wraps." },
];

describe("threshold extraction", function() {
  it("reads the prose half of the requirement and ignores the parenthetical", function() {
    const out = extractThresholds(FSM_REQS);
    const four = out.find(function(r) { return r.req === "REQ-FUNC-004"; });
    expect(four.status).toBe("measure");
    expect(four.number).toBe(20);
    expect(four.kind).toBe("strict");
    // "(counter reached 21 or more)" is an implementation claim — and it was the
    // half that was wrong. Reading it would have expected the first event at 21
    // for the wrong reason, and matched the broken design.
    expect(four.expectedFirst).toBe(21);
    expect(out.filter(function(r) { return r.status === "measure"; })).toHaveLength(1);
  });

  it("skips requirements with no unambiguous threshold, and says why", function() {
    const out = extractThresholds(FSM_REQS);
    expect(out.find(function(r) { return r.req === "REQ-FUNC-005"; }).status).toBe("skip");
    expect(out.find(function(r) { return r.req === "REQ-FUNC-010"; }).why).toMatch(/no unambiguous/);
  });

  it("maps comparators to the right first-event point", function() {
    const rows = extractThresholds([
      { id: "A", desc: "shall assert after at least 8 clock cycles" },
      { id: "B", desc: "shall time out when idle longer than 3 cycles" },
      { id: "C", desc: "shall hold for 5 clock cycles or more" },
    ]);
    expect(rows.map(function(r) { return [r.req, r.expectedFirst]; }))
      .toEqual([["A", 8], ["B", 4], ["C", 5]]);
  });

  it("refuses to guess when a requirement names two thresholds", function() {
    const r = extractThresholds([
      { id: "D", desc: "shall wait more than 4 cycles but at least 9 clock cycles" },
    ])[0];
    expect(r.status).toBe("skip");
    expect(r.why).toMatch(/ambiguous/);
  });

  it("tolerates junk input", function() {
    expect(extractThresholds(null)).toEqual([]);
    expect(extractThresholds([{ desc: "no id" }])).toEqual([]);
  });
});

describe("probe validation — the harness owns the count", function() {
  const good = {
    precondition: "areset = 1; bp_step(); areset = 0; floor = 0;",
    applyOne: "bp_step();",
    settle: "floor = 1; bp_step();",
    eventExpr: "!(active | busy | alarm | fault)",
  };
  it("accepts a well-formed probe", function() {
    expect(validatePrimitives(good).ok).toBe(true);
  });
  it("rejects an apply_one that loops — that is the bug class, handed back to the model", function() {
    for (const bad of ["repeat (2) bp_step();", "for (int i=0;i<2;i++) bp_step();", "while (1) bp_step();", "forever bp_step();"]) {
      const r = validatePrimitives(Object.assign({}, good, { applyOne: bad }));
      expect(r.ok).toBe(false);
      expect(r.why).toMatch(/apply_one/);
    }
  });
  it("rejects fragments that escape their scope", function() {
    expect(validatePrimitives(Object.assign({}, good, { settle: "$finish;" })).ok).toBe(false);
    expect(validatePrimitives(Object.assign({}, good, { precondition: "always @(posedge clk) x <= 1;" })).ok).toBe(false);
    expect(validatePrimitives(Object.assign({}, good, { eventExpr: "" })).ok).toBe(false);
    expect(validatePrimitives(null).ok).toBe(false);
  });
});

describe("probe source", function() {
  it("emits the sweep count itself, and wires every port", function() {
    const src = buildProbeSource({
      req: "REQ-FUNC-004", n: 21, unit: "clock cycles", clk: "clk", dutName: "TopModule",
      iface: [
        { name: "clk", dir: "input", width: "1" },
        { name: "floor", dir: "input", width: "1" },
        { name: "alarm", dir: "output", width: "1" },
        { name: "count", dir: "output", width: "8" },
      ],
      primitives: {
        precondition: "floor = 0;", applyOne: "bp_step();",
        settle: "floor = 1; bp_step();", eventExpr: "!alarm",
      },
    });
    expect(src).toContain("repeat (21) bp_apply_one();");
    // The harness drives the clock and carries a watchdog: a probe that forgets
    // to tick, or one that stalls, must not hang or silently no-op the backend.
    expect(src).toContain("always #5 clk = ~clk;");
    expect(src).toMatch(/watchdog[\s\S]*\$finish/);
    expect(src).toContain("TopModule dut (.clk(clk), .floor(floor), .alarm(alarm), .count(count));");
    expect(src).toContain("logic [7:0] count;");
    expect(src).toContain("BOUNDARY_PROBE n=%0d event=%0d");
  });
});

describe("verdict", function() {
  it("finds the transition and compares it with the requirement's number", function() {
    // The real run-56 sweep: the design's first fault lands at 22, not 21.
    const broken = verdictOf({ 18: 0, 19: 0, 20: 0, 21: 0, 22: 1, 23: 1, 24: 1 }, 21);
    expect(broken.status).toBe("mismatch");
    expect(broken.measuredFirst).toBe(22);
    expect(broken.delta).toBe(1);
    // The same design with `>` changed to `>=`.
    const fixed = verdictOf({ 18: 0, 19: 0, 20: 0, 21: 1, 22: 1, 23: 1, 24: 1 }, 21);
    expect(fixed.status).toBe("match");
    expect(describeBoundary(Object.assign({ req: "REQ-FUNC-004", kind: "strict", number: 20, unit: "clock cycles" }, broken)))
      .toContain("MEASURED 22 (off by +1)");
  });

  it("never manufactures a defect from a shaky probe", function() {
    expect(verdictOf({ 1: 1, 2: 1 }, 2).status).toBe("inconclusive");            // true from the start
    expect(verdictOf({ 1: 0, 2: 0 }, 2).status).toBe("inconclusive");            // never fires
    expect(verdictOf({ 1: 0, 2: 1, 3: 0, 4: 1 }, 2).status).toBe("inconclusive");// toggles back off
    expect(verdictOf({ 3: 0 }, 3).status).toBe("inconclusive");                  // one sample
  });
});

describe("the gate end to end (fake backend)", function() {
  const IFACE = [
    { name: "clk", dir: "input", width: "1" },
    { name: "floor", dir: "input", width: "1" },
    { name: "active", dir: "output", width: "1" },
  ];
  const PRIMS = {
    applicable: true, quantity: "descending cycles",
    precondition: "floor = 0;", applyOne: "bp_step();",
    settle: "floor = 1; bp_step();", eventExpr: "!active",
  };
  function gateArgs(firstEventAt, over) {
    return Object.assign({
      rtl: "module TopModule; endmodule",
      iface: IFACE, requirements: FSM_REQS, clk: "clk", dutName: "TopModule",
      cmds: ["iverilog {SRCS} {TB}"], rtlFileName: "TopModule.sv",
      config: { backendUrl: "local" }, cliOpts: {}, signal: null,
      appendLog: function() {},
      askPrimitives: async function() { return PRIMS; },
    }, over || {});
  }

  it("reports a mismatch when the design's transition is late", async function() {
    // Stub simulator: this design only faults from 22 descending cycles — the
    // real run-56 behaviour. The sweep must find 22 where the requirement implies 21.
    let calls = 0;
    const rows = await runBoundaryGate(gateArgs(null, {
      runCli: async function(_url, payload) {
        calls++;
        const src = payload.files["boundary_probe.sv"];
        const n = parseInt(/repeat \((\d+)\)/.exec(src)[1], 10);
        return { exitCode: 0, stdout: "BOUNDARY_PROBE n=" + n + " event=" + (n >= 22 ? 1 : 0) };
      },
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0].req).toBe("REQ-FUNC-004");
    expect(rows[0].status).toBe("mismatch");
    expect(rows[0].measuredFirst).toBe(22);
    expect(rows[0].expectedFirst).toBe(21);
    expect(calls).toBe(7);   // one small sim per point in the window

    // The same probe against a design that splats from 21 → match.
    const fixed = await runBoundaryGate(gateArgs(null, {
      runCli: async function(_url, payload) {
        const n = parseInt(/repeat \((\d+)\)/.exec(payload.files["boundary_probe.sv"])[1], 10);
        return { exitCode: 0, stdout: "BOUNDARY_PROBE n=" + n + " event=" + (n >= 21 ? 1 : 0) };
      },
    }));
    expect(fixed[0].status).toBe("match");
  });

  it("is inconclusive, not failing, when the backend errors mid-sweep", async function() {
    const rows = await runBoundaryGate(gateArgs(null, {
      runCli: async function() { return { _error: "backend down" }; },
    }));
    expect(rows[0].status).toBe("inconclusive");
    expect(rows[0].why).toMatch(/backend error/);
  });

  it("returns null when no requirement carries a measurable threshold", async function() {
    const rows = await runBoundaryGate(gateArgs(null, { requirements: [FSM_REQS[1]] }));
    expect(rows).toBeNull();
  });

  it("records the reason when the model says the threshold has no observable event", async function() {
    const rows = await runBoundaryGate(gateArgs(null, {
      askPrimitives: async function() { return { applicable: false, reason: "internal counter only" }; },
    }));
    expect(rows[0].status).toBe("inconclusive");
    expect(rows[0].why).toMatch(/internal counter only/);
  });

  it("rejects a looping probe rather than measuring with it", async function() {
    const rows = await runBoundaryGate(gateArgs(null, {
      askPrimitives: async function() { return Object.assign({}, PRIMS, { applyOne: "repeat (2) bp_step();" }); },
    }));
    expect(rows[0].status).toBe("inconclusive");
    expect(rows[0].why).toMatch(/repeat/);
  });
});

describe("eval gate integration", function() {
  function stateWith(boundaries) {
    return {
      spec: { requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "x" }] },
      rtl_generate: { code: "module m; endmodule" },
      test_generate: { code: "module tb; endmodule" },
      lint: { status: "PASS", errors: [], warnings: [] },
      verify: {
        total: 1, pass: 1, fail: 0, cli: true,
        tests: [{ name: "t", st: "PASS", req: "REQ-FUNC-001" }],
        boundaries: boundaries,
      },
    };
  }
  const MISMATCH = [{ req: "REQ-FUNC-004", status: "mismatch", measuredFirst: 22, expectedFirst: 21, delta: 1 }];
  const MATCH = [{ req: "REQ-FUNC-004", status: "match", measuredFirst: 21, expectedFirst: 21, delta: 0 }];

  it("fails an otherwise-green run whose measured threshold is off, and names both numbers", function() {
    const v = runEvalGate(stateWith(MISMATCH), defaultEvalConfig());
    const row = v.results.find(function(r) { return r.id === "boundary_match"; });
    expect(row.status).toBe("FAIL");
    expect(row.detail).toContain("measured first event at 22");
    expect(row.detail).toContain("implies 21");
    expect(v.overall).toBe("FAIL");
    // The design implements the number wrongly — route to the RTL, not the TB.
    expect(triageTargetsFor(v)[0]).toBe("rtl_generate");
  });

  it("passes when the measurement agrees", function() {
    const v = runEvalGate(stateWith(MATCH), defaultEvalConfig());
    expect(v.results.find(function(r) { return r.id === "boundary_match"; }).status).toBe("PASS");
    expect(v.overall).toBe("PASS");
  });

  it("skips — never fails — when nothing was measurable", function() {
    for (const b of [null, [], [{ req: "X", status: "inconclusive", why: "no event" }]]) {
      const v = runEvalGate(stateWith(b), defaultEvalConfig());
      expect(v.results.find(function(r) { return r.id === "boundary_match"; }).status).toBe("SKIP");
      expect(v.overall).toBe("PASS");
    }
  });
});
