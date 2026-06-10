// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// providers/openai — OpenAI/Groq chat completions request builder
// Used for both api.openai.com and api.groq.com (compatible APIs)
// ═══════════════════════════════════════════════════════════════════════════

export function buildOpenAIReq(cfg, sys, usr, max) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["Authorization"] = "Bearer " + cfg.apiKey;

  const body = {
    model: cfg.model,
    max_tokens: max,
    messages: [
      { role: "system", content: sys },
      { role: "user",   content: usr },
    ],
  };
  if (cfg.temperature != null) body.temperature = cfg.temperature;
  if (cfg.top_p != null)       body.top_p       = cfg.top_p;
  if (cfg.seed != null)        body.seed        = cfg.seed;

  return {
    url: (cfg.baseUrl || "https://api.openai.com/v1") + "/chat/completions",
    headers,
    body,
    parse(d) {
      const c = (d.choices || [])[0] || {};
      const u = d.usage || {};
      return {
        text: (c.message || {}).content || "",
        tokensIn:  u.prompt_tokens     || 0,
        tokensOut: u.completion_tokens || 0,
        model: d.model || cfg.model,
      };
    },
  };
}
