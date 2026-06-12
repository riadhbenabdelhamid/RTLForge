// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/config — Configuration loader for the rtlforge terminal app
//
// Resolution order (later beats earlier):
//   1. Hard-coded defaults
//   2. ~/.rtlforge/config.json   (user-global)
//   3. ./.rtlforge.json           (project-local, if present in cwd)
//   4. Environment variables (RTLFORGE_*)
//   5. CLI flags (passed in by the caller as `flags`)
//
// The result is the same shape the GUI uses for its `config` prop, so the
// pipeline nodes don't need to know they're running headlessly.
//
// Sensitive fields (API keys) are NEVER read from the config file in plain
// text — they MUST come from an env var or be in a separate auth file at
// ~/.rtlforge/auth.json which is mode 0600. This mirrors how `gh`,
// `kubectl`, and similar tools separate config from credentials.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_CONFIG = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  maxRetries: 3,
  retryBaseDelayMs: 2000,
  // Pipeline knobs — match the GUI's defaults
  maxLintIters: 3,
  maxVerifyIters: 3,
  strictCli: true,
  // Optional pipeline stages (toggle from CLI with `rtlforge config set`)
  optionalStages: {
    rtl_review:   true,
    formal_props: false,
    lint:         true,
    test_review:  true,
    lint_test:    true,
  },
  // Backend (verilator CLI bridge) — opt-in
  backendUrl: null,
  backendTimeoutSec: 600,
  cliRetryCount: 1,
  // Sim commands template — used when backend is configured.
  // --assert makes Verilator evaluate SVA assertions at runtime; required
  // for the bound formal properties (pipeline/svaBind.js) to actually fire.
  simCmds: "verilator --binary --build --assert -j 0 -Wall {RTL} {TB} -o {RTL}.sim\n./obj_dir/{RTL}.sim",
  // Bind formal_props SVA into verify/judge simulation builds (svaBind.js).
  // Safe by construction: unbindable properties are filtered, and a checker
  // that still breaks the compile triggers a retry without SVA.
  svaInSim: true,
  // Run-budget ceilings (pipeline/budget.js). null = unlimited. Example:
  //   rtlforge config set maxRunCostUsd 2.50
  //   rtlforge config set maxRunTokens 500000
  maxRunTokens: null,
  maxRunCostUsd: null,
  // Mutation gate (pipeline/mutation.js): inject bugs into passing RTL and
  // require the TB to catch them. Off by default (one compile+sim per
  // mutant). Pair with the mutation_score eval criterion for a hard gate.
  mutationTesting: false,
  mutationMaxMutants: 5,
  // Full-auto only: run dependency-independent modules concurrently in
  // waves. Opt-in — multiplies concurrent LLM/Verilator load; abort only
  // kills the latest backend task.
  parallelModules: false,
  // Lint warnings as errors
  lintWarningsAsErrors: false,
  verifyWarningsAsErrors: false,
};

/**
 * Read a JSON file safely. Returns {} on missing file, throws on parse err.
 */
function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    throw new Error("Failed to parse " + filePath + ": " + (e && e.message ? e.message : String(e)));
  }
}

/**
 * Get the user-global config directory: ~/.rtlforge.
 * Honours $RTLFORGE_HOME if set (handy for tests).
 */
export function rtlforgeHome() {
  if (process.env.RTLFORGE_HOME) return process.env.RTLFORGE_HOME;
  return path.join(os.homedir(), ".rtlforge");
}

/**
 * Path to the user-global config file.
 */
export function userConfigPath() {
  return path.join(rtlforgeHome(), "config.json");
}

/**
 * Path to the user-global auth file (API keys). Always mode 0600.
 */
export function userAuthPath() {
  return path.join(rtlforgeHome(), "auth.json");
}

/**
 * Path to the project-local config (cwd-relative).
 */
export function projectConfigPath(cwd) {
  return path.join(cwd || process.cwd(), ".rtlforge.json");
}

/**
 * Pull API keys from auth file or env vars. Order:
 *   1. RTLFORGE_API_KEY (provider-agnostic — convenience)
 *   2. ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_HOST etc.
 *   3. ~/.rtlforge/auth.json keyed by provider
 */
export function loadApiKey(provider) {
  // 1. Provider-agnostic env var
  if (process.env.RTLFORGE_API_KEY) return process.env.RTLFORGE_API_KEY;

  // 2. Provider-specific env vars
  const envKey = {
    anthropic: "ANTHROPIC_API_KEY",
    openai:    "OPENAI_API_KEY",
    ollama:    null,           // Ollama runs locally, no key
  }[provider];
  if (envKey && process.env[envKey]) return process.env[envKey];

  // 3. Auth file
  const authPath = userAuthPath();
  if (fs.existsSync(authPath)) {
    try {
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
      if (auth && auth[provider] && auth[provider].apiKey) return auth[provider].apiKey;
    } catch (_) { /* ignore — caller will get a clearer error from missing key */ }
  }
  return null;
}

