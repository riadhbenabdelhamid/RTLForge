// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// callLLM — Main LLM dispatch with streaming and two retry layers
// Routes to provider builder, handles streaming for all 3 modes.
//
// Layer 1 (callWithTransientRetry): transient transport failures — 429/5xx,
//   network errors — with exponential backoff. The call itself failed;
//   nothing was produced.
//
// Layer 2 (callLLM): TRUNCATION recovery. The call SUCCEEDED but the output
//   was cut by the stage's maxTokens cap. Every provider reports this
//   (anthropic stop_reason "max_tokens", openai/groq finish_reason "length",
//   ollama done_reason "length"); we re-issue the call with a doubled token
//   cap instead of handing broken JSON to the pipeline — which previously
//   surfaced as "JSON parse failed: TRUNCATED OUTPUT … Try increasing Max
//   Tokens" and made the USER do the retry by hand. extractJSON's error
//   remains the final backstop when escalation runs out.
// ═══════════════════════════════════════════════════════════════════════════

import { PROVIDERS } from "../constants/providers.js";
import { readSSE } from "./sse.js";
import { looksTruncatedJSON } from "./extractJSON.js";
import { buildAnthropicReq } from "./providers/anthropic.js";
import { buildOpenAIReq }    from "./providers/openai.js";
import { buildOllamaReq }    from "./providers/ollama.js";

/**
 * Classify whether a successful result was cut short. Returns a reason
 * string (for logs/diagnosis) or null when the output looks complete.
 *
 *   "length-cap"     — the provider explicitly reported a token-cap cut
 *   "no-stop-reason" — stop reason missing (proxy dropped it) AND the
 *                      output looks like cut-off JSON
 *   "eos-mid-json"   — explicit clean "stop" but the JSON is unparseable
 *                      with unbalanced braces. Local models (LM Studio /
 *                      Ollama) genuinely do this: the model emits EOS in
 *                      the middle of a long JSON object, or the server
 *                      clamps output at its own context limit while still
 *                      reporting "stop". A resample retry often recovers —
 *                      and is the difference between self-healing and the
 *                      user staring at a TRUNCATED OUTPUT error.
 *
 * looksTruncatedJSON parse-checks first, so balanced-but-odd output and
 * non-JSON prose never trigger a retry.
 */
function lengthCutReason(result) {
  const sr = String(result.stopReason || "").toLowerCase();
  if (sr === "max_tokens" || sr === "length") return "length-cap";
  if (!result.stopReason) {
    return looksTruncatedJSON(result.text || "") ? "no-stop-reason" : null;
  }
  return looksTruncatedJSON(result.text || "") ? "eos-mid-json" : null;
}

/**
 * Truncation-aware dispatch. Config knobs (both optional):
 *   truncationRetries — extra attempts with a raised cap (default 2)
 *   maxTokensCeiling  — escalation never exceeds this (default 16384);
 *                       a cap on OUR ladder, not the provider's own limit
 *
 * Token accounting: discarded truncated attempts DID consume tokens, so
 * their tokensIn/tokensOut are folded into the returned result (the ledger
 * and the run-budget guard must see real spend). `_truncationRetries`
 * records how many escalations happened; `truncated: true` is stamped when
 * even the final attempt was cut — extractJSON will then fail with its
 * actionable message, exactly as before this layer existed.
 */
export async function callLLM(args) {
  const cfg = args.config || {};
  const truncationRetries = cfg.truncationRetries != null ? cfg.truncationRetries : 2;
  const tokenCeiling = cfg.maxTokensCeiling || 16384;

  let currentMax = args.maxTokens || 4096;
  let attempt = 0;
  let retrySpendIn = 0;
  let retrySpendOut = 0;
  let prevTextLen = -1;

  for (;;) {
    let attemptArgs = args;
    if (attempt > 0) {
      // Seed perturbation: several stage configs pin a sampling seed for
      // reproducibility (e.g. spec uses seed 42). Re-sending the IDENTICAL
      // prompt with the identical seed to a seeded backend (LM Studio /
      // Ollama) reproduces the identical cut output — a deterministic
      // waste. Nudging the seed per attempt keeps reproducibility for the
      // first call while making retries actually different.
      const retryCfg = (cfg.seed != null)
        ? Object.assign({}, cfg, { seed: cfg.seed + attempt })
        : cfg;
      attemptArgs = Object.assign({}, args, { maxTokens: currentMax, config: retryCfg });
    }
    const result = await callWithTransientRetry(attemptArgs);
    // Stamp the cap this attempt ran with — extractJSON folds it into the
    // TRUNCATED error so failures are diagnosable after the fact.
    result.maxTokensRequested = currentMax;
    const cutReason = lengthCutReason(result);

    if (!cutReason || attempt >= truncationRetries || currentMax >= tokenCeiling) {
      if (retrySpendIn > 0 || retrySpendOut > 0) {
        result.tokensIn = (result.tokensIn || 0) + retrySpendIn;
        result.tokensOut = (result.tokensOut || 0) + retrySpendOut;
        result._truncationRetries = attempt;
      }
      if (cutReason) {
        result.truncated = true;
        // Root-cause inference for the final error message: if a retry with
        // a LARGER cap produced essentially the same amount of text, the
        // request cap was never the binding constraint — the server is
        // clamping (model context exhausted, or a server-side output
        // limit). Raising Max Tokens in Settings cannot fix that, and the
        // error should say so instead of sending the user in circles.
        const len = (result.text || "").length;
        result.truncationCause =
          (attempt > 0 && prevTextLen >= 0 && len <= prevTextLen * 1.1)
            ? "provider-limit"
            : "max-tokens";
      }
      return result;
    }

    // Fold the discarded attempt's spend into the running total and escalate.
    retrySpendIn += result.tokensIn || 0;
    retrySpendOut += result.tokensOut || 0;
    prevTextLen = (result.text || "").length;
    attempt++;
    const next = Math.min(tokenCeiling, currentMax * 2);
    console.warn(
      "[callLLM] Output cut (" + cutReason + ", stopReason="
      + (result.stopReason || "unreported") + ") at maxTokens=" + currentMax
      + " — retrying with maxTokens=" + next
      + (cfg.seed != null ? ", seed=" + (cfg.seed + attempt) : "")
      + " (truncation retry " + attempt + "/" + truncationRetries + ")",
    );
    currentMax = next;
  }
}

/**
 * Retry wrapper around callLLMOnce.
 * Retries on transient errors (429, 500, 502, 503, 504, network failures).
 * Never retries on AbortError or auth/4xx errors.
 * Exponential backoff: 2s, 4s, 8s + jitter.
 */
async function callWithTransientRetry(args) {
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
