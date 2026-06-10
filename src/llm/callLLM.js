// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// callLLM — Main LLM dispatch with streaming and retry wrapper
// Routes to provider builder, handles streaming for all 3 modes,
// retries transient failures with exponential backoff.
// ═══════════════════════════════════════════════════════════════════════════

import { PROVIDERS } from "../constants/providers.js";
import { readSSE } from "./sse.js";
import { buildAnthropicReq } from "./providers/anthropic.js";
import { buildOpenAIReq }    from "./providers/openai.js";
import { buildOllamaReq }    from "./providers/ollama.js";

/**
 * Retry wrapper around callLLMOnce.
 * Retries on transient errors (429, 500, 502, 503, 504, network failures).
 * Never retries on AbortError or auth/4xx errors.
 * Exponential backoff: 2s, 4s, 8s + jitter.
 */
export async function callLLM(args) {
  const cfg = args.config || {};
  const maxRetries = cfg.maxRetries != null ? cfg.maxRetries : 3;
  const baseDelay  = cfg.retryBaseDelayMs   || 2000;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callLLMOnce(args);
    } catch (e) {
      lastError = e;
      // Never retry aborts — propagate immediately
      if (e.name === "AbortError") throw e;

      const msg = String(e.message || "");
      const isRetryable =
        /\b(429|500|502|503|504)\b/.test(msg) ||
        /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket hang up/i.test(msg);

      if (!isRetryable || attempt === maxRetries) throw e;

      const delay = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
      console.warn(
        "[callLLM] Retryable error (attempt " + (attempt + 1) + "/" + (maxRetries + 1) + "): " +
        msg.substring(0, 200) + " — retrying in " + Math.round(delay) + "ms"
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * Single-shot LLM call. Builds the request, dispatches by provider,
 * handles streaming and non-streaming paths uniformly.
 */
export async function callLLMOnce(args) {
  const sys     = args.systemPrompt || "";
  const usr     = args.userMessage  || "";
  const max     = args.maxTokens    || 4096;
  const cfg     = args.config       || {};
  const onChunk = args.onChunk      || null;
  const signal  = args.signal       || cfg._signal || null;

  // Prompt-length proxy so runMetrics can fall back to char/4 estimation when
  // the provider returns tokensIn=0 (heavily-cached responses, or providers
  // that omit usage entirely).
  const promptLen = sys.length + usr.length;

  const provider  = cfg.provider || "anthropic";
  const provEntry = PROVIDERS.find((p) => p.id === provider);
  const rc = Object.assign({}, cfg, {
    baseUrl: cfg.baseUrl || (provEntry ? provEntry.url : ""),
    model:   cfg.model   || (provEntry ? provEntry.model : ""),
  });

  let req;
  if (provider === "anthropic")    req = buildAnthropicReq(rc, sys, usr, max);
  else if (provider === "ollama")  req = buildOllamaReq(rc, sys, usr, max);
  else                              req = buildOpenAIReq(rc, sys, usr, max);

  const useStream = !!onChunk;
  if (useStream) req.body.stream = true;

  // Wall-clock + monotonic instrumentation. We capture both:
  //   startedAtMs / endedAtMs — Date.now() wall-clock (epoch ms), for display
  //   latencyMs                — performance.now() monotonic delta (ms), for math
  // The two diverge only on system clock changes mid-call (rare).
  const t0 = performance.now();
  const startedAtMs = Date.now();
  const fetchOpts = { method: "POST", headers: req.headers, body: JSON.stringify(req.body) };
  if (signal) fetchOpts.signal = signal;

  const resp = await fetch(req.url, fetchOpts);
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(provider + " API " + resp.status + ": " + errText);
  }

  if (useStream && resp.body) {
    return await readStream(provider, resp, t0, startedAtMs, promptLen, sys, usr, rc, onChunk, signal);
  }

  // Non-streaming path
  const data = await resp.json();
  const p = req.parse(data);
  const totalLatency = Math.round(performance.now() - t0);
  // Extract stop reason: Anthropic → data.stop_reason, OpenAI/Groq → choices[0].finish_reason, Ollama → data.done_reason
  const nsStopReason = data.stop_reason ||
    ((data.choices || [])[0] || {}).finish_reason ||
    data.done_reason || null;

  // BODY-VISIBILITY FIX: even when streaming is disabled (useStream=false
  // or resp.body unavailable) we still want the streaming-style log section
  // to show its body. Fire onChunk once with the final text so subscribers
  // (e.g. the pipeline log's `appendLog.stream` writer) populate their
  // section bodies. Without this, users see the section header but no
  // body — exactly the "empty RTL fix output" symptom.
  if (onChunk) {
    onChunk(p.text || "", {
      ttft: totalLatency,
      tokensOut: p.tokensOut,
      elapsed: (totalLatency / 1000).toFixed(1),
      tokPerSec: totalLatency > 0 ? (p.tokensOut / (totalLatency / 1000)).toFixed(1) : "0",
      done: true,
    });
  }

  return {
    text: p.text,
    tokensIn: p.tokensIn,
    tokensOut: p.tokensOut,
    latencyMs: totalLatency,
    // ISO-compatible wall-clock pair for the Duration tab.
    startedAtMs: startedAtMs,
    endedAtMs:   Date.now(),
    // Prompt-length proxy for char/4 fallback estimation
    promptLen: promptLen,
    // Full prompt text for the per-stage Log panel (GUI decides truncation)
    systemPrompt: sys,
    userMessage:  usr,
    model: p.model,
    provider,
    ttft: totalLatency,
    stopReason: nsStopReason,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Streaming dispatch — different formats per provider
// ───────────────────────────────────────────────────────────────────────────

async function readStream(provider, resp, t0, startedAtMs, promptLen, sys, usr, rc, onChunk, signal) {
  let fullText = "";
  let ttft = 0;
  let chunkCount = 0;
  let tokensOut = 0;
  let tokensIn = 0;
  let modelName = rc.model;
  let stopReason = null;

  if (provider === "anthropic") {
    // With prompt caching enabled, `input_tokens` reports only the uncached
    // portion. Sum in cache_read_input_tokens + cache_creation_input_tokens so
    // tokensIn reflects the full input the call consumed (cache hits otherwise
    // report 0).
    const anthInputFromUsage = function(u) {
      if (!u) return 0;
      return (u.input_tokens || 0)
        + (u.cache_read_input_tokens || 0)
        + (u.cache_creation_input_tokens || 0);
    };
    await readSSE(resp, (evt) => {
      if (evt.type === "message_start" && evt.message) {
        modelName = evt.message.model || modelName;
        if (evt.message.usage) tokensIn = anthInputFromUsage(evt.message.usage);
      }
      if (evt.type === "content_block_delta" && evt.delta && evt.delta.text) {
        if (chunkCount === 0) ttft = Math.round(performance.now() - t0);
        chunkCount++;
        fullText += evt.delta.text;
        tokensOut = chunkCount; // approximate
        const elapsed = (performance.now() - t0) / 1000;
        onChunk(fullText, {
          ttft, tokensOut, elapsed: elapsed.toFixed(1),
          tokPerSec: elapsed > 0 ? (tokensOut / elapsed).toFixed(1) : "0",
        });
      }
      if (evt.type === "message_delta") {
        if (evt.usage) {
          tokensOut = evt.usage.output_tokens || tokensOut;
          const v = anthInputFromUsage(evt.usage);
          if (v) tokensIn = v;
        }
        if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
      }
    }, signal);
  } else if (provider === "ollama") {
    // Ollama streams newline-delimited JSON
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      if (signal && signal.aborted) {
        reader.cancel();
        throw new DOMException("Aborted", "AbortError");
      }
      const result = await reader.read();
      if (result.done) break;
      buf += decoder.decode(result.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (let li = 0; li < lines.length; li++) {
        if (!lines[li].trim()) continue;
        try {
          const obj = JSON.parse(lines[li]);
          if (obj.message && obj.message.content) {
            if (chunkCount === 0) ttft = Math.round(performance.now() - t0);
            chunkCount++;
            fullText += obj.message.content;
            tokensOut = chunkCount;
            const el = (performance.now() - t0) / 1000;
            onChunk(fullText, {
              ttft, tokensOut, elapsed: el.toFixed(1),
              tokPerSec: el > 0 ? (tokensOut / el).toFixed(1) : "0",
            });
          }
          if (obj.done && obj.prompt_eval_count) tokensIn = obj.prompt_eval_count;
          if (obj.done && obj.eval_count) tokensOut = obj.eval_count;
          if (obj.done && obj.done_reason) stopReason = obj.done_reason;
          else if (obj.done) stopReason = "stop";
          modelName = obj.model || modelName;
        } catch (_) { /* skip bad line */ }
      }
    }
  } else {
    // OpenAI / Groq SSE
    await readSSE(resp, (evt) => {
      const delta = ((evt.choices || [])[0] || {}).delta || {};
      if (delta.content) {
        if (chunkCount === 0) ttft = Math.round(performance.now() - t0);
        chunkCount++;
        fullText += delta.content;
        tokensOut = chunkCount;
        const el2 = (performance.now() - t0) / 1000;
        onChunk(fullText, {
          ttft, tokensOut, elapsed: el2.toFixed(1),
          tokPerSec: el2 > 0 ? (tokensOut / el2).toFixed(1) : "0",
        });
      }
      const finishReason = ((evt.choices || [])[0] || {}).finish_reason;
      if (finishReason) stopReason = finishReason;
      if (evt.model) modelName = evt.model;
      if (evt.usage) {
        tokensIn  = evt.usage.prompt_tokens     || tokensIn;
        tokensOut = evt.usage.completion_tokens || tokensOut;
      }
    }, signal);
  }

  const totalMs = Math.round(performance.now() - t0);
  // Final update
  if (onChunk) onChunk(fullText, {
    ttft, tokensOut, elapsed: (totalMs / 1000).toFixed(1),
    tokPerSec: totalMs > 0 ? (tokensOut / (totalMs / 1000)).toFixed(1) : "0",
    done: true,
  });

  return {
    text: fullText, tokensIn, tokensOut,
    latencyMs: totalMs, model: modelName, provider,
    // Wall-clock pair for the Duration tab
    startedAtMs: startedAtMs,
    endedAtMs:   Date.now(),
    // Prompt-length proxy for fallback estimation
    promptLen: promptLen,
    // Prompt text for the per-stage Log panel
    systemPrompt: sys,
    userMessage:  usr,
    ttft, stopReason,
  };
}
