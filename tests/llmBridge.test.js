// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// llmBridge — external model in the pipeline's LLM seat. The resolver is the
// same `config._llmReplay` seam recordReplay uses, but a miss ASKS (parks the
// prompt on disk) instead of failing, and blocks until an answer appears.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLLMBridge } from "../src/llm/bridge.js";
import { promptHash } from "../src/llm/recordReplay.js";

const CALL = { systemPrompt: "sys", userMessage: "write me an RTL module", model: "m1" };
const SHORT = promptHash(CALL).slice(0, 8);

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("createLLMBridge", () => {
  it("returns a .txt answer verbatim without parking a prompt", () => {
    fs.mkdirSync(path.join(dir, "answers"), { recursive: true });
    fs.writeFileSync(path.join(dir, "answers", SHORT + ".txt"), '{"code":"module m;\\nendmodule"}');
    const bridge = createLLMBridge(dir);
    const r = bridge(CALL);
    expect(r.text).toBe('{"code":"module m;\\nendmodule"}');
    expect(r.provider).toBe("bridge");
    expect(r.model).toBe("m1");
    expect(bridge.stats).toEqual({ asked: 0, cached: 1, answered: 0, declined: 0 });
    expect(fs.readdirSync(path.join(dir, "pending"))).toHaveLength(0);
  });

  it("accepts a JSON answer, plain or recordReplay-shaped", () => {
    fs.mkdirSync(path.join(dir, "answers"), { recursive: true });
    fs.writeFileSync(path.join(dir, "answers", SHORT + ".json"),
      JSON.stringify({ text: "plain", tokensOut: 42, stopReason: "length" }));
    let r = createLLMBridge(dir)(CALL);
    expect(r.text).toBe("plain");
    expect(r.tokensOut).toBe(42);
    expect(r.stopReason).toBe("length");

    fs.writeFileSync(path.join(dir, "answers", SHORT + ".json"),
      JSON.stringify({ response: { text: "nested" } }));
    expect(createLLMBridge(dir)(CALL).text).toBe("nested");
  });

  it(".txt wins over .json for the same prompt", () => {
    fs.mkdirSync(path.join(dir, "answers"), { recursive: true });
    fs.writeFileSync(path.join(dir, "answers", SHORT + ".txt"), "from-txt");
    fs.writeFileSync(path.join(dir, "answers", SHORT + ".json"), JSON.stringify({ text: "from-json" }));
    expect(createLLMBridge(dir)(CALL).text).toBe("from-txt");
  });

  it("parks the full prompt and times out loudly when unanswered", () => {
    const bridge = createLLMBridge(dir, { timeoutMs: 60, pollMs: 10 });
    expect(() => bridge(CALL)).toThrow(/LLM BRIDGE TIMEOUT/);
    const files = fs.readdirSync(path.join(dir, "pending"));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(SHORT);
    const parked = JSON.parse(fs.readFileSync(path.join(dir, "pending", files[0]), "utf8"));
    expect(parked.hash).toBe(promptHash(CALL));
    expect(parked.systemPrompt).toBe("sys");
    expect(parked.userMessage).toBe("write me an RTL module");
    expect(parked.answerFile).toContain(SHORT + ".txt");
    expect(bridge.stats.asked).toBe(1);
  });

  it("the timeout message names the prompt and the file to write", () => {
    let msg = "";
    try { createLLMBridge(dir, { timeoutMs: 30, pollMs: 10 })(CALL); } catch (e) { msg = e.message; }
    expect(msg).toContain(SHORT);
    expect(msg).toContain("write me an RTL module");
    expect(msg).toMatch(/answers[/\\]/);
  });

  it("an answer written while parked is picked up and returned", () => {
    const bridge = createLLMBridge(dir, { timeoutMs: 5000, pollMs: 10,
      // onWait fires once the prompt is parked — write the answer from here,
      // which is exactly the external model's move, minus the wall clock.
      onWait: (info) => fs.writeFileSync(
        path.join(dir, "answers", info.short + ".txt"), "answered-while-parked"),
    });
    const r = bridge(CALL);
    expect(r.text).toBe("answered-while-parked");
    expect(bridge.stats).toEqual({ asked: 1, cached: 0, answered: 1, declined: 0 });
  });

  it("re-asking an answered prompt is free and parks nothing new", () => {
    const bridge = createLLMBridge(dir, { timeoutMs: 5000, pollMs: 10,
      onWait: (info) => fs.writeFileSync(path.join(dir, "answers", info.short + ".txt"), "once"),
    });
    bridge(CALL);
    bridge(CALL);
    bridge(CALL);
    expect(bridge.stats).toEqual({ asked: 1, cached: 2, answered: 1, declined: 0 });
    expect(fs.readdirSync(path.join(dir, "pending"))).toHaveLength(1);
  });

  it("distinct prompts get distinct parked files and answers", () => {
    const other = { systemPrompt: "sys", userMessage: "write me a testbench", model: "m1" };
    const bridge = createLLMBridge(dir, { timeoutMs: 5000, pollMs: 10,
      onWait: (info) => fs.writeFileSync(
        path.join(dir, "answers", info.short + ".txt"), "ans-" + info.short),
    });
    expect(bridge(CALL).text).toBe("ans-" + SHORT);
    expect(bridge(other).text).toBe("ans-" + promptHash(other).slice(0, 8));
    expect(fs.readdirSync(path.join(dir, "pending"))).toHaveLength(2);
  });

  it("a malformed JSON answer fails loudly rather than silently empty", () => {
    fs.mkdirSync(path.join(dir, "answers"), { recursive: true });
    fs.writeFileSync(path.join(dir, "answers", SHORT + ".json"), "{not json");
    expect(() => createLLMBridge(dir)(CALL)).toThrow(/not valid JSON/);
    fs.writeFileSync(path.join(dir, "answers", SHORT + ".json"), JSON.stringify({ nope: 1 }));
    expect(() => createLLMBridge(dir)(CALL)).toThrow(/no `text` string/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Model filter (mixed-tier runs). With opts.models the bridge answers only
// the calls routed to it and DECLINES the rest with { passthrough: true },
// which callLLM honours by continuing to the configured provider. Combined
// with config.modelRouting this is what puts an external model on one path
// and a local model on the other inside a single run.
// ═══════════════════════════════════════════════════════════════════════════
describe("createLLMBridge: model filter", () => {
  it("declines a call whose model is not listed", () => {
    const bridge = createLLMBridge(dir, { models: ["bridge-model"], timeoutMs: 50, pollMs: 10 });
    const r = bridge({ systemPrompt: "s", userMessage: "u", model: "qwen3.6:35b" });
    expect(r).toEqual({ passthrough: true });
    expect(bridge.stats.declined).toBe(1);
    expect(bridge.stats.asked).toBe(0);
    expect(fs.readdirSync(path.join(dir, "pending"))).toHaveLength(0);
  });

  it("answers a call whose model IS listed", () => {
    const call = { systemPrompt: "s", userMessage: "u", model: "bridge-model" };
    const short = promptHash(call).slice(0, 8);
    fs.mkdirSync(path.join(dir, "answers"), { recursive: true });
    fs.writeFileSync(path.join(dir, "answers", short + ".txt"), "mine");
    const bridge = createLLMBridge(dir, { models: ["bridge-model"] });
    expect(bridge({ ...call }).text).toBe("mine");
    expect(bridge.stats.declined).toBe(0);
  });

  it("without a filter every call is the bridge's", () => {
    const bridge = createLLMBridge(dir, { timeoutMs: 40, pollMs: 10 });
    expect(() => bridge({ systemPrompt: "s", userMessage: "u", model: "anything" }))
      .toThrow(/LLM BRIDGE TIMEOUT/);
    expect(bridge.stats.declined).toBe(0);
  });
});

// The passthrough contract as callLLM sees it: a declined call must reach the
// provider path, not raise REPLAY MISS.
describe("callLLM honours a declined bridge call", () => {
  it("passes through to the provider instead of throwing", async () => {
    const { callLLM } = await import("../src/llm/callLLM.js");
    let reached = false;
    const cfg = {
      provider: "ollama", model: "qwen3.6:35b", baseUrl: "http://127.0.0.1:1",
      // fail fast: this test asserts WHICH layer errors, not transport patience
      localRecoveryTimeoutSec: 0, transportRetries: 0,
      _llmReplay: () => ({ passthrough: true }),
    };
    try {
      await callLLM({ config: cfg, systemPrompt: "s", userMessage: "u", maxTokens: 8 });
    } catch (e) {
      // The provider is unreachable on purpose — what matters is that the
      // failure comes from the transport, never from the replay layer.
      reached = !/REPLAY MISS/.test(e.message);
    }
    expect(reached).toBe(true);
  }, 30000);

  it("still throws REPLAY MISS when the resolver returns nothing", async () => {
    const { callLLM } = await import("../src/llm/callLLM.js");
    await expect(callLLM({
      config: { provider: "ollama", model: "m", _llmReplay: () => null },
      systemPrompt: "s", userMessage: "u", maxTokens: 8,
    })).rejects.toThrow(/REPLAY MISS/);
  });
});
