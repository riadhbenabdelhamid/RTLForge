// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// providers/ollama — Ollama /api/chat request builder
// Streaming uses newline-delimited JSON (NDJSON), not SSE.
// ═══════════════════════════════════════════════════════════════════════════

export function buildOllamaReq(cfg, sys, usr, max) {
  const opts = { num_predict: max };
  if (cfg.temperature != null) opts.temperature = cfg.temperature;
  if (cfg.top_p != null)       opts.top_p       = cfg.top_p;
  if (cfg.top_k != null)       opts.top_k       = cfg.top_k;
  if (cfg.seed != null)        opts.seed        = cfg.seed;

  return {
    url: (cfg.baseUrl || "http://localhost:11434") + "/api/chat",
    headers: { "Content-Type": "application/json" },
    body: {
      model: cfg.model || "qwen2.5-coder:32b",
      stream: false,
      messages: [
        { role: "system", content: sys },
        { role: "user",   content: usr },
      ],
      options: opts,
    },
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
