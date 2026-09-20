// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/llm/index.js", async () => ({ ...await vi.importActual("../src/llm/index.js"), callLLMJson: vi.fn() }));
import { callLLMJson } from "../src/llm/index.js";
import { specNode } from "../src/pipeline/nodes/spec.js";
import { assessDesignContract, specQualificationError } from "../src/pipeline/designContract.js";
import { applySkillsToPrompt } from "../src/pipeline/applySkillsToPrompt.js";
import { createStore } from "../src/term/store.js";
import { createMemoryStorage } from "../src/projectState/storage.js";

const source = "Implement module named WordPath.\nInterface:\n- input word_i (5 bits)\n- output word_o (5 bits)\nword_o equals word_i.\nThere is no clocked storage.";
const spec = () => ({ modName: "WordPath", domain: "combinational", params: [],
  iface: [{ name: "word_i", dir: "input", width: "5" }, { name: "word_o", dir: "output", width: "5", reset: "N/A" }],
  requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "The module shall copy word_i to word_o.",
    src: "An invented word-copy quotation.", rat: "Copy the selected input word." }] });
const reply = data => ({ data, llms: [{ text: JSON.stringify(data), tokensIn: 1, tokensOut: 1 }] });
const config = mode => ({ attributionPolicy: "auto", _executionMode: mode, specReask: false,
  provider: "openai", model: "test", stageSettings: {}, skillsDisabled: true });

beforeEach(() => callLLMJson.mockReset());

describe("attribution at the production Spec boundary", () => {
  it.each(["semi-auto", "full-auto"])("bounds citation repair and applies the %s gate without changing behavior", async mode => {
    const data = spec(), cfg = config(mode);
    callLLMJson.mockResolvedValueOnce(reply(data)).mockResolvedValue(reply({ citations: [{
      id: data.requirements[0].id, requirement: data.requirements[0].desc, kind: "direct",
      src: "Another invented quotation.", reason: "Incorrect model citation", sources: [{ quote: "Another invented quotation." }],
    }] }));
    const st = { _userDesc: source, _config: cfg, _onLog: vi.fn() };
    const out = await specNode(st);
    expect(callLLMJson).toHaveBeenCalledTimes(3); // one generation, at most two citation repairs
    expect(out.spec.requirements[0].desc).toBe(data.requirements[0].desc);
    expect(out.spec.status).toBe("UNVERIFIED");
    expect(out.spec._designContract.attributionPolicy).toMatchObject({ requested: "auto",
      executionMode: mode, effective: mode === "full-auto" ? "relaxed" : "strict" });
    expect(out.spec._designContract.issues.every(i => i.code === "CITATION_UNRESOLVED")).toBe(true);
    const next = { ...st, ...out };
    if (mode === "full-auto") {
      expect(specQualificationError(out.spec)).toBeNull();
      expect((await applySkillsToPrompt({ userMessage: "Generate RTL." }, next, "rtl_generate")).userMessage).toContain("PROVISIONAL GENERATION ONLY");
    } else {
      expect(specQualificationError(out.spec)?.code).toBe("SPEC_ATTRIBUTION_UNRESOLVED");
      await expect(applySkillsToPrompt({ userMessage: "Generate RTL." }, next, "rtl_generate")).rejects.toThrow(/requires revision/);
    }
  });
  it.each(["semi-auto", "full-auto"])("makes no extra citation calls for qualified source text in %s", async mode => {
    const data = spec(); data.requirements[0].src = "word_o equals word_i.";
    callLLMJson.mockResolvedValueOnce(reply(data));
    const out = await specNode({ _userDesc: source, _config: config(mode) });
    expect(callLLMJson).toHaveBeenCalledTimes(1);
    expect(out.spec._designContract.issues).toEqual([]);
    expect(specQualificationError(out.spec)).toBeNull();
  });
});

describe("checkpoint attribution continuity", () => {
  it.each(["auto", "strict", "relaxed"])("retains %s policy, mode, contract hash and qualification on resume", async policy => {
    const data = spec(); data.requirements[0].src = "word_o equals word_i.";
    const cfg = { ...config("full-auto"), attributionPolicy: policy };
    callLLMJson.mockResolvedValueOnce(reply(data));
    const storage = createMemoryStorage(), projectId = "attribution-roundtrip";
    const first = createStore({ config: cfg, storage, projectId });
    const result = await first.runStage({ stageId: 2, overrideDesc: source });
    expect(result.ok).toBe(true);
    const original = first.activeMod().stageData[2]._designContract;
    await first.saveCheckpoint();
    const resumedConfig = { ...cfg }; delete resumedConfig._executionMode;
    const resumed = createStore({ config: resumedConfig, storage, projectId });
    const restored = await resumed.loadCheckpoint();
    expect(restored.uiState.mode).toBe("full-auto");
    expect(restored.uiState.config.attributionPolicy).toBe(policy);
    expect(restored.uiState.config._executionMode).toBeUndefined();
    expect(resumed.activeMod().stageData[2]._designContract).toEqual(original);
    const check = vi.fn(async (_, st) => {
      expect(st._config._executionMode).toBe("full-auto");
      expect(assessDesignContract(st._userDesc, st.spec, st.elicit, st._config).issues).toEqual([]);
      return { architect: { strategy: "Direct connection" } };
    });
    expect((await resumed.runStage({ stageId: 3, services: { pipeline: { invokeNode: check } } })).ok).toBe(true);
    expect(check).toHaveBeenCalledOnce();
    expect(callLLMJson).toHaveBeenCalledTimes(1);
  });
});
