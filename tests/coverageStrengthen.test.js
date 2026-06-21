// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Task #19: coverage-driven TB strengthening. Pure helpers + the driver with
// runCli/callLLM/extractJSON stubbed — no live backend.

import { describe, it, expect, vi } from "vitest";
import { parseCoverageBuckets } from "../src/cli/index.js";
import {
  findCoverageGaps, acceptStrengthening, withCoverageCmds, coveredReqIds,
  runCoverageStrengthening,
} from "../src/pipeline/coverageStrengthen.js";

// ── parseCoverageBuckets ─────────────────────────────────────────────────────
describe("parseCoverageBuckets", () => {
  it("extracts count-0 records as uncovered points and tallies byKind", () => {
    const dat = [
      "C 'top.sv:10:3\\line\\...' 5",
      "C 'top.sv:11:3\\line\\...' 0",
      "C 'top.sv:12:3\\branch\\...' 0",
    ].join("\n");
    const out = parseCoverageBuckets(dat);
    expect(out.uncovered).toEqual([
      { file: "top.sv", line: 11, kind: "line" },
      { file: "top.sv", line: 12, kind: "branch" },
    ]);
    expect(out.byKind.line).toEqual({ hit: 1, total: 2 });
    expect(out.byKind.branch).toEqual({ hit: 0, total: 1 });
  });

  it("returns empty for summary-only files and honors the cap", () => {
    expect(parseCoverageBuckets("# COVERAGE: line 80%").uncovered).toEqual([]);
    const many = Array.from({ length: 100 }, (_, i) => "C 'f.sv:" + i + ":0\\line\\' 0").join("\n");
    expect(parseCoverageBuckets(many, { cap: 5 }).uncovered).toHaveLength(5);
  });
});

// ── findCoverageGaps ─────────────────────────────────────────────────────────
describe("findCoverageGaps", () => {
  it("flags only gated kinds below threshold", () => {
    const g = findCoverageGaps({
      cov: { line: 60, branch: 90, toggle: 10 },
      buckets: { uncovered: [{ file: "a", line: 1, kind: "line" }] },
      thresholds: { line: 80, branch: 70 },   // toggle not gated → ignored
      requirements: [],
      coversMap: { tasks: [] },
    });
    expect(g.weakKinds).toEqual([{ kind: "line", measured: 60, threshold: 80 }]);
    expect(g.uncoveredPoints).toHaveLength(1);
  });

  it("lists uncovered Must/Should reqs (Must first), excludes covered + May", () => {
    const g = findCoverageGaps({
      cov: {}, buckets: { uncovered: [] }, thresholds: {},
      requirements: [
        { id: "REQ-A-1", pri: "Should", desc: "s" },
        { id: "REQ-B-1", pri: "Must", desc: "m" },
        { id: "REQ-C-1", pri: "Must", desc: "covered" },
        { id: "REQ-D-1", pri: "May", desc: "may" },
      ],
      coversMap: { tasks: [{ name: "t", req: "REQ-C-1" }] },
    });
    expect(g.uncoveredReqs.map((r) => r.id)).toEqual(["REQ-B-1", "REQ-A-1"]);
  });
});

// ── acceptStrengthening ──────────────────────────────────────────────────────
describe("acceptStrengthening", () => {
  const pass = (names) => names.map((n) => ({ name: n, st: "PASS" }));

  it("rejects a candidate with any failing test", () => {
    const v = acceptStrengthening(
      { cov: { line: 60 }, tests: pass(["a"]) },
      { cov: { line: 90 }, tests: [{ name: "a", st: "PASS" }, { name: "b", st: "FAIL" }] },
      { kinds: ["line"] },
    );
    expect(v).toMatchObject({ accept: false, reason: "candidate-test-failed" });
  });

  it("rejects when a previously-passing test regresses/disappears", () => {
    const v = acceptStrengthening(
      { cov: { line: 60 }, tests: pass(["a", "b"]) },
      { cov: { line: 90 }, tests: pass(["a"]) },   // b gone
      { kinds: ["line"] },
    );
    expect(v).toMatchObject({ accept: false, reason: "regression" });
  });

  it("rejects when nothing improved", () => {
    const v = acceptStrengthening(
      { cov: { line: 60 }, tests: pass(["a"]) },
      { cov: { line: 60 }, tests: pass(["a", "b"]) },
      { kinds: ["line"], reqNewlyCovered: 0 },
    );
    expect(v).toMatchObject({ accept: false, reason: "no-improvement" });
  });

  it("accepts on coverage gain", () => {
    const v = acceptStrengthening(
      { cov: { line: 60 }, tests: pass(["a"]) },
      { cov: { line: 85 }, tests: pass(["a", "b"]) },
      { kinds: ["line"] },
    );
    expect(v.accept).toBe(true);
    expect(v.gain.kinds.line).toBe(25);
  });

  it("accepts on a newly-covered requirement even with flat coverage", () => {
    const v = acceptStrengthening(
      { cov: { line: 60 }, tests: pass(["a"]) },
      { cov: { line: 60 }, tests: pass(["a", "b"]) },
      { kinds: ["line"], reqNewlyCovered: 1 },
    );
    expect(v).toMatchObject({ accept: true, reason: "improved" });
    expect(v.gain.reqsCovered).toBe(1);
  });
});

