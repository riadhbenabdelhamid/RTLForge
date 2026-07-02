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
