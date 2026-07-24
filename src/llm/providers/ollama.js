// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// providers/ollama — Ollama /api/chat request builder
// Streaming uses newline-delimited JSON (NDJSON), not SSE.
// ═══════════════════════════════════════════════════════════════════════════

export function buildOllamaReq(cfg, sys, usr, max, jsonSchema) {
  const opts = { num_predict: max };
  // Context window. Without an explicit num_ctx, Ollama 0.30.x applies a ~4k
  // request default regardless of the model's capability and SILENTLY drops
  // the front of longer prompts (measured: run 18). Default 32768 via config;
  // ollamaNumCtx: 0 omits the field (defer to the model/server default, e.g.
  // a Modelfile-baked window).
  const numCtx = cfg.ollamaNumCtx == null ? 32768 : cfg.ollamaNumCtx;
  if (numCtx > 0) opts.num_ctx = numCtx;
  if (cfg.temperature != null) opts.temperature = cfg.temperature;
  if (cfg.top_p != null)       opts.top_p       = cfg.top_p;
  if (cfg.top_k != null)       opts.top_k       = cfg.top_k;
  if (cfg.seed != null)        opts.seed        = cfg.seed;

  const body = {
    model: cfg.model || "qwen2.5-coder:32b",
    stream: false,
    messages: [
      { role: "system", content: sys },
      { role: "user",   content: usr },
    ],
    options: opts,
  };
  // Structured outputs (docs/improvement-roadmap.md #1): Ollama ≥0.5 accepts a
  // JSON schema in `format` and constrains decoding to it.
  if (jsonSchema) body.format = jsonSchema.schema || jsonSchema;
  // Reasoning channel (measured: run 27, laguna-s-2.1). Thinking-capable
  // models route reasoning to message.thinking; under a num_predict cap the
  // whole budget can go to thinking and content arrives EMPTY. false disables
  // reasoning server-side, true/"low"/"high" forces or tunes it. null/undefined
  // omits the field — Ollama rejects `think` on models without the capability.
  if (cfg.ollamaThink != null) body.think = cfg.ollamaThink;

  return {
    url: (cfg.baseUrl || "http://localhost:11434") + "/api/chat",
    headers: { "Content-Type": "application/json" },
    body: body,
    parse(d) {
      const msg = d.message || {};
      // Thinking-channel backfill, mirroring the OpenAI reasoning_content
      // fallback: use content when present, else the thinking text.
      const text = (msg.content || "").trim() !== "" ? msg.content
                 : (msg.thinking || "");
      return {
        text: text,
        tokensIn:  d.prompt_eval_count || 0,
        tokensOut: d.eval_count        || 0,
        model: d.model || cfg.model,
      };
    },
  };
}
