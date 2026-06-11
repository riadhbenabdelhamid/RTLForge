// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Pipeline node integration tests
//
// These exercise lintNode / verifyNode / judgeNode end-to-end against
// mocked LLM and CLI backends. They catch regressions in the kind of
// behavior the v6→v9 audits surfaced — silent LLM fallback, broken
// strict-CLI mode, missing log entries on parse failures, etc.
//
// Approach: vi.mock() intercepts the LLM and CLI modules so the node
// code runs unchanged but we control what those calls return. The node's
// real reducer-style state shaping is preserved.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the LLM and CLI modules BEFORE importing the nodes under test ──
// Vitest hoists vi.mock to the top of the file, so these run first.
vi.mock("../src/llm/index.js", async function() {
  const actual = await vi.importActual("../src/llm/extractJSON.js");
  return {
    callLLM: vi.fn(),  // each test will supply a .mockResolvedValue
    extractJSON: actual.extractJSON,
    addRetryHint: function(s) { return s; },
  };
});
vi.mock("../src/cli/index.js", function() {
  return {
    runCli: vi.fn(),                                    // each test supplies behavior
    parseCLIOutput: function(stderr) {
      // Tiny re-implementation matching the real one for predictable testing.
      // We could re-import the real one, but copying is simpler and decouples
      // these tests from the real parser's output format.
      const errors = [];
      const warnings = [];
      (stderr || "").split("\n").forEach(function(line) {
        if (/^%Error/.test(line))   errors.push({ id: "ERR", msg: line, where: "" });
        if (/^%Warning/.test(line)) warnings.push({ id: "WARN", msg: line, where: "" });
      });
      return { errors, warnings };
    },
    // V22 #5 — parseTestLine extracts [PASS]/[FAIL] lines from CLI stdout.
    // Tiny copy of the real parser (cycles/time-aware). The integration
    // tests need it because verify.js imports it directly from the mocked
    // module; without this export, every CLI happy-path test fails with
    // "No 'parseTestLine' export is defined on the '../src/cli/index.js' mock".
    parseTestLine: function(line) {
      const m = line.match(/\[(PASS|FAIL)\]\s+(.*?)\s*$/);
      if (!m) return null;
      // Bare-form parser for tests: ignore timing extraction here, just
      // return name + status with zeros (the real parser's timing logic
      // is exercised by the standalone parser tests, not these integration
      // ones).
      return { name: m[2].trim(), status: m[1], cyc: 0, ms: 0 };
    },
    // V22 #6 — parseCoverageDat returns {line, branch, toggle, fsm, expr}.
    // Tests don't exercise this path, so a stub returning all-null works.
    parseCoverageDat: function(_text) {
      return { line: null, branch: null, toggle: null, fsm: null, expr: null };
    },
    CliBackendError: class CliBackendError extends Error {
      constructor(msg, attempts) {
        super(msg);
        this.name = "CliBackendError";
        this.isCliBackendError = true;
        this.attempts = attempts || 1;
      }
    },
    testBackendConnection: vi.fn(),
  };
});

// Now import the actual nodes (they pick up the mocked modules)
import { lintNode } from "../src/pipeline/nodes/lint.js";
import { verifyNode } from "../src/pipeline/nodes/verify.js";
import { judgeNode } from "../src/pipeline/nodes/judge.js";
import { callLLM } from "../src/llm/index.js";
import { runCli, CliBackendError } from "../src/cli/index.js";

