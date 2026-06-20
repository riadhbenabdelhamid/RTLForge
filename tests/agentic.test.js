// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Slice A (platform polish #21): provider-agnostic tool-use for `rtlforge ask`.
// Pure translation layer — no network. "Parity" is made falsifiable here.

import { describe, it, expect } from "vitest";
import {
  toProviderTools, buildAgenticRequest, parseAgenticResponse, encodeToolResults,
} from "../src/llm/agentic.js";

const TOOLS = [
  { name: "get_status", description: "read state",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "run_stage", description: "run a stage",
    input_schema: { type: "object", properties: { stage: { type: "string" } }, required: ["stage"] } },
];
const SYS = "you are an agent";
const MSGS = [{ role: "user", content: "hi" }];

describe("toProviderTools", () => {
  it("is identity for anthropic (canonical shape)", () => {
    expect(toProviderTools("anthropic", TOOLS)).toBe(TOOLS);
  });
  it("maps to the function shape for openai/ollama", () => {
    for (const p of ["openai", "ollama"]) {
      const out = toProviderTools(p, TOOLS);
      expect(out[0]).toEqual({
        type: "function",
        function: { name: "get_status", description: "read state", parameters: TOOLS[0].input_schema },
      });
    }
  });
});

describe("buildAgenticRequest", () => {
  it("anthropic request is byte-identical to the legacy anthropicTurn body", () => {
    const req = buildAgenticRequest("anthropic", {
      config: { model: "claude-x", apiKey: "sk-ant" }, system: SYS, tools: TOOLS, messages: MSGS,
    });
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "sk-ant",
      "anthropic-version": "2023-06-01",
    });
    expect(req.body).toEqual({
      model: "claude-x", system: SYS, max_tokens: 2048, tools: TOOLS, messages: MSGS,
    });
  });

  it("openai prepends system as a message and sends function tools + tool_choice", () => {
    const req = buildAgenticRequest("openai", {
      config: { model: "gpt-x", apiKey: "sk-oai" }, system: SYS, tools: TOOLS, messages: MSGS,
    });
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer sk-oai");
    expect(req.body.messages[0]).toEqual({ role: "system", content: SYS });
    expect(req.body.messages[1]).toEqual(MSGS[0]);
    expect(req.body.tool_choice).toBe("auto");
    expect(req.body.tools[0].type).toBe("function");
  });

  it("ollama hits /api/chat non-streaming with a baseUrl override", () => {
    const req = buildAgenticRequest("ollama", {
      config: { model: "llama3", baseUrl: "http://host:1234" }, system: SYS, tools: TOOLS, messages: MSGS,
    });
    expect(req.url).toBe("http://host:1234/api/chat");
    expect(req.body.stream).toBe(false);
    expect(req.body.messages[0].role).toBe("system");
  });
});

describe("parseAgenticResponse", () => {
  it("anthropic: text blocks + tool_use → normalized toolCalls", () => {
    const r = parseAgenticResponse("anthropic", {
      content: [
        { type: "text", text: "thinking" },
        { type: "tool_use", id: "tu_1", name: "run_stage", input: { stage: "verify" } },
      ],
    });
    expect(r.text).toBe("thinking");
    expect(r.toolCalls).toEqual([{ id: "tu_1", name: "run_stage", input: { stage: "verify" } }]);
    expect(r.assistantMsg.role).toBe("assistant");
  });

  it("openai: parses JSON-string arguments and carries the raw message back", () => {
    const msg = {
      role: "assistant", content: "",
      tool_calls: [{ id: "call_9", function: { name: "run_stage", arguments: '{"stage":"lint"}' } }],
    };
    const r = parseAgenticResponse("openai", { choices: [{ message: msg }] });
    expect(r.toolCalls).toEqual([{ id: "call_9", name: "run_stage", input: { stage: "lint" } }]);
    expect(r.assistantMsg).toBe(msg);
  });

  it("openai: malformed arguments → input {} and never throws", () => {
    const r = parseAgenticResponse("openai", {
      choices: [{ message: { tool_calls: [{ id: "c", function: { name: "x", arguments: "{not json" } }] } }],
    });
    expect(r.toolCalls[0].input).toEqual({});
  });

  it("ollama: object arguments + missing id → synthesized id", () => {
    const r = parseAgenticResponse("ollama", {
      message: { content: "ok", tool_calls: [{ function: { name: "get_status", arguments: { a: 1 } } }] },
    });
    expect(r.text).toBe("ok");
    expect(r.toolCalls[0]).toEqual({ id: "call_0", name: "get_status", input: { a: 1 } });
  });

  it("no tool calls → empty toolCalls (graceful loop end)", () => {
    expect(parseAgenticResponse("openai", { choices: [{ message: { content: "just text" } }] }).toolCalls).toEqual([]);
  });
});

describe("encodeToolResults", () => {
  const results = [{ id: "c1", name: "get_status", output: "{\"ok\":true}" }];

  it("anthropic: one user message with tool_result blocks", () => {
    expect(encodeToolResults("anthropic", results)).toEqual([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "{\"ok\":true}" }] },
    ]);
  });

  it("openai: one tool message per result with tool_call_id", () => {
    expect(encodeToolResults("openai", results)).toEqual([
      { role: "tool", tool_call_id: "c1", content: "{\"ok\":true}" },
    ]);
  });

  it("ollama: tool message with tool_name and no tool_call_id", () => {
    const out = encodeToolResults("ollama", results);
    expect(out[0]).toEqual({ role: "tool", tool_name: "get_status", content: "{\"ok\":true}" });
    expect(out[0].tool_call_id).toBeUndefined();
  });
});
