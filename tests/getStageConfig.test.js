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
