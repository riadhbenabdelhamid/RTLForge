import { describe, expect, it, vi, beforeEach } from "vitest";

const llmPrompts = [];
const llmQueue = [];
const cliQueue = [];

vi.mock("../src/llm/index.js", function() {
  return {
    callLLMJson: vi.fn(async function(prompt) {
      llmPrompts.push(prompt);
      if (!llmQueue.length) throw new Error("unexpected LLM call");
      const data = llmQueue.shift();
      return { data, llms: [{ model: "stub", provider: "stub", tokensIn: 3, tokensOut: 4, latencyMs: 1 }] };
    }),
    callLLM: vi.fn(),
    addRetryHint: function(prompt) { return prompt; },
    extractJSON: function(text) { return JSON.parse(text); },
  };
});

vi.mock("../src/cli/index.js", function() {
  return {
    runCli: vi.fn(async function() {
      if (!cliQueue.length) throw new Error("unexpected CLI call");
      const result = cliQueue.shift();
      if (result instanceof Error) throw result;
      return result;
    }),
    parseCLIOutput: function() { return { errors: [], warnings: [] }; },
    parseTestLine: function(line) {
      const m = /\[(PASS|FAIL)\]\s+(\S+)/.exec(line || "");
      return m ? { status: m[1], name: m[2], cyc: 1, ms: 1 } : null;
    },
    extractInfoEvidence: function() { return []; },
    attachInfoEvidence: function(tests) { return tests; },
    parseCoverageDat: function() { return { line: 100, branch: 100, toggle: 100 }; },
    CliBackendError: class CliBackendError extends Error {},
  };
});

const { rtlGenerateNode } = await import("../src/pipeline/nodes/rtl_generate.js");
const { testGenerateNode } = await import("../src/pipeline/nodes/test_generate.js");
const { verifyNode } = await import("../src/pipeline/nodes/verify.js");
const { serializeCheckpoint } = await import("../src/projectState/checkpoint.js");

const RTL_STANDALONE = "module m(input logic clk); logic x; endmodule";
const RTL_PIPELINE = "module m(input logic clk); logic x; assign x = clk; endmodule";
const TB_STANDALONE = "module m_tb; initial begin void'($urandom(32'hC0FFEE)); $display(\"[PASS] a\"); $finish; end endmodule";
const TB_PIPELINE = "module m_tb; initial begin $display(\"[PASS] a\"); $finish; end endmodule";
const TB_UNSEEDED = "module m_tb; initial begin $display($random); $finish; end endmodule";

function config() {
  return {
    provider: "stub", model: "stub", stageSettings: {}, useGlobalLLM: true,
    standaloneFallback: true, standaloneCheckerVersion: "rtlforge-checker-v1",
    backendUrl: "http://backend", simCmds: "sim --seed C0FFEE {RTL} {TB}",
    strictCli: false, maxVerifyIters: 1, cliRetryCount: 0, backendTimeoutSec: 5,
    boundaryProbe: false, mutationTesting: false, coverageStrengthening: false,
    triageInvestigation: false, svaInSim: false, syntaxRepair: false,
  };
}

function state(rtl, tb) {
  return {
    _userDesc: "A tiny clocked module named m with a clk input.", _config: config(),
    elicit: { modName: "m" }, spec: { modName: "m", iface: [{ name: "clk", dir: "input", width: "" }], params: [], requirements: [] },
    architect: { summary: "pipeline architecture" }, rtl_generate: rtl, test_generate: tb,
    formal_verify: { status: "PASS", proven: true }, _onLog: function() {}, _signal: null,
    _logger: { context: {}, state: function() {}, llm: function() {}, cli: function() {}, skill: function() {}, prompt: function() {}, result: function() {} },
  };
}

beforeEach(function() {
  llmPrompts.length = 0;
  llmQueue.length = 0;
  cliQueue.length = 0;
});