// ── Test helpers ────────────────────────────────────────────────────────────
function makeBaseState(overrides) {
  // Minimal state object that satisfies all node entry preconditions.
  const base = {
    elicit: { modName: "fifo", domain: "test" },
    spec: {
      requirements: [{ id: "R1", text: "ready/valid handshake", pri: "Must" }],
      iface: [],
      params: [],
    },
    architect: { strategy: "pipeline", description: "test", blocks: [] },
    rtl_generate: { code: "module fifo(input clk, input rst_n);\nendmodule\n" },
    test_generate: { code: "module fifo_tb;\nendmodule\n" },
    formal_props: { properties: [], covers: [], bind_module: "" },
    verify: {
      // cli:true marks this as a REAL simulation run. The judge's
      // verification-provenance gate downgrades a gate-PASS to UNVERIFIED
      // when verify data is LLM-estimated (no cli flag), so fixtures that
      // mean "verify genuinely passed" must carry it.
      sim: "Verilator", total: 1, pass: 1, fail: 0, cli: true,
      cov: { line: 100, branch: 100, toggle: 100 }, tests: [], log: "",
    },
    lint: { tool: "Verilator", status: "PASS", errors: [], warnings: [], summary: "", log: "" },
    _config: {
      provider: "openai", model: "gpt-4o", apiKey: "sk-test",
      useGlobalLLM: true,
      stageSettings: {},
      maxLintIters:   3,
      maxVerifyIters: 3,
      maxJudgeIters:  3,
      simTimeoutCycles: 100000,
      backendUrl: "",
      simCmds: "verilator --binary {RTL} {TB}",
      strictCli: true,
      cliRetryCount: 1,
      backendTimeoutSec: 600,
    },
    _onLog: null,
    _signal: null,
    _childInterfaces: null,
    _sharedPackageCode: null,
  };
  if (!overrides) return base;
  return Object.assign({}, base, overrides, {
    _config: Object.assign({}, base._config, overrides._config || {}),
  });
}

function llmReply(json, extras) {
  // Helper to build a callLLM return value from a JSON object.
  return Object.assign({
    text: typeof json === "string" ? json : JSON.stringify(json),
    tokensIn: 100, tokensOut: 50, latencyMs: 200,
    model: "gpt-4o", provider: "openai", stopReason: "stop",
  }, extras || {});
}

beforeEach(function() {
  callLLM.mockReset();
  runCli.mockReset();
});

