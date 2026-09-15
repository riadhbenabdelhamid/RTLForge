import { describe, expect, it, vi, beforeEach } from "vitest";
import { djb2 } from "../src/utils/hash.js";
import { extractModuleInterface } from "../src/utils/svInterface.js";

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
    standaloneCheckerReview: true,
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
  it("qualifies and repairs a checker created in the test generation fallback path", async function() {
    const corrected = TB_STANDALONE.replace("[PASS] a", "[PASS] corrected");
    llmQueue.push({ code: TB_STANDALONE },
      { status: "FAIL", findings: [{ severity: "major", text: "Missing required case" }], summary: "Incomplete" },
      { code: corrected }, { status: "PASS", findings: [], summary: "Cases covered" },
      { code: TB_PIPELINE });
    const out = await testGenerateNode(state({ code: RTL_PIPELINE }, {}));
    const checker = out.test_generate._standaloneCheckerCandidate;
    expect(checker.status).toBe("READY");
    expect(checker.code).toBe(corrected);
    expect(checker.rawCode).toBe(TB_STANDALONE);
    expect(checker.qualification.sourceHash).toBe(djb2(corrected));
    expect(checker.qualification.attempts.map(a => a.status)).toEqual(["FAIL", "PASS"]);
    expect(checker.qualification.maxRepairs).toBe(1);
    expect(out._llms.filter(c => /standalone/.test(c.stage))).toHaveLength(4);
    for (const prompt of llmPrompts.slice(0, 4)) {
      expect(prompt.userMessage).not.toContain("assign x = clk");
      expect(prompt.userMessage).not.toContain("pipeline architecture");
    }
  });

  it("bounds checker correction and leaves a repeated failure unqualified", async function() {
    const failure = { status: "FAIL", findings: [{ severity: "major", text: "Source timing remains unresolved" }] };
    llmQueue.push({ code: TB_STANDALONE }, failure, { code: TB_STANDALONE }, failure, { code: TB_PIPELINE });
    const out = await testGenerateNode(state({ code: RTL_PIPELINE }, {}));
    expect(out.test_generate._standaloneCheckerCandidate.status).toBe("UNREVIEWED");
    expect(out.test_generate._standaloneCheckerCandidate.qualification.attempts).toHaveLength(2);
    expect(llmQueue).toHaveLength(0);
  });

  it("replays immutable source rows even when the generated checker reports all passes", async function() {
    const rtl = "module m(input d, output q); assign q = ~d; endmodule";
    const s = state({ code: rtl }, { code: TB_PIPELINE });
    s._config.standaloneFallback = false;
    s._userDesc = "d q\n0 0\n1 1\n";
    s.spec.iface = [{ name: "d", dir: "input", width: "1" }, { name: "q", dir: "output", width: "1" }];
    cliQueue.push({ stdout: "[PASS] generated\n", stderr: "", exitCode: 0 },
      { stdout: "[FAIL] SOURCE.T1.L2.q\n[FAIL] SOURCE.T1.L3.q\n", stderr: "", exitCode: 0 });
    const out = await verifyNode(s);
    expect(out.verify.status).toBe("FAIL");
    expect(out.verify._sourceEvidence.status).toBe("FAIL");
    expect(out.verify.fail).toBe(2);
    expect(cliQueue).toHaveLength(0);
    expect(llmPrompts).toHaveLength(0);
  });

  it("retains incumbent source passes even when a repair passes more generated checks", async function() {
    const incumbent = "module m(input d, output q); assign q = d; endmodule";
    const pipeline = "module m(input d, output q); assign q = 1'b0; endmodule";
    const s = state({ code: pipeline, _standaloneCandidate: { status: "READY", code: incumbent } }, { code: TB_PIPELINE });
    s._userDesc = "d q\n0 0\n1 1\n";
    s.spec.iface = [{ name: "d", dir: "input", width: "1" }, { name: "q", dir: "output", width: "1" }];
    s.test_generate._standaloneCheckerCandidate = { status: "READY", code: TB_STANDALONE, qualification: {
      status: "PASS", sourceHash: djb2(TB_STANDALONE),
      inputHash: djb2(s._userDesc + "\n" + extractModuleInterface(incumbent, "m")),
    } };
    const measured = stdout => ({ stdout, stderr: "", exitCode: 0 });
    cliQueue.push(measured("[PASS] a\n[PASS] b\n[PASS] c\n"),
      measured("[PASS] SOURCE.T1.L2.q\n[FAIL] SOURCE.T1.L3.q\n"),
      measured("[PASS] a\n[FAIL] b\n[FAIL] c\n"),
      measured("[PASS] SOURCE.T1.L2.q\n[PASS] SOURCE.T1.L3.q\n"),
      measured("[PASS] a\n[PASS] b\n[PASS] c\n"));
    const out = await verifyNode(s);
    expect(out.rtl_generate.code).toBe(incumbent);
    expect(out.verify._sourceEvidence.status).toBe("PASS");
    expect(out.verify._standaloneComparison.reason).toBe("PASSED_CHECK_REGRESSION");
    expect(cliQueue).toHaveLength(0); // pipeline source replay is cached for its identical RTL
  });

  it("rejects a cold generated RTL candidate with the wrong requested exported name", async function() {
    llmQueue.push({ code: "module WrongTop(input logic clk); endmodule" });
    const s = state({}, {});
    s._config.standaloneFallback = false;
    s._config.requiredModuleName = "RequiredTop";
    await expect(rtlGenerateNode(s)).rejects.toThrow(/requiredModuleName is \"RequiredTop\"/);
  });

  it("rejects a wrong-name best-of-N baseline before it can be selected", async function() {
    llmQueue.push({ code: "module WrongTop(input logic clk); endmodule" });
    const s = state({}, {});
    s._config.standaloneFallback = false;
    s._config.requiredModuleName = "RequiredTop";
    s._config.bestOfN = 2;
    await expect(rtlGenerateNode(s)).rejects.toThrow(/requiredModuleName is \"RequiredTop\"/);
  });

  it("generates and carries the independent candidate/checker, then retains a tied incumbent", async function() {
    llmQueue.push({ code: RTL_STANDALONE }, { code: TB_STANDALONE },
      { status: "PASS", findings: [], summary: "checker contract is covered" },
      { code: RTL_PIPELINE }, { code: TB_PIPELINE });
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
    llmQueue.push({ code: RTL_STANDALONE }, { code: TB_STANDALONE },
      { status: "PASS", findings: [], summary: "checker contract is covered" },
      { code: RTL_PIPELINE }, { code: TB_PIPELINE });
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

  it("preserves the pipeline pair and marks comparison unverified when checker is unavailable", async function() {
    const rtlSlot = {
      code: RTL_PIPELINE,
      _standaloneCandidate: { status: "READY", code: RTL_STANDALONE, rawCode: RTL_STANDALONE },
    };
    const tbSlot = { code: TB_PIPELINE };
    cliQueue.push({ stdout: "[PASS] pipeline\n", stderr: "", exitCode: 0 });
    const verified = await verifyNode(state(rtlSlot, tbSlot));
    expect(verified.rtl_generate.code).toBe(RTL_PIPELINE);
    expect(verified.verify.status).toBe("UNVERIFIED");
    expect(verified.verify.cli).toBe(true);
    expect(verified.verify.total).toBe(1);
    expect(verified.verify._standaloneComparison.selectedSource).toBe("pipeline");
    expect(verified.verify._standaloneComparison.status).toBe("UNVERIFIED");
    expect(verified.verify._standaloneComparison.artifacts.pipeline.rtl).toBe(RTL_PIPELINE);
    expect(verified.verify._standaloneComparison.artifacts.standalone.rtl).toBe(RTL_STANDALONE);
  });

  it("preserves the pipeline pair when a comparison call errors", async function() {
    const checkerHeader = extractModuleInterface(RTL_STANDALONE, "m");
    const rtlSlot = {
      code: RTL_PIPELINE,
      _standaloneCandidate: { status: "READY", code: RTL_STANDALONE, rawCode: RTL_STANDALONE },
    };
    const tbSlot = {
      code: TB_PIPELINE,
      _standaloneCheckerCandidate: { status: "READY", code: TB_STANDALONE, rawCode: TB_STANDALONE,
        qualification: { status: "PASS", method: "bounded-independent-review",
          sourceHash: djb2(TB_STANDALONE),
          inputHash: djb2("A tiny clocked module named m with a clk input.\n" + checkerHeader) } },
    };
    cliQueue.push(
      { stdout: "[PASS] pipeline\n", stderr: "", exitCode: 0 },
      { stdout: "[PASS] incumbent\n", stderr: "", exitCode: 0 },
      new Error("pipeline comparison timed out"),
    );
    const verified = await verifyNode(state(rtlSlot, tbSlot));
    expect(verified.rtl_generate.code).toBe(RTL_PIPELINE);
    expect(verified.test_generate.code).toBe(TB_PIPELINE);
    expect(verified.verify.cli).toBe(true);
    expect(verified.verify.pass).toBe(1);
    expect(verified.verify._standaloneComparison.selectedSource).toBe("pipeline");
    expect(verified.verify._standaloneComparison.status).toBe("UNVERIFIED");
    expect(verified.verify._standaloneComparison.evidenceStatus).toBe("TIMEOUT");
  });

  it("rejects every unseeded random source as incomparable", async function() {
    const checkerHeader = extractModuleInterface(RTL_STANDALONE, "m");
    const rtlSlot = {
      code: RTL_PIPELINE,
      _standaloneCandidate: { status: "READY", code: RTL_STANDALONE, rawCode: RTL_STANDALONE },
    };
    const tbSlot = {
      code: TB_PIPELINE,
      _standaloneCheckerCandidate: { status: "READY", code: TB_UNSEEDED, rawCode: TB_UNSEEDED,
        qualification: { status: "PASS", method: "bounded-independent-review",
          sourceHash: djb2(TB_UNSEEDED),
          inputHash: djb2("A tiny clocked module named m with a clk input.\n" + checkerHeader) } },
    };
    cliQueue.push({ stdout: "[PASS] pipeline\n", stderr: "", exitCode: 0 });
    const verified = await verifyNode(state(rtlSlot, tbSlot));
    expect(verified.rtl_generate.code).toBe(RTL_PIPELINE);
    expect(verified.verify.status).toBe("UNVERIFIED");
    expect(verified.verify._standaloneComparison.status).toBe("UNVERIFIED");
    expect(verified.verify._standaloneComparison.reason).toContain("randomness");
  });

  it("remeasures formal evidence against the selected RTL without repair", async function() {
    const checkerHeader = extractModuleInterface(RTL_STANDALONE, "m");
    const rtlSlot = {
      code: RTL_PIPELINE,
      _standaloneCandidate: { status: "READY", code: RTL_STANDALONE, rawCode: RTL_STANDALONE },
    };
    const tbSlot = {
      code: TB_PIPELINE,
      _standaloneCheckerCandidate: { status: "READY", code: TB_STANDALONE, rawCode: TB_STANDALONE,
        qualification: { status: "PASS", method: "bounded-independent-review",
          sourceHash: djb2(TB_STANDALONE),
          inputHash: djb2("A tiny clocked module named m with a clk input.\n" + checkerHeader) } },
    };
    const s = state(rtlSlot, tbSlot);
    s._config.optionalStages = { formal_verify: true };
    s._config.formalProve = false;
    s.formal_props = { properties: [{ id: "SVA-1", code: "assert property (@(posedge clk) 1);" }] };
    let bmcCalls = 0;
    s._services = { formalRunner: {
      sbyAvailable: () => true,
      runBmc: async () => { bmcCalls++; return { status: "PASS", log: "DONE (PASS)", elapsedMs: 1 }; },
    } };
    cliQueue.push(
      { stdout: "[PASS] a\n", stderr: "", exitCode: 0 },
      { stdout: "[PASS] a\n", stderr: "", exitCode: 0 },
      { stdout: "[PASS] a\n", stderr: "", exitCode: 0 },
    );
    const verified = await verifyNode(s);
    expect(verified.rtl_generate.code).toBe(RTL_STANDALONE);
    expect(verified.formal_verify.status).toBe("PASS");
    expect(verified.formal_verify.remeasure).toBe(true);
    expect(verified.formal_verify.repairIterationsDisabled).toBe(true);
    expect(verified.formal_verify.sourceHash).toBe(djb2(RTL_STANDALONE));
    expect(verified.formal_verify._forHash).toHaveProperty("rtl");
    expect(verified.formal_verify._forHash).toHaveProperty("formal_props");
    expect(bmcCalls).toBe(1);
  });
});
