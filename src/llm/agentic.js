// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// llm/agentic — provider-agnostic tool-use turn for `rtlforge ask` (Slice A #21)
//
// The pipeline's callLLM layer is text-only; the `ask` agentic loop needs
// tool-use, whose wire protocol differs across providers. This module is the
// single translation point. The CANONICAL internal tool shape is the
// Anthropic-style `{ name, description, input_schema }` ask.js already
// declares — so the tool definitions never change; we translate to/from each
// provider here.
//
// Split into PURE builders/parsers (unit-testable, no network) and a thin
// agenticTurn() that does fetch + parse:
//
//   toProviderTools(provider, tools)
//   buildAgenticRequest(provider, { config, system, tools, messages, maxTokens })
//                                              → { url, headers, body }
//   parseAgenticResponse(provider, json)       → { text, toolCalls, assistantMsg }
//   encodeToolResults(provider, results)       → message(s) to append
//   agenticTurn(args)                          → { text, toolCalls, assistantMsg }
//
// The message history is kept PROVIDER-NATIVE by the caller: it appends the
// returned `assistantMsg` and the `encodeToolResults` output, so the next
// request's `messages` are already in that provider's shape. An initial
// `{ role:"user", content:"<text>" }` is valid for all three providers.
//
// Non-streaming (matching today's `ask`). A model that ignores `tools` simply
// returns text with no toolCalls → the loop ends gracefully.
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_BASE = {
  anthropic: "https://api.anthropic.com",
  openai:    "https://api.openai.com/v1",
  ollama:    "http://localhost:11434",
};

function safeParseJSON(s) {
  if (s == null) return {};
  if (typeof s === "object") return s;           // Ollama may hand back an object
  try { return JSON.parse(s); } catch (_e) { return {}; }
}

/** Canonical Anthropic-shaped tool defs → the provider's tool schema. */
export function toProviderTools(provider, tools) {
  const list = Array.isArray(tools) ? tools : [];
  if (provider === "anthropic") return list;     // identity — canonical IS anthropic
  // OpenAI and Ollama share the function-calling shape.
  return list.map(function(t) {
    return {
      type: "function",
      function: {
        name:        t.name,
        description: t.description,
        parameters:  t.input_schema || { type: "object", properties: {} },
      },
    };
  });
}

/**
 * Build the HTTP request for one agentic turn. Pure — no network. `messages`
 * is the provider-native history; `system` is supplied separately and folded
 * in per the provider's convention.
 */
export function buildAgenticRequest(provider, args) {
  const a = args || {};
  const cfg = a.config || {};
  const baseUrl = cfg.baseUrl || DEFAULT_BASE[provider];
  const maxTokens = a.maxTokens || 2048;
  const tools = toProviderTools(provider, a.tools);
  const messages = Array.isArray(a.messages) ? a.messages : [];

  if (provider === "anthropic") {
    const headers = { "content-type": "application/json" };
    if (cfg.apiKey) { headers["x-api-key"] = cfg.apiKey; headers["anthropic-version"] = "2023-06-01"; }
    return {
      url: baseUrl + "/v1/messages",
      headers: headers,
      body: {
        model: cfg.model,
        system: a.system,
        max_tokens: maxTokens,
        tools: tools,
        messages: messages,
      },
    };
  }

  if (provider === "ollama") {
    return {
      url: baseUrl + "/api/chat",
      headers: { "content-type": "application/json" },
      body: {
        model: cfg.model,
        messages: [{ role: "system", content: a.system }].concat(messages),
        tools: tools,
        stream: false,
      },
    };
  }

  // openai (and OpenAI-compatible: groq, etc.)
  const headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = "Bearer " + cfg.apiKey;
  return {
    url: baseUrl + "/chat/completions",
    headers: headers,
    body: {
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: a.system }].concat(messages),
      tools: tools,
      tool_choice: "auto",
    },
  };
}

/**
 * Normalize a provider's raw JSON response into a common shape:
 *   text         — assistant prose (may be "")
 *   toolCalls    — [{ id, name, input }] (input always an object)
 *   assistantMsg — the provider-shaped assistant entry to push back into history
 */
export function parseAgenticResponse(provider, json) {
  const d = json || {};

  if (provider === "anthropic") {
    const blocks = Array.isArray(d.content) ? d.content : [];
    const text = blocks.filter(function(b) { return b.type === "text"; })
      .map(function(b) { return b.text; }).join("\n");
    const toolCalls = blocks.filter(function(b) { return b.type === "tool_use"; })
      .map(function(b) { return { id: b.id, name: b.name, input: b.input || {} }; });
    return { text: text, toolCalls: toolCalls, assistantMsg: { role: "assistant", content: blocks } };
  }

  // openai / ollama both nest the assistant turn under a message object.
  const msg = provider === "ollama"
    ? (d.message || {})
    : (((d.choices || [])[0] || {}).message || {});
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls = rawCalls.map(function(tc, i) {
    const fn = tc.function || {};
    return {
      id:    tc.id || ("call_" + i),       // Ollama omits ids — synthesize a stable one
      name:  fn.name,
      input: safeParseJSON(fn.arguments),  // OpenAI: JSON string · Ollama: object-or-string
    };
  });
  return { text: msg.content || "", toolCalls: toolCalls, assistantMsg: msg };
}

/**
 * Encode executed tool results into the message(s) to append for the next
 * turn. `results`: [{ id, name, output }] where output is a string.
 */
export function encodeToolResults(provider, results) {
  const list = Array.isArray(results) ? results : [];
  if (provider === "anthropic") {
    return [{
      role: "user",
      content: list.map(function(r) {
        return { type: "tool_result", tool_use_id: r.id, content: r.output };
      }),
    }];
  }
  if (provider === "ollama") {
    // Ollama has no tool_call_id; tool_name helps newer models correlate.
    return list.map(function(r) {
      return { role: "tool", tool_name: r.name, content: r.output };
    });
  }
  // openai
  return list.map(function(r) {
    return { role: "tool", tool_call_id: r.id, content: r.output };
  });
}

/**
 * Run one agentic turn against the configured provider. Throws on a non-OK
 * HTTP response (parity with the previous Anthropic-only path).
 *
 * @param {object} args { provider, config, system, tools, messages, signal, maxTokens }
 * @returns {Promise<{ text, toolCalls, assistantMsg }>}
 */
export async function agenticTurn(args) {
  const a = args || {};
  const provider = a.provider || (a.config && a.config.provider);
  const req = buildAgenticRequest(provider, a);
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal: a.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(function() { return ""; });
    throw new Error(provider + " API " + res.status + ": " + String(text).slice(0, 400));
  }
  const json = await res.json();
  return parseAgenticResponse(provider, json);
}
