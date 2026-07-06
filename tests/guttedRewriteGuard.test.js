// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Structural-collapse guard (detectGuttedRewrite) + lintNode rejection.
//
// Bug: a fix/regen loop would "resolve" a lint finding by DELETING the code
// that caused it — collapsing the module to `module four_bit_counter;
// endmodule`. An empty module LINTS CLEAN, so the classifier read the baseline
// findings as "resolved" and the issue-count best-known tracker preferred 0
// over N — the gutted stub shipped. The guard rejects such candidates.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectGuttedRewrite } from "../src/pipeline/fixLoopHelpers.js";

const REAL = `module four_bit_counter(input clk, input rst_n, input en, output reg [3:0] q);
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) q <= 4'b0000;
    else if (en)  q <= q + 1'b1;
  end
endmodule`;

describe("detectGuttedRewrite", () => {
  it("flags the exact reported symptom — an empty shell with no ports", () => {
    expect(detectGuttedRewrite(REAL, "module four_bit_counter;\nendmodule")).toBe(true);
  });

  it("flags an empty body even when the port list is retained", () => {
    const shell = "module four_bit_counter(input clk, input rst_n, output reg [3:0] q);\nendmodule";
    expect(detectGuttedRewrite(REAL, shell)).toBe(true);
  });

  it("flags an empty parameterized module shell", () => {
    expect(detectGuttedRewrite(REAL, "module ctr #(parameter W=4) (input clk); endmodule")).toBe(true);
  });

  it("flags severe partial loss (candidate drops most of the body — 30% retained)", () => {
    const stub = "module four_bit_counter(input clk); reg [3:0] q; endmodule";
    expect(detectGuttedRewrite(REAL, stub)).toBe(true);
  });

  it("does NOT flag a moderate rewrite that retains ~half the body (conservative threshold)", () => {
    // Keeps ports + a real assign (41% retained) — above the 0.4 ratio, so the
    // guard stays out of the way. A false positive would only cost a skipped
    // candidate, but the threshold is set to avoid even that on real fixes.
    const half = "module four_bit_counter(input clk, output reg [3:0] q);\n  assign q = 0;\nendmodule";
    expect(detectGuttedRewrite(REAL, half)).toBe(false);
  });

  it("does NOT flag a genuine minimal fix (blocking → nonblocking, ports intact)", () => {
    const fixed = REAL.replace("q <= q + 1'b1", "q  <= q + 1'b1");   // 1-char cosmetic
    expect(detectGuttedRewrite(REAL, fixed)).toBe(false);
  });

  it("does NOT flag a fix that adds a lint_off suppression (grows the file)", () => {
    const grown = REAL.replace("endmodule", "  /* verilator lint_off UNUSEDSIGNAL */\nendmodule");
    expect(detectGuttedRewrite(REAL, grown)).toBe(false);
  });

  it("does NOT flag when there is nothing substantial to protect (tiny baseline)", () => {
    // The existing lintNode converge fixture uses exactly this shape.
    expect(detectGuttedRewrite("module sync_fifo; endmodule", "module sync_fifo_fixed; endmodule")).toBe(false);
  });

  it("does NOT misread a real module whose last statement ends in ');' before endmodule", () => {
    const withCall = `module m(input a, output y);
  sub u_sub (.a(a), .y(y));
endmodule`;
    // withCall is < 120 meaningful chars here, but the point is the empty-body
    // regex must not match it — pad the body so it clears minChars and rely on
    // the ratio branch returning false (it's a full module vs a full module).
    const padded = withCall.replace("endmodule", "  // ".padEnd(140, "x") + "\n  wire [7:0] tmp; assign tmp = 8'h00;\nendmodule");
    expect(detectGuttedRewrite(REAL, padded)).toBe(false);
  });

  it("treats a non-string candidate (flaky nested object) as gutted", () => {
    expect(detectGuttedRewrite(REAL, { code: "oops" })).toBe(true);
  });

  it("is symmetric on emptiness: a real fix of a real module is kept", () => {
    const other = REAL.replace("four_bit_counter", "counter4");
    expect(detectGuttedRewrite(REAL, other)).toBe(false);
  });
});

// ─── lintNode rejects a gutted fix candidate ────────────────────────────────

vi.mock("../src/llm/index.js", async function() {
  const actual = await vi.importActual("../src/llm/extractJSON.js");
  return { callLLM: vi.fn(), extractJSON: actual.extractJSON, addRetryHint: function(s) { return s; } };
});
vi.mock("../src/cli/index.js", function() {
  return {
    runCli: vi.fn(),
    parseCLIOutput: function(stderr) {
      const errors = [], warnings = [];
      (stderr || "").split("\n").forEach(function(line) {
        if (/^%Error/.test(line))   errors.push({ code: "WIDTH", sev: "error", msg: line });
        if (/^%Warning/.test(line)) warnings.push({ code: "WARN", sev: "warning", msg: line });
      });
      return { errors, warnings };
    },
    CliBackendError: class extends Error {},
  };
});

const { lintNode } = await import("../src/pipeline/nodes/lint.js");
const { callLLM } = await import("../src/llm/index.js");
const { runCli } = await import("../src/cli/index.js");

function baseState() {
  return {
    elicit: { modName: "four_bit_counter" },
    spec: { requirements: [], iface: [], params: [] },
    rtl_generate: { code: REAL },
    _config: {
      provider: "openai", model: "gpt-4o", apiKey: "sk-test",
      maxLintIters: 3, backendUrl: "http://localhost:3001", strictCli: true,
      cliRetryCount: 0, backendTimeoutSec: 10, stageSettings: {},
    },
    _onLog: null, _signal: null,
  };
}

beforeEach(() => { callLLM.mockReset(); runCli.mockReset(); });

describe("lintNode rejects a gutted fix (keeps real RTL rather than shipping an empty module)", () => {
  it("empty-module fix is rejected; original code kept; loop stagnates without adopting the stub", async () => {
    // Every lint of the (unchanged) real RTL reports one error.
    runCli.mockResolvedValue({ stdout: "", stderr: "%Error: four_bit_counter.sv:3:17: width mismatch\n", exitCode: 1 });
    // Every fix returns the reported empty shell.
    callLLM.mockResolvedValue({
      text: JSON.stringify({ code: "module four_bit_counter;\nendmodule", fixes: ["allegedly fixed"] }),
      tokensIn: 10, tokensOut: 5, latencyMs: 1, model: "gpt-4o", provider: "openai", stopReason: "stop",
    });

    const d = await lintNode(baseState());

    // The gutted stub was NEVER adopted — the shipped code is the real module.
    expect(d.rtl_generate.code).toBe(REAL);
    expect(d.rtl_generate.code).not.toMatch(/^module four_bit_counter;\s*endmodule\s*$/);
    expect(d.rtl_generate._originalCode).toBeUndefined();     // code unchanged → no fix marker
    // Both fix attempts were flagged as gutted, and stagnation stopped the loop.
    expect(d.lint.iterations.some((it) => it.gutted)).toBe(true);
    expect(d.lint.iterations.every((it) => !it.regression)).toBe(true);
    // No recheck CLI run happened for the gutted candidate (guard fires first):
    // one lint per iteration, two iterations → two runCli calls, two fix calls.
    expect(runCli).toHaveBeenCalledTimes(2);
    expect(callLLM).toHaveBeenCalledTimes(2);
  });
});
