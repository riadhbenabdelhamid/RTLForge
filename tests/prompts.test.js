// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// vitest-compatible test file mirroring the prompts coverage in verify.mjs
// Run via: npx vitest run tests/prompts.test.js
import { describe, it, expect } from "vitest";
import {
  BASE_SYS, sys, j,
  promptElicit,
  promptSpec, promptSpecFromDescription,
  promptArch,
  promptRTL,
  promptRTLReview, promptRTLReviewFix,
  promptFormalProps,
  promptLint, promptRTLFix,
  promptTB,
  promptTestReview, promptTestReviewFix,
  promptVerify, promptVerifyTriage, promptRTLFromVerifyFail, promptTBFromVerifyFail,
  promptJudge, promptJudgeTriage,
} from "../src/prompts/index.js";

// Shared fixtures
const sampleEl = {
  modName: "sync_fifo", domain: "FIFO buffer",
  questions: [], answers: {}, customAnswers: {}, assumptions: [],
};
const sampleSpec = {
  iface: [
    { name: "clk",   dir: "input",  width: "1",      desc: "System clock" },
    { name: "rst_n", dir: "input",  width: "1",      desc: "Active-low async reset" },
    { name: "din",   dir: "input",  width: "DATA_W", desc: "Write data" },
    { name: "dout",  dir: "output", width: "DATA_W", desc: "Read data" },
  ],
  params: [{ name: "DATA_W", type: "parameter", def: 8, range: "[1:1024]", desc: "Data width" }],
  requirements: [
    { id: "REQ-INTF-001", cat: "Interface",     pri: "Must",   desc: "The module shall provide synchronous read/write" },
    { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must",   desc: "The module shall report empty/full status" },
    { id: "REQ-TIME-001", cat: "Timing",        pri: "Should", desc: "The module should operate at 200 MHz" },
  ],
};
const sampleArch = {
  strategy: "Synchronous FIFO", description: "Standard FIFO",
  blocks: [{ name: "Mem", desc: "Storage" }], mermaid: "graph TD\\n  A --> B",
};
const sampleRTL = "module sync_fifo;\nendmodule";
const sampleTB  = "module sync_fifo_tb;\ninitial $finish;\nendmodule";

describe("prompts/base", () => {
  it("BASE_SYS contains output contract", () => {
    expect(BASE_SYS).toMatch(/OUTPUT CONTRACT/);
    expect(BASE_SYS).toMatch(/JSON object/);
  });
  it("sys() returns BASE_SYS when no extra", () => {
    expect(sys()).toBe(BASE_SYS);
  });
  it("sys(extra) appends extra after BASE_SYS", () => {
    const out = sys("EXTRA RULE: foo");
    expect(out.startsWith(BASE_SYS)).toBe(true);
    expect(out).toMatch(/EXTRA RULE: foo/);
  });
  it("j() is JSON.stringify alias", () => {
    expect(j({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
  });
});

describe("promptElicit", () => {
  it("returns valid shape", () => {
    const p = promptElicit("a fifo", null);
    expect(typeof p.systemPrompt).toBe("string");
    expect(typeof p.userMessage).toBe("string");
    expect(typeof p.maxTokens).toBe("number");
    expect(p.userMessage).toMatch(/Analyse the hardware module description/);
    expect(p.userMessage).toMatch(/a fifo/);
  });
  it("omits child section when no children", () => {
    const p = promptElicit("a fifo", null);
    expect(p.userMessage).not.toMatch(/THIS MODULE IS A PARENT/);
  });
  it("includes child section when children present", () => {
    const p = promptElicit("a fifo", [{ instanceName: "u_fifo", moduleId: "fifo", description: "child" }]);
    expect(p.userMessage).toMatch(/THIS MODULE IS A PARENT/);
    expect(p.userMessage).toMatch(/u_fifo/);
  });
  it("includes minimalism + answerability rules", () => {
    const p = promptElicit("a fifo with 8-bit data and active-low reset", null);
    expect(p.userMessage).toMatch(/MINIMALISM RULE/);
    expect(p.userMessage).toMatch(/ANSWERABILITY/);
    expect(p.userMessage).toMatch(/OPTION DISTINCTNESS/);
    expect(p.userMessage).toMatch(/ID STABILITY/);
  });
});

describe("promptSpec / promptSpecFromDescription", () => {
  it("promptSpec interpolates modName", () => {
    const p = promptSpec(sampleEl, null);
    expect(p.userMessage).toMatch(/Convert the elicited answers/);
    expect(p.userMessage).toMatch(/sync_fifo/);
    expect(p.userMessage).toMatch(/ANTI-INVENTION TEST/);
  });
  it("promptSpec adds skipped note when there are unanswered questions", () => {
    const elWithQs = { ...sampleEl, questions: [{ id: "INTF-01", cat: "interface", text: "Q1", opts: ["a", "b"] }], answers: {} };
    const p = promptSpec(elWithQs, null);
    expect(p.userMessage).toMatch(/elicitation question\(s\) were deliberately left unanswered/);
  });
  it("promptSpec injects judge feedback when present", () => {
    const elWithJudge = { ...sampleEl, _judgeFailures: [{ req: "REQ-FUNC-002", note: "missing" }], _judgeRecs: ["Add coverage for X"] };
    const p = promptSpec(elWithJudge, null);
    expect(p.userMessage).toMatch(/JUDGE FEEDBACK/);
    expect(p.userMessage).toMatch(/REQ-FUNC-002/);
  });
  it("promptSpec resolves Other (specify) custom answers", () => {
    const elWithCustom = {
      ...sampleEl,
      questions: [{ id: "INTF-01", cat: "interface", text: "What protocol?", opts: ["AXI", "Other (specify)"] }],
      answers: { "INTF-01": "Other (specify)" },
      customAnswers: { "INTF-01": "Wishbone" },
    };
    const p = promptSpec(elWithCustom, null);
    expect(p.userMessage).toMatch(/Wishbone/);
    expect(p.userMessage).not.toMatch(/"answer":"Other \(specify\)"/);
  });
  it("promptSpecFromDescription bypasses elicit", () => {
    const p = promptSpecFromDescription("a uart tx with parity", null);
    expect(p.userMessage).toMatch(/Derive a complete formal specification directly from the hardware/);
    expect(p.userMessage).toMatch(/a uart tx with parity/);
    expect(p.userMessage).not.toMatch(/INPUT DATA/);
  });
});

describe("promptArch", () => {
  it("emits Mermaid system rule", () => {
    const p = promptArch(sampleSpec, sampleEl, null);
    expect(p.userMessage).toMatch(/Design the micro-architecture/);
    expect(p.systemPrompt).toMatch(/MERMAID OUTPUT RULES/);
    expect(p.systemPrompt).toMatch(/no subgraph/);
  });
  it("includes layering rule", () => {
    const p = promptArch(sampleSpec, sampleEl, null);
    expect(p.userMessage).toMatch(/LAYERING RULE/);
    expect(p.userMessage).toMatch(/SIMPLICITY RULE/);
  });
  it("adds child section when children present", () => {
    const p = promptArch(sampleSpec, sampleEl, [{ instanceName: "u_fifo", moduleId: "fifo" }]);
    expect(p.userMessage).toMatch(/CHILD MODULES TO INSTANTIATE/);
  });
});

describe("promptRTL", () => {
  it("includes synthesisability discipline", () => {
    const p = promptRTL(sampleArch, sampleSpec, sampleEl, null, null);
    expect(p.userMessage).toMatch(/synthesisable IEEE 1800-2017/);
    expect(p.userMessage).toMatch(/SYNTHESISABILITY RULES/);
    expect(p.userMessage).toMatch(/always_ff/);
    expect(p.userMessage).toMatch(/INTERFACE COMPLIANCE/);
    expect(p.userMessage).toMatch(/SELF-REVIEW BEFORE EMIT/);
  });
  it("injects shared package when provided", () => {
    const p = promptRTL(sampleArch, sampleSpec, sampleEl, null, "package shared_pkg; ... endpackage");
    expect(p.userMessage).toMatch(/SHARED PACKAGE/);
    expect(p.userMessage).toMatch(/shared_pkg/);
  });
  it("injects child instantiation rules", () => {
    const p = promptRTL(sampleArch, sampleSpec, sampleEl, [{ instanceName: "u0", moduleId: "fifo" }], null);
    expect(p.userMessage).toMatch(/CHILD INSTANCES/);
    expect(p.userMessage).toMatch(/INSTANTIATION RULES/);
  });
});

describe("promptRTLReview / promptRTLReviewFix", () => {
  it("review structures the multi-pass review", () => {
    const p = promptRTLReview(sampleRTL, sampleSpec, sampleArch, sampleEl);
    expect(p.userMessage).toMatch(/REVIEW PASSES/);
    expect(p.userMessage).toMatch(/SCORING RUBRIC/);
    expect(p.userMessage).toMatch(/spec_compliance/);
  });
  it("fix filters to critical+major only", () => {
    const review = { issues: [
      { id: "RR-001", severity: "critical", description: "race" },
      { id: "RR-002", severity: "minor",    description: "naming" },
      { id: "RR-003", severity: "major",    description: "width" },
    ]};
    const p = promptRTLReviewFix(sampleRTL, review, sampleSpec, sampleEl);
    expect(p.userMessage).toMatch(/2 critical\/major/);
    expect(p.userMessage).toMatch(/RR-001/);
    expect(p.userMessage).toMatch(/RR-003/);
    expect(p.userMessage).not.toMatch(/RR-002/);
  });
});

describe("promptFormalProps", () => {
  it("single-clock mode with active-low rst_n", () => {
    const p = promptFormalProps(sampleRTL, sampleSpec, sampleEl, null, null);
    expect(p.userMessage).toMatch(/MODULE NATURE: SYNCHRONOUS/);
    expect(p.userMessage).toMatch(/Clock signal: clk/);
    expect(p.userMessage).toMatch(/active-low/);
  });
  it("purely combinatorial mode", () => {
    const combSpec = { iface: [{ name: "a", dir: "input", width: "8" }], params: [], requirements: [] };
    const p = promptFormalProps(sampleRTL, combSpec, sampleEl, null, null);
    expect(p.userMessage).toMatch(/PURELY COMBINATORIAL/);
    expect(p.userMessage).toMatch(/Do NOT use @\(posedge/);
  });
  it("multi-clock mode", () => {
    const mcSpec = { iface: [{ name: "clk_a", dir: "input", width: "1" }, { name: "clk_b", dir: "input", width: "1" }], params: [], requirements: [] };
    const p = promptFormalProps(sampleRTL, mcSpec, sampleEl, null, null);
    expect(p.userMessage).toMatch(/MULTI-CLOCK SYNCHRONOUS/);
    expect(p.userMessage).toMatch(/2 clock domains/);
  });
  it("includes auto-derived constraints when provided", () => {
    const aa = [{ id: "AUTO-001", source: "Param FOO range", code: "assume property (FOO >= 0);" }];
    const p = promptFormalProps(sampleRTL, sampleSpec, sampleEl, null, aa);
    expect(p.userMessage).toMatch(/AUTO-DERIVED CONSTRAINTS \(already generated/);
    expect(p.userMessage).toMatch(/AUTO-001/);
  });
});

describe("promptLint / promptRTLFix", () => {
  it("lint includes Verilator vocabulary and evidence rules", () => {
    const p = promptLint(sampleRTL, sampleEl);
    expect(p.userMessage).toMatch(/VOCABULARY/);
    expect(p.userMessage).toMatch(/UNUSED/);
    expect(p.userMessage).toMatch(/CASEINCOMPLETE/);
    expect(p.userMessage).toMatch(/EVIDENCE RULES/);
  });
  it("fix counts errors+warnings combined", () => {
    const lint = {
      errors: [{ id: "E-1", code: "SYNTAX", line: 5, msg: "x" }],
      warnings: [{ id: "W-1", code: "UNUSED", line: 7, msg: "y" }, { id: "W-2", code: "WIDTH", line: 9, msg: "z" }],
    };
    const p = promptRTLFix(sampleRTL, lint, sampleEl, null);
    expect(p.userMessage).toMatch(/\(3\)/);                  // "FINDINGS TO RESOLVE (3):"
    expect(p.userMessage).toMatch(/EXTERNAL CONTRACT/);
  });
  it("fix injects non-monotonic policy when previousFixes provided", () => {
    const lint = { errors: [], warnings: [{ id: "W-1", code: "UNUSED", line: 7, msg: "y" }] };
    const p = promptRTLFix(sampleRTL, lint, sampleEl, ["fixed UNUSED on line 3"]);
    expect(p.userMessage).toMatch(/PREVIOUSLY APPLIED FIXES/);
    expect(p.userMessage).toMatch(/NON-MONOTONIC POLICY/);
  });
});

describe("promptTB", () => {
  it("includes TB structure requirements", () => {
    const p = promptTB(sampleRTL, sampleSpec, sampleEl, null);
    expect(p.userMessage).toMatch(/self-checking SystemVerilog testbench/);
    expect(p.userMessage).toMatch(/sync_fifo_tb/);
    expect(p.userMessage).toMatch(/apply_reset/);
    expect(p.userMessage).toMatch(/TIMEOUT_NS/);
    expect(p.userMessage).toMatch(/CHECK/);
    expect(p.userMessage).toMatch(/SUMMARY/);
  });
  it("notes children are part of DUT", () => {
    const p = promptTB(sampleRTL, sampleSpec, sampleEl, [{ instanceName: "u0" }]);
    expect(p.userMessage).toMatch(/instantiates child modules/);
  });
});

describe("promptTestReview / promptTestReviewFix", () => {
  it("review shape", () => {
    const p = promptTestReview(sampleTB, sampleRTL, sampleSpec, sampleEl);
    expect(p.userMessage).toMatch(/Review the testbench/);
    expect(p.userMessage).toMatch(/REQUIREMENT COVERAGE/);
    expect(p.userMessage).toMatch(/INFRASTRUCTURE/);
  });
  it("fix filters to critical+major", () => {
    const review = { issues: [
      { id: "TR-001", severity: "critical", description: "missing reset test" },
      { id: "TR-002", severity: "minor",    description: "comment style" },
    ]};
    const p = promptTestReviewFix(sampleTB, sampleRTL, review, sampleSpec, sampleEl);
    expect(p.userMessage).toMatch(/critical\/major/);
    expect(p.userMessage).toMatch(/\(1 critical\/major\)/);
  });
});

describe("promptVerify family", () => {
  it("estimates from snippets — clearly labelled estimated", () => {
    const p = promptVerify(sampleTB, sampleRTL, sampleSpec);
    expect(p.userMessage).toMatch(/Estimate what would happen/);
    expect(p.userMessage).toMatch(/AI-estimated/);
    expect(p.userMessage).toMatch(/sync_fifo_tb/);
    expect(p.userMessage).toMatch(/REQ-INTF-001/);
    expect(p.userMessage).not.toMatch(/REQ-TIME-001/); // Should-priority excluded
  });
  it("triage offers three target choices", () => {
    const verifyResult = { tests: [{ name: "t1", st: "FAIL", req: "REQ-001" }], log: "[FAIL] t1: mismatch" };
    const p = promptVerifyTriage(verifyResult, sampleSpec, sampleEl);
    expect(p.userMessage).toMatch(/Classify the root cause/);
    expect(p.userMessage).toMatch(/test_generate/);
    expect(p.userMessage).toMatch(/rtl_generate/);
  });
  it("RTL fix filters to failed tests only", () => {
    const verifyResult = { tests: [
      { name: "t1", st: "FAIL", req: "REQ-001" },
      { name: "t2", st: "PASS", req: "REQ-002" },
    ], log: "" };
    const p = promptRTLFromVerifyFail(sampleRTL, verifyResult, sampleSpec, sampleEl);
    expect(p.userMessage).toMatch(/Repair the "sync_fifo" RTL/);
    expect(p.userMessage).toMatch(/\(1\)/);
    expect(p.userMessage).toMatch(/EXTERNAL CONTRACT/);
  });
  it("TB fix preserves coverage annotations", () => {
    const verifyResult = { tests: [{ name: "t1", st: "FAIL", req: "REQ-001" }], log: "" };
    const p = promptTBFromVerifyFail(sampleTB, sampleRTL, verifyResult, sampleSpec, sampleEl);
    expect(p.userMessage).toMatch(/Repair the testbench/);
    expect(p.userMessage).toMatch(/NEVER REDUCE COVERAGE/);
  });
  it("Issue #8: promptRTLFromVerifyFail includes previousFixes section when provided", () => {
    const verifyResult = { tests: [{ name: "t1", st: "FAIL", req: "REQ-001" }], log: "" };
    const prev = [{ test: "t0", desc: "added missing reset" }];
    const p = promptRTLFromVerifyFail(sampleRTL, verifyResult, sampleSpec, sampleEl, prev);
    expect(p.userMessage).toMatch(/PREVIOUSLY APPLIED FIXES/);
    expect(p.userMessage).toMatch(/NON-MONOTONIC POLICY/);
    expect(p.userMessage).toMatch(/added missing reset/);
  });
  it("Issue #8: promptRTLFromVerifyFail omits previousFixes section when empty/undefined", () => {
    const verifyResult = { tests: [{ name: "t1", st: "FAIL", req: "REQ-001" }], log: "" };
    const p1 = promptRTLFromVerifyFail(sampleRTL, verifyResult, sampleSpec, sampleEl);
    expect(p1.userMessage).not.toMatch(/PREVIOUSLY APPLIED FIXES/);
    const p2 = promptRTLFromVerifyFail(sampleRTL, verifyResult, sampleSpec, sampleEl, []);
    expect(p2.userMessage).not.toMatch(/PREVIOUSLY APPLIED FIXES/);
  });
  it("Issue #8: promptTBFromVerifyFail includes previousFixes section when provided", () => {
    const verifyResult = { tests: [{ name: "t1", st: "FAIL", req: "REQ-001" }], log: "" };
    const prev = [{ test: "t0", desc: "fixed clock period" }];
    const p = promptTBFromVerifyFail(sampleTB, sampleRTL, verifyResult, sampleSpec, sampleEl, prev);
    expect(p.userMessage).toMatch(/PREVIOUSLY APPLIED FIXES/);
    expect(p.userMessage).toMatch(/fixed clock period/);
  });
});

describe("promptJudge / promptJudgeTriage", () => {
  it("judge with full state", () => {
    const state = {
      elicit: sampleEl, spec: sampleSpec,
      lint:   { status: "PASS", iteration: 1, errors: [], warnings: [] },
      formal_props: { properties: [{}, {}], covers: [{}] },
      verify: { pass: 5, total: 5, cov: { line: 92, branch: 80 }, tests: [{ name: "t1", st: "PASS", req: "REQ-INTF-001" }] },
      _config: { maxLintIters: 3 },
    };
    const p = promptJudge(state);
    expect(p.userMessage).toMatch(/quality-gate verdict/);
    expect(p.userMessage).toMatch(/PASS \(iteration 1\/3/);
    expect(p.userMessage).toMatch(/5\/5 tests passed/);
    expect(p.userMessage).toMatch(/Lint Test\s+: SKIPPED/);
  });
  it("judge with both lint stages present", () => {
    const state = {
      elicit: sampleEl, spec: sampleSpec,
      lint:      { status: "PASS", iteration: 1, errors: [], warnings: [] },
      lint_test: { status: "PASS", iteration: 1, errors: [], warnings: [] },
      _config: { maxLintIters: 3 },
    };
    const p = promptJudge(state);
    expect(p.userMessage).toMatch(/Lint RTL\s+: PASS/);
    expect(p.userMessage).toMatch(/Lint Test\s+: PASS/);
    // Verdict gate should reference both lint stages
    expect(p.userMessage).toMatch(/state\.lint\.status === "PASS"/);
    expect(p.userMessage).toMatch(/state\.lint_test/);
  });
  it("judge handles missing lint/verify gracefully", () => {
    const state = { elicit: sampleEl, spec: sampleSpec };
    const p = promptJudge(state);
    expect(p.userMessage).toMatch(/Lint RTL\s+: N\/A/);
    expect(p.userMessage).toMatch(/Lint Test\s+: SKIPPED/);
    expect(p.userMessage).toMatch(/Simulation\s+: N\/A/);
  });
  it("triage extracts unmet requirements", () => {
    const judgeResult = {
      score: 42, overall: "FAIL",
      trace: [
        { req: "REQ-INTF-001", ok: true,  test: "test_intf",  note: "ok" },
        { req: "REQ-FUNC-001", ok: false, test: null,         note: "not tested" },
      ],
    };
    const p = promptJudgeTriage(judgeResult, sampleSpec, sampleEl);
    expect(p.userMessage).toMatch(/Pick the EARLIEST stage/);
    expect(p.userMessage).toMatch(/JUDGE SCORE: 42/);
    const unvalSection = p.userMessage.split("ALL REQUIREMENTS:")[0];
    expect(unvalSection).toMatch(/UNVALIDATED REQUIREMENTS/);
    expect(unvalSection).toMatch(/REQ-FUNC-001/);
    expect(unvalSection).not.toMatch(/REQ-INTF-001/);
    // Evidence requirement should be enforced
    expect(p.userMessage).toMatch(/EVIDENCE REQUIREMENT/);
  });
});
