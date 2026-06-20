// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Task #18 (client side): runCli stamps a taskId into the request body, and
// abortBackendTask targets one task or all. fetch is stubbed — no backend.

import { describe, it, expect, vi, afterEach } from "vitest";
import { runCli, abortBackendTask, buildAbortBody, genTaskId } from "../src/cli/runCli.js";

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function okResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

describe("buildAbortBody / genTaskId", () => {
  it("buildAbortBody targets a task or all", () => {
    expect(buildAbortBody("abc")).toEqual({ taskId: "abc" });
    expect(buildAbortBody()).toEqual({ all: true });
    expect(buildAbortBody(null)).toEqual({ all: true });
  });

  it("genTaskId returns unique non-empty ids", () => {
    const a = genTaskId(), b = genTaskId();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

describe("runCli task id", () => {
  it("includes a taskId in the posted /api/execute body and fires onTaskId", async () => {
    let sentBody = null;
    let urlHit = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      urlHit = url;
      sentBody = JSON.parse(opts.body);
      return okResponse({ stdout: "", stderr: "", exitCode: 0, files: {}, taskId: sentBody.taskId });
    });
    let captured = null;
    const result = await runCli("http://localhost:3001", { command: "verilator --version", files: {} },
      null, { onTaskId: (id) => { captured = id; } });

    expect(urlHit).toBe("http://localhost:3001/api/execute");
    expect(typeof sentBody.taskId).toBe("string");
    expect(sentBody.taskId.length).toBeGreaterThan(0);
    expect(captured).toBe(sentBody.taskId);   // onTaskId saw the same id
    expect(result.exitCode).toBe(0);
  });
});

describe("abortBackendTask", () => {
  it("POSTs a targeted body when given a taskId", async () => {
    let opts = null;
    globalThis.fetch = vi.fn(async (_url, o) => { opts = o; return okResponse({ ok: true }); });
    await abortBackendTask("http://localhost:3001", "task-7");
    expect(JSON.parse(opts.body)).toEqual({ taskId: "task-7" });
  });

  it("POSTs an all:true body when no taskId is given (global cancel)", async () => {
    let opts = null;
    globalThis.fetch = vi.fn(async (_url, o) => { opts = o; return okResponse({ ok: true }); });
    await abortBackendTask("http://localhost:3001");
    expect(JSON.parse(opts.body)).toEqual({ all: true });
  });

  it("is a no-op without a backend url", async () => {
    globalThis.fetch = vi.fn();
    await abortBackendTask(null, "x");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
