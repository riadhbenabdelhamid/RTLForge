// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { getStageConfig } from "../src/constants/providers.js";

describe("getStageConfig — Audit #5 (deliberate empty-string override)", function() {
  const baseConfig = {
    provider: "openai",
    model: "gpt-4o",
    apiKey: "sk-global",
    useGlobalLLM: false,  // per-stage overrides active
    stageSettings: {},
  };

  it("uses global value when no per-stage override is set", function() {
    const c = getStageConfig(baseConfig, "rtl_generate");
    expect(c.provider).toBe("openai");
    expect(c.model).toBe("gpt-4o");
    expect(c.apiKey).toBe("sk-global");
  });

  it("respects a non-empty per-stage provider/model override", function() {
    const cfg = {
      ...baseConfig,
      stageSettings: { rtl_generate: { provider: "anthropic", model: "claude-sonnet-4", apiKey: "sk-stage" } },
    };
    const c = getStageConfig(cfg, "rtl_generate");
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-sonnet-4");
    expect(c.apiKey).toBe("sk-stage");
  });

  it("treats empty-string override as no-override (uses global)", function() {
    // Audit #5: empty string used to *also* fall through to global because
    // the check was `&& ss.provider`. Both old and new behavior agree on
    // empty → fall through, but the new check now uses `!= null && !== ""`
    // which is more explicit. This test pins the behavior.
    const cfg = {
      ...baseConfig,
      stageSettings: { rtl_generate: { provider: "", model: "", apiKey: "" } },
    };
    const c = getStageConfig(cfg, "rtl_generate");
    expect(c.provider).toBe("openai");
    expect(c.model).toBe("gpt-4o");
    expect(c.apiKey).toBe("sk-global");
  });

  it("when useGlobalLLM is true, ignores all per-stage overrides", function() {
    const cfg = {
      ...baseConfig,
      useGlobalLLM: true,
      stageSettings: { rtl_generate: { provider: "anthropic", model: "claude" } },
    };
    const c = getStageConfig(cfg, "rtl_generate");
    expect(c.provider).toBe("openai");
    expect(c.model).toBe("gpt-4o");
  });
});

describe("getStageConfig — model routing", function() {
  const global = {
    provider: "anthropic", model: "claude-opus", apiKey: "sk-anthropic",
    useGlobalLLM: true, stageSettings: {},
  };

  it("absent modelRouting → resolution identical to before (global wins)", function() {
    const c = getStageConfig(global, "test_generate");
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-opus");
    expect(c.apiKey).toBe("sk-anthropic");
  });

  it("routes a single stage to a different model — honored despite useGlobalLLM:true", function() {
    const cfg = {
      ...global,
      modelRouting: {
        test_generate: { provider: "openai", model: "gpt-4o", apiKey: "sk-openai" },
      },
    };
    const tb = getStageConfig(cfg, "test_generate");
    expect(tb.provider).toBe("openai");
    expect(tb.model).toBe("gpt-4o");
    expect(tb.apiKey).toBe("sk-openai");
    // A non-routed stage still uses the global model — this is the
    // decorrelation: RTL writer ≠ TB writer.
    const rtl = getStageConfig(cfg, "rtl_generate");
    expect(rtl.provider).toBe("anthropic");
    expect(rtl.model).toBe("claude-opus");
  });

  it("baseUrl follows the routed provider, not the global baseUrl", function() {
    // Global points at a custom LM Studio URL; a stage routed to openai must
    // NOT inherit that URL.
    const cfg = {
      provider: "lmstudio", model: "local", apiKey: "x",
      baseUrl: "http://localhost:1234/v1", useGlobalLLM: true, stageSettings: {},
      modelRouting: { rtl_generate: { provider: "openai", model: "gpt-4o", apiKey: "sk" } },
    };
    const rtl = getStageConfig(cfg, "rtl_generate");
    expect(rtl.provider).toBe("openai");
    expect(rtl.baseUrl).not.toBe("http://localhost:1234/v1");
    expect(rtl.baseUrl).toMatch(/openai/);
    // The non-routed stage keeps the global custom baseUrl.
    const spec = getStageConfig(cfg, "spec");
    expect(spec.baseUrl).toBe("http://localhost:1234/v1");
  });

  it("an explicit route.baseUrl overrides everything", function() {
    const cfg = {
      ...global,
      modelRouting: { lint: { provider: "ollama", model: "qwen", baseUrl: "http://gpu-box:11434" } },
    };
    expect(getStageConfig(cfg, "lint").baseUrl).toBe("http://gpu-box:11434");
  });

  it("route takes precedence over an active per-stage stageSettings override", function() {
    const cfg = {
      provider: "anthropic", model: "claude-opus", apiKey: "sk",
      useGlobalLLM: false,
      stageSettings: { verify: { provider: "openai", model: "gpt-3.5" } },
      modelRouting: { verify: { provider: "groq", model: "llama-70b" } },
    };
    const c = getStageConfig(cfg, "verify");
    expect(c.provider).toBe("groq");
    expect(c.model).toBe("llama-70b");
  });
});
