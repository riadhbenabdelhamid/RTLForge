// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// providers/anthropic — Anthropic Messages API request builder
// ═══════════════════════════════════════════════════════════════════════════

export function buildAnthropicReq(cfg, sys, usr, max) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) {
    headers["x-api-key"] = cfg.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }

  const body = {
    model: cfg.model || "claude-sonnet-4-20250514",
    max_tokens: max,
    system: sys,
    messages: [{ role: "user", content: usr }],
  };
  if (cfg.temperature != null) body.temperature = cfg.temperature;
  if (cfg.top_p != null) body.top_p = cfg.top_p;
  if (cfg.top_k != null) body.top_k = cfg.top_k;

  return {
    url: (cfg.baseUrl || "https://api.anthropic.com") + "/v1/messages",
    headers,
    body,
    parse(d) {
      const text = (d.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      // With prompt caching enabled, `input_tokens` reports only the un-cached
      // portion (often 0 on a cache hit). Sum in the cache_read + cache_creation
      // fields so the reported value reflects the full input consumed.
      const u = d.usage || {};
      return {
        text,
        tokensIn:  (u.input_tokens || 0)
                 + (u.cache_read_input_tokens || 0)
                 + (u.cache_creation_input_tokens || 0),
        tokensOut: u.output_tokens || 0,
        model: d.model || cfg.model,
      };
    },
  };
}
