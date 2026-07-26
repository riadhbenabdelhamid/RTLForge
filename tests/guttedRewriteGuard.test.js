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
import { detectGuttedRewrite, noDeletionDirective, detectTbInfraLoss, stripEmbeddedTbModules, repairRtlCandidate, detectImplausibleArtifact } from "../src/pipeline/fixLoopHelpers.js";

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

  // ── detectTbInfraLoss (measured: nemotron run 4 — a late TB fix rewrote the
  //    whole bench, dropping step()/check()/ref_ model; the rewrite was LARGER
  //    than the original so detectGuttedRewrite could not fire) ──
  describe("detectTbInfraLoss", () => {
    const REF_TB = [
      "module ctr_tb;",
      "  task automatic step(input int n = 1); repeat (n) begin @(posedge clk); #1; end endtask",
      "  task automatic check(input bit c, input string l); if (c) passes++; else fails++; endtask",
      "  logic [3:0] ref_count;",
      "  always_ff @(posedge clk or negedge rst_n) if (!rst_n) ref_count <= '0; else if (en) ref_count <= ref_count + 1'b1;",
      "  initial begin step(4); check(q == ref_count, \"REQ-FUNC-001.1\"); end",
      "endmodule",
    ].join("\n");

    it("flags the measured rewrite: bigger TB that lost step/check/ref infrastructure", () => {
      const garbage = REF_TB.replace(/task automatic step[^\n]*\n/, "")
        .replace(/task automatic check[^\n]*\n/, "// checks inlined\n")
        .replace(/ref_count/g, "expected")
        + "\n// padding ".repeat(40);
      expect(garbage.length).toBeGreaterThan(REF_TB.length);      // gutted guard blind
      expect(detectGuttedRewrite(REF_TB, garbage)).toBe(false);
      expect(detectTbInfraLoss(REF_TB, garbage)).toBe(true);
    });

    it("flags loss of ANY single marker (step task removed, rest kept)", () => {
      const noStep = REF_TB.replace(/task automatic step[^\n]*\n/, "").replace("step(4); ", "");
      expect(detectTbInfraLoss(REF_TB, noStep)).toBe(true);
    });

    it("does NOT flag a legitimate fix that keeps the infrastructure", () => {
      const fixed = REF_TB.replace("step(4)", "step(5)");
      expect(detectTbInfraLoss(REF_TB, fixed)).toBe(false);
    });

    it("does NOT flag a directed-architecture TB (no markers to protect)", () => {
      const directed = "module tb;\n  initial begin\n    @(posedge clk);\n    if (q !== 4'h4) $error(\"bad\");\n  end\nendmodule";
      expect(detectTbInfraLoss(directed, directed + "\n// fix comment")).toBe(false);
    });

    it("does NOT flag a fix that ADDS ref-model infrastructure to a directed TB", () => {
      const directed = "module tb;\n  initial @(posedge clk);\nendmodule";
      expect(detectTbInfraLoss(directed, REF_TB)).toBe(false);
    });

    // Measured (run 8 resume): a verify TB fix deleted apply_reset while its
    // call sites remained — named markers didn't cover it.
    it("flags a fix that removes a task definition but leaves its calls (orphaned calls)", () => {
      const withReset = REF_TB.replace("initial begin",
        "task automatic apply_reset(); rst_n = 0; repeat (2) @(posedge clk); rst_n = 1; endtask\n  initial begin\n    apply_reset();");
      const dropped = withReset.replace(/task automatic apply_reset\(\);[^\n]*endtask\n/, "");
      expect(dropped).toContain("apply_reset();");            // calls remain
      expect(detectTbInfraLoss(withReset, dropped)).toBe(true);
    });

    // Measured (run 9): reasoning-token exhaustion made the model echo the
    // JSON template — "<complete testbench source>" shipped as the TB.
    it("detectImplausibleArtifact flags placeholders, prose, empties, non-strings", () => {
      expect(detectImplausibleArtifact("<complete testbench source>")).toBe(true);
      expect(detectImplausibleArtifact("")).toBe(true);
      expect(detectImplausibleArtifact(null)).toBe(true);
      expect(detectImplausibleArtifact({ code: "x" })).toBe(true);
      expect(detectImplausibleArtifact("Here is a description of the testbench I would write, covering reset and increment behavior in detail.")).toBe(true);   // prose, no module
      expect(detectImplausibleArtifact(REF_TB)).toBe(false);   // real TB passes
    });

    it("does NOT flag a fix that removes a task together with ALL its calls", () => {
      const withReset = REF_TB.replace("initial begin",
        "task automatic apply_reset(); rst_n = 0; endtask\n  initial begin\n    apply_reset();");
      const removedBoth = withReset
        .replace(/task automatic apply_reset\(\);[^\n]*endtask\n/, "")
        .replace(/apply_reset\(\);\s*/, "");
      expect(detectTbInfraLoss(withReset, removedBoth)).toBe(false);
    });
  });

  // ── stripEmbeddedTbModules (measured: nemotron run 7 — an rtl_review fix
  //    appended a complete `module up_counter_4bit_tb; … endmodule` after the
  //    DUT; at verify the RTL artifact collides with the real TB artifact) ──
  describe("stripEmbeddedTbModules / repairRtlCandidate", () => {
    const DUT = "module up_counter_4bit(input logic clk, output logic [3:0] q);\n  always_ff @(posedge clk) q <= q + 1'b1;\nendmodule // up_counter_4bit";
    const TB = "module up_counter_4bit_tb;\n  logic clk;\n  up_counter_4bit dut(.clk(clk), .q(q));\n  initial begin clk = 0; end\nendmodule";

    it("strips the measured leak: TB module appended after the DUT", () => {
      const r = stripEmbeddedTbModules(DUT + "\n\n" + TB);
      expect(r.stripped).toEqual(["up_counter_4bit_tb"]);
      expect(r.code).toContain("module up_counter_4bit(");
      expect(r.code).not.toContain("module up_counter_4bit_tb;");
    });

    it("never strips when the artifact IS a lone testbench (kind safety net)", () => {
      const r = stripEmbeddedTbModules(TB);
      expect(r.stripped).toEqual([]);
      expect(r.code).toBe(TB);
    });

    it("pure RTL passes through unchanged", () => {
      const r = stripEmbeddedTbModules(DUT);
      expect(r.stripped).toEqual([]);
      expect(r.code).toBe(DUT);
    });

    it("repairRtlCandidate composes strip + syntax repair (both fire)", () => {
      const broken = DUT.replace("q <= q + 1'b1", "q <= (4){1'b0}") + "\n\n" + TB;
      const r = repairRtlCandidate({ syntaxRepair: true }, broken, null);
      expect(r.code).not.toContain("_tb;");
      expect(r.code).toContain("q <= {4{1'b0}}");
    });

    it("repairRtlCandidate passes non-string candidates through untouched", () => {
      const obj = { code: "oops" };
      expect(repairRtlCandidate({ syntaxRepair: true }, obj, null).code).toBe(obj);
    });
  });

  it("is symmetric on emptiness: a real fix of a real module is kept", () => {
    const other = REAL.replace("four_bit_counter", "counter4");
    expect(detectGuttedRewrite(REAL, other)).toBe(false);
  });
});

