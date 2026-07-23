// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Chain-entry transport retry (runs 20–21): three chain entries died
// permanently on "fetch failed" — run 20's test_review, run 21's lint-chain
// and verify-chain rtl_generate, the last being that run's only repair
// chance. A transport-class death now gets exactly ONE entry-level retry;
// non-transport errors keep the old record-and-continue behavior.

import { describe, it, expect, vi } from "vitest";
import { runReflowChain, isTransportError } from "../src/pipeline/reflowRunner.js";

function baseSt(invokeNode) {
  return {
    _config: {},
    _onLog: function() {},
    _signal: null,
    _logger: {
      events: [],
      state: function() {}, llm: function() {}, cli: function() {},
      skill: function() {}, prompt: function() {}, result: function() {},
      context: { depth: 0, parentStageKey: null, parentIter: null },
    },
    _services: { invokeNode: invokeNode, allStages: [{ id: 4, key: "rtl_generate", order: 40 }] },
  };
}
const CHAIN = [{ stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" }];

describe("isTransportError", function() {
  it("matches the callLLM ladder's network family, not logic errors", function() {
    expect(isTransportError("fetch failed")).toBe(true);
    expect(isTransportError("connect ECONNREFUSED 127.0.0.1:11434")).toBe(true);
    expect(isTransportError("terminated")).toBe(true);
    expect(isTransportError("rtl_generate produced no usable module")).toBe(false);
    expect(isTransportError(null)).toBe(false);
  });
});

describe("runReflowChain transport retry", function() {
  it("retries a fetch-failed entry ONCE and adopts the second attempt", async function() {
    let calls = 0;
    const invokeNode = vi.fn(async function() {
      calls++;
      if (calls === 1) throw new Error("fetch failed");
      return { rtl_generate: { code: "module ok; endmodule" }, _llms: [] };
    });
    const logs = [];
    const walk = await runReflowChain({
      chain: CHAIN, st: baseSt(invokeNode), currentState: {},
      allLlms: [], appendLog: function(t, b) { logs.push(t + " " + (b || "")); },
      ownerKey: "verify", ownerIter: 1, parentDepth: 0, strictOnError: false,
    });
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(walk.chainHistory[0].status).toBe("ran");
    expect(walk.currentState.rtl_generate.code).toContain("module ok");
    expect(logs.join("\n")).toMatch(/transport retry/);
  });

  it("a second transport death is recorded as error (no infinite retry)", async function() {
    const invokeNode = vi.fn(async function() { throw new Error("fetch failed"); });
    const walk = await runReflowChain({
      chain: CHAIN, st: baseSt(invokeNode), currentState: {},
      allLlms: [], appendLog: function() {},
      ownerKey: "verify", ownerIter: 1, parentDepth: 0, strictOnError: false,
    });
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(walk.chainHistory[0].status).toBe("error");
    expect(walk.chainHistory[0].error).toMatch(/fetch failed/);
  });

  it("non-transport errors are NOT retried", async function() {
    const invokeNode = vi.fn(async function() { throw new Error("produced no usable module"); });
    const walk = await runReflowChain({
      chain: CHAIN, st: baseSt(invokeNode), currentState: {},
      allLlms: [], appendLog: function() {},
      ownerKey: "verify", ownerIter: 1, parentDepth: 0, strictOnError: false,
    });
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expect(walk.chainHistory[0].status).toBe("error");
  });

  it("user aborts propagate instead of being swallowed as entry errors", async function() {
    const invokeNode = vi.fn(async function() {
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(runReflowChain({
      chain: CHAIN, st: baseSt(invokeNode), currentState: {},
      allLlms: [], appendLog: function() {},
      ownerKey: "verify", ownerIter: 1, parentDepth: 0, strictOnError: false,
    })).rejects.toThrow(/Aborted/);
  });
});
