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

  // Record/replay hooks (docs/improvement-roadmap.md #5). Both are INJECTED
  // functions on config (this module is browser-bundled — no node imports):
  //   _llmReplay(call) → result | null  — resolve from fixtures instead of the
  //     network; null/undefined means MISS and the call FAILS LOUDLY (a changed
  //     prompt is the regression signal, surfaced as a diff by the thrower).
  //   _llmTap(record)                   — observe every completed call (the
  //     recorder); best-effort, never fatal.
  if (typeof cfg._llmReplay === "function") {
    const replayed = cfg._llmReplay({
      systemPrompt: args.systemPrompt || "",
      userMessage:  args.userMessage  || "",
      model: cfg.model || "",
    });
    // A resolver may DECLINE a call it does not own by returning
    // { passthrough: true } — the call then proceeds to the real provider.
    // This is what lets one run mix tiers: an external model answers the
    // stages routed to it while the rest go to the configured provider.
    if (!replayed) {
      throw new Error("LLM REPLAY MISS — no fixture for this prompt (model=" + (cfg.model || "?")
        + "). The prompt changed since recording; re-record or bless the change.\n"
        + "userMessage head: " + String(args.userMessage || "").slice(0, 200));
    }
    if (replayed.passthrough !== true) {
      return Object.assign({
        tokensIn: 0, tokensOut: 0, latencyMs: 0,
        startedAtMs: Date.now(), endedAtMs: Date.now(),
        promptLen: (args.systemPrompt || "").length + (args.userMessage || "").length,
        systemPrompt: args.systemPrompt || "", userMessage: args.userMessage || "",
        model: cfg.model || "replay", provider: cfg.provider || "replay",
        stopReason: "stop", _replayed: true,
      }, replayed);
    }
  }

  const truncationRetries = cfg.truncationRetries != null ? cfg.truncationRetries : 2;
  const tokenCeiling = cfg.maxTokensCeiling || 16384;

  let currentMax = args.maxTokens || 4096;
  let attempt = 0;
  let retrySpendIn = 0;
  let retrySpendOut = 0;
  let prevTextLen = -1;
  let stripSchema = false;   // provider rejected response_format — stop re-sending it
  let forceNoThink = false;  // thinking-only JSON output — disable reasoning on retry

  for (;;) {
    let attemptArgs = args;
    if (attempt > 0) {
      // Seed perturbation: several stage configs pin a sampling seed for
      // reproducibility (e.g. spec uses seed 42). Re-sending the IDENTICAL
      // prompt with the identical seed to a seeded backend (LM Studio /
      // Ollama) reproduces the identical cut output — a deterministic
      // waste. Nudging the seed per attempt keeps reproducibility for the
      // first call while making retries actually different.
      let retryCfg = (cfg.seed != null)
        ? Object.assign({}, cfg, { seed: cfg.seed + attempt })
        : cfg;
      if (forceNoThink) retryCfg = Object.assign({}, retryCfg, { ollamaThink: false });
      attemptArgs = Object.assign({}, args, { maxTokens: currentMax, config: retryCfg });
    }
    if (stripSchema && attemptArgs.jsonSchema) {
      attemptArgs = Object.assign({}, attemptArgs);
      delete attemptArgs.jsonSchema;
    }
    const result = await callWithTransientRetry(attemptArgs);
    if (result._schemaUnsupported) stripSchema = true;
    // Stamp the cap this attempt ran with — extractJSON folds it into the
    // TRUNCATED error so failures are diagnosable after the fact.
    result.maxTokensRequested = currentMax;
    const cutReason = lengthCutReason(result);

    // Thinking-only output on a JSON call (run 28: laguna finished a 14k
    // thinking block with EOS and empty content — done_reason "stop", so the
    // length ladder never fired, and the fallback text was prose, not JSON;
    // under uncapped thinking, later stages burned ~20-min attempts to the
    // context wall the same way). A JSON-expecting call whose content channel
    // never engaged cannot be salvaged from reasoning text deterministically.
    // Repair: retry ONCE with reasoning disabled for this call only —
    // thinking stays on for prose stages and for calls that answer normally.
    // expectJson is stamped by callLLMJson (stages rarely pass a jsonSchema).
    if (result._thinkingFallback && (attemptArgs.jsonSchema || attemptArgs.expectJson)
        && !forceNoThink && attempt < truncationRetries) {
      retrySpendIn += result.tokensIn || 0;
      retrySpendOut += result.tokensOut || 0;
      prevTextLen = (result.text || "").length;
      attempt++;
      forceNoThink = true;
      console.warn("[callLLM] JSON call returned only thinking text ("
        + (result.text || "").length + " chars) — retrying with "
        + "think=false (retry " + attempt + "/" + truncationRetries + ")");
      continue;
    }

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
      // Recorder tap (roadmap #5) — best-effort, never fatal.
      if (typeof cfg._llmTap === "function") {
        try {
          cfg._llmTap({
            systemPrompt: args.systemPrompt || "",
            userMessage:  args.userMessage  || "",
            model: cfg.model || "", provider: cfg.provider || "",
            response: {
              text: result.text || "",
              tokensIn: result.tokensIn || 0,
              tokensOut: result.tokensOut || 0,
              stopReason: result.stopReason || null,
            },
          });
        } catch (_e) { /* recording must never affect the run */ }
      }
      return result;
    }

    // Fold the discarded attempt's spend into the running total and escalate.
    retrySpendIn += result.tokensIn || 0;
    retrySpendOut += result.tokensOut || 0;
    prevTextLen = (result.text || "").length;
    attempt++;
    // Escalation must never go BACKWARDS. maxTokensCeiling defaults to 16384,
    // which is below what a reasoning model needs: asked for 64000 and cut
    // short, `Math.min(ceiling, currentMax*2)` handed the retry 16384 — a
    // quarter of the budget that had just proved insufficient, so the retry
    // could only fail harder. Measured (run 52) while raising qwen3.8-27b's
    // rtl_generate budget past the default ceiling.
    //
    // And when the ceiling leaves no room to grow, retrying at the SAME budget
    // is not a retry, it is the same request again — minutes of local
    // inference for an outcome already observed. Stop and report the
    // truncation instead.
    const next = Math.max(currentMax, Math.min(tokenCeiling, currentMax * 2));
    if (next <= currentMax) {
      console.warn(
        "[callLLM] Output cut (" + cutReason + ") at maxTokens=" + currentMax
        + " and the ceiling (" + tokenCeiling + ") leaves no room to escalate — "
        + "returning the truncated result rather than repeating the same request.",
      );
      return result;
    }
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
// ─── local-provider circuit breaker (docs/improvement-roadmap.md #6) ─────────
//
// Measured: every `fetch failed` that killed a run correlated with LM Studio
// evicting/reloading a model under load — a RELOADING server needs 30–90 s,
// while the transient ladder (4 tries, backoff ≤ 8 s) is tuned for rate limits
// and gives up long before recovery. For LOCAL providers, a network-class
// failure triggers a cheap GET /models probe loop that waits for the server to
// come back WITHOUT consuming ladder attempts; when the server answers but the
// configured model is gone, fail fast with the actionable cause instead of a
// generic fetch error.

