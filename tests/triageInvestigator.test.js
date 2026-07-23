// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// triageInvestigator — waveform-grounded verify triage (run 18).
//
// Pins the probe-loop contract: the model requests VCD windows and must
// return a grounded verdict; the loop is strictly bounded; every failure
// path (no VCD, transport error, persistent malformed output, no verdict on
// the forced round) returns null so the caller's one-shot triage takes over.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/llm/index.js", function() {
  return {
    callLLM: vi.fn(),
    extractJSON: function(t) { return JSON.parse(t); },
  };
});

const { callLLM } = await import("../src/llm/index.js");
const { investigateTriage, answerProbe } = await import("../src/pipeline/triageInvestigator.js");

// A minimal but real VCD: clk, dout[8], rd_en across three times.
const VCD = `$scope module tb $end
$var wire 1 ! clk $end
$var wire 8 " dout $end
$scope module dut $end
$var wire 1 # rd_en $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
0!
b00000000 "
0#
#100
1!
1#
#200
0!
b00000101 "
`;

const TESTS = [
  { name: "REQ-FUNC-003.3", st: "FAIL", req: "REQ-FUNC-003", evidence: "dout changed without a read" },
  { name: "REQ-FUNC-001.1", st: "PASS" },
];
const SPEC = { requirements: [
  { id: "REQ-FUNC-003", pri: "Must", desc: "dout updates only on an accepted read" },
] };

function reply(obj) {
  return Promise.resolve({ text: JSON.stringify(obj), tokensIn: 10, tokensOut: 5, latencyMs: 1, model: "m" });
}

function baseOpts(extra) {
  return Object.assign({
    vcdText: VCD, simOut: "[FAIL] REQ-FUNC-003.3 @63 cycles @ t=200",
    tests: TESTS, spec: SPEC,
    rtlCode: "module sync_fifo; endmodule", tbCode: "module tb; endmodule",
    llmConfig: {}, maxProbes: 3, allLlms: [],
  }, extra);
}

beforeEach(function() { callLLM.mockReset(); });

describe("answerProbe", function() {
  it("renders a window for requested signals and never throws on garbage", function() {
    const w = answerProbe(VCD, { signals: ["dout", "rd_en"], aroundTime: 200, span: 150 });
    expect(w).toContain("dout");
    expect(w).toContain("00000101");
    expect(typeof answerProbe(VCD, null)).toBe("string");
    expect(typeof answerProbe("", { signals: ["x"] })).toBe("string");
  });
});

describe("investigateTriage", function() {
  it("probe → verdict: returns the grounded verdict with the probe transcript", async function() {
    callLLM
      .mockImplementationOnce(function(req) {
        // The static brief carries spec, failing checks, code, and inventory.
        expect(req.userMessage).toContain("WAVEFORM ORACLE");
        expect(req.userMessage).toContain("REQ-FUNC-003");
        expect(req.userMessage).toContain("tb.dout");
        return reply({ probe: { signals: ["dout", "rd_en"], aroundTime: 200, span: 150 } });
      })
      .mockImplementationOnce(function(req) {
        // Round 2 sees the answered window appended after the stable brief.
        expect(req.userMessage).toContain("PROBE 1");
        expect(req.userMessage).toContain("00000101");
        return reply({ verdict: { target: "rtl_generate",
          reason: "dout changed at t=200 with rd_en low",
          evidence: "dout 00000000→00000101 at #200, rd_en=0" } });
      });
    const allLlms = [];
    const r = await investigateTriage(baseOpts({ allLlms: allLlms, iter: 2 }));
    expect(r.target).toBe("rtl_generate");
    expect(r.evidence).toContain("rd_en=0");
    expect(r.probes.length).toBe(1);
    expect(allLlms.length).toBe(2);
    expect(allLlms[0].stage).toBe("verify-triage-probe-2.1");
  });

  it("REJECTS a zero-probe verdict, accepts after a real probe (run 20: fabricated 'observed' claims)", async function() {
    callLLM
      .mockReturnValueOnce(reply({ verdict: { target: "test_generate", reason: "r", evidence: "at t=306000 dout shows 8'h01" } }))
      .mockImplementationOnce(function(req) {
        expect(req.userMessage).toContain("VERDICT REJECTED");
        expect(req.userMessage).toContain("fabricated");
        return reply({ probe: { signals: ["dout"], aroundTime: 200, span: 150 } });
      })
      .mockReturnValueOnce(reply({ verdict: { target: "test_generate", reason: "r", evidence: "e" } }));
    const r = await investigateTriage(baseOpts());
    expect(r.target).toBe("test_generate");
    expect(r.probes.length).toBe(1);
  });

  it("a second zero-probe verdict ends the investigation (null → classic triage)", async function() {
    callLLM.mockReturnValue(reply({ verdict: { target: "rtl_generate", reason: "r", evidence: "e" } }));
    expect(await investigateTriage(baseOpts())).toBeNull();
    expect(callLLM).toHaveBeenCalledTimes(2);
  });

  it("maxProbes 0 skips the investigation entirely — nothing can be grounded", async function() {
    expect(await investigateTriage(baseOpts({ maxProbes: 0 }))).toBeNull();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("is strictly bounded: probing forever ends with a forced round, then null", async function() {
    callLLM.mockImplementation(function(req) {
      // The final round announces 0 probes remaining and demands the verdict.
      if (req.userMessage.indexOf("0 probes remaining") >= 0) {
        return reply({ probe: { signals: ["clk"] } });  // model STILL probes → null
      }
      return reply({ probe: { signals: ["clk"], aroundTime: 100 } });
    });
    const r = await investigateTriage(baseOpts({ maxProbes: 2 }));
    expect(r).toBeNull();
    expect(callLLM).toHaveBeenCalledTimes(3);  // 2 probe rounds + forced round
  });

  it("nudges once on a malformed turn, then gives up on the second", async function() {
    callLLM
      .mockReturnValueOnce(reply({ nonsense: true }))
      .mockImplementationOnce(function(req) {
        expect(req.userMessage).toContain("MALFORMED RESPONSE");
        return reply({ probe: { signals: ["dout"], aroundTime: 200 } });
      })
      .mockReturnValueOnce(reply({ verdict: { target: "rtl_generate", reason: "r", evidence: "e" } }));
    const r = await investigateTriage(baseOpts());
    expect(r.target).toBe("rtl_generate");

    callLLM.mockReset();
    callLLM.mockReturnValue(reply({ nonsense: true }));
    expect(await investigateTriage(baseOpts())).toBeNull();
  });

  it("rejects verdicts with invalid targets", async function() {
    callLLM.mockReturnValue(reply({ verdict: { target: "spec", reason: "r" } }));
    expect(await investigateTriage(baseOpts({ maxProbes: 2 }))).toBeNull();
  });

  it("returns null without a usable VCD or on transport failure", async function() {
    expect(await investigateTriage(baseOpts({ vcdText: null }))).toBeNull();
    expect(await investigateTriage(baseOpts({ vcdText: "not a vcd" }))).toBeNull();
    expect(callLLM).not.toHaveBeenCalled();
    callLLM.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await investigateTriage(baseOpts())).toBeNull();
  });
});
