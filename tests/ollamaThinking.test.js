// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Ollama thinking-channel handling (measured: run 27, laguna-s-2.1).
//
// Thinking-capable Ollama models route reasoning to message.thinking; under a
// num_predict cap the entire budget can go to thinking and message.content
// arrives EMPTY. Run 27's RTL Review burned two truncation retries (8k→16k)
// and 44 minutes, then halted the pipeline on "JSON parse failed: empty or
// non-string input". Pins:
//   1. buildOllamaReq plumbs config.ollamaThink as the top-level `think`
//      field — false disables reasoning server-side; null OMITS the field
//      (Ollama rejects `think` on models without the capability).
//   2. The NDJSON streaming path accumulates message.thinking deltas and
//      falls back to them only when the content channel ends empty —
//      mirroring the OpenAI reasoning_content fallback.
//   3. The non-streaming parse() backfills empty content from thinking.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildOllamaReq } from "../src/llm/providers/ollama.js";
import { callLLM } from "../src/llm/callLLM.js";

const CFG = { provider: "ollama", model: "laguna-s-2.1:latest", baseUrl: "http://localhost:11434" };

describe("buildOllamaReq think plumb (run 27: thinking ate the whole cap)", function() {
  it("ollamaThink:false lands as body.think === false", function() {
    const r = buildOllamaReq(Object.assign({}, CFG, { ollamaThink: false }), "s", "u", 100);
    expect(r.body.think).toBe(false);
  });

  it("effort strings pass through verbatim", function() {
    const r = buildOllamaReq(Object.assign({}, CFG, { ollamaThink: "low" }), "s", "u", 100);
    expect(r.body.think).toBe("low");
  });

  it("null/undefined OMITS the field (models without the capability reject it)", function() {
    expect("think" in buildOllamaReq(CFG, "s", "u", 100).body).toBe(false);
    expect("think" in buildOllamaReq(Object.assign({}, CFG, { ollamaThink: null }), "s", "u", 100).body).toBe(false);
  });

  it("non-streaming parse backfills empty content from thinking", function() {
    const r = buildOllamaReq(CFG, "s", "u", 100);
    expect(r.parse({ message: { content: "", thinking: '{"code":"m"}' } }).text).toBe('{"code":"m"}');
    // content wins when both channels carry text
    expect(r.parse({ message: { content: "answer", thinking: "pondering" } }).text).toBe("answer");
  });
});

describe("buildOllamaReq num_predict — content-only cap (run 28: maxThinkingTokens)", function() {
  it("think disabled keeps the strict server cap (num_predict = max)", function() {
    const r = buildOllamaReq(Object.assign({}, CFG, { ollamaThink: false, maxThinkingTokens: 4096 }), "s", "u", 100);
    expect(r.body.options.num_predict).toBe(100);
  });

  it("thinking possible + no budget → uncapped server side (num_predict = -1)", function() {
    expect(buildOllamaReq(CFG, "s", "u", 100).body.options.num_predict).toBe(-1);
    expect(buildOllamaReq(Object.assign({}, CFG, { ollamaThink: true }), "s", "u", 100).body.options.num_predict).toBe(-1);
  });

  it("thinking possible + maxThinkingTokens → ceiling is max + budget", function() {
    const r = buildOllamaReq(Object.assign({}, CFG, { maxThinkingTokens: 4096 }), "s", "u", 100);
    expect(r.body.options.num_predict).toBe(4196);
  });
});

// NDJSON stream body: one JSON object per line, no SSE framing.
function ndjsonBody(objs) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start: function(controller) {
      for (let i = 0; i < objs.length; i++) {
        controller.enqueue(enc.encode(JSON.stringify(objs[i]) + "\n"));
      }
      controller.close();
    },
  });
}

function mockFetchResponse(opts) {
  return {
    ok: true, status: 200, statusText: "OK",
    body: opts.body || null,
    json: async function() { return opts.json || {}; },
    text: async function() { return opts.text || ""; },
  };
}

