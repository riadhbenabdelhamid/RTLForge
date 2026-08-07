// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Best-of-N generation (#17) — pure core + node wiring.
//
// Part 1 exercises the pure selection policy in src/pipeline/bestOfN.js with
// no mocks. Part 2 drives rtl_generate / test_generate against mocked LLM + CLI
// to confirm the cold-gen path selects the cleanest candidate, ledgers every
// candidate into the durable _genLlmsRtl/_genLlmsTb keys, and that N=1 / no
// backend / informed-fix all stay single-shot.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveBestOfN, resolveBestOfNTemp, diversityConfig, summarizeLint,
  rankCandidates, runBestOfN, bestOfNMeta, RANK_CRITERIA,
} from "../src/pipeline/bestOfN.js";

// ─── Part 1: pure core ──────────────────────────────────────────────────────

describe("resolveBestOfN / resolveBestOfNTemp", () => {
  it("defaults to 1 / 0.7 and clamps junk", () => {
    expect(resolveBestOfN({})).toBe(1);
    expect(resolveBestOfN(null)).toBe(1);
    expect(resolveBestOfN({ bestOfN: 4 })).toBe(4);
    expect(resolveBestOfN({ bestOfN: 0 })).toBe(1);     // < 1 → off
    expect(resolveBestOfN({ bestOfN: -3 })).toBe(1);
    expect(resolveBestOfN({ bestOfN: 99 })).toBe(8);    // hard cap
    expect(resolveBestOfN({ bestOfN: "3" })).toBe(3);   // numeric strings
    expect(resolveBestOfN({ bestOfN: "x" })).toBe(1);

    expect(resolveBestOfNTemp({})).toBe(0.7);
    expect(resolveBestOfNTemp({ bestOfNTemp: 0 })).toBe(0);
    expect(resolveBestOfNTemp({ bestOfNTemp: 1.2 })).toBe(1.2);
    expect(resolveBestOfNTemp({ bestOfNTemp: 9 })).toBe(2);   // cap
    expect(resolveBestOfNTemp({ bestOfNTemp: -1 })).toBe(0.7);
  });
});

describe("diversityConfig", () => {
  it("candidate 0 is the greedy baseline (config untouched)", () => {
    const base = { temperature: 0.1, seed: 42, model: "m" };
    expect(diversityConfig(base, 0, 0.7)).toBe(base);   // same reference
  });

  it("candidates >= 1 explore at temp with a per-candidate seed offset", () => {
    const base = { temperature: 0.1, seed: 42, model: "m" };
    const c1 = diversityConfig(base, 1, 0.7);
    const c2 = diversityConfig(base, 2, 0.7);
    expect(c1).not.toBe(base);
    expect(c1.temperature).toBe(0.7);
    expect(c1.seed).toBe(43);
    expect(c2.seed).toBe(44);
    expect(c1.model).toBe("m");        // other fields preserved
    expect(base.temperature).toBe(0.1); // base not mutated
  });

  it("does not inject a seed when the base left it provider-default", () => {
    const c1 = diversityConfig({ temperature: 0.1 }, 1, 0.5);
    expect(c1.temperature).toBe(0.5);
    expect("seed" in c1).toBe(false);
  });
});

describe("summarizeLint", () => {
  it("maps a parsed CLI result to {compiles, errors, warnings}", () => {
    expect(summarizeLint({ exitCode: 0, errors: [], warnings: [] }))
      .toEqual({ compiles: true, errors: 0, warnings: 0 });
    expect(summarizeLint({ exitCode: 0, errors: [], warnings: [1, 2] }))
      .toEqual({ compiles: true, errors: 0, warnings: 2 });
    expect(summarizeLint({ exitCode: 1, errors: [1], warnings: [] }))
      .toEqual({ compiles: false, errors: 1, warnings: 0 });
    // exitCode 0 but an error present is still "does not compile cleanly"
    expect(summarizeLint({ exitCode: 0, errors: [1], warnings: [] }).compiles).toBe(false);
  });

  it("returns null when there is no usable result", () => {
    expect(summarizeLint(null)).toBe(null);
    expect(summarizeLint({})).toBe(null);
  });
});