describe("noDeletionDirective", () => {
  it("appends a complete-module requirement to the fix prompt and preserves the rest", () => {
    const p = { systemPrompt: "SYS", userMessage: "fix this", maxTokens: 8000 };
    const out = noDeletionDirective(p);
    expect(out).not.toBe(p);                            // shallow copy, not mutated
    expect(p.userMessage).toBe("fix this");             // original untouched
    expect(out.systemPrompt).toBe("SYS");
    expect(out.maxTokens).toBe(8000);
    expect(out.userMessage).toContain("fix this");
    expect(out.userMessage).toContain("COMPLETE");
    expect(out.userMessage).toMatch(/keep|Keep/i);
    // Phrased positively — it tells the model to CORRECT, not a list of don'ts.
    expect(out.userMessage).toMatch(/CORRECT/i);
  });

  it("tolerates a prompt with no userMessage", () => {
    const out = noDeletionDirective({ systemPrompt: "s" });
    expect(typeof out.userMessage).toBe("string");
    expect(out.userMessage.length).toBeGreaterThan(0);
  });
});

// ─── lintNode rejects a gutted fix candidate ────────────────────────────────

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

const gutted = (json) => ({
  text: JSON.stringify(json), tokensIn: 10, tokensOut: 5, latencyMs: 1,
  model: "gpt-4o", provider: "openai", stopReason: "stop",
});

