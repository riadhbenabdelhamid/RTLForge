// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runCli, CliBackendError } from "../src/cli/runCli.js";

describe("runCli — Fix #2 robustness", function() {
  let originalFetch;
  beforeEach(function() {
    originalFetch = globalThis.fetch;
  });
  afterEach(function() {
    globalThis.fetch = originalFetch;
  });

  it("returns null when no backendUrl is provided", async function() {
    const r = await runCli("", { command: "echo", files: {} });
    expect(r).toBe(null);
  });

  it("returns _error after exhausting retries", async function() {
    let attempts = 0;
    globalThis.fetch = vi.fn(function() {
      attempts++;
      return Promise.reject(new Error("network down"));
    });
    const r = await runCli("http://x", { command: "echo", files: {} }, null, { retries: 2, timeoutMs: 5000 });
    expect(r).toBeTruthy();
    expect(r._error).toBe(true);
    expect(r._attempts).toBe(3);             // 1 initial + 2 retries
    expect(attempts).toBe(3);
    expect(r._msg).toMatch(/network down/);
  });

  it("succeeds on the second attempt after one transient failure", async function() {
    let attempts = 0;
    globalThis.fetch = vi.fn(function() {
      attempts++;
      if (attempts === 1) return Promise.reject(new Error("transient"));
      return Promise.resolve({
        ok: true,
        json: function() { return Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }); },
      });
    });
    const r = await runCli("http://x", { command: "echo", files: {} }, null, { retries: 2, timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("returns _error on persistent HTTP 500", async function() {
    globalThis.fetch = vi.fn(function() {
      return Promise.resolve({ ok: false, status: 500, json: function() { return Promise.resolve({}); } });
    });
    const r = await runCli("http://x", { command: "echo", files: {} }, null, { retries: 1, timeoutMs: 1000 });
    expect(r._error).toBe(true);
    expect(r._msg).toMatch(/HTTP 500/);
    expect(r._attempts).toBe(2);
  });

  it("CliBackendError carries attempts and is identifiable", function() {
    const e = new CliBackendError("boom", 4);
    expect(e.message).toBe("boom");
    expect(e.attempts).toBe(4);
    expect(e.isCliBackendError).toBe(true);
    expect(e.name).toBe("CliBackendError");
  });

  it("does not leak abort listeners on the user signal across many calls", async function() {
    // Improvement A1 regression: each successful or failed call must clean up
    // its abort-event listener and timeout. Previously listeners accumulated
    // across the lifetime of the user's AbortSignal.
    globalThis.fetch = vi.fn(function() {
      return Promise.resolve({
        ok: true,
        json: function() { return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }); },
      });
    });
    const ctl = new AbortController();
    let added = 0;
    let removed = 0;
    const realAdd = ctl.signal.addEventListener.bind(ctl.signal);
    const realRemove = ctl.signal.removeEventListener.bind(ctl.signal);
    ctl.signal.addEventListener = function(type, fn, opts) {
      if (type === "abort") added++;
      return realAdd(type, fn, opts);
    };
    ctl.signal.removeEventListener = function(type, fn) {
      if (type === "abort") removed++;
      return realRemove(type, fn);
    };

    for (let i = 0; i < 5; i++) {
      await runCli("http://x", { command: "echo", files: {} }, ctl.signal, { retries: 0, timeoutMs: 5000 });
    }
    // Each call should add one listener and remove it again on success.
    expect(added).toBe(5);
    expect(removed).toBe(5);
  });
});

// ─── parseCLIOutput correctness-class warning promotion (run 27) ────────────
// Verilator tagged the run-killing TB bug only %Warning-IMPLICITSTATIC ("The
// initializer value will only be set once"): an in-block `bit do_wr = ...`
// froze the reference model at time zero, 35/78 tests failed, and the judge
// FAILed — while lint_test PASSed because lintWarningsAsErrors defaults off.
// Correctness-class codes now land in errors[] so every compile/lint guard
// gates on them.
import { parseCLIOutput } from "../src/cli/runCli.js";

describe("parseCLIOutput promoted warnings (run 27: IMPLICITSTATIC)", function() {
  const STDERR = [
    "%Warning-IMPLICITSTATIC: sync_fifo_tb.sv:118:11: Variable's lifetime implicitly set to static (IEEE 1800-2023 6.21)",
    "                                                : ... The initializer value will only be set once",
    "  118 |       bit do_wr = wr_en & (~full);",
    "%Warning-WIDTHEXPAND: rtl.sv:58:34: Operator ADD expects 32 bits on the LHS",
  ].join("\n");

  it("IMPLICITSTATIC lands in errors[] with sev error, continuation intact", function() {
    const parsed = parseCLIOutput(STDERR);
    expect(parsed.errors.length).toBe(1);
    expect(parsed.errors[0].code).toBe("IMPLICITSTATIC");
    expect(parsed.errors[0].sev).toBe("error");
    expect(parsed.errors[0].line).toBe(118);
    expect(parsed.errors[0].msg).toContain("only be set once");
  });

  it("ordinary warnings stay warnings", function() {
    const parsed = parseCLIOutput(STDERR);
    expect(parsed.warnings.length).toBe(1);
    expect(parsed.warnings[0].code).toBe("WIDTHEXPAND");
    expect(parsed.warnings[0].sev).toBe("warning");
  });

  it("real %Error lines are unaffected", function() {
    const parsed = parseCLIOutput("%Error: tb.sv:5:2: syntax error, unexpected endmodule");
    expect(parsed.errors.length).toBe(1);
    expect(parsed.errors[0].code).toBe("SYNTAX");
  });
});
