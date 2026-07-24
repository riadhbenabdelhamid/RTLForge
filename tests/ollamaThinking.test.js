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
