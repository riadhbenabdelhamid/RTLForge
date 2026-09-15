// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(function() {
  return { store: null, verdict: "PASS", verify: null, saved: null };
});
vi.mock("../src/term/config.js", function() {
  return {
    loadConfig: function() { return { provider: "ollama", model: "authored-stub", trackRunSummaries: false }; },
    loadApiKey: function() { return null; },
    rtlforgeHome: function() { return "/tmp/rtlforge-cli-verdict-test"; },
  };
});
vi.mock("../src/term/fsStorage.js", function() {
  return { createFsStorage: function() { return {}; } };
});
vi.mock("../src/term/store.js", function() {
  return { createStore: function() { return fixture.store; } };
});
vi.mock("../src/constants/stages.js", function() {
  const stages = [{ id: 8, key: "verify", label: "Verify" }, { id: 9, key: "judge", label: "Judge" }];
  return { ALL_STAGES: stages, getActiveStages: function() { return stages; } };
});
vi.mock("../src/term/llmHooks.js", function() {
  return { attachLLMHooks: async function() {} };
});
vi.mock("../src/observer/index.js", function() {
  return {
    openDb: async function() { return { available: false }; },
    insertEvent: vi.fn(), summarizeRun: vi.fn(), synthStateFromStageData: vi.fn(),
    queryEvents: vi.fn(), eventsToSummaries: vi.fn(), runEta: vi.fn(), formatEta: vi.fn(),
  };
});

import { cmdRun } from "../src/term/commands/run.js";
import { UNVERIFIED_EXPLANATION } from "../src/utils/verificationPresentation.js";

let stdout;
let stderr;
beforeEach(function() {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation(function(chunk) { stdout.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation(function(chunk) { stderr.push(String(chunk)); return true; });
  fixture.verdict = "PASS";
  fixture.verify = { cli: true, total: 2, pass: 1, fail: 1 };
  const mod = { stageData: {}, completed: new Set() };
  fixture.saved = vi.fn(async function() {});
  fixture.store = {
    projectId: "authored-project",
    ensureModule: vi.fn(), activeMod: function() { return mod; },
    getState: function() { return { activeModId: "design", modules: { design: mod } }; },
    saveCheckpoint: fixture.saved,
    loadCheckpoint: async function() { return { uiState: { config: {} } }; },
    runStage: vi.fn(async function({ stageId }) {
      mod.stageData[stageId] = stageId === 8
        ? fixture.verify
        : { overall: fixture.verdict };
      mod.completed.add(stageId);
      return { ok: true };
    }),
  };
});
afterEach(function() { vi.restoreAllMocks(); });

describe("CLI terminal verdict", function() {
  it.each(["FAIL", "UNVERIFIED"])("returns failure and preserves artifacts for Judge %s", async function(verdict) {
    fixture.verdict = verdict;
    const code = await cmdRun({ _: ["An independently authored small module."] });
    expect(code).toBe(1);
    expect(fixture.saved).toHaveBeenCalledTimes(2);
    expect(fixture.store.activeMod().stageData[9].overall).toBe(verdict);
    expect(stderr.join("")).toContain(verdict);
    expect(stdout.join("")).not.toContain("pipeline complete");
    if (verdict === "UNVERIFIED") expect(stdout.join("")).toContain(UNVERIFIED_EXPLANATION);
  });

  it("allows an intermediate failure that is resolved by the final gate", async function() {
    const code = await cmdRun({ _: ["An independently authored small module."] });
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("pipeline complete");
  });

  it("checks a resumed completed Judge result instead of declaring success", async function() {
    const mod = fixture.store.activeMod();
    mod.completed.add(8); mod.completed.add(9);
    mod.stageData[8] = { cli: true, total: 1, pass: 0, fail: 1 };
    mod.stageData[9] = { overall: "UNVERIFIED" };
    const code = await cmdRun({ _: [], resume: "authored-project" });
    expect(code).toBe(1);
    expect(fixture.store.runStage).not.toHaveBeenCalled();
    expect(stdout.join("")).not.toContain("pipeline complete");
    expect(stdout.join("")).toContain("unresolved (UNVERIFIED; already executed)");
    expect(stdout.join("")).toContain(UNVERIFIED_EXPLANATION);
  });

  it("returns failure when explicitly stopping at a failing Verify stage", async function() {
    const code = await cmdRun({ _: ["An independently authored small module."], until: "verify" });
    expect(code).toBe(1);
    expect(fixture.store.runStage).toHaveBeenCalledTimes(1);
    expect(stderr.join("")).toContain("failing checks");
  });

  it.each(["UNKNOWN_EXIT", "RUNTIME_EXIT", "MISSING_MARKERS", "COMPILE_FAILURE"])(
    "rejects an incomplete Verify outcome %s even with zero failed markers", async function(status) {
      fixture.verify = { cli: true, total: 1, pass: 1, fail: 0, status: status };
      expect(await cmdRun({ _: ["Authored module."], until: "verify" })).toBe(1);
      expect(stderr.join("")).toContain(status);
      expect(stdout.join("")).not.toContain("pipeline complete");
    });

  it("does not claim simulated success from an LLM estimate", async function() {
    fixture.verify = { cli: false, total: 1, pass: 1, fail: 0 };
    expect(await cmdRun({ _: ["Authored module."], until: "verify" })).toBe(1);
    expect(stderr.join("")).toContain("UNVERIFIED");
  });
});
