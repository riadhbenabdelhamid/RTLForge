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

// ═══════════════════════════════════════════════════════════════════════════
// Truncation recovery — the Layer-2 retry ladder in callLLM.
//
// When the provider reports a length-cut (stop_reason "max_tokens" /
// finish_reason "length"), callLLM must re-issue the call with a doubled
// token cap instead of returning broken JSON that fails the stage with
// "TRUNCATED OUTPUT". Discarded attempts' token spend is folded into the
// final result so the ledger and budget guard see real cost.
// ═══════════════════════════════════════════════════════════════════════════

function anthropicJson(text, stopReason, tokensIn, tokensOut) {
  return {
    content: [{ type: "text", text: text }],
    model: "claude-test",
    usage: { input_tokens: tokensIn, output_tokens: tokensOut },
    stop_reason: stopReason,
  };
}

function mockJsonResponse(json) {
  return {
    ok: true, status: 200, body: null,
    json: async function() { return json; },
    text: async function() { return ""; },
  };
}

describe("callLLM truncation recovery", function() {
  it("retries with a doubled token cap when stop_reason is max_tokens", async function() {
    globalThis.fetch
      .mockResolvedValueOnce(mockJsonResponse(
        anthropicJson('{"requirements":[{"id":"R1"', "max_tokens", 100, 50)))
      .mockResolvedValueOnce(mockJsonResponse(
        anthropicJson('{"requirements":[{"id":"R1"}]}', "end_turn", 100, 80)));
    const result = await callLLM({
      config: { provider: "anthropic", apiKey: "sk-test", model: "claude-test" },
      systemPrompt: "sys", userMessage: "user", maxTokens: 1000,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    // Second request carries the doubled cap
    const body2 = JSON.parse(globalThis.fetch.mock.calls[1][1].body);
    expect(body2.max_tokens).toBe(2000);
    // Final result is the complete attempt…
    expect(result.text).toBe('{"requirements":[{"id":"R1"}]}');
    expect(result.stopReason).toBe("end_turn");
    expect(result.truncated).toBeUndefined();
    // …with the discarded attempt's spend folded in (100+100 in, 50+80 out)
    expect(result.tokensIn).toBe(200);
    expect(result.tokensOut).toBe(130);
    expect(result._truncationRetries).toBe(1);
  });

  it("stops escalating at the ceiling and stamps truncated:true", async function() {
    // Cap already AT the ceiling: no retry possible — single call, stamped.
    globalThis.fetch.mockResolvedValue(mockJsonResponse(
      anthropicJson('{"a":{"b":', "max_tokens", 10, 10)));
    const result = await callLLM({
      config: { provider: "anthropic", apiKey: "sk-test", model: "claude-test",
                maxTokensCeiling: 1000 },
      systemPrompt: "s", userMessage: "u", maxTokens: 1000,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(true);
  });

  it("gives up after truncationRetries and returns the last attempt stamped", async function() {
    globalThis.fetch.mockResolvedValue(mockJsonResponse(
      anthropicJson('{"a":{"b":', "max_tokens", 10, 10)));
    const result = await callLLM({
      config: { provider: "anthropic", apiKey: "sk-test", model: "claude-test",
                truncationRetries: 2 },
      systemPrompt: "s", userMessage: "u", maxTokens: 100,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);   // 1 + 2 retries
    expect(result.truncated).toBe(true);
    expect(result._truncationRetries).toBe(2);
    // extractJSON remains the final backstop for this stamped result —
    // the stage error message flow is unchanged in the worst case.
  });

  it("backstop: retries when stop reason is missing but the JSON looks cut", async function() {
    globalThis.fetch
      .mockResolvedValueOnce(mockJsonResponse(
        anthropicJson('{"x":{"y":1', null, 5, 5)))
      .mockResolvedValueOnce(mockJsonResponse(
        anthropicJson('{"x":{"y":1}}', "end_turn", 5, 9)));
    const result = await callLLM({
      config: { provider: "anthropic", apiKey: "sk-test", model: "claude-test" },
      systemPrompt: "s", userMessage: "u", maxTokens: 500,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('{"x":{"y":1}}');
  });

  it("eos-mid-json: clean 'stop' with unbalanced JSON IS retried (local models do this)", async function() {
    // LM Studio / Ollama can emit EOS mid-JSON (or clamp at the server's own
    // context limit while still reporting 'stop'). A resample retry often
    // recovers — and is the difference between self-healing and the user
    // staring at a TRUNCATED OUTPUT error.
    globalThis.fetch
      .mockResolvedValueOnce(mockJsonResponse(anthropicJson('{"oops":{', "end_turn", 5, 5)))
      .mockResolvedValueOnce(mockJsonResponse(anthropicJson('{"oops":{"ok":1}}', "end_turn", 5, 8)));
    const result = await callLLM({
      config: { provider: "anthropic", apiKey: "sk-test", model: "claude-test" },
      systemPrompt: "s", userMessage: "u", maxTokens: 500,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('{"oops":{"ok":1}}');
    expect(result.truncated).toBeUndefined();
  });

  it("parseable output is never treated as truncated, whatever the brace count", async function() {
    // Braces inside string values (SV concatenations in {"code": …}) must
    // not false-positive — the parse pre-check in looksTruncatedJSON.
    globalThis.fetch.mockResolvedValue(mockJsonResponse(
      anthropicJson('{"code":"assign y = {a, b, {c}};"}', "end_turn", 5, 5)));
    const result = await callLLM({
      config: { provider: "anthropic", apiKey: "sk-test", model: "claude-test" },
      systemPrompt: "s", userMessage: "u", maxTokens: 500,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBeUndefined();
  });

  it("perturbs a pinned sampling seed on retries (seeded retries are identical otherwise)", async function() {
    globalThis.fetch
      .mockResolvedValueOnce(mockJsonResponse(anthropicJson('{"a":{', "max_tokens", 5, 5)))
      .mockResolvedValueOnce(mockJsonResponse(anthropicJson('{"a":{}}', "end_turn", 5, 5)));
    await callLLM({
      // openai provider so `seed` lands in the request body
      config: { provider: "openai", apiKey: "sk-test", model: "gpt-test", seed: 42 },
      systemPrompt: "s", userMessage: "u", maxTokens: 500,
    });
    const body1 = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    const body2 = JSON.parse(globalThis.fetch.mock.calls[1][1].body);
    expect(body1.seed).toBe(42);
    expect(body2.seed).toBe(43);   // nudged so the retry can actually differ
  });

  it("diagnoses provider-limit when a larger cap doesn't lengthen the output", async function() {
    // Same-length cut output despite a doubled cap = the request cap was
    // never the binding constraint; the server (context window / its own
    // output limit) is. The stamped cause flips extractJSON's advice from
    // 'raise Max Tokens' to 'fix the context length'.
    const cutText = '{"requirements":[{"id":"R1"';
    globalThis.fetch.mockResolvedValue(mockJsonResponse(
      anthropicJson(cutText, "max_tokens", 10, 10)));
    const result = await callLLM({
      config: { provider: "anthropic", apiKey: "sk-test", model: "claude-test",
                truncationRetries: 2 },
      systemPrompt: "s", userMessage: "u", maxTokens: 1000,
    });
    expect(result.truncated).toBe(true);
    expect(result.truncationCause).toBe("provider-limit");
    expect(result.maxTokensRequested).toBe(4000);  // 1000 → 2000 → 4000
  });
});

describe("extractJSON truncation provenance", function() {
  it("folds callLLM meta into the TRUNCATED error with cause-aware advice", async function() {
    const { extractJSON } = await import("../src/llm/extractJSON.js");
    const meta = {
      stopReason: "max_tokens", maxTokensRequested: 4000,
      _truncationRetries: 2, truncationCause: "provider-limit",
    };
    let msg = "";
    try { extractJSON('{"a":{"b":', meta); } catch (e) { msg = e.message; }
    expect(msg).toContain("stop reason: max_tokens");
    expect(msg).toContain("maxTokens requested: 4000");
    expect(msg).toContain("auto-recovery retries already attempted: 2");
    expect(msg).toContain("Raising Max Tokens will NOT help");
    expect(msg).toContain("context");
    // Without provider-limit cause, the classic advice remains
    let msg2 = "";
    try { extractJSON('{"a":{"b":', { stopReason: "max_tokens" }); } catch (e) { msg2 = e.message; }
    expect(msg2).toContain("Try increasing Max Tokens");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Streaming token-usage accounting — OpenAI-compatible providers (OpenAI / Groq
// / LM Studio) omit usage from streamed responses UNLESS stream_options.
// include_usage is requested. Without it every streamed call reported
// tokensIn=0, degrading cost/token accounting to char/4 estimates (the e2e
// found lint/lint_test/judge — the always-streaming stages — all at tokIn=0).
// ═══════════════════════════════════════════════════════════════════════════
function sseBody(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start: function(controller) {
      for (let i = 0; i < chunks.length; i++) {
        controller.enqueue(enc.encode("data: " + chunks[i] + "\n\n"));
      }
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

describe("callLLM streaming usage (stream_options.include_usage)", function() {
  it("openai stream request asks for usage AND captures it from the final chunk", async function() {
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      body: sseBody([
        JSON.stringify({ choices: [{ delta: { content: "hel" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
        // Final usage-only chunk (empty choices) — must not crash the reader.
        JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } }),
      ]),
    }));
    const r = await callLLM({
      provider: "openai", systemPrompt: "s", userMessage: "u",
      onChunk: function() {},                         // forces the streaming path
      config: { provider: "openai", apiKey: "k" },
    });
    // Request asked for usage
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    // Real usage captured (not the chunk-count approximation)
    expect(r.text).toBe("hello");
    expect(r.tokensIn).toBe(42);
    expect(r.tokensOut).toBe(7);
  });

  it("anthropic stream does NOT get stream_options (it streams usage natively)", async function() {
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      body: sseBody([
        JSON.stringify({ type: "message_start", message: { model: "claude", usage: { input_tokens: 11 } } }),
        JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } }),
        JSON.stringify({ type: "message_delta", usage: { output_tokens: 3 }, delta: { stop_reason: "end_turn" } }),
      ]),
    }));
    const r = await callLLM({
      provider: "anthropic", systemPrompt: "s", userMessage: "u",
      onChunk: function() {},
      config: { provider: "anthropic", apiKey: "k" },
    });
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toBeUndefined();
    expect(r.tokensIn).toBe(11);
  });
});

// ─── socket-drop resilience (measured: crashed a live CLI system run) ──────
describe("callLLM socket-drop resilience", function() {
  it("undici 'terminated' mid-stream is network-class: retried, not fatal", async function() {
    // First call: a stream that errors with undici's shape after one chunk.
    const enc = new TextEncoder();
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      body: new ReadableStream({
        start: function(controller) {
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
          controller.error(new TypeError("terminated", { cause: new Error("read ETIMEDOUT") }));
        },
      }),
    }));
    // Retry: clean full response.
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      body: sseBody([
        JSON.stringify({ choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }], model: "m" }),
      ]),
    }));
    const r = await callLLM({
      systemPrompt: "s", userMessage: "u", onChunk: function() {},
      // non-local baseUrl skips the recovery probe loop; tiny backoff keeps the test fast
      config: { provider: "lmstudio", apiKey: "k", baseUrl: "http://lm.example:1234/v1", retryBaseDelayMs: 1, maxRetries: 1 },
    });
    expect(r.text).toBe("recovered");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("a rejecting reader.cancel() on abort does not become an unhandled rejection", async function() {
    const enc = new TextEncoder();
    const ctl = new AbortController();
    let cancelRejected = false;
    const unhandled = [];
    const onUnhandled = (reason) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
        body: new ReadableStream({
          start: function(controller) {
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
            // never closes — the abort path must cancel
          },
          cancel: function() {
            cancelRejected = true;
            return Promise.reject(new TypeError("terminated"));   // undici's late socket error
          },
        }),
      }));
      const p = callLLM({
        systemPrompt: "s", userMessage: "u", onChunk: function() { ctl.abort(); },
        signal: ctl.signal,
        config: { provider: "lmstudio", apiKey: "k", baseUrl: "http://lm.example:1234/v1" },
      });
      await expect(p).rejects.toThrow(/abort/i);
      expect(cancelRejected).toBe(true);
      // let any orphaned rejection reach the process hook before asserting
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// ─── reasoning-channel fallback (measured: LM Studio + nemotron + json_schema) ─
describe("callLLM reasoning-channel fallback", function() {
  it("uses delta.reasoning_content when the content channel ends empty (streaming)", async function() {
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      body: sseBody([
        JSON.stringify({ choices: [{ delta: { reasoning_content: '{"code":"module tiny; ' } }] }),
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'endmodule"}' }, finish_reason: "stop" }], model: "nemotron" }),
      ]),
    }));
    const r = await callLLM({
      systemPrompt: "s", userMessage: "u", onChunk: function() {},
      config: { provider: "lmstudio", apiKey: "k", baseUrl: "http://lm.example:1234/v1" },
    });
    expect(r.text).toBe('{"code":"module tiny; endmodule"}');
  });

  it("content wins when BOTH channels carry text (normal reasoning model)", async function() {
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      body: sseBody([
        JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking about it…" } }] }),
        JSON.stringify({ choices: [{ delta: { content: '{"code":"real answer"}' }, finish_reason: "stop" }] }),
      ]),
    }));
    const r = await callLLM({
      systemPrompt: "s", userMessage: "u", onChunk: function() {},
      config: { provider: "lmstudio", apiKey: "k", baseUrl: "http://lm.example:1234/v1" },
    });
    expect(r.text).toBe('{"code":"real answer"}');
  });

  it("non-streaming: message.reasoning_content backfills an empty content", async function() {
    globalThis.fetch.mockResolvedValueOnce(mockFetchResponse({
      json: { choices: [{ message: { content: "", reasoning_content: '{"code":"m"}' }, finish_reason: "stop" }], model: "nemotron", usage: { prompt_tokens: 5, completion_tokens: 3 } },
    }));
    const r = await callLLM({
      systemPrompt: "s", userMessage: "u",
      config: { provider: "lmstudio", apiKey: "k", baseUrl: "http://lm.example:1234/v1" },
    });
    expect(r.text).toBe('{"code":"m"}');
  });
});