describe("rankCandidates", () => {
  const c = (index, compiles, errors, warnings) =>
    ({ index, lint: { compiles, errors, warnings } });

  it("compiles dominates errors dominates warnings", () => {
    const cands = [
      c(0, false, 0, 0),  // doesn't compile
      c(1, true, 0, 2),   // compiles, 2 warnings
      c(2, true, 0, 0),   // compiles, clean  ← winner
      c(3, true, 1, 0),   // compiles but 1 error
    ];
    const { winner, ranked } = rankCandidates(cands, RANK_CRITERIA);
    expect(winner.index).toBe(2);
    expect(ranked.map((r) => r.index)).toEqual([2, 1, 3, 0]);
  });

  it("breaks ties by lower index (greedy baseline wins)", () => {
    const cands = [c(0, true, 0, 0), c(1, true, 0, 0), c(2, true, 0, 0)];
    expect(rankCandidates(cands).winner.index).toBe(0);
  });

  it("a candidate with no lint ranks worst on every axis", () => {
    const cands = [{ index: 0, lint: null }, c(1, true, 5, 9)];
    expect(rankCandidates(cands).winner.index).toBe(1);
  });
});

describe("runBestOfN (orchestrator with injected effects)", () => {
  const mkGen = (codes) => async (cfg, i) => ({ code: codes[i], llms: [{ tokensIn: 1, tokensOut: 1, i }] });
  const lintByCode = (table) => async (code) => table[code] || null;

  it("draws N, lints each, and returns the cleanest", async () => {
    const r = await runBestOfN({
      n: 3,
      makeConfig: (i) => ({ i }),
      generate: mkGen(["A", "B", "C"]),
      lintCode: lintByCode({
        A: { compiles: false, errors: 1, warnings: 0 },
        B: { compiles: true, errors: 0, warnings: 0 },
        C: { compiles: true, errors: 0, warnings: 3 },
      }),
    });
    expect(r.winner.code).toBe("B");
    expect(r.candidates).toHaveLength(3);
  });

  it("honors shouldContinue (budget) — stops drawing further candidates", async () => {
    let drawn = 0;
    const r = await runBestOfN({
      n: 5,
      makeConfig: (i) => ({ i }),
      generate: async (cfg, i) => { drawn++; return { code: "X" + i, llms: [] }; },
      lintCode: async () => ({ compiles: true, errors: 0, warnings: 0 }),
      shouldContinue: (i) => i < 2,   // allow draws 1, stop before 2
    });
    expect(drawn).toBe(2);           // candidate 0 (baseline) + candidate 1
    expect(r.candidates).toHaveLength(2);
  });

  it("propagates a candidate-0 generation error (the stage truly failed)", async () => {
    await expect(runBestOfN({
      n: 3,
      makeConfig: (i) => ({ i }),
      generate: async () => { throw new Error("baseline boom"); },
      lintCode: async () => null,
    })).rejects.toThrow("baseline boom");
  });

  it("skips a later candidate that fails to generate, keeps the rest", async () => {
    const skipped = [];
    const r = await runBestOfN({
      n: 3,
      makeConfig: (i) => ({ i }),
      generate: async (cfg, i) => {
        if (i === 1) throw new Error("flaky draw");
        return { code: "OK" + i, llms: [] };
      },
      lintCode: async () => ({ compiles: true, errors: 0, warnings: 0 }),
      onCandidate: (rec) => { if (rec.error) skipped.push(rec.index); },
    });
    expect(r.candidates.map((c) => c.index)).toEqual([0, 2]);
    expect(skipped).toEqual([1]);
  });
});

describe("bestOfNMeta", () => {
  it("summarizes the ranking for the trace", () => {
    const result = {
      winner: { index: 1 },
      candidates: [{}, {}],
      ranked: [
        { index: 1, lint: { compiles: true, errors: 0, warnings: 0 } },
        { index: 0, lint: { compiles: false, errors: 2, warnings: 1 } },
      ],
    };
    const m = bestOfNMeta(result);
    expect(m.n).toBe(2);
    expect(m.winner).toBe(1);
    expect(m.ranking[0]).toEqual({ index: 1, compiles: true, errors: 0, warnings: 0 });
    expect(m.ranking[1].compiles).toBe(false);
  });
});

// ─── Part 2: node wiring (mocked LLM + CLI) ─────────────────────────────────

const h = vi.hoisted(() => ({ genCount: 0 }));