describe("lintNode re-asks for a working replacement when a fix comes back gutted", () => {
  it("gutted fix → re-ask returns a COMPLETE module → the working replacement is adopted and ships", async () => {
    // A realistic lint fix (reg→logic, always→always_ff, sized literals) — a
    // complete module, materially different from the baseline (so the churn
    // tracker doesn't read it as a cosmetic re-emission).
    const WORKING = `module four_bit_counter(input clk, input rst_n, input en, output logic [3:0] q);
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) q <= 4'd0;
    else if (en)  q <= q + 4'd1;
  end
endmodule`;
    // iter1 primary lint → error; recheck of the working replacement → clean;
    // iter2 primary lint → clean (converge).
    runCli
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error: four_bit_counter.sv:3:17: width mismatch\n", exitCode: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    // fix#1 guts the module; the re-ask returns the working replacement.
    callLLM
      .mockResolvedValueOnce(gutted({ code: "module four_bit_counter;\nendmodule", fixes: ["deleted body"] }))
      .mockResolvedValueOnce(gutted({ code: WORKING, fixes: ["widened literal"] }));

    const d = await lintNode(baseState());

    expect(d.rtl_generate.code).toBe(WORKING);                 // working replacement, NOT the stub
    expect(d.rtl_generate.code).toContain("always_ff");        // the real fix landed
    expect(d.rtl_generate._fixSource).toBe("fixed post lint");
    expect(d.rtl_generate._originalCode).toBe(REAL);
    expect(d.lint.status).toBe("PASS");
    expect(d.lint.iterations[0]._structured.kind).toBe("rtl_fix_reask");
    expect(callLLM).toHaveBeenCalledTimes(2);                  // fix + re-ask
    // The re-ask prompt carried the complete-module directive.
    const reaskPrompt = callLLM.mock.calls[1][0];
    expect(reaskPrompt.userMessage).toContain("COMPLETE");
  });

  it("gutted fix AND gutted re-ask → keep the real RTL as last resort; loop stagnates, never ships the stub", async () => {
    runCli.mockResolvedValue({ stdout: "", stderr: "%Error: four_bit_counter.sv:3:17: width mismatch\n", exitCode: 1 });
    callLLM.mockResolvedValue(gutted({ code: "module four_bit_counter;\nendmodule", fixes: ["deleted body"] }));

    const d = await lintNode(baseState());

    // Never adopted the stub — shipped the real module with its finding.
    expect(d.rtl_generate.code).toBe(REAL);
    expect(d.rtl_generate.code).not.toMatch(/^module four_bit_counter;\s*endmodule\s*$/);
    expect(d.rtl_generate._originalCode).toBeUndefined();      // code unchanged → no fix marker
    expect(d.lint.iterations.some((it) => it.gutted)).toBe(true);
    // Each iteration does fix + re-ask (both gutted); two iterations to stagnation.
    expect(runCli).toHaveBeenCalledTimes(2);                   // 2 primary lints, no rechecks
    expect(callLLM).toHaveBeenCalledTimes(4);                  // (fix + re-ask) × 2
  });
});
