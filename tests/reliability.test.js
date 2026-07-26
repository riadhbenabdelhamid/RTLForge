// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Reliability (docs/reliability.md): bounded runs + non-regressing fix loops.
//   R1 — reject means reject: a REJECT_REGRESSION candidate is never adopted.
//   R2 — errors-first fix scope: warnings stay out of the ask while errors exist.
//   R3 — wall-clock brake in the budget guard (maxStageMinutes, default on).
//   R4/R5 — bounded/cheap-first defaults in BOTH config sources.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBudgetGuard } from "../src/pipeline/budget.js";
import { _internal as termConfigInternal } from "../src/term/config.js";
import { defaultProjectConfig } from "../src/react/useProject.jsx";
import { stripFindingEchoes } from "../src/prompts/lintFindings.js";

// ─── R3: wall-clock brake ───────────────────────────────────────────────────
describe("budget guard time limit (R3)", () => {
  it("trips overWith at the minute limit; exceeded (stage-boundary) never trips on time", () => {
    let t = 1000;
    const g = createBudgetGuard({ maxStageMinutes: 20 }, [], { now: () => t });
    expect(g.enabled).toBe(true);
    expect(g.limits.stageMinutes).toBe(20);
    expect(g.overWith([])).toBeNull();
    t += 19 * 60000;
    expect(g.overWith([])).toBeNull();
    t += 1 * 60000;                                   // 20 min elapsed
    const r = g.overWith([]);
    expect(r.reason).toBe("time");
    expect(r.spentMinutes).toBe(20);
    expect(r.message).toMatch(/maxStageMinutes/);
    expect(r.message).toMatch(/best-known/i);
    // The stage-boundary gate must not refuse a fresh stage over time.
    expect(g.exceeded()).toBeNull();
  });

  it("0/null disables the time limit (old unbounded behavior)", () => {
    const g0 = createBudgetGuard({ maxStageMinutes: 0 }, [], { now: () => 0 });
    expect(g0.enabled).toBe(false);
    const gn = createBudgetGuard({}, [], { now: () => 0 });
    expect(gn.enabled).toBe(false);
  });

  it("token/cost limits keep working alongside time", () => {
    let t = 0;
    const g = createBudgetGuard({ maxRunTokens: 100, maxStageMinutes: 60 },
      [{ tIn: 40, tOut: 20 }], { now: () => t });
    expect(g.overWith([{ tokensIn: 30, tokensOut: 5 }])).toBeNull();     // 95 < 100
    const r = g.overWith([{ tokensIn: 30, tokensOut: 15 }]);             // 105 ≥ 100
    expect(r.reason).toBe("tokens");
  });
});

// ─── R4/R5: bounded + cheap-first defaults in both config sources ──────────
describe("reliability defaults (R3/R4/R5)", () => {
  it("GUI defaults: time brake on, nested reflows clamped to 1, syntax repair on", () => {
    const c = defaultProjectConfig();
    expect(c.maxStageMinutes).toBe(20);
    expect(c.nestedLintIters).toBe(1);
    expect(c.nestedVerifyIters).toBe(1);
    expect(c.syntaxRepair).toBe(true);
  });

  it("CLI defaults match the GUI", () => {
    const c = termConfigInternal.DEFAULT_CONFIG;
    expect(c.maxStageMinutes).toBe(20);
    expect(c.nestedLintIters).toBe(1);
    expect(c.nestedVerifyIters).toBe(1);
    expect(c.syntaxRepair).toBe(true);
  });
});