vi.mock("../src/prompts/index.js", () => ({
  promptRTL: () => ({ messages: [{ role: "user", content: "cold-rtl" }] }),
  promptTB:  () => ({ messages: [{ role: "user", content: "cold-tb" }] }),
  // Pass-through echo guard (real one strips findings-format lines).
  stripFindingEchoes: (code) => ({ code, stripped: 0 }),
}));
vi.mock("../src/prompts/lint.js", () => ({
  promptRTLFix:    () => ({ messages: [] }),
  promptTBLintFix: () => ({ messages: [] }),
}));
vi.mock("../src/prompts/verify.js", () => ({
  promptRTLFromVerifyFail: () => ({ messages: [] }),
  promptTBFromVerifyFail:  () => ({ messages: [] }),
}));
vi.mock("../src/prompts/rtlReview.js", () => ({ promptRTLReviewFix: () => ({ messages: [] }) }));
vi.mock("../src/prompts/testReview.js", () => ({ promptTestReviewFix: () => ({ messages: [] }) }));
vi.mock("../src/pipeline/applySkillsToPrompt.js", () => ({
  applySkillsToPrompt: async (p) => p,
}));
vi.mock("../src/constants/index.js", async () => {
  const actual = await vi.importActual("../src/constants/index.js");
  return Object.assign({}, actual, {
    getStageConfig: () => ({ _maxTokens: 1000, temperature: 0.1, seed: 42 }),
  });
});

// Each cold draw returns a distinct candidate code: CAND0, CAND1, CAND2, …
vi.mock("../src/llm/index.js", () => ({
  callLLMJson: vi.fn(async () => {
    const i = h.genCount++;
    const code = "module CAND" + i + "(input logic clk); endmodule";
    return {
      data: { code },
      llms: [{ text: JSON.stringify({ code }), tokensIn: 10, tokensOut: 5, latencyMs: 1, model: "stub", provider: "stub" }],
      parseRetried: 0,
    };
  }),
  callLLM: vi.fn(async () => ({ text: "{}", tokensIn: 0, tokensOut: 0, latencyMs: 0, model: "stub", provider: "stub" })),
  extractJSON: (t) => JSON.parse(t),
  addRetryHint: () => {},
}));

// CAND0 doesn't elaborate; CAND1 is clean; CAND2 elaborates with a warning.
vi.mock("../src/cli/index.js", () => ({
  runCli: vi.fn(async (url, payload) => {
    const code = Object.values(payload.files || {}).join("\n");
    if (code.includes("CAND0")) return {
    extractInfoEvidence: function() { return []; },
    attachInfoEvidence: function(t) { return t; }, exitCode: 1, stderr: "%Error: does not elaborate" };
    if (code.includes("CAND2")) return { exitCode: 0, stderr: "%Warning-WIDTH: meh" };
    return { exitCode: 0, stderr: "" };   // CAND1 / clean
  }),
  parseCLIOutput: (stderr) => {
    const errors = [], warnings = [];
    (stderr || "").split("\n").forEach((line) => {
      if (/^%Error/.test(line)) errors.push({ code: "ERR", msg: line });
      if (/^%Warning/.test(line)) warnings.push({ code: "WARN", msg: line });
    });
    return { errors, warnings };
  },
  CliBackendError: class CliBackendError extends Error {
    constructor(msg, attempts) { super(msg); this.name = "CliBackendError"; this.attempts = attempts || 1; }
  },
}));

const { rtlGenerateNode } = await import("../src/pipeline/nodes/rtl_generate.js");
const { testGenerateNode } = await import("../src/pipeline/nodes/test_generate.js");
const llmMod = await import("../src/llm/index.js");
const cliMod = await import("../src/cli/index.js");

beforeEach(() => {
  h.genCount = 0;
  llmMod.callLLMJson.mockClear();
  cliMod.runCli.mockClear();
});