// ── withCoverageCmds / coveredReqIds ─────────────────────────────────────────
describe("withCoverageCmds + coveredReqIds", () => {
  it("adds --coverage to the compile step and a verilator_coverage step", () => {
    const out = withCoverageCmds(["verilator --binary {RTL} {TB} -o sim", "./sim"]);
    expect(out[0]).toMatch(/verilator --coverage --binary/);
    expect(out.some((c) => /verilator_coverage --write/.test(c))).toBe(true);
  });
  it("is idempotent when coverage is already present", () => {
    const cmds = ["verilator --coverage --binary {RTL} {TB} -o sim", "verilator_coverage --write logs/coverage.dat logs/coverage.dat"];
    expect(withCoverageCmds(cmds)).toHaveLength(2);
  });
  it("coveredReqIds upcases task reqs into a set", () => {
    const s = coveredReqIds({ tasks: [{ req: "req-a-1" }, { req: null }, { req: "REQ-B-1" }] });
    expect([...s].sort()).toEqual(["REQ-A-1", "REQ-B-1"]);
  });
});

// ── runCoverageStrengthening (driver, stubbed deps) ──────────────────────────
describe("runCoverageStrengthening", () => {
  const cov = (line) => "# COVERAGE: line " + line + "%";
  const baseArgs = (over) => Object.assign({
    rtl: "module m; endmodule",
    tb: "module tb; // ORIG\nendmodule",
    cmds: ["verilator --coverage --binary {RTL} {TB} -o sim && ./sim"],
    rtlFileName: "m.sv", tbFileName: "m_tb.sv",
    spec: { requirements: [] },
    thresholds: { line: 80 },
    config: { backendUrl: "http://x", coverageStrengthenRounds: 2 },
    cliOpts: {}, signal: null,
    extractJSON: (t) => JSON.parse(t),
  }, over);

  it("short-circuits when there are no gaps (no LLM call)", async () => {
    const callLLM = vi.fn();
    const runCli = vi.fn(async () => ({ stdout: "[PASS] a", files: { "logs/coverage.dat": cov(95) } }));
    const r = await runCoverageStrengthening(baseArgs({ runCli, callLLM }));
    expect(r).toMatchObject({ strengthened: false, reason: "no-gaps" });
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("adopts an improving candidate and reports the gain", async () => {
    const runCli = vi.fn(async (_url, payload) => {
      const tb = payload.files["m_tb.sv"];
      return tb.includes("STRONG")
        ? { stdout: "[PASS] a\n[PASS] b", files: { "logs/coverage.dat": cov(88) } }
        : { stdout: "[PASS] a",          files: { "logs/coverage.dat": cov(60) } };
    });
    const callLLM = vi.fn(async () => ({ text: JSON.stringify({ code: "module tb; // ORIG STRONG\nendmodule" }) }));
    const r = await runCoverageStrengthening(baseArgs({ runCli, callLLM }));
    expect(r.strengthened).toBe(true);
    expect(r.code).toMatch(/STRONG/);
    expect(r.coverageGain.line).toBe(28);
    expect(r.addedTests).toBe(1);
    expect(r.rounds).toBe(1);   // line 88 ≥ 80 → gaps cleared, loop breaks
  });

  it("discards a regressing candidate and keeps the original", async () => {
    const runCli = vi.fn(async (_url, payload) => {
      const tb = payload.files["m_tb.sv"];
      return tb.includes("BAD")
        ? { stdout: "[FAIL] a", files: { "logs/coverage.dat": cov(99) } }   // breaks test a
        : { stdout: "[PASS] a", files: { "logs/coverage.dat": cov(60) } };
    });
    const callLLM = vi.fn(async () => ({ text: JSON.stringify({ code: "module tb; // BAD\nendmodule" }) }));
    const r = await runCoverageStrengthening(baseArgs({ runCli, callLLM }));
    expect(r.strengthened).toBe(false);
    expect(r.code).toMatch(/ORIG/);
    expect(r.rounds).toBe(2);   // tried both rounds, never adopted
  });
});