/**
 * Apply RTLFORGE_* environment variables on top of `cfg`. Documented set:
 *   RTLFORGE_PROVIDER          → cfg.provider
 *   RTLFORGE_MODEL             → cfg.model
 *   RTLFORGE_BACKEND_URL       → cfg.backendUrl
 *   RTLFORGE_MAX_LINT_ITERS    → cfg.maxLintIters
 *   RTLFORGE_MAX_VERIFY_ITERS  → cfg.maxVerifyIters
 *   RTLFORGE_STRICT_CLI        → cfg.strictCli  ("true"/"false"/"1"/"0")
 */
function applyEnvOverrides(cfg) {
  const env = process.env;
  const out = Object.assign({}, cfg);
  if (env.RTLFORGE_PROVIDER)         out.provider         = env.RTLFORGE_PROVIDER;
  if (env.RTLFORGE_MODEL)            out.model            = env.RTLFORGE_MODEL;
  if (env.RTLFORGE_BACKEND_URL)      out.backendUrl       = env.RTLFORGE_BACKEND_URL;
  if (env.RTLFORGE_MAX_LINT_ITERS)   out.maxLintIters     = parseInt(env.RTLFORGE_MAX_LINT_ITERS, 10);
  if (env.RTLFORGE_MAX_VERIFY_ITERS) out.maxVerifyIters   = parseInt(env.RTLFORGE_MAX_VERIFY_ITERS, 10);
  if (env.RTLFORGE_STRICT_CLI != null) {
    out.strictCli = /^(1|true|yes|on)$/i.test(env.RTLFORGE_STRICT_CLI);
  }
  return out;
}

/**
 * Build the effective config by walking the resolution chain.
 *
 * @param {object} [opts]
 * @param {object} [opts.flags]   - Final-priority flat object overlay (CLI flags)
 * @param {string} [opts.cwd]     - Project root (default process.cwd())
 * @param {boolean} [opts.skipFiles]  - Skip file reads (for tests)
 * @returns {object} effective config (no apiKey field — fetch via loadApiKey)
 */
export function loadConfig(opts) {
  const o = opts || {};
  let cfg = Object.assign({}, DEFAULT_CONFIG, {
    optionalStages: Object.assign({}, DEFAULT_CONFIG.optionalStages),
  });

  if (!o.skipFiles) {
    const userCfg = readJsonIfExists(userConfigPath());
    cfg = mergeConfig(cfg, userCfg);

    const projCfg = readJsonIfExists(projectConfigPath(o.cwd));
    cfg = mergeConfig(cfg, projCfg);
  }

  cfg = applyEnvOverrides(cfg);

  if (o.flags) cfg = mergeConfig(cfg, o.flags);

  return cfg;
}

/**
 * Two-level merge: top-level shallow + `optionalStages` shallow.
 * This is enough for the current shape; if config grows nested objects
 * later we'll need a deeper merge.
 */
function mergeConfig(base, overlay) {
  if (!overlay || typeof overlay !== "object") return base;
  const out = Object.assign({}, base, overlay);
  if (overlay.optionalStages || base.optionalStages) {
    out.optionalStages = Object.assign({},
      base.optionalStages || {}, overlay.optionalStages || {});
  }
  return out;
}

/**
 * Persist `cfg` to ~/.rtlforge/config.json. Creates the directory if missing.
 * Strips any apiKey field defensively — keys go in auth.json only.
 */
export function saveUserConfig(cfg) {
  const dir = rtlforgeHome();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const sanitized = Object.assign({}, cfg);
  delete sanitized.apiKey;
  fs.writeFileSync(userConfigPath(), JSON.stringify(sanitized, null, 2) + "\n", { mode: 0o644 });
  return userConfigPath();
}

/**
 * Persist `apiKey` for a provider in auth.json (mode 0600).
 */
export function saveApiKey(provider, apiKey) {
  const dir = rtlforgeHome();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const authPath = userAuthPath();
  let auth = {};
  if (fs.existsSync(authPath)) {
    try { auth = JSON.parse(fs.readFileSync(authPath, "utf8")) || {}; }
    catch (_) { auth = {}; }
  }
  auth[provider] = Object.assign({}, auth[provider] || {}, { apiKey });
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  // Force mode in case the file pre-existed with looser perms
  try { fs.chmodSync(authPath, 0o600); } catch (_) { /* best effort */ }
  return authPath;
}

// Exported for tests
export const _internal = { mergeConfig, applyEnvOverrides, DEFAULT_CONFIG };
