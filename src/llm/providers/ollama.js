// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// providers/ollama — Ollama /api/chat request builder
// Streaming uses newline-delimited JSON (NDJSON), not SSE.
// ═══════════════════════════════════════════════════════════════════════════

export function buildOllamaReq(cfg, sys, usr, max, jsonSchema) {
  const opts = { num_predict: max };
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

  return {
    url: (cfg.baseUrl || "http://localhost:11434") + "/api/chat",
    headers: { "Content-Type": "application/json" },
    body: body,
    parse(d) {
      return {
        text: (d.message || {}).content || "",
        tokensIn:  d.prompt_eval_count || 0,
        tokensOut: d.eval_count        || 0,
        model: d.model || cfg.model,
      };
    },
  };
}
