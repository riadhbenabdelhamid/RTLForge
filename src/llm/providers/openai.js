// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// providers/openai — OpenAI/Groq chat completions request builder
// Used for both api.openai.com and api.groq.com (compatible APIs)
// ═══════════════════════════════════════════════════════════════════════════

export function buildOpenAIReq(cfg, sys, usr, max, jsonSchema) {
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
  // Structured outputs (docs/improvement-roadmap.md #1): constrain decoding to
  // a JSON schema. LM Studio ≥0.3 / llama.cpp enforce it at the decoder —
  // malformed/truncated JSON becomes impossible; OpenAI validates it. `strict`
  // comes from the schema def (false by default for maximum server
  // compatibility — llama.cpp grammar-constrains regardless).
  if (jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name:   jsonSchema.name || "response",
        strict: jsonSchema.strict === true,
        schema: jsonSchema.schema || jsonSchema,
      },
    };
  }

  // Provider-specific fields, merged last so a caller can reach a knob this
  // builder does not model — `reasoning_effort`, or llama.cpp/LM Studio's
  // `chat_template_kwargs: {enable_thinking: false}` for Qwen3. Merged after
  // the fields above so an explicit override wins, but `model` and `messages`
  // are restored: overwriting those would silently retarget the request.
  if (cfg.extraBody && typeof cfg.extraBody === "object") {
    Object.assign(body, cfg.extraBody, { model: body.model, messages: body.messages });
  }

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
