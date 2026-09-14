// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { describe, expect, it } from "vitest";
import { classifySimulationOutcome } from "../src/pipeline/classifiers.js";
import {
  checkerQualification, selectCommonCheckerCandidate,
} from "../src/pipeline/candidateGuard.js";
import { promptStandaloneTBReview } from "../src/prompts/standaloneTest.js";
import { parseCLIOutput } from "../src/cli/runCli.js";
import { djb2 } from "../src/utils/hash.js";
import { judgeNode, checkerEvidenceInvalidOf, championRestoreOf } from "../src/pipeline/nodes/judge.js";

describe("checker evidence reliability", function() {
  it("keeps semantic review input independent of RTL and pipeline findings", function() {
    const p = promptStandaloneTBReview("copies d to q", "module m(input d, output q);", "module m_tb; endmodule", "m");
    expect(p.userMessage).toContain("ORIGINAL USER DESCRIPTION");
    expect(p.userMessage).toContain("DUT MODULE HEADER");
    expect(p.userMessage).toContain("INDEPENDENT CHECKER SOURCE");
    expect(p.userMessage).toContain("Do not assume anything about hidden RTL implementation details");
    expect(p.userMessage).not.toContain("pipeline findings");
  });
  it("separates compiler diagnostics from runtime assertion exits", function() {
    expect(classifySimulationOutcome({
      exitCode: 1, stdout: "", stderr: "%Error: m_tb.sv:4: syntax error\n",
      diagnostics: { errors: [{ code: "SYNTAX", msg: "syntax error" }] }, tests: [],
    })).toBe("COMPILE_FAILURE");
    expect(classifySimulationOutcome({
      exitCode: 1, stdout: "[PASS] a\n", stderr: "%Error: m_tb.sv:4: Verilog $stop\n",
      diagnostics: parseCLIOutput("%Error: m_tb.sv:4: Verilog $stop\n"), tests: [{ name: "a", st: "PASS" }],
    })).toBe("RUNTIME_EXIT");
    expect(classifySimulationOutcome({
      exitCode: 0, stdout: "", stderr: "", diagnostics: { errors: [] }, tests: [],
    })).toBe("MISSING_MARKERS");
    expect(classifySimulationOutcome({
      stdout: "", stderr: "", diagnostics: { errors: [] }, tests: [],
    })).toBe("UNKNOWN_EXIT");
  });

  it("does not treat an unreviewed checker as trustworthy evidence", function() {
    const checker = { status: "READY", code: "module m_tb; endmodule", qualification: { status: "UNREVIEWED" } };
    expect(checkerQualification({ checkerCandidate: checker }).trustworthy).toBe(false);
    const measurement = { cli: true, tests: [{ name: "a", st: "PASS" }], total: 1, pass: 1, fail: 0 };
    const result = selectCommonCheckerCandidate(
      { checkerCandidate: checker, verify: measurement },
      { checkerCandidate: checker, verify: measurement },
    );
    expect(result.decision).toBe("FALLBACK");
    expect(result.reason).toBe("CHECKER_UNREVIEWED");
  });

  it("accepts a reviewed checker only for a strict retained-pass improvement", function() {
    const checkerCode = "module m_tb; endmodule";
    const checker = {
      status: "READY", code: checkerCode,
      qualification: { status: "PASS", method: "bounded-independent-review",
        sourceHash: djb2(checkerCode), inputHash: "input" },
    };
    const c = { version: "v1", seed: "deterministic", hash: "h" };
    const base = { checkerCandidate: checker, checker: c,
      verify: { cli: true, checker: c, tests: [{ name: "a", st: "PASS" }, { name: "b", st: "FAIL" }], total: 2, pass: 1, fail: 1 } };
    const better = { checkerCandidate: checker, checker: c,
      verify: { cli: true, checker: c, tests: [{ name: "a", st: "PASS" }, { name: "b", st: "PASS" }], total: 2, pass: 2, fail: 0 } };
    expect(selectCommonCheckerCandidate(better, base).decision).toBe("ACCEPT_IMPROVEMENT");
    expect(checkerQualification({ checkerCandidate: {
      status: "READY", code: checkerCode + " ", qualification: checker.qualification,
    } }).trustworthy).toBe(false);
  });

  it("judge stops before repair when checker evidence is invalid", async function() {
    const invoked = [];
    const result = await judgeNode({
      _config: { maxJudgeIters: 3, standaloneFallback: false },
      _userDesc: "counter",
      spec: { requirements: [] }, elicit: {},
      rtl_generate: { code: "module m; endmodule" },
      test_generate: { code: "module tb; endmodule" },
      lint: { status: "PASS", errors: [], warnings: [] },
      verify: {
        cli: true, total: 1, pass: 0, fail: 1,
        tests: [{ name: "check", st: "FAIL" }],
        _checkerEvidenceInvalid: true,
        champion: { rtl: "module prior; endmodule", tb: "module prior_tb; endmodule",
          pass: 4, total: 4, fail: 0 },
      },
      _services: { invokeNode: async function(key) { invoked.push(key); return {}; } },
      _onLog: function() {},
    });
    expect(checkerEvidenceInvalidOf({ verify: { _checkerEvidenceInvalid: true } })).toBe(true);
    expect(invoked).toEqual([]);
    expect(result.judge.overall).toBe("UNVERIFIED");
    expect(result.judge.stopReason).toBe("checker-evidence-invalid");
    expect(result.judge.judgeHistory).toEqual([]);
    expect(result.rtl_generate.code).toBe("module m; endmodule");
    expect(result.test_generate.code).toBe("module tb; endmodule");
    expect(championRestoreOf({ verify: {
      _checkerEvidenceInvalid: true,
      champion: { rtl: "prior", tb: "prior_tb", total: 4, pass: 4 },
    } })).toBeNull();
  });

  it("gates common-checker terminal statuses without standalone comparison", function() {
    for (const status of ["UNVERIFIED", "UNKNOWN_EXIT", "MISSING_MARKERS", "RUNTIME_EXIT"]) {
      expect(checkerEvidenceInvalidOf({ verify: { status } })).toBe(true);
    }
    // Older checkpoints with no status remain usable until the verifier
    // supplies evidence; missing status alone is not an invalidation signal.
    expect(checkerEvidenceInvalidOf({ verify: { cli: true, status: "PASS" } })).toBe(false);
  });
});
