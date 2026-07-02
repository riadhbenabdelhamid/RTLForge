// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Pipeline replay regression (docs/improvement-roadmap.md #5): drive the real
// pipeline from recorded LLM fixtures — no model, no network. A prompt change
// since recording surfaces as a loud REPLAY MISS with the prompt head; that
// failure IS the regression signal (re-record or bless the change).
//
// Fixtures: tests/fixtures/llm/counter_updown — recorded from a live
// lfm2-24b-a2b run with the exact config below (temp 0, seed 7). Re-record:
//   node scratchpad driver, or `rtlforge run "<desc>" --record-llm <dir>`.

import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReplayLLM, createLLMRecorder, promptHash } from "../src/llm/recordReplay.js";
import { buildPipeline, runStages } from "../src/pipeline/index.js";
import { selectSpecs } from "../bench/specs.mjs";
import fs from "node:fs";
import os from "node:os";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "llm", "counter_updown");

// MUST byte-match the recording driver's config (prompts are regenerated live).
function replayConfig() {
  return {
    provider: "lmstudio", model: "liquid/lfm2-24b-a2b",
    baseUrl: "http://localhost:1234/v1", apiKey: "local",
    useGlobalLLM: true,
    backendUrl: null,
    optionalStages: { rtl_review: false, formal_props: false, lint: true, test_review: false, lint_test: false },
    maxLintIters: 2,
    temperature: 0, seed: 7,
    errorsToAvoid: false, useShippedRules: false, syntaxRepair: false, fixPatchMode: false,
    structuredOutputs: true,
    truncationRetries: 2, maxTokensCeiling: 16384,
  };
}

describe("pipeline replay (recorded lfm2-24b run, no network)", () => {
  it("replays spec→architect→rtl_generate→lint and produces the recorded shapes", async () => {
    const replay = createReplayLLM(FIXTURES);
    expect(replay.size).toBeGreaterThanOrEqual(4);
    const config = Object.assign(replayConfig(), { _llmReplay: replay });
    const spec = selectSpecs("counter_updown")[0];

    const st = await runStages(buildPipeline(), ["spec", "architect", "rtl_generate", "lint"],
      { _userDesc: spec.description, _config: config });

    expect(replay.stats.misses).toEqual([]);            // every prompt matched a fixture
    expect(replay.stats.hits).toBeGreaterThanOrEqual(4);
    expect(st.spec && st.spec.requirements && st.spec.requirements.length).toBeGreaterThan(0);
    expect(st.rtl_generate.code).toMatch(/module/);
    expect(st.rtl_generate.code.length).toBeGreaterThan(200);
    expect(st.lint.status).toBe("PASS");
  }, 30000);

  it("a changed prompt fails loudly with the prompt head (the regression signal)", async () => {
    const replay = createReplayLLM(FIXTURES);
    const config = Object.assign(replayConfig(), { _llmReplay: replay });
    await expect(runStages(buildPipeline(), ["spec"],
      { _userDesc: "a totally different design description", _config: config }))
      .rejects.toThrow(/REPLAY MISS/);
  });
});

describe("recorder/replayer mechanics", () => {
  it("promptHash keys on system+user+model", () => {
    const a = promptHash({ systemPrompt: "s", userMessage: "u", model: "m" });
    expect(promptHash({ systemPrompt: "s", userMessage: "u", model: "m" })).toBe(a);
    expect(promptHash({ systemPrompt: "s", userMessage: "u", model: "OTHER" })).not.toBe(a);
    expect(promptHash({ systemPrompt: "s2", userMessage: "u", model: "m" })).not.toBe(a);
  });
  it("record → replay round-trips a call; re-asks of the same prompt dedupe", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-"));
    const tap = createLLMRecorder(dir);
    tap({ systemPrompt: "s", userMessage: "u", model: "m", provider: "p", response: { text: "hello", tokensIn: 1, tokensOut: 2, stopReason: "stop" } });
    tap({ systemPrompt: "s", userMessage: "u", model: "m", provider: "p", response: { text: "hello2", tokensIn: 1, tokensOut: 2, stopReason: "stop" } });
    expect(fs.readdirSync(dir)).toHaveLength(1);        // same prompt → one fixture, last wins
    const replay = createReplayLLM(dir);
    expect(replay({ systemPrompt: "s", userMessage: "u", model: "m" }).text).toBe("hello2");
    expect(replay({ systemPrompt: "x", userMessage: "u", model: "m" })).toBe(null);
    expect(replay.stats.misses).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
