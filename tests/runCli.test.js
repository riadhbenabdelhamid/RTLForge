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
