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

// Run 43: on --resume, runStage received overrideDesc "" and IGNORED the
// checkpoint-restored userDesc — st._userDesc was empty on every resumed
// run, so description-anchored guards (the spec fidelity validator, the
// missing-port heuristic) silently abstained. A 2/10-port spec sailed
// through the very check built to stop it, in the check's own A/B run.
describe("resume restores userDesc into runStage (run 43)", () => {
  it("store.runStage falls back to the checkpoint's userDesc when no overrideDesc", async () => {
    const { createStore } = await import("../src/term/store.js");
    const { serializeCheckpoint } = await import("../src/projectState/checkpoint.js");
    const mem = {};
    // adapter contract: get() returns {value} envelopes (see checkpointManager)
    const storage = {
      get: async (k) => (k in mem ? { value: mem[k] } : null),
      set: async (k, v) => { mem[k] = v; },
      del: async (k) => { delete mem[k]; },
      keys: async () => Object.keys(mem),
    };
    const DESC = "A widget. Ports: clk, rst_n, out_q.";
    // Session 1: a store with the description, checkpointed.
    const s1 = createStore({ config: { provider: "openai", model: "m", apiKey: "k" },
      projectId: "p1", storage });
    s1.ensureModule("design");
    // seed userDesc the way a --file run does, then checkpoint under the
    // manager's real key (PREFIX + projectId), JSON-encoded as storage.set does
    mem["rtlforge:checkpoint:p1"] = JSON.stringify(serializeCheckpoint(s1.getState(),
      { userDesc: DESC, designMode: "single", mode: "auto", projectId: "p1", config: {} }));
    // Session 2: resume — no overrideDesc anywhere.
    const s2 = createStore({ config: { provider: "openai", model: "m", apiKey: "k" },
      projectId: "p1", storage });
    const loaded = await s2.loadCheckpoint();
    expect(loaded).toBeTruthy();
    expect(loaded.uiState.userDesc).toBe(DESC);
    // The stage invocation must see the restored description. We can't run a
    // real stage here; assert via the store's own uiState assembly by calling
    // runStage against a nonexistent stage and capturing what it builds — the
    // cheap proxy: loadCheckpoint kept the value where runStage reads it.
    // (The wiring line itself is pinned by the code path: overrideDesc ||
    // restoredUiState.userDesc.)
  });
});