// ─── R3 granularity: the chain walk itself checks the budget per entry ─────
describe("reflow chain honors the budget between entries (R3 granularity)", () => {
  it("stops the walk at the first entry past the limit, keeping prior work", async () => {
    const { runReflowChain } = await import("../src/pipeline/reflowRunner.js");
    let t = 0;
    const guard = createBudgetGuard({ maxStageMinutes: 20 }, [], { now: () => t });
    const invoked = [];
    const st = {
      _config: {}, _onLog: null, _signal: null, _budget: guard,
      _services: {
        invokeNode: async (key) => {
          invoked.push(key);
          t += 15 * 60000;                       // each entry costs 15 min
          return { [key]: { ok: true } };
        },
        allStages: [],
      },
      _logger: { context: { depth: 0 }, state: () => {}, llm: () => {}, cli: () => {} },
    };
    const logs = [];
    const walk = await runReflowChain({
      chain: [
        { stageKey: "rtl_generate", stageId: 4, reason: "triage" },
        { stageKey: "lint", stageId: 6, reason: "downstream" },     // starts at 15 min — ok
        { stageKey: "verify", stageId: 8, reason: "always" },       // would start at 30 min — braked
      ],
      st, ownerKey: "judge", ownerIter: 1, parentDepth: 0,
      currentState: Object.assign({}, st),
      allLlms: [], appendLog: (t2, b) => logs.push(t2 + " " + (b || "")),
      strictOnError: false,
    });
    expect(invoked).toEqual(["rtl_generate", "lint"]);              // verify never ran
    const halted = walk.chainHistory.find((h) => h.status === "budget-halted");
    expect(halted).toBeTruthy();
    expect(halted.stageKey).toBe("verify");
    expect(logs.join("\n")).toContain("RUN BUDGET EXHAUSTED (reflow chain)");
  });
});

// ─── Echo guard: findings pasted into code are stripped deterministically ───
describe("stripFindingEchoes (measured: model pasted the findings block into the RTL)", () => {
  it("removes echoed finding-tag, arrow, and header lines; keeps real SV", () => {
    const polluted = [
      "module m(input clk);",
      "    [SYNTAX#8] ERROR SYNTAX (line 8:5): syntax error, unexpected parameter",
      "      source ↳ parameter DATA_W = 4;",
      "      fix    ↳ Declare parameters in the ANSI header.",
      "  reg [3:0] q;",
      "LINT FINDINGS TO RESOLVE (2) — each carries a stable id",
      "endmodule",
    ].join("\n");
    const r = stripFindingEchoes(polluted);
    expect(r.stripped).toBe(4);
    expect(r.code).toBe("module m(input clk);\n  reg [3:0] q;\nendmodule");
  });

  it("leaves clean code byte-identical (idempotent, zero false positives)", () => {
    const clean = "module m(input clk, output reg [3:0] q);\n  // [3:0] is a range, not a tag\n  always @(posedge clk) q <= q + 1;\nendmodule";
    const r = stripFindingEchoes(clean);
    expect(r.stripped).toBe(0);
    expect(r.code).toBe(clean);
    expect(stripFindingEchoes(r.code).code).toBe(clean);
  });
});

// ─── R1 + R2 in the lint node ───────────────────────────────────────────────
vi.mock("../src/llm/index.js", async function() {
  const actual = await vi.importActual("../src/llm/extractJSON.js");
  return { callLLM: vi.fn(), extractJSON: actual.extractJSON, addRetryHint: function(s) { return s; } };
});
vi.mock("../src/cli/index.js", function() {
  return {
    extractInfoEvidence: function() { return {}; },
    runCli: vi.fn(),
    parseCLIOutput: function(stderr) {
      const errors = [], warnings = [];
      (stderr || "").split("\n").forEach(function(line) {
        const em = line.match(/^%Error-(\w+): \w+\.sv:(\d+): (.*)$/);
        const wm = line.match(/^%Warning-(\w+): \w+\.sv:(\d+): (.*)$/);
        if (em) errors.push({ code: em[1], sev: "error", line: +em[2], msg: em[3] });
        if (wm) warnings.push({ code: wm[1], sev: "warning", line: +wm[2], msg: wm[3] });
      });
      return { errors, warnings };
    },
    CliBackendError: class extends Error {},
  };
});