describe("callLLM Ollama streaming thinking-channel fallback", function() {
  let warnSpy;
  beforeEach(function() {
    globalThis.fetch = vi.fn();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(function() {});
  });
  afterEach(function() { warnSpy.mockRestore(); });

  it("uses accumulated thinking when the content channel ends empty", async function() {
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      body: ndjsonBody([
        { message: { thinking: '{"verdict":' }, model: "laguna-s-2.1:latest" },
        { message: { thinking: '"ok"}' } },
        { message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 7, eval_count: 100 },
      ]),
    }));
    const r = await callLLM({
      systemPrompt: "s", userMessage: "u", onChunk: function() {},
      config: CFG,
    });
    expect(r.text).toBe('{"verdict":"ok"}');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("thinking channel"));
  });

  it("content wins when BOTH channels carry text (model thinks AND answers)", async function() {
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      body: ndjsonBody([
        { message: { thinking: "let me reason…" } },
        { message: { content: '{"verdict":"real"}' } },
        { message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 7, eval_count: 20 },
      ]),
    }));
    const r = await callLLM({
      systemPrompt: "s", userMessage: "u", onChunk: function() {},
      config: CFG,
    });
    expect(r.text).toBe('{"verdict":"real"}');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("callLLM Ollama streaming content-only cap (run 28: maxThinkingTokens)", function() {
  let warnSpy;
  beforeEach(function() {
    globalThis.fetch = vi.fn();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(function() {});
  });
  afterEach(function() { warnSpy.mockRestore(); });

  it("clamps the CONTENT channel at maxTokens and reports a length cut", async function() {
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      body: ndjsonBody([
        { message: { thinking: "brief ponder " } },
        { message: { content: "a" } },
        { message: { content: "b" } },
        { message: { content: "c" } },
        { message: { content: "d" } },
        { message: { content: "e" } },
        { message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 7, eval_count: 9 },
      ]),
    }));
    const r = await callLLM({
      systemPrompt: "s", userMessage: "u", onChunk: function() {}, maxTokens: 3,
      config: Object.assign({}, CFG, { truncationRetries: 0 }),
    });
    expect(r.text).toBe("abc");
    expect(r.stopReason).toBe("length");
    expect(r.truncated).toBe(true);
    // Cancelled before the done message: spend = content + thinking chunks.
    expect(r.tokensOut).toBe(4);
  });

  it("aborts a runaway thinker at maxThinkingTokens before any content", async function() {
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      body: ndjsonBody([
        { message: { thinking: "round1 " } },
        { message: { thinking: "round2 " } },
        { message: { thinking: "round3 " } },
        { message: { thinking: "round4 " } },
      ]),
    }));
    const r = await callLLM({
      systemPrompt: "s", userMessage: "u", onChunk: function() {}, maxTokens: 100,
      config: Object.assign({}, CFG, { maxThinkingTokens: 2, truncationRetries: 0 }),
    });
    // Content never arrived — the thinking fallback carries what exists.
    expect(r.text).toBe("round1 round2 ");
    expect(r.stopReason).toBe("length");
    expect(r.truncated).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("thinking channel"));
  });

  it("default (no budget) lets a long thinker finish and answer", async function() {
    const lines = [];
    for (let i = 0; i < 6; i++) lines.push({ message: { thinking: "t" + i + " " } });
    lines.push({ message: { content: '{"ok":true}' } });
    lines.push({ message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 40 });
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({ body: ndjsonBody(lines) }));
    const r = await callLLM({
      systemPrompt: "s", userMessage: "u", onChunk: function() {}, maxTokens: 100,
      config: Object.assign({}, CFG, { truncationRetries: 0 }),
    });
    expect(r.text).toBe('{"ok":true}');
    expect(r.stopReason).toBe("stop");
    expect(r.truncated).toBeUndefined();
    expect(r.tokensOut).toBe(40);
  });

  it("think:false keeps the legacy strict-cap path (no client clamp)", async function() {
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      body: ndjsonBody([
        { message: { content: "a" } },
        { message: { content: "b" } },
        { message: { content: "c" } },
        { message: { content: "d" } },
        { message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 4 },
      ]),
    }));
    const r = await callLLM({
      systemPrompt: "s", userMessage: "u", onChunk: function() {}, maxTokens: 2,
      config: Object.assign({}, CFG, { ollamaThink: false, truncationRetries: 0 }),
    });
    // The server (mock) ran past the cap; with think:false we trust
    // num_predict and never cut client-side.
    expect(r.text).toBe("abcd");
    expect(r.stopReason).toBe("stop");
  });
});
