// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Structured outputs (docs/improvement-roadmap.md #1): schema-constrained JSON
// decoding — builders, kill-switch, and the 400-fallback.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildOpenAIReq } from "../src/llm/providers/openai.js";
import { buildOllamaReq } from "../src/llm/providers/ollama.js";
import { callLLMOnce } from "../src/llm/callLLM.js";
import { CODE_SCHEMA, FIX_SCHEMA } from "../src/prompts/schemas.js";

const CFG = { model: "m", baseUrl: "http://x/v1" };

describe("provider builders", () => {
  it("openai-compat emits response_format json_schema when a schema is given", () => {
    const r = buildOpenAIReq(CFG, "s", "u", 100, CODE_SCHEMA);
    expect(r.body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "sv_code", strict: false, schema: CODE_SCHEMA.schema },
    });
  });
  it("openai-compat body is byte-identical without a schema (no-regression)", () => {
    const a = JSON.stringify(buildOpenAIReq(CFG, "s", "u", 100).body);
    const b = JSON.stringify(buildOpenAIReq(CFG, "s", "u", 100, null).body);
    expect(b).toBe(a);
    expect(a).not.toMatch(/response_format/);
  });
  it("ollama emits format: <schema>", () => {
    const r = buildOllamaReq(CFG, "s", "u", 100, FIX_SCHEMA);
    expect(r.body.format).toBe(FIX_SCHEMA.schema);
    expect(JSON.stringify(buildOllamaReq(CFG, "s", "u", 100).body)).not.toMatch(/"format"/);
  });
});

describe("callLLMOnce schema behavior (stubbed fetch)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function okResponse(text) {
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
        model: "m",
      }),
    };
  }

  it("sends the schema for lmstudio and parses normally", async () => {
    const bodies = [];
    vi.stubGlobal("fetch", async (url, opts) => { bodies.push(JSON.parse(opts.body)); return okResponse('{"code":"x"}'); });
    const r = await callLLMOnce({
      systemPrompt: "s", userMessage: "u", maxTokens: 64,
      jsonSchema: CODE_SCHEMA,
      config: { provider: "lmstudio", model: "m", baseUrl: "http://x/v1" },
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].response_format.json_schema.name).toBe("sv_code");
    expect(r.text).toBe('{"code":"x"}');
    expect(r._schemaUnsupported).toBeUndefined();
  });

  it("config.structuredOutputs === false strips the schema (kill-switch)", async () => {
    const bodies = [];
    vi.stubGlobal("fetch", async (url, opts) => { bodies.push(JSON.parse(opts.body)); return okResponse("t"); });
    await callLLMOnce({
      systemPrompt: "s", userMessage: "u", maxTokens: 64,
      jsonSchema: CODE_SCHEMA,
      config: { provider: "lmstudio", model: "m", baseUrl: "http://x/v1", structuredOutputs: false },
    });
    expect(bodies[0].response_format).toBeUndefined();
  });

  it("a 400 on the schema retries ONCE unconstrained and stamps _schemaUnsupported", async () => {
    const bodies = [];
    let call = 0;
    vi.stubGlobal("fetch", async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      call++;
      if (call === 1) return { ok: false, status: 400, text: async () => "response_format not supported" };
      return okResponse('{"code":"y"}');
    });
    const r = await callLLMOnce({
      systemPrompt: "s", userMessage: "u", maxTokens: 64,
      jsonSchema: CODE_SCHEMA,
      config: { provider: "lmstudio", model: "m", baseUrl: "http://x/v1" },
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].response_format).toBeDefined();     // first try constrained
    expect(bodies[1].response_format).toBeUndefined();   // retry unconstrained
    expect(r._schemaUnsupported).toBe(true);
    expect(r.text).toBe('{"code":"y"}');
  });

  it("a non-400 failure still throws (fallback is 400-specific)", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, text: async () => "boom" }));
    await expect(callLLMOnce({
      systemPrompt: "s", userMessage: "u", maxTokens: 64,
      jsonSchema: CODE_SCHEMA,
      config: { provider: "lmstudio", model: "m", baseUrl: "http://x/v1" },
    })).rejects.toThrow(/500/);
  });
});