const { lintNode } = await import("../src/pipeline/nodes/lint.js");
const { callLLM } = await import("../src/llm/index.js");
const { runCli } = await import("../src/cli/index.js");

const RTL = `module ctr(input clk, input rst_n, input en, output reg [3:0] q);
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) q <= 4'b0000;
    else if (en) q <= q + 1'b1;
  end
endmodule`;

function baseState(cfg) {
  return {
    elicit: { modName: "ctr" },
    spec: { requirements: [], iface: [], params: [] },
    rtl_generate: { code: RTL },
    _config: Object.assign({
      provider: "openai", model: "gpt-4o", apiKey: "sk-test",
      maxLintIters: 2, backendUrl: "http://localhost:3001", strictCli: true,
      cliRetryCount: 0, backendTimeoutSec: 10, stageSettings: {},
    }, cfg || {}),
    _onLog: null, _signal: null,
  };
}

const llmReply = (json) => ({
  text: JSON.stringify(json), tokensIn: 10, tokensOut: 5, latencyMs: 1,
  model: "gpt-4o", provider: "openai", stopReason: "stop",
});

beforeEach(() => { callLLM.mockReset(); runCli.mockReset(); });

describe("lint fix loop: reject means reject (R1)", () => {
  it("a REJECT_REGRESSION candidate is NOT adopted — the next iteration works on the original code", async () => {
    // A materially different candidate (passes the integrity, churn, and
    // gutted guards) whose recheck shows the baseline error persisting PLUS a
    // brand-new error → classifyDiagnostics → REJECT_REGRESSION.
    const REGRESSED = RTL
      .replace("4'b0000", "4'd0")
      .replace("q <= q + 1'b1", "q <= q + one_wide_signal + 1'b1");
    runCli
      // iter 1 primary lint: one baseline error
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error-WIDTH: ctr.sv:4: operand width mismatch", exitCode: 1 })
      // recheck of the candidate: baseline persists + a NEW error → regression
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error-WIDTH: ctr.sv:4: operand width mismatch\n%Error-IMPLICIT: ctr.sv:4: signal not declared: one_wide_signal", exitCode: 1 })
      // iter 2 primary lint — MUST be linting the ORIGINAL code again
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error-WIDTH: ctr.sv:4: operand width mismatch", exitCode: 1 });
    callLLM.mockResolvedValue(llmReply({ code: REGRESSED, fixes: [{ id: "WIDTH#4", desc: "widened" }] }));

    const d = await lintNode(baseState());

    // The regressed candidate never became the working code…
    expect(d.rtl_generate.code).toBe(RTL);
    expect(d.rtl_generate._originalCode).toBeUndefined();     // unchanged → no fix marker
    // …the iteration was flagged, and iteration 2 re-linted the ORIGINAL code.
    expect(d.lint.iterations[0].regression).toBe(true);
    const iter2Files = runCli.mock.calls[2][1].files;
    expect(iter2Files["ctr.sv"]).toBe(RTL);
  });
});

