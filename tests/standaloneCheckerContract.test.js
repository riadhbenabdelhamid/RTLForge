// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { promptStandaloneTB } from "../src/prompts/standaloneTest.js";
import { parseTestLine } from "../src/cli/runCli.js";
import { selectCommonCheckerCandidate } from "../src/pipeline/candidateGuard.js";

function skipWithoutVerilator(ctx) {
  try {
    execFileSync("verilator", ["--version"], { stdio: "ignore" });
    return true;
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "EPERM")) {
      ctx.skip("Verilator is unavailable in this execution environment");
      return false;
    }
    throw e;
  }
}

function writeTinyFiles(dir, inverted) {
  fs.writeFileSync(path.join(dir, "tiny.sv"), [
    "module tiny(input logic d, output logic q);",
    "  assign q = " + (inverted ? "~d" : "d") + ";",
    "endmodule",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "tiny_tb.sv"), [
    "module tiny_tb;",
    "  logic d; logic q;",
    "  tiny dut(.d(d), .q(q));",
    "  task automatic check(input logic ok, input string id);",
    "    if (ok) $display(\"[PASS] %s\", id);",
    "    else begin $display(\"[FAIL] %s\", id); failures++; end",
    "  endtask",
    "  integer failures;",
    "  initial begin",
    "    failures = 0;",
    "    d = 1'b0; #1; check(q === 1'b0, \"tiny.copy.0\");",
    "    d = 1'b1; #1; check(q === 1'b1, \"tiny.copy.1\");",
    "    if (failures != 0) $fatal(1);",
    "    else $finish(0);",
    "  end",
    "endmodule",
  ].join("\n"));
}

function buildTiny(dir) {
  execFileSync("verilator", [
    "--binary", "--timing", "--top-module", "tiny_tb",
    "tiny.sv", "tiny_tb.sv", "-o", "tiny_sim",
  ], { cwd: dir, stdio: "pipe" });
}

function parsedChecks(output) {
  return String(output || "").split("\n").map(parseTestLine).filter(Boolean);
}

function measured(checks, checker) {
  const pass = checks.filter((check) => check.status === "PASS").length;
  return {
    cli: true,
    checker,
    tests: checks,
    pass,
    fail: checks.length - pass,
    total: checks.length,
  };
}

function skipIfSimulatorUnavailable(ctx, e) {
  if (e && (e.code === "ENOENT" || e.code === "EPERM")) {
    ctx.skip("Verilator execution is unavailable in this environment");
    return true;
  }
  return false;
}

describe("independent checker marker contract", function() {
  it("requires the exact parser-compatible marker and unique ID contract", function() {
    const p = promptStandaloneTB(
      "A tiny combinational module copies input d to output q.",
      "module tiny(input logic d, output logic q);",
      "tiny",
    );
    expect(p.userMessage).toContain("[PASS] <stable-unique-check-id>");
    expect(p.userMessage).toContain("[FAIL] <stable-unique-check-id>");
    expect(p.userMessage).toContain("do not emit `PASS [label]`");
    expect(p.userMessage).toContain("single-token values using only letters");
    expect(p.userMessage).toContain("unique across all repeated cycles");
    expect(p.userMessage).toContain("full predetermined check sequence");
    expect(p.userMessage).toContain("after the final marker");
  });

  it("accepts only the production marker syntax", function() {
    expect(parseTestLine("[PASS] REQ-FUNC-001.0")).toMatchObject({
      status: "PASS", name: "REQ-FUNC-001.0",
    });
    expect(parseTestLine("PASS [REQ-FUNC-001.0]")).toBeNull();
    expect(parseTestLine("TEST PASS: all checks passed")).toBeNull();
  });

  it("runs a small independent checker through Verilator and production parsing", function(ctx) {
    if (!skipWithoutVerilator(ctx)) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtlforge-checker-contract-"));
    let output;
    try {
      writeTinyFiles(dir, false);
      buildTiny(dir);
      output = execFileSync(path.join(dir, "obj_dir", "tiny_sim"), [], {
        cwd: dir, encoding: "utf8", stdio: "pipe",
      });
    } catch (e) {
      if (skipIfSimulatorUnavailable(ctx, e)) return;
      throw e;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const checks = parsedChecks(output);
    expect(checks).toEqual([
      expect.objectContaining({ status: "PASS", name: "tiny.copy.0" }),
      expect.objectContaining({ status: "PASS", name: "tiny.copy.1" }),
    ]);
  });

  it("reports a real FAIL marker and nonzero exit for an incorrect DUT", function(ctx) {
    if (!skipWithoutVerilator(ctx)) return;
    const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtlforge-checker-contract-"));
    let baselineOutput;
    try {
      writeTinyFiles(baselineDir, false);
      buildTiny(baselineDir);
      baselineOutput = execFileSync(path.join(baselineDir, "obj_dir", "tiny_sim"), [], {
        cwd: baselineDir, encoding: "utf8", stdio: "pipe",
      });
    } catch (e) {
      if (skipIfSimulatorUnavailable(ctx, e)) return;
      throw e;
    } finally {
      fs.rmSync(baselineDir, { recursive: true, force: true });
    }
    const baselineChecks = parsedChecks(baselineOutput);
    expect(baselineChecks).toEqual([
      expect.objectContaining({ status: "PASS", name: "tiny.copy.0" }),
      expect.objectContaining({ status: "PASS", name: "tiny.copy.1" }),
    ]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtlforge-checker-contract-"));
    let error;
    try {
      writeTinyFiles(dir, true);
      buildTiny(dir);
      execFileSync(path.join(dir, "obj_dir", "tiny_sim"), [], {
        cwd: dir, encoding: "utf8", stdio: "pipe",
      });
    } catch (e) {
      if (skipIfSimulatorUnavailable(ctx, e)) return;
      error = e;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(error).toBeTruthy();
    expect(error.status).not.toBe(0);
    const checks = parsedChecks(error.stdout);
    expect(checks).toEqual([
      expect.objectContaining({ status: "FAIL", name: "tiny.copy.0" }),
      expect.objectContaining({ status: "FAIL", name: "tiny.copy.1" }),
    ]);

    const checker = { version: "tiny-contract-v1", seed: "C0FFEE", hash: "tiny" };
    const incumbent = measured(checks, checker);
    const candidate = measured(baselineChecks, checker);
    const accepted = selectCommonCheckerCandidate(candidate, incumbent);
    expect(accepted.decision).toBe("ACCEPT_IMPROVEMENT");
    expect(accepted.selected).toBe(candidate);

    const reverse = selectCommonCheckerCandidate(incumbent, candidate);
    expect(reverse.decision).toBe("FALLBACK");
    expect(reverse.reason).toBe("PASSED_CHECK_REGRESSION");
  });
});
