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
  analyzeCheckCoverage, dutConnectedSignals, extractChecks,
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
    expect(logs).toMatch(/SELF-REFERENTIAL CHECKS/);
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