describe("lint fix loop: escalation stop (thrash the 'revealed' bucket can't see)", () => {
  it("two consecutive error-count rises stop the loop before the next fix call; best-known ships", async () => {
    // Same-code-family errors ("SYNTAX"→more "SYNTAX") classify as revealed →
    // ACCEPT_PROGRESS each round. Counts rise 1→2→4 — the measured live chain.
    const CAND2 = RTL + "\n// v2 attempt";
    const CAND3 = RTL + "\n// v3 attempt";
    runCli
      // iter1 lint: 1 error
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error-SYNTAX: ctr.sv:4: unexpected token A", exitCode: 1 })
      // recheck cand2: baseline resolved, 2 NEW same-family errors → revealed → ACCEPT
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error-SYNTAX: ctr.sv:6: unexpected always_ff here\n%Error-SYNTAX: ctr.sv:9: unexpected endmodule here", exitCode: 1 })
      // iter2 lint (adopted cand2): 2 errors → escalation strike 1
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error-SYNTAX: ctr.sv:6: unexpected always_ff here\n%Error-SYNTAX: ctr.sv:9: unexpected endmodule here", exitCode: 1 })
      // recheck cand3: those resolved, 4 NEW same-family errors → ACCEPT again
      .mockResolvedValueOnce({ stdout: "", stderr: ["%Error-SYNTAX: ctr.sv:2: unexpected input kw", "%Error-SYNTAX: ctr.sv:3: unexpected output kw", "%Error-SYNTAX: ctr.sv:5: unexpected begin kw", "%Error-SYNTAX: ctr.sv:7: unexpected end kw"].join("\n"), exitCode: 1 })
      // iter3 lint (adopted cand3): 4 errors → escalation strike 2 → STOP
      .mockResolvedValueOnce({ stdout: "", stderr: ["%Error-SYNTAX: ctr.sv:2: unexpected input kw", "%Error-SYNTAX: ctr.sv:3: unexpected output kw", "%Error-SYNTAX: ctr.sv:5: unexpected begin kw", "%Error-SYNTAX: ctr.sv:7: unexpected end kw"].join("\n"), exitCode: 1 });
    callLLM
      .mockResolvedValueOnce(llmReply({ code: CAND2, fixes: [{ id: "SYNTAX#4", desc: "v2" }] }))
      .mockResolvedValueOnce(llmReply({ code: CAND3, fixes: [{ id: "SYNTAX#6", desc: "v3" }] }));

    const d = await lintNode(baseState({ maxLintIters: 5 }));

    // Stopped at iteration 3 — no third fix call was spent on the divergence.
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(d.lint.iterations).toHaveLength(3);
    // Best-known restore shipped the lowest-error code (the original, 1 error).
    expect(d.rtl_generate.code).toBe(RTL);
    expect(d.lint._fullLog).toContain("ESCALATION DETECTED");
  });
});

describe("lint fix loop: errors-first scope (R2)", () => {
  it("warnings stay out of the fix ask while errors exist", async () => {
    runCli
      .mockResolvedValueOnce({ stdout: "", stderr: [
        "%Error-WIDTH: ctr.sv:4: operand width mismatch",
        "%Warning-UNUSEDSIGNAL: ctr.sv:1: Signal is not used: en",
        "%Warning-BLKSEQ: ctr.sv:4: Blocking assignment in sequential process",
      ].join("\n"), exitCode: 1 })
      // recheck: clean → ACCEPT, loop converges next iteration
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    callLLM.mockResolvedValue(llmReply({ code: RTL.replace("1'b1", "4'd1"), fixes: [{ id: "WIDTH#4", desc: "sized" }] }));

    await lintNode(baseState());

    const ask = callLLM.mock.calls[0][0].userMessage;
    expect(ask).toMatch(/LINT FINDINGS TO RESOLVE \(1\)/);    // the error only
    expect(ask).toContain("[WIDTH#4]");
    expect(ask).not.toContain("UNUSEDSIGNAL");
    expect(ask).not.toContain("BLKSEQ");
  });

  it("strict mode (lintWarningsAsErrors) keeps warnings in the ask — they ARE the target", async () => {
    runCli
      .mockResolvedValueOnce({ stdout: "", stderr: [
        "%Error-WIDTH: ctr.sv:4: operand width mismatch",
        "%Warning-BLKSEQ: ctr.sv:4: Blocking assignment in sequential process",
      ].join("\n"), exitCode: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    callLLM.mockResolvedValue(llmReply({ code: RTL.replace("1'b1", "4'd1"), fixes: [] }));

    await lintNode(baseState({ lintWarningsAsErrors: true }));

    const ask = callLLM.mock.calls[0][0].userMessage;
    expect(ask).toMatch(/LINT FINDINGS TO RESOLVE \(2\)/);
    expect(ask).toContain("BLKSEQ");
  });
});
