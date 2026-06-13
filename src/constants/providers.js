// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Providers — LLM provider registry, capability flags, recommended settings
// ═══════════════════════════════════════════════════════════════════════════

// Model names default to empty string: the user must explicitly choose a model
// before any request goes out, rather than silently sending a stale default.
// The LLM call layer surfaces a clear "model unset" error for model="".
export const PROVIDERS = [
  { id: "ollama",    label: "Ollama",    local: true,  model: "", url: "http://localhost:11434" },
  { id: "lmstudio",  label: "LM Studio", local: true,  model: "", url: "http://localhost:1234/v1" },
  { id: "anthropic", label: "Anthropic", local: false, model: "", url: "https://api.anthropic.com" },
  { id: "openai",    label: "OpenAI",    local: false, model: "", url: "https://api.openai.com/v1" },
  { id: "groq",      label: "Groq",      local: false, model: "", url: "https://api.groq.com/openai/v1" },
];

/** Which sampling fields each provider supports. */
export const PROVIDER_SUPPORTS = {
  anthropic: { top_p: true, top_k: true,  seed: false },
  openai:    { top_p: true, top_k: false, seed: true  },
  groq:      { top_p: true, top_k: false, seed: true  },
  ollama:    { top_p: true, top_k: true,  seed: true  },
  lmstudio:  { top_p: true, top_k: true,  seed: true  },
};

/** Per-stage recommended LLM settings. Used as fallback when global config is off. */
export const RECOMMENDED_STAGE_SETTINGS = {
  elicit:           { maxTokens: 10000, temperature: 0.4,  top_p: 0.90, top_k: 50, seed: null },
  spec:             { maxTokens: 10000, temperature: 0.15, top_p: 0.85, top_k: 40, seed: 42 },
  spec_from_desc:   { maxTokens: 10000, temperature: 0.25, top_p: 0.88, top_k: 45, seed: null },
  architect:        { maxTokens: 8000,  temperature: 0.35, top_p: 0.90, top_k: 50, seed: null },
  rtl_generate:     { maxTokens: 16000, temperature: 0.10, top_p: 0.80, top_k: 30, seed: 42 },
  formal_props:     { maxTokens: 10000, temperature: 0.12, top_p: 0.82, top_k: 35, seed: 42 },
  lint:             { maxTokens: 6000,  temperature: 0.05, top_p: 0.75, top_k: 25, seed: 42 },
  rtl_fix:          { maxTokens: 16000, temperature: 0.08, top_p: 0.78, top_k: 30, seed: 42 },
  test_generate:    { maxTokens: 16000, temperature: 0.20, top_p: 0.85, top_k: 40, seed: null },
  test_fix:         { maxTokens: 16000, temperature: 0.10, top_p: 0.80, top_k: 30, seed: 42 },
  verify:           { maxTokens: 6000,  temperature: 0.08, top_p: 0.78, top_k: 30, seed: 42 },
  verify_triage:    { maxTokens: 6000,  temperature: 0.10, top_p: 0.80, top_k: 35, seed: 42 },
  judge:            { maxTokens: 6000,  temperature: 0.10, top_p: 0.80, top_k: 35, seed: 42 },
  judge_triage:     { maxTokens: 6000,  temperature: 0.10, top_p: 0.80, top_k: 35, seed: 42 },
  decompose:        { maxTokens: 10000, temperature: 0.30, top_p: 0.88, top_k: 45, seed: null },
  shared_package:   { maxTokens: 8000,  temperature: 0.12, top_p: 0.82, top_k: 35, seed: 42 },
  integration_lint: { maxTokens: 6000,  temperature: 0.08, top_p: 0.78, top_k: 30, seed: 42 },
  integration_test: { maxTokens: 10000, temperature: 0.18, top_p: 0.85, top_k: 40, seed: null },
  integration_judge:{ maxTokens: 6000,  temperature: 0.10, top_p: 0.80, top_k: 35, seed: 42 },
  rtl_from_verify:  { maxTokens: 16000, temperature: 0.10, top_p: 0.80, top_k: 30, seed: 42 },
  rtl_review:       { maxTokens: 8000,  temperature: 0.20, top_p: 0.85, top_k: 40, seed: null },
  rtl_review_fix:   { maxTokens: 16000, temperature: 0.08, top_p: 0.78, top_k: 30, seed: 42 },
  test_review:      { maxTokens: 8000,  temperature: 0.20, top_p: 0.85, top_k: 40, seed: null },
  test_review_fix:  { maxTokens: 16000, temperature: 0.10, top_p: 0.80, top_k: 30, seed: 42 },
};

/**
 * Build a resolved config for a specific pipeline stage.
 * When Global LLM is ON: sampling params left to provider unless per-stage overrides exist.
 * When Global LLM is OFF: per-stage settings control everything.
 * Any knob marked as disabled (_disabled map) is omitted entirely.
 */