describe("rtl_generate best-of-N node wiring", () => {
  const baseSt = (cfg) => ({ architect: {}, spec: {}, elicit: { modName: "foo" }, _onLog: () => {}, _config: cfg });

  it("best-of-3 picks the cleanest-elaborating candidate and ledgers all 3 draws", async () => {
    const out = await rtlGenerateNode(baseSt({ bestOfN: 3, backendUrl: "http://x" }));
    expect(llmMod.callLLMJson).toHaveBeenCalledTimes(3);
    expect(cliMod.runCli).toHaveBeenCalledTimes(3);
    expect(out.rtl_generate.code).toContain("CAND1");     // clean compile wins
    expect(out.rtl_generate._bestOfN.n).toBe(3);
    expect(out.rtl_generate._bestOfN.winner).toBe(1);
    // Durable cold-gen ledger holds every candidate's call (3 draws).
    expect(out._genLlmsRtl).toHaveLength(3);
    expect(out.rtl_generate._llms).toHaveLength(3);
  });

  it("N=1 stays single-shot (no lint, no _bestOfN) but still publishes the durable key", async () => {
    const out = await rtlGenerateNode(baseSt({ bestOfN: 1, backendUrl: "http://x" }));
    expect(llmMod.callLLMJson).toHaveBeenCalledTimes(1);
    expect(cliMod.runCli).not.toHaveBeenCalled();
    expect(out.rtl_generate.code).toContain("CAND0");
    expect(out.rtl_generate._bestOfN).toBeUndefined();
    expect(out._genLlmsRtl).toHaveLength(1);
  });

  it("no backend → single-shot even with bestOfN>=2 (selector unavailable)", async () => {
    const out = await rtlGenerateNode(baseSt({ bestOfN: 4 }));
    expect(llmMod.callLLMJson).toHaveBeenCalledTimes(1);
    expect(cliMod.runCli).not.toHaveBeenCalled();
    expect(out.rtl_generate._bestOfN).toBeUndefined();
  });

  // Ranking must use the SAME file set the module ships with. In a system run
  // every candidate imports the shared package and instantiates its children;
  // linting each one ALONE fails them all identically on "Import package not
  // found", and the selection degenerates to "candidate 0 wins the tie"
  // (run 47).
  it("ranks candidates against the shared package and the children, package first", async () => {
    const st = baseSt({ bestOfN: 2, backendUrl: "http://x" });
    st._sharedPackageCode = "package uart_pkg;\n  localparam int W = 8;\nendpackage";
    st._childInterfaces = [{ modName: "uart_tx", code: "module uart_tx; endmodule" }];
    await rtlGenerateNode(st);
    expect(cliMod.runCli).toHaveBeenCalledTimes(2);
    const payload = cliMod.runCli.mock.calls[0][1];
    expect(Object.keys(payload.files)).toEqual(["uart_pkg.sv", "uart_tx.sv", "foo.sv"]);
    expect(payload.command).toContain("uart_pkg.sv uart_tx.sv foo.sv");
  });

  it("a single-module run stages the module alone, exactly as before", async () => {
    await rtlGenerateNode(baseSt({ bestOfN: 2, backendUrl: "http://x" }));
    const payload = cliMod.runCli.mock.calls[0][1];
    expect(Object.keys(payload.files)).toEqual(["foo.sv"]);
    expect(payload.command).toBe("verilator --lint-only -Wall foo.sv");
  });

  it("informed-fix branch is never best-of-N and never sets the cold-gen key", async () => {
    const st = baseSt({ bestOfN: 3, backendUrl: "http://x" });
    st._fixContext = { source: "lint", lintResult: { errors: [{ code: "X" }], warnings: [] } };
    const out = await rtlGenerateNode(st);
    expect(llmMod.callLLMJson).toHaveBeenCalledTimes(1);
    expect(cliMod.runCli).not.toHaveBeenCalled();
    expect(out._genLlmsRtl).toBeUndefined();   // cold-gen scope only
  });
});

describe("test_generate best-of-N node wiring", () => {
  const baseSt = (cfg) => ({
    rtl_generate: { code: "module foo; endmodule" },
    spec: {}, elicit: { modName: "foo" }, _onLog: () => {}, _config: cfg,
  });

  it("best-of-3 selects the cleanest-integrating TB and ledgers via _genLlmsTb", async () => {
    const out = await testGenerateNode(baseSt({ bestOfN: 3, backendUrl: "http://x" }));
    expect(llmMod.callLLMJson).toHaveBeenCalledTimes(3);
    expect(out.test_generate.code).toContain("CAND1");
    expect(out.test_generate._bestOfN.winner).toBe(1);
    expect(out._genLlmsTb).toHaveLength(3);
  });
});