describe("standaloneFallback integration", function() {
  it("generates and carries the independent candidate/checker, then retains a tied incumbent", async function() {
    llmQueue.push({ code: RTL_STANDALONE }, { code: TB_STANDALONE }, { code: RTL_PIPELINE }, { code: TB_PIPELINE });
    const rtl = await rtlGenerateNode(state({}, {}));
    expect(rtl.rtl_generate._standaloneCandidate.status).toBe("READY");
    expect(llmPrompts[0].userMessage).toContain("ORIGINAL USER DESCRIPTION");
    expect(llmPrompts[0].userMessage).not.toContain("pipeline architecture");

    const tb = await testGenerateNode(state(rtl.rtl_generate, {}));
    expect(tb.test_generate._standaloneCheckerCandidate.status).toBe("READY");
    expect(llmPrompts[1].userMessage).toContain("ORIGINAL USER DESCRIPTION");
    expect(llmPrompts[1].userMessage).toContain("DUT MODULE HEADER");
    expect(llmPrompts[1].userMessage).not.toContain("assign x = clk");

    // Initial pipeline result, then standalone and pipeline under the same
    // independent checker. The tie must keep standalone and invalidate formal
    // proof credit because the shipped RTL changes.
    cliQueue.push(
      { stdout: "[PASS] a\n", stderr: "", exitCode: 0 },
      { stdout: "[PASS] a\n", stderr: "", exitCode: 0 },
      { stdout: "[PASS] a\n", stderr: "", exitCode: 0 },
    );
    const verified = await verifyNode(state(rtl.rtl_generate, tb.test_generate));
    expect(verified.rtl_generate.code).toBe(RTL_STANDALONE);
    expect(verified.test_generate.code).toBe(TB_STANDALONE);
    expect(verified.verify._standaloneComparison.reason).toBe("TIE");
    expect(verified.verify._standaloneComparison.formalInvalidated).toBe(true);
    expect(verified.verify._standaloneComparison.checker.seed).toBe("0xC0FFEE");
    expect(verified.rtl_generate._standaloneCandidate.rawCode).toBe(RTL_STANDALONE);

    const checkpoint = serializeCheckpoint({ modules: { m: {
      stageData: { 4: verified.rtl_generate, 7: verified.test_generate, 8: verified.verify },
      completed: new Set(), stageErrors: {}, stageRuns: {},
    } }, integrationState: { stageData: {}, completed: new Set(), errors: {} } },
    { userDesc: "A tiny clocked module named m with a clk input.", config: config() });
    expect(checkpoint.modules.m.stageData[4]._standaloneCandidate.rawCode).toBe(RTL_STANDALONE);
    expect(checkpoint.modules.m.stageData[7]._standaloneCheckerCandidate.rawCode).toBe(TB_STANDALONE);
  });

  it("adopts pipeline RTL only for strict same-universe improvement", async function() {
    llmQueue.push({ code: RTL_STANDALONE }, { code: TB_STANDALONE }, { code: RTL_PIPELINE }, { code: TB_PIPELINE });
    const rtl = await rtlGenerateNode(state({}, {}));
    const tb = await testGenerateNode(state(rtl.rtl_generate, {}));
    cliQueue.push(
      { stdout: "[PASS] a\n[FAIL] b\n", stderr: "", exitCode: 1 },
      { stdout: "[PASS] a\n[FAIL] b\n", stderr: "", exitCode: 1 },
      { stdout: "[PASS] a\n[PASS] b\n", stderr: "", exitCode: 0 },
    );
    const verified = await verifyNode(state(rtl.rtl_generate, tb.test_generate));
    expect(verified.rtl_generate.code).toBe(RTL_PIPELINE);
    expect(verified.test_generate.code).toBe(TB_STANDALONE);
    expect(verified.verify._standaloneComparison.decision).toBe("ACCEPT_IMPROVEMENT");
    expect(verified.verify._standaloneComparison.retainedPassedChecks).toBe(true);
    expect(verified.verify._standaloneComparison.pipeline.passedCheckIds).toEqual(["a", "b"]);
  });

  it("selects the incumbent and clears pipeline evidence when the checker is unavailable", async function() {
    const rtlSlot = {
      code: RTL_PIPELINE,
      _standaloneCandidate: { status: "READY", code: RTL_STANDALONE, rawCode: RTL_STANDALONE },
    };
    const tbSlot = { code: TB_PIPELINE };
    cliQueue.push({ stdout: "[PASS] pipeline\n", stderr: "", exitCode: 0 });
    const verified = await verifyNode(state(rtlSlot, tbSlot));
    expect(verified.rtl_generate.code).toBe(RTL_STANDALONE);
    expect(verified.verify.status).toBe("UNVERIFIED");
    expect(verified.verify.cli).toBe(false);
    expect(verified.verify.total).toBe(0);
    expect(verified.verify._standaloneComparison.selectedSource).toBe("original-description");
    expect(verified.verify._standaloneComparison.status).toBe("UNAVAILABLE");
    expect(verified.verify._standaloneComparison.formalInvalidated).toBe(true);
    expect(verified.verify._standaloneComparison.lintInvalidated).toBe(true);
  });

  it("selects the measured incumbent when the pipeline comparison call errors", async function() {
    const rtlSlot = {
      code: RTL_PIPELINE,
      _standaloneCandidate: { status: "READY", code: RTL_STANDALONE, rawCode: RTL_STANDALONE },
    };
    const tbSlot = {
      code: TB_PIPELINE,
      _standaloneCheckerCandidate: { status: "READY", code: TB_STANDALONE, rawCode: TB_STANDALONE },
    };
    cliQueue.push(
      { stdout: "[PASS] pipeline\n", stderr: "", exitCode: 0 },
      { stdout: "[PASS] incumbent\n", stderr: "", exitCode: 0 },
      new Error("pipeline comparison timed out"),
    );
    const verified = await verifyNode(state(rtlSlot, tbSlot));
    expect(verified.rtl_generate.code).toBe(RTL_STANDALONE);
    expect(verified.test_generate.code).toBe(TB_STANDALONE);
    expect(verified.verify.cli).toBe(true);
    expect(verified.verify.pass).toBe(1);
    expect(verified.verify._standaloneComparison.selectedSource).toBe("original-description");
    expect(verified.verify._standaloneComparison.status).toBe("TIMEOUT");
    expect(verified.verify._standaloneComparison.formalInvalidated).toBe(true);
  });

  it("rejects every unseeded random source as incomparable", async function() {
    const rtlSlot = {
      code: RTL_PIPELINE,
      _standaloneCandidate: { status: "READY", code: RTL_STANDALONE, rawCode: RTL_STANDALONE },
    };
    const tbSlot = {
      code: TB_PIPELINE,
      _standaloneCheckerCandidate: { status: "READY", code: TB_UNSEEDED, rawCode: TB_UNSEEDED },
    };
    cliQueue.push({ stdout: "[PASS] pipeline\n", stderr: "", exitCode: 0 });
    const verified = await verifyNode(state(rtlSlot, tbSlot));
    expect(verified.rtl_generate.code).toBe(RTL_STANDALONE);
    expect(verified.verify.status).toBe("UNVERIFIED");
    expect(verified.verify._standaloneComparison.status).toBe("UNVERIFIED");
    expect(verified.verify._standaloneComparison.reason).toContain("randomness");
  });
});