function isLocalBaseUrl(baseUrl) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(String(baseUrl || ""));
}

// Node's fetch (undici) enforces headersTimeout (default 300s): a request
// whose response HEADERS take >5 min is killed with a generic "fetch failed"
// while the server logs 499 "client closed". A local server that must LOAD a
// large model before answering legitimately exceeds that (measured, run 22:
// ~10-minute loads on a degraded box killed the run twice — headers only
// arrive after the load, streaming or not). For LOCAL calls, use a dedicated
// dispatcher with the header deadline disabled and a generous 10-min
// inter-chunk body timeout (not infinite — a truly hung server must still
// fail). The Agent class is reached dependency-free through the global
// dispatcher's constructor; browsers (no undici, no such timeout) and any
// lookup failure fall back to default fetch behavior.
let _localDispatcher = null;
function localFetchExtras() {
  try {
    if (typeof process === "undefined" || !process.versions || !process.versions.node) return {};
    if (!_localDispatcher) {
      // The global-dispatcher symbol is only populated once fetch() has been
      // INVOKED in this process — and the first LLM call of a run (often the
      // longest: it triggers the model load) arrives before any prior fetch.
      // Prime it with a data: URL fetch (symbol is set synchronously at call
      // time), and never cache a failed lookup: caching null here once made
      // the whole fix inert for entire processes (measured, run 22 part 3 —
      // the 499s stayed at exactly 5m01s with the dispatcher "in place").
      let g = globalThis[Symbol.for("undici.globalDispatcher.1")];
      if (!g) {
        try { fetch("data:,").catch(function() {}); } catch (_x) { /* keep g undefined */ }
        g = globalThis[Symbol.for("undici.globalDispatcher.1")];
      }
      if (g && g.constructor) {
        _localDispatcher = new g.constructor({ headersTimeout: 0, bodyTimeout: 600000 });
      }
    }
    return _localDispatcher ? { dispatcher: _localDispatcher } : {};
  } catch (_e) {
    return {};
  }
}

