// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Self-referential-check detection (measured: gpt-oss-20b run 13, sync FIFO).
// The TB "verified" a design with a pointer-width bug (capacity DEPTH-1,
// wrap corruption losing all stored words) at 20/20 because checks like
// check(ref_count == DEPTH) compare the reference model TO ITSELF. A check
// whose condition mentions no DUT-connected signal verifies nothing; a
// requirement whose every check is such is unverified — deterministically.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  analyzeCheckCoverage, dutConnectedSignals, extractChecks, checkForwardingTasks,
  constantCondition, weakCondition,
} from "../src/pipeline/tbCheckCoverage.js";

vi.mock("../src/llm/index.js", async function() {
  const actual = await vi.importActual("../src/llm/extractJSON.js");
  return { callLLM: vi.fn(), extractJSON: actual.extractJSON, addRetryHint: function(s) { return s; } };
});

const { callLLM } = await import("../src/llm/index.js");
const { testReviewNode } = await import("../src/pipeline/nodes/test_review.js");

const BAD_TB = [
  "module fifo_tb;",
  "logic clk, wr_en, full;",
  "logic [7:0] dout;",
  "int ref_count;",
  "logic [7:0] ref_dout;",
  "task automatic check(input bit cond, input string label);",
  "endtask",
  "task automatic step(input int n = 1);",
  "endtask",
  "synchronous_fifo dut(.clk(clk), .wr_en(wr_en), .dout(dout), .full(full));",
  "initial begin",
  "  // the run-13 pattern: the reference model checked against itself",
  "  check(ref_count == 16, \"REQ-FUNC-001.1\");",
  "  check(ref_dout == 8'h00, \"REQ-FUNC-001.2\");",
  "  check(dout == ref_dout, \"REQ-FUNC-002.1\");",
  "end",
  "endmodule",
].join("\n");

const GOOD_TB = BAD_TB
  .replace("check(ref_count == 16, \"REQ-FUNC-001.1\");",
           "check(full == 1'b1, \"REQ-FUNC-001.1\");")
  .replace("check(ref_dout == 8'h00, \"REQ-FUNC-001.2\");",
           "check(dout == ref_dout, \"REQ-FUNC-001.2\");");

describe("analyzeCheckCoverage", function() {
  it("flags requirements whose every check is self-referential (run 13)", function() {
    const a = analyzeCheckCoverage(BAD_TB);
    expect(a.total).toBe(3);
    expect(a.dutObserving).toBe(1);
    expect(a.unverifiedReqs).toEqual(["REQ-FUNC-001"]);
  });

  it("passes a TB whose checks observe DUT signals", function() {
    const a = analyzeCheckCoverage(GOOD_TB);
    expect(a.unverifiedReqs).toEqual([]);
    expect(a.dutObserving).toBe(3);
  });

  it("skips the check task's own declaration", function() {
    const checks = extractChecks(BAD_TB);
    expect(checks.length).toBe(3);
    expect(checks.every(function(c) { return !/input/.test(c.cond); })).toBe(true);
  });

  it("collects DUT-connected signal names from the port map", function() {
    const s = dutConnectedSignals(BAD_TB);
    expect(s.has("dout")).toBe(true);
    expect(s.has("full")).toBe(true);
    expect(s.has("ref_count")).toBe(false);
  });

  it("ignores signal names inside strings and comments", function() {
    const tb = [
      "module tb;",
      "logic q; logic ref_q;",
      "dut d(.q(q));",
      "task automatic check(input bit c, input string l); endtask",
      "initial check(ref_q == 1, \"REQ-FUNC-001.1\"); // q mentioned here",
      "endmodule",
    ].join("\n");
    expect(analyzeCheckCoverage(tb).unverifiedReqs).toEqual(["REQ-FUNC-001"]);
  });
});

