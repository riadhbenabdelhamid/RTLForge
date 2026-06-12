// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// callLLMJson — the in-call "re-ask with the parse error as a hint" layer.
//
// Pins the contract single-call nodes (spec, formal_props) rely on:
// the hint reaches the retry prompt, every attempt's spend is surfaced,
// and a pinned sampling seed is nudged so the re-ask can actually differ.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { callLLMJson } from "../src/llm/callLLMJson.js";

beforeEach(function() {
  globalThis.fetch = vi.fn();
});

function openaiJson(text) {
  return {
    ok: true, status: 200, body: null,
    json: async function() {
      return {
        choices: [{ message: { content: text }, finish_reason: "stop" }],
        model: "gpt-test",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    },
    text: async function() { return ""; },
  };
}

describe("callLLMJson", function() {
  it("returns parsed data with no retry when the first reply is valid", async function() {
    globalThis.fetch.mockResolvedValueOnce(openaiJson('{"ok":1}'));
    const jr = await callLLMJson({
      config: { provider: "openai", apiKey: "sk-test", model: "gpt-test" },
      systemPrompt: "s", userMessage: "u", maxTokens: 100,
    });
    expect(jr.data.ok).toBe(1);
    expect(jr.llms.length).toBe(1);
    expect(jr.parseRetried).toBe(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("re-asks once with the parse error in-prompt and ledgers both attempts", async function() {
    globalThis.fetch
      .mockResolvedValueOnce(openaiJson("I cannot produce JSON today, sorry."))
      .mockResolvedValueOnce(openaiJson('{"recovered":true}'));
    const jr = await callLLMJson({
      config: { provider: "openai", apiKey: "sk-test", model: "gpt-test" },
      systemPrompt: "s", userMessage: "original prompt", maxTokens: 100,
    });
    expect(jr.data.recovered).toBe(true);
    expect(jr.parseRetried).toBe(1);
    expect(jr.llms.length).toBe(2);          // failed attempt is ledgered too
    // The retry prompt carries the hint AND the original content
    const body2 = JSON.parse(globalThis.fetch.mock.calls[1][1].body);
    const retryMsg = body2.messages.map(function(m) { return m.content; }).join("\n");
    expect(retryMsg).toContain("original prompt");
    expect(retryMsg).toContain("RETRY CONTEXT");
    expect(retryMsg).toContain("JSON parse failed");
  });

  it("nudges a pinned seed on the re-ask (offset from the truncation ladder)", async function() {
    globalThis.fetch
      .mockResolvedValueOnce(openaiJson("not json at all"))
      .mockResolvedValueOnce(openaiJson('{"x":1}'));
    await callLLMJson({
      config: { provider: "openai", apiKey: "sk-test", model: "gpt-test", seed: 42 },
      systemPrompt: "s", userMessage: "u", maxTokens: 100,
    });
    const body1 = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    const body2 = JSON.parse(globalThis.fetch.mock.calls[1][1].body);
    expect(body1.seed).toBe(42);
    expect(body2.seed).toBe(1043);   // 42 + 1000 + attempt(1)
  });

  it("throws the final parse error with .llms attached when all attempts fail", async function() {
    globalThis.fetch.mockResolvedValue(openaiJson("still not json"));
    let err = null;
    try {
      await callLLMJson({
        config: { provider: "openai", apiKey: "sk-test", model: "gpt-test" },
        systemPrompt: "s", userMessage: "u", maxTokens: 100,
      });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message).toContain("JSON parse failed");
    expect(err.llms.length).toBe(2);         // spend recoverable by callers
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("parseRetries: 0 disables the re-ask", async function() {
    globalThis.fetch.mockResolvedValue(openaiJson("nope"));
    let err = null;
    try {
      await callLLMJson({
        config: { provider: "openai", apiKey: "sk-test", model: "gpt-test" },
        systemPrompt: "s", userMessage: "u", maxTokens: 100,
      }, { parseRetries: 0 });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