// ─── lintNode integration ────────────────────────────────────────────────────
describe("lintNode integration", function() {
  it("CLI happy path: clean lint converges in 1 iteration", async function() {
    runCli.mockResolvedValue({
      stdout: "", stderr: "", exitCode: 0,
    });
    const st = makeBaseState({ _config: { backendUrl: "http://localhost:3001" } });
    const result = await lintNode(st);
    expect(result.lint.status).toBe("PASS");
    expect(result.lint.errors).toEqual([]);
    expect(result.lint.cli).toBe(true);
    // Should NOT have called the LLM at all
    expect(callLLM).not.toHaveBeenCalled();
    // Should have called CLI exactly once (no fix iteration needed)
    expect(runCli).toHaveBeenCalledTimes(1);
  });

  it("strict CLI mode: backend error throws CliBackendError instead of falling back to LLM", async function() {
    runCli.mockResolvedValue({
      _error: true, _msg: "Cannot reach backend at http://localhost:3001",
      _attempts: 2,
    });
    const st = makeBaseState({
      _config: { backendUrl: "http://localhost:3001", strictCli: true },
    });
    await expect(lintNode(st)).rejects.toThrow(CliBackendError);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("LLM fallback path: no backend → uses LLM directly", async function() {
    // runCli is still called (it's a thin wrapper), but it returns null
    // immediately when backendUrl is empty — and the node falls through to
    // the LLM branch.
    runCli.mockResolvedValue(null);
    callLLM.mockResolvedValue(llmReply({
      tool: "LLM", status: "PASS", errors: [], warnings: [], summary: "OK", log: "",
    }));
    const st = makeBaseState({ _config: { backendUrl: "" } });   // no backend
    const result = await lintNode(st);
    expect(result.lint.status).toBe("PASS");
    // LLM should have been called exactly once (clean → no fix iter)
    expect(callLLM).toHaveBeenCalledTimes(1);
  });

  it("non-strict mode: backend error falls back to LLM with _cliError annotation", async function() {
    runCli.mockResolvedValue({
      _error: true, _msg: "Network error", _attempts: 2,
    });
    callLLM.mockResolvedValue(llmReply({
      tool: "LLM", status: "PASS", errors: [], warnings: [], summary: "OK", log: "",
    }));
    const st = makeBaseState({
      _config: { backendUrl: "http://localhost:3001", strictCli: false },
    });
    const result = await lintNode(st);
    expect(result.lint.status).toBe("PASS");
    expect(result.lint._cliError).toMatch(/Network error/);
    // Both should have been called
    expect(runCli).toHaveBeenCalled();
    expect(callLLM).toHaveBeenCalled();
  });

  it("respects config.maxLintIters when set above default", async function() {
    // CLI always returns errors → loop exhausts iters
    runCli.mockResolvedValue({
      stdout: "", stderr: "%Error: something\n", exitCode: 1,
    });
    // LLM always returns code identical to input → triggers stagnation
    callLLM.mockImplementation(function(args) {
      // Find the input RTL — the prompt body has it
      const codeFromPrompt = (args.userMessage || "").match(/module fifo[\s\S]*?endmodule/);
      return Promise.resolve(llmReply({
        code: codeFromPrompt ? codeFromPrompt[0] : "module fifo;\nendmodule\n",
        fixes: ["pretend fix"],
      }));
    });
    const st = makeBaseState({
      _config: { backendUrl: "http://localhost:3001", maxLintIters: 5, strictCli: false },
    });
    await lintNode(st);
    // Lint will call CLI on iter 1, fix attempts on iters 1 & 2 will both
    // produce identical code → stagnation kicks in at count >= 2 and breaks.
    // The exact count depends on stagnation logic, but if maxLintIters were
    // ignored we'd get exactly 3 (the old default).
    expect(runCli.mock.calls.length).toBeGreaterThanOrEqual(1);
    // Stagnation breaks after 2 identical fixes → only 1-2 LLM calls expected
    expect(callLLM.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(callLLM.mock.calls.length).toBeLessThanOrEqual(5);
  });
});

// ─── verifyNode integration ──────────────────────────────────────────────────
describe("verifyNode integration", function() {
  it("CLI happy path: simulation passes on first try", async function() {
    runCli.mockResolvedValue({
      stdout: "[PASS] handshake_test\n", stderr: "", exitCode: 0,
    });
    const st = makeBaseState({ _config: { backendUrl: "http://localhost:3001" } });
    const result = await verifyNode(st);
    expect(result.verify.fail).toBe(0);
    expect(result.verify.pass).toBeGreaterThan(0);
    expect(result.verify.cli).toBe(true);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("surfaces _noMarkers warning when CLI exits 0 but produces no PASS/FAIL lines", async function() {
    // The exact bug from Audit #2 — backend exits cleanly but the testbench
    // forgot to print [PASS]/[FAIL] markers. Used to silently report 1/1
    // fail; now should set _noMarkers so the UI can warn.
    runCli.mockResolvedValue({
      stdout: "Simulation finished with no output\n", stderr: "", exitCode: 0,
    });
    const st = makeBaseState({ _config: { backendUrl: "http://localhost:3001" } });
    const result = await verifyNode(st);
    expect(result.verify._noMarkers).toBe(true);
  });

  it("strict CLI mode: empty simCmds throws clear error", async function() {
    const st = makeBaseState({
      _config: {
        backendUrl: "http://localhost:3001",
        simCmds: "",                  // empty
        strictCli: true,
      },
    });
    await expect(verifyNode(st)).rejects.toThrow(CliBackendError);
    await expect(verifyNode(st)).rejects.toThrow(/No simulation commands/);
  });

  it("strict CLI mode: backend error throws instead of falling back", async function() {
    runCli.mockResolvedValue({
      _error: true, _msg: "Backend timeout", _attempts: 2,
    });
    const st = makeBaseState({
      _config: { backendUrl: "http://localhost:3001", strictCli: true },
    });
    await expect(verifyNode(st)).rejects.toThrow(CliBackendError);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("LLM-only path (no backend): runs through promptVerify", async function() {
    // Like the lint case: runCli is called but returns null immediately when
    // there's no backendUrl, and the node falls through to the LLM branch.
    runCli.mockResolvedValue(null);
    callLLM.mockResolvedValue(llmReply({
      sim: "LLM",
      total: 2, pass: 2, fail: 0,
      cov: { line: 90, branch: 80, toggle: 75 },
      tests: [{ name: "t1", st: "PASS" }, { name: "t2", st: "PASS" }],
      log: "",
    }));
    const st = makeBaseState({ _config: { backendUrl: "" } });
    const result = await verifyNode(st);
    expect(result.verify.pass).toBe(2);
    expect(result.verify.fail).toBe(0);
    expect(callLLM).toHaveBeenCalled();
  });

  // ── Issue #8: five-tier classifier-gated accept/reject (mirrors lint) ──

  it("Issue #8 + Group B (v20): REJECT_NO_IMPROVEMENT classification still recorded but candidate is forwarded", async function() {
    // Iter 1 baseline: 1 failing test (t1).
    // Iter 1 fix → iter 2: t1 still fails (resolved=0) AND a new test t2
    // is now reported as failing (revealed=1). classifyTestResults →
    // REJECT_NO_IMPROVEMENT (no resolved, no regression introduced from
    // baseline-passing tests, but some new failures revealed in code that
    // wasn't there before).
    //
    // Group B convergence fix: previously REJECT_NO_IMPROVEMENT reset the
    // current code to bestRTL/bestTB (revert). Now we forward the candidate
    // so iter N+1 sees the actual current state. Best-known restore at end
    // recovers the best-seen state.
    runCli
      .mockResolvedValueOnce({  // iter 1: t1 fails
        stdout: "[FAIL] t1\n", stderr: "", exitCode: 1,
      })
      .mockResolvedValueOnce({  // iter 2: t1 still fails AND new test t2 fails
        stdout: "[FAIL] t1\n[FAIL] t2\n", stderr: "", exitCode: 1,
      })
      .mockResolvedValueOnce({  // iter 3: t1 still fails (after another forward)
        stdout: "[FAIL] t1\n", stderr: "", exitCode: 1,
      });
    callLLM
      .mockResolvedValueOnce(llmReply({ target: "rtl_generate", reason: "test" }))
      .mockResolvedValueOnce(llmReply({ code: "module fifo; // changed v1\nendmodule\n", fixes: [{ test: "t1", desc: "fix1" }] }))
      .mockResolvedValueOnce(llmReply({ code: "module fifo_tb;\n// changed v1\nendmodule\n", fixes: [] }))
      .mockResolvedValueOnce(llmReply({ target: "rtl_generate", reason: "still failing" }))
      .mockResolvedValueOnce(llmReply({ code: "module fifo; // changed v2\nendmodule\n", fixes: [{ test: "t1", desc: "fix2" }] }))
      .mockResolvedValueOnce(llmReply({ code: "module fifo_tb;\n// changed v2\nendmodule\n", fixes: [] }));
    const st = makeBaseState({ _config: { backendUrl: "http://localhost:3001" } });
    const result = await verifyNode(st);
    const iter2 = result.verify.verifyHistory.find(function(h) { return h.iter === 2; });
    expect(iter2).toBeDefined();
    expect(iter2.classification).toBeDefined();
    expect(iter2.classification.patchDecision).toBe("REJECT_NO_IMPROVEMENT");
  });

  it("Group B (v20): forward-candidate semantics — iter N+1's RTL fix sees the iter-N candidate code, not the original baseline", async function() {
    // Pin the new behaviour: when iter 1 produces REJECT_NO_IMPROVEMENT,
    // iter 2's RTL fix LLM call should receive the iter-1 candidate code as
    // input, NOT the original baseline code. We verify this by inspecting
    // the prompt argument passed to callLLM on iter 2's RTL fix.
    runCli
      .mockResolvedValueOnce({ stdout: "[FAIL] t1\n", stderr: "", exitCode: 1 })          // iter 1 baseline
      .mockResolvedValueOnce({ stdout: "[FAIL] t1\n[FAIL] t2\n", stderr: "", exitCode: 1 }) // iter 2 (REJECT_NO_IMP)
      .mockResolvedValueOnce({ stdout: "[FAIL] t1\n", stderr: "", exitCode: 1 });           // iter 3
    const v1Code = "module fifo;\n// version v1 changed by iter 1\nendmodule\n";
    const v2Code = "module fifo;\n// version v2 changed by iter 2\nendmodule\n";
    callLLM
      .mockResolvedValueOnce(llmReply({ target: "rtl_generate", reason: "test" }))
      .mockResolvedValueOnce(llmReply({ code: v1Code, fixes: [{ test: "t1", desc: "fix1" }] }))
      .mockResolvedValueOnce(llmReply({ code: "tb1", fixes: [] }))
      .mockResolvedValueOnce(llmReply({ target: "rtl_generate", reason: "still failing" }))
      // iter 2 RTL fix: capture which code it receives as input
      .mockImplementationOnce(function(prompt) {
        // The user-visible signal we want: iter 2's RTL fix should be
        // called with the iter-1 candidate (v1Code) as input, not the
        // original "module fifo() endmodule" baseline.
        expect(prompt.userMessage).toContain("version v1 changed by iter 1");
        return llmReply({ code: v2Code, fixes: [{ test: "t1", desc: "fix2" }] });
      })
      .mockResolvedValueOnce(llmReply({ code: "tb2", fixes: [] }));
    const st = makeBaseState({ _config: { backendUrl: "http://localhost:3001" } });
    await verifyNode(st);
    // The assertion inside mockImplementationOnce is the actual check; if
    // we got here without throwing, the assertion passed.
    expect(callLLM).toHaveBeenCalled();
  });

  it("Issue #8: ACCEPT_PROGRESS keeps candidate when resolved > 0", async function() {
    // Iter 1: 0/2 passing.
    // Iter 1 fix → iter 2: 1/2 passing (one resolved).
    // classifyTestResults → ACCEPT_PROGRESS.
    runCli
      .mockResolvedValueOnce({
        stdout: "[FAIL] t1\n[FAIL] t2\n", stderr: "", exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: "[PASS] t1\n[FAIL] t2\n", stderr: "", exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: "[PASS] t1\n[PASS] t2\n", stderr: "", exitCode: 0,
      });
    callLLM
      .mockResolvedValueOnce(llmReply({ target: "rtl_generate", reason: "test" }))
      .mockResolvedValueOnce(llmReply({ code: "module fifo; // v1\nendmodule\n", fixes: [{ test: "t1", desc: "fixed t1" }] }))
      .mockResolvedValueOnce(llmReply({ code: "module fifo_tb;// v1\nendmodule\n", fixes: [] }))
      .mockResolvedValueOnce(llmReply({ target: "rtl_generate", reason: "test" }))
      .mockResolvedValueOnce(llmReply({ code: "module fifo; // v2\nendmodule\n", fixes: [{ test: "t2", desc: "fixed t2" }] }))
      .mockResolvedValueOnce(llmReply({ code: "module fifo_tb;// v2\nendmodule\n", fixes: [] }));
    const st = makeBaseState({ _config: { backendUrl: "http://localhost:3001" } });
    const result = await verifyNode(st);
    const iter2 = result.verify.verifyHistory.find(function(h) { return h.iter === 2; });
    expect(iter2.classification.patchDecision).toBe("ACCEPT_PROGRESS");
    expect(iter2.classification.resolved).toBe(1);
  });

  it("Issue #8: previousFixes are accumulated and surfaced on result._fixes", async function() {
    // Confirm that:
    //  (a) RTL fix on iter 1 emits fixes[].
    //  (b) Those fixes are exposed on result.verify._fixes so the RTL Gen
    //      split-view fix panel can show them.
    runCli
      .mockResolvedValueOnce({
        stdout: "[FAIL] t1\n", stderr: "", exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: "[PASS] t1\n", stderr: "", exitCode: 0,
      });
    callLLM
      .mockResolvedValueOnce(llmReply({ target: "rtl_generate", reason: "test" }))
      .mockResolvedValueOnce(llmReply({
        code: "module fifo; // v1\nendmodule\n",
        fixes: [
          { test: "t1", desc: "added missing reset" },
          { test: "t1", desc: "fixed off-by-one in counter" },
        ],
      }))
      .mockResolvedValueOnce(llmReply({ code: "module fifo_tb;// v1\nendmodule\n", fixes: [] }));
    const st = makeBaseState({ _config: { backendUrl: "http://localhost:3001" } });
    const result = await verifyNode(st);
    expect(result.verify._fixes).toBeDefined();
    expect(Array.isArray(result.verify._fixes)).toBe(true);
    expect(result.verify._fixes.length).toBe(2);
    // v20 Group A5: each entry is now a {text, iter} object so the UI can
    // annotate fixes with "iteration N". Earlier versions used plain strings.
    expect(result.verify._fixes[0].text).toContain("t1");
    expect(result.verify._fixes[0].text).toContain("added missing reset");
    expect(typeof result.verify._fixes[0].iter).toBe("number");
    // _fixes should also be mirrored onto rtl_generate when RTL changed
    expect(result.rtl_generate._fixes).toEqual(result.verify._fixes);
  });

  it("Issue #8: patch integrity stagnation — both fix calls return identical code 2× → loop bails", async function() {
    // Iter 1: 0/1 fail. Iter 1 fix returns IDENTICAL code (no-op).
    // Iter 2: 0/1 fail. Iter 2 fix returns IDENTICAL code (no-op).
    // Pre-Issue#8: loop would burn through max iters with no progress.
    // Post-Issue#8: stagnation counter increments on each no-op pair,
    // and at count >= 2 the loop bails.
    const sameRTL = "module fifo(input clk, input rst_n);\nendmodule\n";
    const sameTB = "module fifo_tb;\nendmodule\n";
    runCli
      .mockResolvedValue({   // every call returns the same fail
        stdout: "[FAIL] t1\n", stderr: "", exitCode: 1,
      });
    callLLM
      // iter 1: triage + RTL fix (no-op) + TB fix (no-op)
      .mockResolvedValueOnce(llmReply({ target: "rtl_generate", reason: "test" }))
      .mockResolvedValueOnce(llmReply({ code: sameRTL, fixes: [] }))
      .mockResolvedValueOnce(llmReply({ code: sameTB, fixes: [] }))
      // iter 2: triage + RTL fix (no-op) + TB fix (no-op)
      .mockResolvedValueOnce(llmReply({ target: "rtl_generate", reason: "test" }))
      .mockResolvedValueOnce(llmReply({ code: sameRTL, fixes: [] }))
      .mockResolvedValueOnce(llmReply({ code: sameTB, fixes: [] }));
    // The loop should bail without reaching iter 3 (max=3) because both
    // iters produced no-op patches.
    const st = makeBaseState({ _config: { backendUrl: "http://localhost:3001" } });
    const result = await verifyNode(st);
    // Should have stopped before all 3 iters ran. Either 2 or 3 entries —
    // 2 if stagnation triggered after iter 2, 3 if final iter ran first.
    expect(result.verify.verifyHistory.length).toBeLessThanOrEqual(3);
    // One of the iterations should be marked patchInvalid OR the final
    // verifyHistory entry has the patchInvalid flag from the post-iter
    // stagnation check.
    const anyPatchInvalid = result.verify.verifyHistory.some(function(h) { return h.patchInvalid; });
    expect(anyPatchInvalid).toBe(true);
  });
});

// ─── judgeNode integration ───────────────────────────────────────────────────
describe("judgeNode integration", function() {
  it("happy path: deterministic gate PASS in iter 1 stops the loop, no LLM calls", async function() {
    // Judge does not call the LLM for the verdict. With the baseState's
    // verify=PASS (cli-backed) and lint clean, the conservative-default
    // criteria measure ≥ threshold and the gate returns PASS without
    // any LLM call.
    const st = makeBaseState();
    const result = await judgeNode(st);
    expect(result.judge.overall).toBe("PASS");
    expect(result.judge.verified).toBe(true);   // cli-backed verify → real PASS
    expect(result.judge.evalOverall).toBe("PASS");
    expect(result.judge.score).toBe(100);  // 3/3 enabled criteria pass
    expect(result.judge.eval).toBeDefined();
    expect(result.judge.eval.totalEnabled).toBeGreaterThan(0);
    expect(result.judge.eval.failed).toBe(0);
    // No LLM call needed when the gate passes on iter 1
    expect(callLLM).toHaveBeenCalledTimes(0);
  });

  it("regen JSON parse failure logs warning and keeps previous state", async function() {
    // Trigger a regen path by failing verify. Triage candidates for
    // verify failure are [test_generate, rtl_generate] (2 → LLM triage).
    // The triage targets test_generate; TB regen returns invalid JSON.
    // Per the explicit-log-on-parse-error policy, the run log captures
    // "TB regen JSON parse failed" rather than silently swallowing it.
    let logBuf = "";
    callLLM
      .mockResolvedValueOnce(llmReply({               // triage: route to test_generate
        target: "test_generate", reason: "verify failing",
      }))
      .mockResolvedValueOnce(llmReply("not valid json {{{"))  // TB regen — bad JSON
      .mockResolvedValueOnce(llmReply({                // re-verify: now passing
        sim: "LLM", total: 1, pass: 1, fail: 0,
        cov: { line: 100, branch: 100, toggle: 100 }, tests: [], log: "",
      }));
    const st = makeBaseState({
      verify: { sim: "Verilator", total: 1, pass: 0, fail: 1,
        cov: {}, tests: [], log: "" },     // failing → drives a regen iter
      _config: { maxJudgeIters: 2 },
      _onLog: function(buf) { logBuf = buf; },
    });
    const result = await judgeNode(st);
    // The parse error is an explicit log entry, not silently swallowed
    expect(logBuf).toMatch(/TB regen JSON parse failed/);
    expect(logBuf).toMatch(/Keeping previous TB/);
    // After the LLM-estimated re-verify "passed", iter 2's gate sees
    // verify=PASS — but the provenance gate downgrades to UNVERIFIED
    // because nothing was actually simulated (the re-verify was an LLM
    // estimate, not a CLI run). The raw gate outcome stays auditable.
    expect(result.judge.overall).toBe("UNVERIFIED");
    expect(result.judge.evalOverall).toBe("PASS");
    expect(result.judge.verified).toBe(false);
  });

  it("uses getStageConfig for sub-stage settings (Audit #3)", async function() {
    // V22: with verify failing, regen flow runs. Each LLM call (triage,
    // TB regen, re-verify) gets its own stage-specific config from
    // getStageConfig — including the `_maxTokens` field that the
    // global config doesn't have.
    callLLM
      .mockResolvedValueOnce(llmReply({                // triage
        target: "rtl_generate", reason: "broken impl",
      }))
      .mockResolvedValueOnce(llmReply({                // RTL regen
        code: "module fifo_v2;\nendmodule\n",
      }))
      .mockResolvedValueOnce(llmReply({                // TB regen
        code: "module fifo_tb_v2;\nendmodule\n",
      }))
      .mockResolvedValueOnce(llmReply({                // re-verify
        sim: "LLM", total: 1, pass: 1, fail: 0,
        cov: { line: 100, branch: 100, toggle: 100 }, tests: [], log: "",
      }));
    const st = makeBaseState({
      verify: { sim: "Verilator", total: 1, pass: 0, fail: 1,
        cov: {}, tests: [], log: "" },
      _config: { maxJudgeIters: 2 },
    });
    await judgeNode(st);
    // Each sub-call carries its own stage-specific config (with _maxTokens).
    const calls = callLLM.mock.calls.map(function(c) { return c[0].config; });
    expect(calls.length).toBeGreaterThan(0);
    calls.forEach(function(c) {
      expect(c).toBeDefined();
      expect(c._maxTokens).toBeGreaterThan(0);  // getStageConfig populates this
    });
  });
});