describe("testReviewNode check-coverage enforcement", function() {
  function state(tb) {
    return {
      test_generate: { code: tb },
      rtl_generate: { code: "module synchronous_fifo(input clk); endmodule" },
      spec: { requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "cap" }], iface: [], params: [] },
      elicit: { modName: "synchronous_fifo" },
      _config: { provider: "openai", model: "m", apiKey: "k", stageSettings: {}, maxTestReviewIters: 2 },
      _onLog: vi.fn(),
    };
  }
  const reply = (json) => ({
    text: JSON.stringify(json), tokensIn: 1, tokensOut: 1, latencyMs: 1,
    model: "m", provider: "openai", stopReason: "stop",
  });

  beforeEach(function() { callLLM.mockReset(); });

  it("forces NEEDS_FIX on a blind PASS, and the fix loop clears it with a DUT-observing TB", async function() {
    callLLM
      // initial review: the LLM is blind to the self-referential checks
      .mockResolvedValueOnce(reply({ verdict: "PASS", score: 95, issues: [] }))
      // fix call: returns a TB whose checks observe the DUT
      .mockResolvedValueOnce(reply({ code: GOOD_TB, fixes: ["observe DUT outputs"] }))
      // re-review: clean
      .mockResolvedValueOnce(reply({ verdict: "PASS", score: 95, issues: [] }));
    const st = state(BAD_TB);
    const out = await testReviewNode(st);

    // The initial review was overridden deterministically…
    expect(out.test_review._iterations[0].verdict).toBe("NEEDS_FIX");
    // …with the injected critical issue naming the requirement…
    const logs = st._onLog.mock.calls.map(function(c) { return c[0]; }).join("\n");
    expect(logs).toMatch(/NON-DISCRIMINATING CHECKS/);
    expect(logs).toMatch(/REQ-FUNC-001/);
    // …and the fix loop adopted the DUT-observing TB, ending clean.
    expect(out.test_review.verdict).toBe("PASS");
    expect(out.test_generate.code).toContain("check(full == 1'b1");
  });

  it("leaves a DUT-observing TB's PASS untouched (single LLM call)", async function() {
    callLLM.mockResolvedValueOnce(reply({ verdict: "PASS", score: 96, issues: [] }));
    const out = await testReviewNode(state(GOOD_TB));
    expect(out.test_review.verdict).toBe("PASS");
    expect(callLLM).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Comparison helpers (run 45). The analysis scanned only `check(` calls, so a
// testbench that routes its comparison through a helper —
//   check_val(dout, ref_dout, "REQ-FUNC-001.1")
// — hid the DUT port one call deep, and four requirements were wrongly forced
// critical as "compares the reference model to itself". A forwarding call's
// condition is its ARGUMENT list; the guard keeps its teeth when those
// arguments contain no DUT signal.
// ═══════════════════════════════════════════════════════════════════════════
describe("check coverage through a forwarding helper (run 45)", () => {
  const tb = (call) => `module tb;
  logic [31:0] dout, ref_dout;
  dut u (.dout(dout));
  task automatic check(input logic c, input string l); endtask
  task automatic check_val(input logic [31:0] got, input logic [31:0] exp, input string l);
    if (got !== exp) $display("mismatch");
    check(got === exp, l);
  endtask
  initial begin ${call} end
endmodule`;

  it("a DUT signal passed through the helper counts as observed", () => {
    const cov = analyzeCheckCoverage(tb('check_val(dout, ref_dout, "REQ-FUNC-001.1");'));
    expect(cov.unverifiedReqs).toEqual([]);
    expect(cov.dutObserving).toBeGreaterThan(0);
  });

  it("a helper called with only reference signals is still caught", () => {
    const cov = analyzeCheckCoverage(tb('check_val(ref_dout, ref_dout, "REQ-FUNC-001.1");'));
    expect(cov.unverifiedReqs).toEqual(["REQ-FUNC-001"]);
  });

  it("a direct check() is unaffected", () => {
    const cov = analyzeCheckCoverage(tb('check(dout === ref_dout, "REQ-FUNC-002.1");'));
    expect(cov.unverifiedReqs).toEqual([]);
  });

  it("a task that never calls check() is not treated as a forwarder", () => {
    const src = `module tb;
  logic [31:0] dout; dut u (.dout(dout));
  task automatic check(input logic c, input string l); endtask
  task automatic drive(input logic [31:0] v, input string l); $display("%0d", v); endtask
  initial begin drive(dout, "REQ-FUNC-003.1"); check(1'b1, "REQ-FUNC-003.2"); end
endmodule`;
    const cov = analyzeCheckCoverage(src);
    // drive() is not a check, so REQ-FUNC-003 rests on the bare check(1'b1)
    expect(cov.unverifiedReqs).toEqual(["REQ-FUNC-003"]);
  });

  it("checkForwardingTasks finds the helper and its formals", () => {
    const f = checkForwardingTasks(tb('check_val(dout, ref_dout, "REQ-FUNC-001.1");'));
    expect(Array.from(f.keys())).toEqual(["check_val"]);
    expect(f.get("check_val").args).toContain("got");
    expect(f.get("check_val").args).toContain("exp");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Non-discriminating checks (run 46). Observing a DUT signal is not enough
// to make a check meaningful. A local model shipped a testbench containing
//   check(1, "REQ-FUNC-003.1")              always passes
//   check($isunknown(0), "REQ-INTF-001.1")  always fails
// The first mentions no signal so the DUT-signal test caught it; the second
// looks like a call and sailed through. Constant conditions are gated;
// weaker shapes are reported but never gate, because each has a legitimate
// use and a false positive costs a wasted fix round.
// ═══════════════════════════════════════════════════════════════════════════
describe("constantCondition (run 46)", () => {
  it("recognises the always-true literals", () => {
    for (const c of ["1", "1'b1", "'1", "(1)", " 1'd1 "]) expect(constantCondition(c)).toBe("true");
  });

  it("recognises the always-false literals and $isunknown of a constant", () => {
    for (const c of ["0", "1'b0", "'0", "$isunknown(0)", "$isunknown(8'hFF)"]) {
      expect(constantCondition(c)).toBe("false");
    }
  });

  it("leaves real conditions alone", () => {
    for (const c of ["dout === ref_dout", "busy && !done", "$isunknown(dout)", "cnt == 8'd10"]) {
      expect(constantCondition(c)).toBeNull();
    }
  });
});

describe("weakCondition (run 46)", () => {
  const connected = new Set(["digest", "dout", "q"]);

  it("flags an inequality against a bare literal", () => {
    expect(weakCondition("digest !== '0", connected)).toBe("inequality-against-literal");
    expect(weakCondition("digest !== 256'hDEF", connected)).toBe("inequality-against-literal");
  });

  it("flags a DUT output compared against a function of itself", () => {
    expect(weakCondition("digest[31:0] === (digest[0] + 1)", connected)).toBe("self-comparison");
  });

  it("does NOT flag a stability check through $past", () => {
    expect(weakCondition("q === $past(q)", connected)).toBeNull();
    expect(weakCondition("$stable(q)", connected)).toBeNull();
  });

  it("does NOT flag a comparison against a reference signal", () => {
    expect(weakCondition("dout === ref_dout", connected)).toBeNull();
    expect(weakCondition("digest === DIG_ABC", connected)).toBeNull();
  });

  it("analyzeCheckCoverage separates constant, weak and unverified", () => {
    const src = `module tb;
  logic [31:0] dout, ref_dout;
  dut u (.dout(dout));
  task automatic check(input logic c, input string l); endtask
  initial begin
    check(1, "REQ-FUNC-001.1");
    check($isunknown(0), "REQ-FUNC-002.1");
    check(dout !== 32'h0, "REQ-FUNC-003.1");
    check(dout === ref_dout, "REQ-FUNC-004.1");
  end
endmodule`;
    const cov = analyzeCheckCoverage(src);
    expect(cov.constantChecks.map((c) => c.always)).toEqual(["true", "false"]);
    expect(cov.weakChecks.map((w) => w.kind)).toEqual(["inequality-against-literal"]);
    // the two constant checks carry requirements that nothing else verifies
    expect(cov.unverifiedReqs).toContain("REQ-FUNC-001");
    expect(cov.unverifiedReqs).toContain("REQ-FUNC-002");
    expect(cov.unverifiedReqs).not.toContain("REQ-FUNC-004");
  });
});
