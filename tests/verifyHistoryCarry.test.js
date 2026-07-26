// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// verifyHistory carry-forward (fixture-replay finding on run 19's final
// checkpoint): a nested verify run — the tail of a judge reflow chain —
// REPLACED the outer verify slot wholesale, clobbering the investigated
// history (40/63 + "pointer truncation" reason) down to a bare [{iter:1}].
// Prior entries now ride forward tagged _prior (capped), so the judge's
// investigation steer, triageFlipTarget, and attemptRowsFromHistory keep
// their signal across judge reflows.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/llm/index.js", async function() {
  const actual = await vi.importActual("../src/llm/extractJSON.js");
  return { callLLM: vi.fn(), extractJSON: actual.extractJSON, addRetryHint: function(s) { return s; } };
});
vi.mock("../src/cli/index.js", function() {
  return {
    extractInfoEvidence: function() { return {}; },
    runCli: vi.fn(),
    parseTestLine: function(l) {
      const m = /\[(PASS|FAIL)\] (\S+)/.exec(l);
      return m ? { name: m[2], status: m[1], cyc: 1, ms: 1 } : null;
    },
    parseCLIOutput: function() { return { errors: [], warnings: [] }; },
    parseCoverageDat: function() { return { line: 90, branch: 80, toggle: 70 }; },
    CliBackendError: class extends Error {},
  };
});

const { verifyNode } = await import("../src/pipeline/nodes/verify.js");
const { callLLM } = await import("../src/llm/index.js");
const { runCli } = await import("../src/cli/index.js");
const { attemptRowsFromHistory } = await import("../src/pipeline/fixLoopHelpers.js");

const PRIOR = [{
  iter: 1, pass: 40, total: 63,
  triageTarget: "rtl_generate", triageInvestigated: true,
  triageReason: "waveform investigation (1 probe): pointer truncation prevents full assertion",
}];

function state() {
  return {
    elicit: { modName: "ctr" },
    spec: { modName: "ctr", requirements: [], iface: [], params: [] },
    rtl_generate: { code: "module ctr; endmodule" },
    test_generate: { code: "module ctr_tb; endmodule" },
    // The OUTER verify result a judge-chain nested verify would previously clobber:
    verify: { sim: "Verilator (CLI)", cli: true, pass: 40, fail: 23, total: 63, tests: [], log: "", verifyHistory: PRIOR },
    _config: {
      provider: "openai", model: "m", apiKey: "k", stageSettings: {},
      maxVerifyIters: 1, backendUrl: "http://x", strictCli: false,
      simCmds: "sim {RTL} {TB}", cliRetryCount: 0, backendTimeoutSec: 10,
      triageInvestigation: false,
    },
    _onLog: null, _signal: null,
  };
}

beforeEach(function() {
  callLLM.mockReset();
  runCli.mockReset();
});

describe("verifyHistory carry-forward", function() {
  it("prior investigated entries survive a nested re-run, tagged _prior, pairing intact", async function() {
    runCli.mockResolvedValue({ stdout: "[PASS] T1\n[FAIL] T2\n", stderr: "", exitCode: 1 });
    const d = await verifyNode(state());
    const hist = d.verify.verifyHistory;
    expect(hist.length).toBe(2);
    expect(hist[0]._prior).toBe(true);
    expect(hist[0].triageInvestigated).toBe(true);
    expect(hist[0].triageReason).toMatch(/pointer truncation/);
    expect(hist[1]._prior).toBeUndefined();
    // Pairing semantics: the prior tail's triage decision meets THIS run's
    // first measurement as its outcome (1 pass / 2 total here).
    const rows = attemptRowsFromHistory(hist);
    expect(rows.length).toBe(1);
    expect(rows[0].target).toBe("rtl_generate");
    expect(rows[0].pass).toBe(1);
  });

  it("no prior verify → history unchanged from before (no phantom entries)", async function() {
    runCli.mockResolvedValue({ stdout: "[PASS] T1\n", stderr: "", exitCode: 0 });
    const st = state();
    delete st.verify;
    const d = await verifyNode(st);
    expect(d.verify.verifyHistory.length).toBe(1);
    expect(d.verify.verifyHistory[0]._prior).toBeUndefined();
  });

  it("carry is capped — repeated nesting cannot grow the history without bound", async function() {
    runCli.mockResolvedValue({ stdout: "[PASS] T1\n", stderr: "", exitCode: 0 });
    const st = state();
    st.verify.verifyHistory = new Array(30).fill(0).map(function(_, i) {
      return { iter: i + 1, pass: i, total: 63, triageTarget: "test_generate" };
    });
    const d = await verifyNode(st);
    expect(d.verify.verifyHistory.length).toBeLessThanOrEqual(12);
    // The newest (this run's) entry is always kept.
    expect(d.verify.verifyHistory[d.verify.verifyHistory.length - 1]._prior).toBeUndefined();
  });
});