export function getStageConfig(globalConfig, stageKey) {
  const rec = RECOMMENDED_STAGE_SETTINGS[stageKey] || {};
  const ss = (globalConfig.stageSettings || {})[stageKey] || {};
  const useGlobal = globalConfig.useGlobalLLM !== false;
  const disabled = ss._disabled || {};

  // ── Model routing (highest precedence, ALWAYS honored) ──────────────────────
  // config.modelRouting maps a stage key to a specific LLM identity:
  //   modelRouting: { test_generate: { provider, model, apiKey?, baseUrl? }, … }
  // Unlike the stageSettings path below (gated on useGlobalLLM), a route is
  // honored unconditionally. This is the mechanism for true decorrelation —
  // a DIFFERENT model writes/reviews the testbench than wrote the RTL, which
  // completes the spec-blinding work at the model level — and for cost
  // routing (cheap model for triage/lint-estimation, strong model for RTL).
  // When modelRouting is absent or omits this stage, resolution is byte-for-
  // byte identical to before.
  const route = (globalConfig.modelRouting || {})[stageKey] || {};
  const set = function(v) { return v != null && v !== ""; };

  // Precedence per field: explicit route → (per-stage settings when
  // useGlobalLLM is off) → global. Empty string is "no override" throughout.
  const provider = set(route.provider) ? route.provider
    : ((!useGlobal && set(ss.provider)) ? ss.provider : globalConfig.provider);
  const model    = set(route.model)    ? route.model
    : ((!useGlobal && set(ss.model))    ? ss.model    : globalConfig.model);
  const apiKey   = set(route.apiKey)   ? route.apiKey
    : ((!useGlobal && set(ss.apiKey))   ? ss.apiKey   : globalConfig.apiKey);

  let temperature;
  if (disabled.temperature)            temperature = undefined;
  else if (ss.temperature != null)     temperature = ss.temperature;
  else if (useGlobal)                  temperature = undefined;
  else                                 temperature = rec.temperature != null ? rec.temperature : undefined;

  let top_p;
  if (disabled.top_p)                  top_p = undefined;
  else if (ss.top_p != null)           top_p = ss.top_p;
  else if (useGlobal)                  top_p = undefined;
  else                                 top_p = rec.top_p != null ? rec.top_p : undefined;

  let top_k;
  if (disabled.top_k)                  top_k = undefined;
  else if (ss.top_k != null)           top_k = ss.top_k;
  else if (useGlobal)                  top_k = undefined;
  else                                 top_k = rec.top_k != null ? rec.top_k : undefined;

  let seed;
  if (disabled.seed)                   seed = undefined;
  else if (ss.seed !== undefined)      seed = ss.seed;
  else if (useGlobal)                  seed = undefined;
  else                                 seed = rec.seed !== undefined ? rec.seed : undefined;

  const maxTokens = ss.maxTokens || rec.maxTokens || 4096;
  const provEntry = PROVIDERS.find((p) => p.id === provider);

  // baseUrl must follow the RESOLVED provider. When a route sends this stage
  // to a different provider than the global one, globalConfig.baseUrl (set
  // for the global provider — e.g. a custom LM Studio URL) would point at the
  // wrong server, so it is bypassed in favor of the routed provider's URL.
  const providerRouted = provider !== globalConfig.provider;
  const baseUrl = set(route.baseUrl) ? route.baseUrl
    : providerRouted ? (provEntry ? provEntry.url : "")
    : (globalConfig.baseUrl || (provEntry ? provEntry.url : ""));

  return {
    provider, model, apiKey,
    temperature, top_p, top_k, seed,
    _maxTokens: maxTokens,
    baseUrl: baseUrl,
    backendUrl: globalConfig.backendUrl,
    lintWarningsAsErrors: globalConfig.lintWarningsAsErrors,
    verifyWarningsAsErrors: globalConfig.verifyWarningsAsErrors,
    lintCmd: globalConfig.lintCmd,
    simCmds: globalConfig.simCmds,
    simPath: globalConfig.simPath,
    maxLintIters: globalConfig.maxLintIters || 3,
    maxVerifyIters: globalConfig.maxVerifyIters || 3,
    maxJudgeIters: globalConfig.maxJudgeIters || 3,
    maxRtlReviewIters:  globalConfig.maxRtlReviewIters  || 2,
    maxTestReviewIters: globalConfig.maxTestReviewIters || 2,
    simTimeoutCycles: globalConfig.simTimeoutCycles || 100000,
    // Retry settings propagate to the callLLM wrapper
    maxRetries: globalConfig.maxRetries,
    retryBaseDelayMs: globalConfig.retryBaseDelayMs,
    // CLI robustness flags
    strictCli:         globalConfig.strictCli === true,
    cliRetryCount:     globalConfig.cliRetryCount == null ? 1 : globalConfig.cliRetryCount,
    backendTimeoutSec: globalConfig.backendTimeoutSec || 600,
  };
}