// Provider-correct probe endpoint + model-list extractor. Measured (runs
// 18–19): the probe hardcoded <baseUrl>/models, which works for OpenAI-compat
// servers (LM Studio's baseUrl ends in /v1) but Ollama's NATIVE base URL 404s
// it — and a 404 was treated as "still down", so both runs burned the full
// 2-minute window against a server that was up and loading. Ollama's model
// list lives at /api/tags.
function recoveryProbe(cfg) {
  const base = String(cfg.baseUrl || "").replace(/\/+$/, "");
  if (cfg.provider === "ollama") {
    return { url: base + "/api/tags", ids: (d) => (d.models || []).map((m) => m.name) };
  }
  return { url: base + "/models", ids: (d) => (d.data || []).map((m) => m.id) };
}

/** Model-id match tolerant of Ollama's implicit ":latest" tag. */
function modelListed(ids, model) {
  return ids.some((id) =>
    id === model || id === model + ":latest" || String(id).replace(/:latest$/, "") === model);
}

async function waitForLocalRecovery(cfg, signal) {
  const timeoutMs = (cfg.localRecoveryTimeoutSec != null ? cfg.localRecoveryTimeoutSec : 120) * 1000;
  if (timeoutMs <= 0) return "disabled";
  const probe = recoveryProbe(cfg);
  const start = Date.now();
  const stepMs = 10000;
  while (Date.now() - start < timeoutMs) {
    if (signal && signal.aborted) return "aborted";
    try {
      const resp = await fetch(probe.url, signal ? { signal } : undefined);
      if (resp.ok) {
        // Server is back. Is our model still loaded/listed?
        try {
          const data = await resp.json();
          const ids = probe.ids(data);
          if (ids.length > 0 && cfg.model && !modelListed(ids, cfg.model)) return "model-missing";
        } catch (_e) { /* non-JSON probe body — treat as recovered */ }
        return "recovered";
      }
      // ANY HTTP response proves the server is reachable — a 404/500 here is
      // an endpoint/path mismatch, not an outage. Return recovered and let
      // the real chat request surface the true error instead of stalling.
      return "recovered";
    } catch (_e) { /* still down — keep waiting */ }
    console.warn("[callLLM] local provider unreachable — waiting for recovery ("
      + Math.round((Date.now() - start) / 1000) + "s/" + Math.round(timeoutMs / 1000) + "s)");
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return "timeout";
}

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
      // "terminated" is undici's TypeError when the server/socket drops a
      // streaming response mid-read (its .cause carries the ETIMEDOUT/
      // ECONNRESET) — same class as the raw socket errors.
      const isNetworkClass = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket hang up|terminated/i.test(msg);
      const isRetryable = /\b(429|500|502|503|504)\b/.test(msg) || isNetworkClass;

      if (!isRetryable || attempt === maxRetries) throw e;

      // Circuit breaker: a local server that dropped the connection is most
      // likely reloading a model — stall on the probe (not the ladder) and
      // convert "model evicted" into an actionable error.
      if (isNetworkClass && isLocalBaseUrl(cfg.baseUrl)) {
        const outcome = await waitForLocalRecovery(cfg, args.signal || cfg._signal || null);
        if (outcome === "model-missing") {
          throw new Error("local provider is up but model '" + cfg.model + "' is not loaded"
            + " — it was likely evicted. Reload/pin it in the server (e.g. LM Studio) and retry.");
        }
        if (outcome === "recovered") {
          console.warn("[callLLM] local provider recovered — retrying the call");
          continue;   // does not consume the backoff delay below
        }
        // timeout/aborted/disabled → fall through to the normal ladder
      }

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

  // Structured outputs (docs/improvement-roadmap.md #1): when the caller
  // supplies args.jsonSchema and config.structuredOutputs isn't disabled, ask
  // the provider to CONSTRAIN decoding to the schema — malformed/truncated JSON
  // becomes impossible at the decoder (the measured top time sink: escalation
  // ladders + re-asks). Anthropic has no equivalent request field (extractJSON
  // remains the safety net there and everywhere).
  const jsonSchema = (args.jsonSchema && cfg.structuredOutputs !== false) ? args.jsonSchema : null;
  // Stream ALL local-provider calls, not just those with an onChunk
  // subscriber. Measured (run 22): a non-streaming /api/chat only sends
  // response HEADERS when the entire generation finishes, and Node's fetch
  // (undici) kills any request whose headers take >5 min (headersTimeout
  // default 300s) — the server logs 499 "client closed" and callLLM sees a
  // generic "fetch failed". On a degraded local box, every long review/fix
  // call died this way (and every chain-entry transport death in runs 20–21
  // traces to it). Streaming makes headers arrive immediately, so slow local
  // generations are bounded by real progress, not an arbitrary 5-minute wall.
  const useStream = !!onChunk || isLocalBaseUrl(rc.baseUrl);

  function makeReq(schema) {
    let r;
    if (provider === "anthropic")    r = buildAnthropicReq(rc, sys, usr, max);
    else if (provider === "ollama")  r = buildOllamaReq(rc, sys, usr, max, schema);
    else                              r = buildOpenAIReq(rc, sys, usr, max, schema);
    if (useStream) {
      r.body.stream = true;
      // OpenAI-compatible providers (OpenAI, Groq, LM Studio) OMIT token usage
      // from streaming responses UNLESS explicitly asked — so every streamed
      // call reported tokensIn=0 and an approximate (chunk-count) tokensOut,
      // degrading cost/token accounting to char/4 estimates. Anthropic and
      // Ollama stream usage natively, so this is only needed (and only valid)
      // for the OpenAI path. Older servers simply ignore the field.
      if (provider !== "anthropic" && provider !== "ollama") {
        r.body.stream_options = Object.assign({ include_usage: true }, r.body.stream_options);
      }
    }
    return r;
  }
  let req = makeReq(jsonSchema);

  // Wall-clock + monotonic instrumentation. We capture both:
  //   startedAtMs / endedAtMs — Date.now() wall-clock (epoch ms), for display
  //   latencyMs                — performance.now() monotonic delta (ms), for math
  // The two diverge only on system clock changes mid-call (rare).
  const t0 = performance.now();
  const startedAtMs = Date.now();
  const _extras = isLocalBaseUrl(rc.baseUrl) ? localFetchExtras() : {};
  let fetchOpts = Object.assign({ method: "POST", headers: req.headers, body: JSON.stringify(req.body) }, _extras);
  if (signal) fetchOpts.signal = signal;

  let resp = await fetch(req.url, fetchOpts);
  let schemaUnsupported = false;
  if (!resp.ok && jsonSchema && resp.status === 400) {
    // The provider rejected the schema field (older server / model without
    // grammar support). Retry ONCE unconstrained and mark the result so the
    // truncation ladder stops re-sending the schema for this call chain.
    schemaUnsupported = true;
    resp.text().catch(function() {});   // drain the failed body
    req = makeReq(null);
    fetchOpts = Object.assign({ method: "POST", headers: req.headers, body: JSON.stringify(req.body) }, _extras);
    if (signal) fetchOpts.signal = signal;
    resp = await fetch(req.url, fetchOpts);
  }
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(provider + " API " + resp.status + ": " + errText);
  }

  if (useStream && resp.body) {
    // onChunk may be absent when streaming was forced for a local provider —
    // readStream invokes it unguarded, so hand it a no-op.
    const r = await readStream(provider, resp, t0, startedAtMs, promptLen, sys, usr, rc,
      onChunk || function() {}, signal, max);
    if (schemaUnsupported) r._schemaUnsupported = true;
    return r;
  }

  // Non-streaming path
  const data = await resp.json();
  const p = req.parse(data);
  // Reasoning-channel fallback (see the streaming path above): when the
  // content is empty but the message carries reasoning_content, the answer is
  // there — reasoning models on OpenAI-compat servers (measured: LM Studio +
  // nemotron under json_schema).
  if ((!p.text || p.text.trim() === "")) {
    const _msg = (((data.choices || [])[0] || {}).message) || {};
    const _reason = _msg.reasoning_content || _msg.reasoning || "";
    if (typeof _reason === "string" && _reason.trim() !== "") {
      console.warn("[callLLM] content channel empty — using the reasoning channel ("
        + _reason.length + " chars). Reasoning model on an OpenAI-compat server.");
      p.text = _reason;
    }
  }
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
    _schemaUnsupported: schemaUnsupported || undefined,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Streaming dispatch — different formats per provider
