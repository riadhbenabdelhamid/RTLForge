// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// TB adoption lint gate (run 39). test_review's top-level pass adopted a
// headerless chain candidate carrying 7 compile errors — it had only the
// infra-loss check and a verdict downgrade that rejects nothing, while
// rtl_review has had a lint gate since run 7. Every downstream stage then
// worked on or around that corruption. The gate must reject a candidate that
// lints worse than the TB it replaces, keep the loop retrying to the cap
// (a rejection is not a no-op, bad6727), and record why.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/llm/index.js", async function() {
  const actual = await vi.importActual("../src/llm/extractJSON.js");
  return { callLLM: vi.fn(), extractJSON: actual.extractJSON, addRetryHint: function(s) { return s; } };
});
vi.mock("../src/cli/index.js", function() {
  return {
    extractInfoEvidence: function() { return []; },
    attachInfoEvidence: function(t) { return t; },
    runCli: vi.fn(),
    parseCLIOutput: function(stderr) {
      const all = String(stderr || "").split("\n");
      return {
        errors: all.filter(function(l) { return l.indexOf("%Error") === 0; })
          .map(function(l) { return { code: "SYNTAX", sev: "error", msg: l }; }),
        warnings: all.filter(function(l) { return l.indexOf("%Warning-") === 0; })
          .map(function(l) {
            const m = l.match(/^%Warning-(\w+)/);
            return { code: m ? m[1] : "UNKNOWN", sev: "warning", msg: l };
          }),
      };
    },
    parseTestLine: function() { return null; },
    parseCoverageDat: function() { return { line: 90, branch: 80, toggle: 70 }; },
    CliBackendError: class extends Error {},
  };
});

const { callLLM } = await import("../src/llm/index.js");
const { runCli } = await import("../src/cli/index.js");
const { testReviewNode } = await import("../src/pipeline/nodes/test_review.js");

// A TB with real infrastructure so detectTbInfraLoss stays quiet — the gate
// under test is the LINT one, not the infra one.
const GOOD_TB = [
  "module ctr_tb;",
  "  logic clk, rst_n, en;",
  "  logic [3:0] q;",
  "  int ref_count;",
  "  ctr dut(.clk(clk), .rst_n(rst_n), .en(en), .q(q));",
  "  task automatic check(input bit cond, input string label);",
  "  endtask",
  "  task automatic step(input int n = 1);",
  "  endtask",
  "  initial begin",
  "    check(q == ref_count, \"REQ-FUNC-001.1\");",
  "  end",
  "endmodule",
].join("\n");
// The run-39 shape: headerless (module line gone), infra intact.
const HEADERLESS = GOOD_TB.split("\n").slice(1).join("\n");
// A candidate that KEEPS its header but lints worse — exercises the LINT gate
// specifically (a headerless one is now caught earlier by the e4f4104 header
// floor in detectTbInfraLoss, which is its own test below).
const BROKEN_HEADERED = GOOD_TB.replace("initial begin", "initial begin BROKEN");

const llmReply = (j) => ({ text: JSON.stringify(j), tokensIn: 1, tokensOut: 1,
  latencyMs: 1, model: "m", provider: "openai", stopReason: "stop" });
const NEEDS_FIX = { verdict: "NEEDS_FIX", score: 40, issues: [
  { id: "TR-001", severity: "critical", category: "correctness", description: "x", fix: "y" }] };

function state(cfg) {
  return {
    elicit: { modName: "ctr" },
    spec: { modName: "ctr", requirements: [], iface: [], params: [] },
    rtl_generate: { code: "module ctr(input logic clk, input logic rst_n, input logic en, output logic [3:0] q); endmodule" },
    test_generate: { code: GOOD_TB },
    _config: Object.assign({
      provider: "openai", model: "gpt-4o", apiKey: "sk-test",
      maxTestReviewIters: 2, backendUrl: "http://localhost:3001",
      strictCli: false, cliRetryCount: 0, backendTimeoutSec: 10, stageSettings: {},
    }, cfg || {}),
    _onLog: null, _signal: null,
    // no _services → legacy inline path
  };
}

// Lint result keyed on content: headerless TB → 7 errors, good TB → 0.
function lintByContent(url, payload) {
  const tb = payload.files["ctr_tb.sv"] || "";
  const bad = tb.indexOf("BROKEN") >= 0 || tb.indexOf("module ctr_tb;") < 0;
  const errs = bad
    ? Array.from({ length: 7 }, (_, i) => "%Error: ctr_tb.sv:" + (i + 2) + ":1: syntax error\n").join("")
    : "";
  return Promise.resolve({ stdout: "", stderr: errs, exitCode: bad ? 1 : 0 });
}

beforeEach(() => { callLLM.mockReset(); runCli.mockReset(); });

describe("test_review TB adoption lint gate (run 39)", () => {
  it("rejects a candidate that lints worse, records why, and retries to the cap", async () => {
    runCli.mockImplementation(lintByContent);
    callLLM
      .mockResolvedValueOnce(llmReply(NEEDS_FIX))                                  // initial review
      .mockResolvedValue(llmReply({ code: BROKEN_HEADERED, fixes: ["broke it"] })); // every fix lints worse

    const d = await testReviewNode(state());

    expect(d.test_generate.code).toBe(GOOD_TB);                  // never adopted
    const rejected = d.test_review._iterations.filter((i) =>
      i._structured && /^rejected:errors/.test(i._structured.fixOutcome || ""));
    expect(rejected.length).toBe(2);                             // retried to cap 2, both rejected
    // 1 review + 2 fix attempts; no re-review of unchanged code
    expect(callLLM).toHaveBeenCalledTimes(3);
  });

  it("adopts a clean candidate exactly as before", async () => {
    runCli.mockImplementation(lintByContent);
    const improved = GOOD_TB.replace("// none", "").replace("check(q ==", "check (q ==");
    callLLM
      .mockResolvedValueOnce(llmReply(NEEDS_FIX))
      .mockResolvedValueOnce(llmReply({ code: improved, fixes: ["tweak"] }))
      .mockResolvedValue(llmReply({ verdict: "PASS", score: 90, issues: [] }));

    const d = await testReviewNode(state());
    expect(d.test_generate.code).toBe(improved);
    expect(d.test_review.verdict).toBe("PASS");
  });

  it("no backend → the LINT gate abstains and a headered candidate is adopted", async () => {
    callLLM
      .mockResolvedValueOnce(llmReply(NEEDS_FIX))
      .mockResolvedValueOnce(llmReply({ code: BROKEN_HEADERED, fixes: ["x"] }))
      .mockResolvedValue(llmReply({ verdict: "PASS", score: 90, issues: [] }));

    const d = await testReviewNode(state({ backendUrl: "" }));
    expect(d.test_generate.code).toBe(BROKEN_HEADERED);          // lint gate abstains without CLI
    expect(runCli).not.toHaveBeenCalled();
  });

  it("a HEADERLESS candidate is rejected even with no backend — the header floor needs no CLI", async () => {
    callLLM
      .mockResolvedValueOnce(llmReply(NEEDS_FIX))
      .mockResolvedValue(llmReply({ code: HEADERLESS, fixes: ["dropped header"] }));

    const d = await testReviewNode(state({ backendUrl: "" }));
    expect(d.test_generate.code).toBe(GOOD_TB);                  // e4f4104 floor held
    const infra = d.test_review._iterations.filter((i) =>
      i._structured && /^rejected:infra/.test(i._structured.fixOutcome || ""));
    expect(infra.length).toBeGreaterThan(0);                     // recorded, not "identical"
  });
});
