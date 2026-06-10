// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Lint Test (TB lint) node integration tests
//
// Mirrors the pipelineNodes.integration.test.js pattern: vi.mock() the LLM
// and CLI modules so the node code runs unchanged but the calls return
// controlled values. Tests pin:
//   - happy path (CLI clean, no fix iter)
//   - strict-CLI mode propagates backend failures
//   - LLM-only fallback when no backend
//   - non-strict mode falls back to LLM with _cliError annotation
//   - the result delta correctly updates `lint_test` AND `test_generate`,
//     never `lint` or `rtl_generate`
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/llm/index.js", async function() {
  const actual = await vi.importActual("../src/llm/extractJSON.js");
  return {
    callLLM: vi.fn(),
    extractJSON: actual.extractJSON,
    addRetryHint: function(s) { return s; },
  };
});
vi.mock("../src/cli/index.js", function() {
  return {
    runCli: vi.fn(),
    parseCLIOutput: function(stderr) {
      const errors = [];
      const warnings = [];
      (stderr || "").split("\n").forEach(function(line) {
        if (/^%Error/.test(line))   errors.push({ id: "ERR", msg: line, where: "" });
        if (/^%Warning/.test(line)) warnings.push({ id: "WARN", msg: line, where: "" });
      });
      return { errors, warnings };
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

import { lintTestNode } from "../src/pipeline/nodes/lint_test.js";
import { callLLM } from "../src/llm/index.js";
import { runCli, CliBackendError } from "../src/cli/index.js";

function makeBaseState(overrides) {
  const base = {
    elicit: { modName: "fifo", domain: "test" },
    spec: {
      requirements: [{ id: "R1", text: "ready/valid handshake", pri: "Must" }],
      iface: [],
      params: [],
    },
    rtl_generate:  { code: "module fifo(input clk, input rst_n);\nendmodule\n" },
    test_generate: { code: "module fifo_tb;\ninitial $finish;\nendmodule\n" },
    _config: {
      provider: "openai", model: "gpt-4o", apiKey: "sk-test",
      useGlobalLLM: true, stageSettings: {},
      maxLintIters: 3,
      backendUrl: "",
      strictCli: true,
      cliRetryCount: 0,
      backendTimeoutSec: 10,
    },
    _onLog: null,
    _signal: null,
  };
  if (!overrides) return base;
  return Object.assign({}, base, overrides, {
    _config: Object.assign({}, base._config, overrides._config || {}),
  });
}

function llmReply(json) {
  return {
    text: typeof json === "string" ? json : JSON.stringify(json),
    tokensIn: 50, tokensOut: 30, latencyMs: 100,
    model: "gpt-4o", provider: "openai", stopReason: "stop",
  };
}

beforeEach(function() {
  callLLM.mockReset();
  runCli.mockReset();
});

describe("lintTestNode integration", function() {
  it("CLI happy path: clean TB lint, no fix iter, result on lint_test+test_generate", async function() {
    runCli.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const st = makeBaseState({ _config: { backendUrl: "http://localhost:3001" } });
    const result = await lintTestNode(st);
    // Result delta MUST be on lint_test (NOT lint), and test_generate (NOT rtl_generate)
    expect(result.lint_test).toBeTruthy();
    expect(result.lint_test.status).toBe("PASS");
    expect(result.lint_test.cli).toBe(true);
    expect(result.test_generate).toBeTruthy();
    expect(result.lint).toBeUndefined();         // critical: not the RTL lint stage
    expect(result.rtl_generate).toBeUndefined(); // critical: TB stage doesn't touch RTL
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("strict CLI mode: backend error throws CliBackendError instead of LLM fallback", async function() {
    runCli.mockResolvedValue({
      _error: true, _msg: "Cannot reach backend at http://localhost:3001",
      _attempts: 1,
    });
    const st = makeBaseState({
      _config: { backendUrl: "http://localhost:3001", strictCli: true },
    });
    await expect(lintTestNode(st)).rejects.toThrow(CliBackendError);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("LLM fallback path: no backend → uses promptTBLint", async function() {
    runCli.mockResolvedValue(null);
    callLLM.mockResolvedValue(llmReply({
      tool: "Verilator-TB (AI analysis)",
      status: "PASS", errors: [], warnings: [], summary: "0 errors", log: "",
    }));
    const st = makeBaseState({ _config: { backendUrl: "" } });
    const result = await lintTestNode(st);
    expect(result.lint_test.status).toBe("PASS");
    expect(callLLM).toHaveBeenCalledTimes(1);
    // Confirm the LLM was called with TB lint prompt — not RTL lint prompt.
    // Look for testbench-specific vocabulary in the user message.
    const firstCall = callLLM.mock.calls[0][0];
    expect(firstCall.userMessage).toMatch(/testbench/);
    expect(firstCall.userMessage).toMatch(/USES_DOLLAR_ERROR/);  // TB lint vocabulary
  });

  it("non-strict mode: backend error falls back to LLM with _cliError annotation", async function() {
    runCli.mockResolvedValue({ _error: true, _msg: "timeout", _attempts: 1 });
    callLLM.mockResolvedValue(llmReply({
      tool: "Verilator-TB (AI analysis)",
      status: "PASS", errors: [], warnings: [], summary: "ok", log: "",
    }));
    const st = makeBaseState({
      _config: { backendUrl: "http://localhost:3001", strictCli: false },
    });
    const result = await lintTestNode(st);
    expect(result.lint_test.status).toBe("PASS");
    expect(result.lint_test._cliError).toMatch(/timeout/);
    expect(callLLM).toHaveBeenCalled();
  });

  it("preserves original TB when CLI returns clean (no fixes applied)", async function() {
    runCli.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const originalTB = "module fifo_tb;\ninitial $finish;\nendmodule\n";
    const st = makeBaseState({
      _config: { backendUrl: "http://localhost:3001" },
      test_generate: { code: originalTB },
    });
    const result = await lintTestNode(st);
    expect(result.test_generate.code).toBe(originalTB);
    // No _fixSource annotation when nothing was changed
    expect(result.test_generate._fixSource).toBeUndefined();
  });

  // ─── V20 audit fixes — fix loop, stagnation, A5 iter tagging ───────────

  it("fix loop: TB lint FAIL → fix → PASS converges in 2 iters", async function() {
    // Iter 1 CLI: errors. LLM TB fix: candidate. Iter 2 CLI re-lint: clean.
    runCli
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error: undeclared signal\n", exitCode: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })   // recheck after fix
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // iter 2 baseline (no errors)
    callLLM.mockResolvedValueOnce(llmReply({
      code: "module fifo_tb;\nlogic clk;\ninitial $finish;\nendmodule\n",
      fixes: ["Declared missing clk signal"],
    }));
    const st = makeBaseState({ _config: { backendUrl: "http://localhost:3001" } });
    const result = await lintTestNode(st);
    expect(result.lint_test.status).toBe("PASS");
    // TB code was modified by the fix
    expect(result.test_generate._fixSource).toMatch(/lint_test/);
    expect(result.test_generate._originalCode).toMatch(/module fifo_tb/);
    // V20 Group A5: _fixes carry iter info
    expect(Array.isArray(result.lint_test._fixes)).toBe(true);
    expect(result.lint_test._fixes.length).toBeGreaterThan(0);
    expect(result.lint_test._fixes[0].iter).toBe(1);
    expect(result.lint_test._fixes[0].text).toMatch(/clk/);
    // Mirrored onto test_generate._fixes
    expect(result.test_generate._fixes).toEqual(result.lint_test._fixes);
  });

  it("invalid-patch stagnation: identical TB returned 2× → break, code unchanged", async function() {
    const originalTB = "module fifo_tb;\ninitial $finish;\nendmodule\n";
    // CLI keeps returning the same error.
    runCli.mockResolvedValue({ stdout: "", stderr: "%Error: something\n", exitCode: 1 });
    // LLM returns identical TB every time → patch integrity fails repeatedly.
    callLLM.mockImplementation(function() {
      return Promise.resolve(llmReply({ code: originalTB, fixes: ["pretend fix"] }));
    });
    const st = makeBaseState({
      _config: { backendUrl: "http://localhost:3001", maxLintIters: 5, strictCli: false },
      test_generate: { code: originalTB },
    });
    const result = await lintTestNode(st);
    // Stagnation should break the loop before exhausting maxLintIters
    expect(callLLM.mock.calls.length).toBeLessThanOrEqual(3);
    // TB unchanged because the candidate was identical to the original each time
    expect(result.test_generate.code).toBe(originalTB);
    // Check the iteration entries flagged patchInvalid
    expect(Array.isArray(result.lint_test.iterations)).toBe(true);
    expect(result.lint_test.iterations.some(function(i) { return i.patchInvalid; })).toBe(true);
  });

  it("best-known restore: regression detected → final TB reverts to best-known", async function() {
    const originalTB = "module fifo_tb;\ninitial $finish;\nendmodule\n";
    const badTB      = "module fifo_tb;\nbroken syntax garbage;\nendmodule\n";
    // Sequence (maxLintIters=2):
    //   Iter 1 baseline: 2 errors → bestIssueCount=2, bestTB=originalTB.
    //   Iter 1 fix → badTB.
    //   Iter 1 recheck: 4 errors (regression). Group B forwards finalTB=badTB.
    //   Iter 2 baseline (lints badTB): 5 errors. iter==maxLintIters → break.
    //     finalLint = iter 2 baseline (5 errors).
    //   After loop: bestIssueCount(2) < finalIssueCount(5) → restore bestTB.
    runCli
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error: e1\n%Error: e2\n", exitCode: 1 })                                // iter 1 baseline
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error: e1\n%Error: e2\n%Error: e3\n%Error: e4\n", exitCode: 1 })          // iter 1 recheck (worse)
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error: e1\n%Error: e2\n%Error: e3\n%Error: e4\n%Error: e5\n", exitCode: 1 }); // iter 2 baseline
    callLLM.mockResolvedValueOnce(llmReply({ code: badTB, fixes: ["regressive fix"] }));
    const st = makeBaseState({
      _config: { backendUrl: "http://localhost:3001", maxLintIters: 2, strictCli: false },
      test_generate: { code: originalTB },
    });
    const result = await lintTestNode(st);
    // Best-known restore brings finalTB back to originalTB.
    expect(result.test_generate.code).toBe(originalTB);
    // No _fixSource annotation because finalTB === originalTB after restore.
    expect(result.test_generate._fixSource).toBeUndefined();
  });

  it("Group A5: _fixes accumulate iter tags across multiple fix iterations", async function() {
    const originalTB = "module fifo_tb;\ninitial $finish;\nendmodule\n";
    // maxLintIters defaults to 3. Plan:
    //   Iter 1: baseline [e1,e2] → fix1 → recheck [e1] (1 resolved) → ACCEPT_PROGRESS.
    //   Iter 2: baseline [e1] → fix2 → recheck [] (clean) → ACCEPT_PROGRESS.
    //   Iter 3: baseline [] (clean) → !hasErrors → break.
    runCli
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error: e1\n%Error: e2\n", exitCode: 1 }) // iter 1 baseline
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error: e1\n",             exitCode: 1 }) // iter 1 recheck (e2 resolved)
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error: e1\n",             exitCode: 1 }) // iter 2 baseline
      .mockResolvedValueOnce({ stdout: "", stderr: "",                          exitCode: 0 }) // iter 2 recheck (clean)
      .mockResolvedValueOnce({ stdout: "", stderr: "",                          exitCode: 0 }); // iter 3 baseline (clean → break)
    callLLM
      .mockResolvedValueOnce(llmReply({
        code: originalTB.replace("$finish", "$display(\"x\"); $finish"),
        fixes: ["Added display before finish"],
      }))
      .mockResolvedValueOnce(llmReply({
        code: originalTB.replace("$finish", "$display(\"x\"); $display(\"y\"); $finish"),
        fixes: ["Added second display"],
      }));
    const st = makeBaseState({ _config: { backendUrl: "http://localhost:3001", strictCli: false } });
    const result = await lintTestNode(st);
    // Both fixes should be present, each tagged with the iter that produced it.
    expect(result.lint_test._fixes.length).toBe(2);
    const iters = result.lint_test._fixes.map(function(f) { return f.iter; });
    expect(iters).toEqual([1, 2]);
    // Sanity: text content is human-readable, not stringified JSON
    expect(result.lint_test._fixes[0].text).toMatch(/[A-Za-z]/);
    expect(result.lint_test._fixes[0].text).not.toMatch(/^\{/);
  });

  it("hardening: non-array fixes from the LLM does not crash the node", async function() {
    // The LLM occasionally returns `fixes` as a string instead of an array.
    // Pre-V20 the bare `.map()` would throw TypeError; V20 guards with
    // Array.isArray and silently ignores non-array shapes.
    // Iter 1 baseline: errors. Fix returns valid code but malformed `fixes`.
    // Iter 1 recheck: clean. ACCEPT.
    // Iter 2 baseline: clean → break.
    runCli
      .mockResolvedValueOnce({ stdout: "", stderr: "%Error: e1\n", exitCode: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "",             exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "",             exitCode: 0 });
    callLLM.mockResolvedValueOnce(llmReply({
      code: "module fifo_tb;\nlogic clk;\ninitial $finish;\nendmodule\n",
      fixes: "I fixed everything, trust me",   // wrong shape — string
    }));
    const st = makeBaseState({ _config: { backendUrl: "http://localhost:3001" } });
    // Should NOT throw despite the malformed `fixes` field.
    const result = await lintTestNode(st);
    expect(result.lint_test.status).toBe("PASS");
    // Non-array fixes were silently dropped; _fixes ends up empty.
    expect(result.lint_test._fixes).toEqual([]);
  });
});