// ───────────────────────────────────────────────────────────────────────────

async function readStream(provider, resp, t0, startedAtMs, promptLen, sys, usr, rc, onChunk, signal, maxOut) {
  let fullText = "";
  let ttft = 0;
  let chunkCount = 0;
  let tokensOut = 0;
  let tokensIn = 0;
  let modelName = rc.model;
  let stopReason = null;
  // Set when the Ollama thinking-channel fallback substitutes reasoning text
  // for an empty content channel — the ladder uses it to retry JSON calls
  // with reasoning disabled (run 28: laguna emitted EOS at the end of a 14k
  // thinking block and never wrote content, so stopReason was "stop" and no
  // retry fired; the fallback text was prose, and the JSON stage halted).
  let usedThinkingFallback = false;

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
    // Thinking-channel accumulator (measured: run 27, laguna-s-2.1). Thinking
    // models stream reasoning as message.thinking deltas; when num_predict is
    // exhausted mid-think, message.content never arrives and fullText ends
    // empty. Accumulated separately and used only when the content channel
    // ends empty — models that think AND answer normally are untouched.
    let thinkingText = "";
    // Content-only token cap (measured: run 27 → maxThinkingTokens design).
    // With thinking active the provider raised (or removed) num_predict so
    // reasoning can't starve the answer; the flip side is that WE must cap
    // the answer here. Ollama streams ~one token per NDJSON message, so the
    // content-chunk count approximates content tokens — the same
    // approximation tokensOut already uses. thinkCap aborts a runaway
    // thinker that exhausts its budget before any content arrives (models
    // think first, then answer — once content flows, thinking is over).
    const thinkActive = rc.ollamaThink !== false;
    const contentCap = (thinkActive && maxOut > 0) ? maxOut : Infinity;
    const thinkCap = (thinkActive && rc.maxThinkingTokens != null)
      ? rc.maxThinkingTokens : Infinity;
    let thinkChunks = 0;
    let clamped = false;
    while (true) {
      if (signal && signal.aborted) {
        // cancel() returns a promise; a later socket error rejects it
        // asynchronously — leave a handler or the rejection kills Node.
        try { reader.cancel().catch(() => {}); } catch (_) {}
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
          if (obj.message && obj.message.thinking) { thinkingText += obj.message.thinking; thinkChunks++; }
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
          if (chunkCount >= contentCap || (chunkCount === 0 && thinkChunks >= thinkCap)) {
            clamped = true;
            break;
          }
        } catch (_) { /* skip bad line */ }
      }
      if (clamped) {
        // Cancelling drops the final done message, so eval_count never
        // arrives: report all generated tokens (content + thinking) as
        // tokensOut so spend accounting stays honest; tokensIn falls back
        // to the promptLen char/4 estimate downstream. "length" keeps the
        // truncation ladder's semantics — the answer (or the thinking
        // budget) hit OUR cap, and a retry with a raised cap may recover.
        stopReason = "length";
        tokensOut = chunkCount + thinkChunks;
        try { reader.cancel().catch(() => {}); } catch (_) {}
        break;
      }
    }
    if (fullText.trim() === "" && thinkingText.trim() !== "") {
      console.warn("[callLLM] content channel empty — using the thinking channel ("
        + thinkingText.length + " chars). Thinking-capable Ollama model; set "
        + "config ollamaThink=false to disable reasoning.");
      fullText = thinkingText;
      usedThinkingFallback = true;
    }
  } else {
    // OpenAI / Groq SSE
    // Reasoning-channel accumulator (measured: LM Studio + nemotron under
    // response_format json_schema emits the ENTIRE valid JSON in
    // delta.reasoning_content and leaves delta.content empty — the answer
    // exists, just on the wrong channel). Accumulated separately and used
    // only when the content channel ends empty, so models that reason AND
    // answer normally are untouched.
    let reasoningText = "";
    await readSSE(resp, (evt) => {
      const delta = ((evt.choices || [])[0] || {}).delta || {};
      if (delta.reasoning_content) reasoningText += delta.reasoning_content;
      else if (delta.reasoning) reasoningText += delta.reasoning;
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
    if (fullText.trim() === "" && reasoningText.trim() !== "") {
      console.warn("[callLLM] content channel empty — using the reasoning channel ("
        + reasoningText.length + " chars). Reasoning model on an OpenAI-compat server.");
      fullText = reasoningText;
    }
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
    _thinkingFallback: usedThinkingFallback || undefined,
  };
}
