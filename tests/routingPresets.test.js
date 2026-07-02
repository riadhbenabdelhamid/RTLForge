// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Routing presets (docs/improvement-roadmap.md #3).

import { describe, it, expect } from "vitest";
import { ROUTING_PRESETS, applyRoutingPreset, parseIdentity } from "../src/constants/routingPresets.js";
import { getStageConfig } from "../src/constants/providers.js";

describe("applyRoutingPreset", () => {
  it("expands fast-strong over the prose stages only", () => {
    const map = applyRoutingPreset("fast-strong", { provider: "lmstudio", model: "qwen3.5-9b" });
    expect(Object.keys(map).sort()).toEqual(["architect", "elicit", "spec"]);
    expect(map.spec).toEqual({ provider: "lmstudio", model: "qwen3.5-9b" });
    // code stages untouched — they resolve to the global identity
    expect(map.rtl_generate).toBeUndefined();
    expect(map.judge).toBeUndefined();
  });
  it("carries baseUrl when given; null on unknown preset or bad identity", () => {
    const map = applyRoutingPreset("fast-strong", { provider: "p", model: "m", baseUrl: "http://x" });
    expect(map.elicit.baseUrl).toBe("http://x");
    expect(applyRoutingPreset("nope", { provider: "p", model: "m" })).toBe(null);
    expect(applyRoutingPreset("fast-strong", { provider: "p" })).toBe(null);
  });
  it("the expanded map resolves through getStageConfig as designed", () => {
    const routing = applyRoutingPreset("fast-strong", { provider: "lmstudio", model: "small" });
    const cfg = { provider: "anthropic", model: "big", modelRouting: routing };
    expect(getStageConfig(cfg, "spec").model).toBe("small");
    expect(getStageConfig(cfg, "rtl_generate").model).toBe("big");
  });
});

describe("parseIdentity", () => {
  it("splits provider/model, keeping slashes inside the model id", () => {
    expect(parseIdentity("lmstudio/qwen3.5-9b")).toEqual({ provider: "lmstudio", model: "qwen3.5-9b" });
    expect(parseIdentity("lmstudio/liquid/lfm2-24b-a2b")).toEqual({ provider: "lmstudio", model: "liquid/lfm2-24b-a2b" });
  });
  it("rejects malformed identities", () => {
    expect(parseIdentity("nomodel")).toBe(null);
    expect(parseIdentity("/leading")).toBe(null);
    expect(parseIdentity("trailing/")).toBe(null);
    expect(parseIdentity("")).toBe(null);
  });
});

describe("ROUTING_PRESETS registry", () => {
  it("every preset names only real prose stages", () => {
    for (const p of Object.values(ROUTING_PRESETS)) {
      expect(p.fastStages.length).toBeGreaterThan(0);
      for (const s of p.fastStages) expect(["elicit", "spec", "architect"]).toContain(s);
    }
  });
});
