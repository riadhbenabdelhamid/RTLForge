// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Local-provider circuit breaker (docs/improvement-roadmap.md #6).

import { describe, it, expect, vi, afterEach } from "vitest";
import { callLLM } from "../src/llm/callLLM.js";

afterEach(() => vi.unstubAllGlobals());

function okChat(text) {
  return {
    ok: true, status: 200,
    json: async () => ({
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "m",
    }),
  };
}
function okModels(ids) {
  return { ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }) };
}

const LOCAL_CFG = {
  provider: "lmstudio", model: "m", baseUrl: "http://localhost:1234/v1",
  maxRetries: 2, retryBaseDelayMs: 1, localRecoveryTimeoutSec: 120,
};

describe("local-provider circuit breaker", () => {
  it("a dropped local call waits on the /models probe, then retries and succeeds — without burning the ladder", async () => {
    const calls = [];
    let n = 0;
    vi.stubGlobal("fetch", async (url) => {
      calls.push(String(url));
      n++;
      if (n === 1) throw new TypeError("fetch failed");       // the measured LM Studio drop
      if (String(url).endsWith("/models")) return okModels(["m"]);
      return okChat("hello");
    });
    const r = await callLLM({ systemPrompt: "s", userMessage: "u", maxTokens: 32, config: LOCAL_CFG });
    expect(r.text).toBe("hello");
    expect(calls.some((u) => u.endsWith("/models"))).toBe(true);   // probe happened
  });

  it("server up but model evicted → actionable error, not a generic fetch failure", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async (url) => {
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      if (String(url).endsWith("/models")) return okModels(["some-other-model"]);
      return okChat("x");
    });
    await expect(callLLM({ systemPrompt: "s", userMessage: "u", maxTokens: 32, config: LOCAL_CFG }))
      .rejects.toThrow(/model 'm' is not loaded[\s\S]*evicted/);
  });

  it("remote providers never probe — the ladder behaves exactly as before", async () => {
    const calls = [];
    let n = 0;
    vi.stubGlobal("fetch", async (url) => {
      calls.push(String(url));
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      return okChat("remote ok");
    });
    const r = await callLLM({
      systemPrompt: "s", userMessage: "u", maxTokens: 32,
      config: { provider: "openai", model: "m", baseUrl: "https://api.example.com/v1", maxRetries: 2, retryBaseDelayMs: 1 },
    });
    expect(r.text).toBe("remote ok");
    expect(calls.every((u) => !u.endsWith("/models"))).toBe(true);   // no probe
  });

  // ── Ollama-native probe (runs 18–19: the /models probe 404'd on Ollama and
  // the 404 was read as "still down" — a 2-minute stall against a live,
  // loading server) ─────────────────────────────────────────────────────────
  const OLLAMA_CFG = {
    provider: "ollama", model: "qwen3.6:35b", baseUrl: "http://localhost:11434",
    maxRetries: 2, retryBaseDelayMs: 1, localRecoveryTimeoutSec: 120,
  };
  function okOllamaChat(text) {
    return {
      ok: true, status: 200,
      json: async () => ({ message: { content: text }, done: true,
        prompt_eval_count: 1, eval_count: 1, model: "qwen3.6:35b" }),
    };
  }
  function okTags(names) {
    return { ok: true, status: 200, json: async () => ({ models: names.map((name) => ({ name })) }) };
  }

  it("ollama probes /api/tags (not /models) and recovers", async () => {
    const calls = [];
    let n = 0;
    vi.stubGlobal("fetch", async (url) => {
      calls.push(String(url));
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      if (String(url).endsWith("/api/tags")) return okTags(["qwen3.6:35b"]);
      return okOllamaChat("back");
    });
    const r = await callLLM({ systemPrompt: "s", userMessage: "u", maxTokens: 32, config: OLLAMA_CFG });
    expect(r.text).toBe("back");
    expect(calls.some((u) => u.endsWith("/api/tags"))).toBe(true);
    expect(calls.every((u) => !u.endsWith("11434/models"))).toBe(true);
  });

  it("ANY http response from the probe counts as reachable — a 404 never stalls the window", async () => {
    const calls = [];
    let n = 0;
    vi.stubGlobal("fetch", async (url) => {
      calls.push(String(url));
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      if (String(url).endsWith("/api/tags")) return { ok: false, status: 404, json: async () => ({}) };
      return okOllamaChat("alive");
    });
    const r = await callLLM({ systemPrompt: "s", userMessage: "u", maxTokens: 32, config: OLLAMA_CFG });
    expect(r.text).toBe("alive");
    // Exactly one probe: the 404 proved liveness immediately — no 10s loop.
    expect(calls.filter((u) => u.endsWith("/api/tags")).length).toBe(1);
  });

  it("tolerates Ollama's implicit :latest tag in the model-missing check", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async (url) => {
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      if (String(url).endsWith("/api/tags")) return okTags(["mycoder:latest"]);
      return okOllamaChat("ok");
    });
    const r = await callLLM({ systemPrompt: "s", userMessage: "u", maxTokens: 32,
      config: Object.assign({}, OLLAMA_CFG, { model: "mycoder" }) });
    expect(r.text).toBe("ok");
  });

  it("ollama model truly missing → actionable error", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async (url) => {
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      if (String(url).endsWith("/api/tags")) return okTags(["some-other-model"]);
      return okOllamaChat("x");
    });
    await expect(callLLM({ systemPrompt: "s", userMessage: "u", maxTokens: 32, config: OLLAMA_CFG }))
      .rejects.toThrow(/not loaded/);
  });

  // ── forced streaming for local providers (run 22: undici's 5-min
  // headersTimeout killed every non-streaming local call longer than 5
  // minutes — server logged 499 "client closed", callLLM saw "fetch failed") ─
  it("local calls WITHOUT onChunk still request stream:true; remote calls stay non-streaming", async () => {
    const bodies = [];
    vi.stubGlobal("fetch", async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      // Body-less stub → callLLM falls through to the non-streaming parse,
      // which is exactly the resilience path under test elsewhere.
      return okOllamaChat("ok");
    });
    await callLLM({ systemPrompt: "s", userMessage: "u", maxTokens: 32, config: OLLAMA_CFG });
    expect(bodies[0].stream).toBe(true);

    bodies.length = 0;
    vi.stubGlobal("fetch", async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return okChat("ok");
    });
    await callLLM({
      systemPrompt: "s", userMessage: "u", maxTokens: 32,
      config: { provider: "openai", model: "m", baseUrl: "https://api.example.com/v1", maxRetries: 0, retryBaseDelayMs: 1 },
    });
    expect(bodies[0].stream).toBeUndefined();
  });

  it("local calls carry a dispatcher with the header deadline disabled; remote calls don't", async () => {
    const optsSeen = [];
    vi.stubGlobal("fetch", async (url, opts) => {
      optsSeen.push(opts);
      return okOllamaChat("ok");
    });
    await callLLM({ systemPrompt: "s", userMessage: "u", maxTokens: 32, config: OLLAMA_CFG });
    // In this Node test env the undici global-dispatcher symbol is present,
    // so local calls get a dedicated dispatcher (browser/failed-lookup falls
    // back to none — the try/catch path).
    expect(optsSeen[0].dispatcher).toBeDefined();

    optsSeen.length = 0;
    vi.stubGlobal("fetch", async (url, opts) => { optsSeen.push(opts); return okChat("ok"); });
    await callLLM({
      systemPrompt: "s", userMessage: "u", maxTokens: 32,
      config: { provider: "openai", model: "m", baseUrl: "https://api.example.com/v1", maxRetries: 0, retryBaseDelayMs: 1 },
    });
    expect(optsSeen[0].dispatcher).toBeUndefined();
  });

  it("localRecoveryTimeoutSec: 0 disables the breaker (plain ladder)", async () => {
    const calls = [];
    let n = 0;
    vi.stubGlobal("fetch", async (url) => {
      calls.push(String(url));
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      return okChat("ok");
    });
    const r = await callLLM({
      systemPrompt: "s", userMessage: "u", maxTokens: 32,
      config: Object.assign({}, LOCAL_CFG, { localRecoveryTimeoutSec: 0 }),
    });
    expect(r.text).toBe("ok");
    expect(calls.every((u) => !u.endsWith("/models"))).toBe(true);
  });
});
