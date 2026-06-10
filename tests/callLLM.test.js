// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Tests for src/llm/callLLM.js — non-streaming onChunk emission
//
// Pins the v17 body-visibility fix: even when the streaming code path is
// not taken (useStream=false or resp.body unavailable), the non-streaming
// path now fires onChunk once with the final text so subscribers populate
// their section bodies. Without this, users saw section headers but no
// body — the "empty RTL fix output" symptom.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";
import { callLLM } from "../src/llm/callLLM.js";

beforeEach(function() {
  // Reset fetch mock between tests
  globalThis.fetch = vi.fn();
});

function mockFetchResponse(opts) {
  return {
    ok: opts.ok !== false,
    status: opts.status || 200,
    statusText: opts.statusText || "OK",
    body: opts.body || null,             // null forces non-streaming path
    json: async function() { return opts.json || {}; },
    text: async function() { return opts.text || ""; },
  };
}

describe("callLLM non-streaming onChunk emission (v17 fix)", function() {
  it("fires onChunk once with final text when streaming path is bypassed (anthropic, no body)", async function() {
    // Anthropic streaming response shape with no body — forces non-stream path
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      json: {
        content: [{ type: "text", text: "fake response from anthropic" }],
        model: "claude-3-5-sonnet-test",
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "end_turn",
      },
    }));
    const onChunk = vi.fn();
    const result = await callLLM({
      config: { provider: "anthropic", apiKey: "sk-test", model: "claude-3-5-sonnet-test" },
      systemPrompt: "sys",
      userMessage: "user",
      maxTokens: 100,
      onChunk: onChunk,
    });
    // Must fire onChunk at least once with the final text so the log
    // shows a body, not just a header
    expect(onChunk).toHaveBeenCalled();
    const lastCall = onChunk.mock.calls[onChunk.mock.calls.length - 1];
    expect(lastCall[0]).toBe("fake response from anthropic");
    expect(lastCall[1].done).toBe(true);
    expect(result.text).toBe("fake response from anthropic");
  });

  it("fires onChunk once with final text (openai, no body)", async function() {
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      json: {
        choices: [{ message: { content: "openai response text" }, finish_reason: "stop" }],
        model: "gpt-test",
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      },
    }));
    const onChunk = vi.fn();
    const result = await callLLM({
      config: { provider: "openai", apiKey: "sk-test", model: "gpt-test" },
      systemPrompt: "sys",
      userMessage: "user",
      maxTokens: 100,
      onChunk: onChunk,
    });
    expect(onChunk).toHaveBeenCalled();
    const lastCall = onChunk.mock.calls[onChunk.mock.calls.length - 1];
    expect(lastCall[0]).toBe("openai response text");
    expect(lastCall[1].done).toBe(true);
    expect(result.text).toBe("openai response text");
  });

  it("does not fire onChunk when no callback is provided (no error)", async function() {
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      json: {
        choices: [{ message: { content: "silent" }, finish_reason: "stop" }],
        model: "gpt",
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    }));
    const result = await callLLM({
      config: { provider: "openai", apiKey: "sk-test", model: "gpt" },
      systemPrompt: "s",
      userMessage: "u",
      maxTokens: 100,
      // No onChunk
    });
    expect(result.text).toBe("silent");
  });

  it("non-streaming + log.stream integration: header shows once, body has full text", async function() {
    // Integration: wire callLLM's onChunk into the log.stream pipeline like
    // the production nodes do. Verify the final log buffer has the section
    // header followed by the full LLM response, not an empty body.
    const { createLogger } = await import("../src/pipeline/log.js");
    const log = createLogger(null, "thin");
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      json: {
        choices: [{ message: { content: "{\"code\":\"module x; endmodule\"}" }, finish_reason: "stop" }],
        model: "gpt", usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    }));
    await callLLM({
      config: { provider: "openai", apiKey: "sk-test", model: "gpt" },
      systemPrompt: "s",
      userMessage: "u",
      maxTokens: 100,
      onChunk: function(t, m) { log.stream("RTL Fix output (iter 1)", t); },
    });
    expect(log.buf).toContain("RTL Fix output (iter 1)");
    expect(log.buf).toContain("{\"code\":\"module x; endmodule\"}");
    // Header should appear exactly once
    expect((log.buf.match(/RTL Fix output \(iter 1\)/g) || []).length).toBe(1);
  });
});
