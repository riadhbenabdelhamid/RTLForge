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
  // Per-stage model routing (constants/providers.js getStageConfig). Maps a
  // stage key to {provider, model, apiKey?, baseUrl?}, honored at highest
  // precedence — decorrelate the TB writer/reviewer from the RTL writer, or
  // route cheap stages to a cheaper model. Empty by default.
  modelRouting: {},
  // Pipeline knobs — match the GUI's defaults
  maxLintIters: 3,
  maxVerifyIters: 3,
  strictCli: true,
  // Optional pipeline stages (toggle from CLI with `rtlforge config set`)
  optionalStages: {
    rtl_review:   true,
    formal_props: false,
    formal_verify: false,
    lint:         true,
    test_review:  true,
    lint_test:    true,
  },
  // Backend (verilator CLI bridge) — opt-in
  backendUrl: null,
  backendTimeoutSec: 600,
  cliRetryCount: 1,
  // Truncation recovery (llm/callLLM.js): auto-retry with a doubled token
  // cap when the provider reports a length-cut output, up to the ceiling.
  truncationRetries: 2,
  maxTokensCeiling: 16384,
  // Structured outputs (llm/callLLM.js, docs/improvement-roadmap.md #1):
  // constrain JSON-stage decoding to a schema on providers that support it
  // (OpenAI-compat response_format, Ollama format). ON by default — this is a
  // transport-correctness feature; set false as the escape hatch for a server
  // that misbehaves with schemas.
  structuredOutputs: true,
  // Patch-mode fix loops (pipeline/applyEdits.js, docs/improvement-roadmap.md
  // #2): fix prompts return exact-match edits instead of the whole file —
  // ~10× smaller outputs, no truncation ladder. Fail-closed (a non-applying
  // edit falls back to one full-file ask). Off until the acceptance A/B passes.
  fixPatchMode: false,
  // Local-provider circuit breaker (llm/callLLM.js, roadmap #6): on a
  // network-class failure against a localhost provider, probe GET /models and
  // wait for the server to finish reloading (LM Studio model swaps take
  // 30-90s) instead of burning the retry ladder. 0 disables.
  localRecoveryTimeoutSec: 120,
  // Waveform-grounded verify fixes (pipeline/vcdWindow.js, roadmap #7): dump a
  // VCD during verify sims (local backend only) and lead failing-test fix
  // prompts with a compact signal window around the first failure. Off until
  // the acceptance A/B on a strong model.
  waveGroundedFixes: false,
  // Formal BMC stage (cli/formalRunner.js, roadmap #8): SymbiYosys bounded
  // model check of the bound SVA properties. Needs `sby` on PATH.
  formalDepth: 15,
  formalTimeoutSec: 120,
  maxFormalIters: 2,   // LLM fix iterations when BMC finds a violation
  // Integration fix loop (projectState/runIntegrationPipeline.js, SoC S3):
  // cap on inline repair iterations per integration stage (top wiring / system
  // TB). Only active with a real backend — estimates are never fixed against.
  maxIntegrationIters: 2,
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
  // Wall-clock brake, ON by default (docs/reliability.md R3): no stage's loops
  // run past this many minutes — nested reflow chains share the stage clock.
  // Graceful: best-known state kept, honest status. 0 = unlimited.
  maxStageMinutes: 20,
  // Mutation gate (pipeline/mutation.js): inject bugs into passing RTL and
  // require the TB to catch them. Off by default (one compile+sim per
  // mutant). Pair with the mutation_score eval criterion for a hard gate.
  mutationTesting: false,
  mutationMaxMutants: 5,
  // Coverage strengthening (pipeline/coverageStrengthen.js): after a real-CLI
  // verify PASS, ADD tests for weak coverage + uncovered requirements, adopting
  // only if it provably helps. Off by default (one LLM call + compile+sim per
  // round). Thresholds come from the enabled coverage eval criteria.
  coverageStrengthening: false,
  coverageStrengthenRounds: 2,
  // Errors-to-avoid (pipeline/errorsToAvoid.js): harvest recurring lint errors
  // across runs and inject the top ones into cold RTL/TB generation. Off by
  // default; catalog persisted at ~/.rtlforge/errors-to-avoid.json.
  errorsToAvoid: false,
  // Part E (docs/training-mode.md): each harvested lesson is attributed to the
  // model whose code triggered it. When false (default) a model is injected only
  // with its OWN lessons (plus unattributed/legacy ones); true lets one model's
  // errors steer another model's generation.
  errorsToAvoidCrossModel: false,
  // Bundled trained-knowledge packs (pipeline/knowledgePacks.js, Path B): a
  // single opt-in switch. When on, every shipped rule pack whose model matches
  // the ACTIVE model is auto-appended to cold RTL/TB generation. Off by default;
  // inert on any model without a matching pack.
  useShippedRules: false,
  // Deterministic syntax repair (pipeline/syntaxRepair.js, docs/syntax-repair.md):
  // mechanical fixes on freshly generated RTL/TB code (missing [:0] bounds,
  // bare compiler directives, VHDL-style ports, decimal 'b literals, mid-block
  // declarations) BEFORE the first lint — zero LLM cost. ON by default
  // (docs/reliability.md R5): conservative by construction (fires only on
  // constructs invalid where they stand), and the dominant local-model lint
  // errors are exactly these mechanical classes.
  syntaxRepair: true,
  // Nested reflow iteration clamps (docs/reliability.md R4): a chain entry
  // inside a judge/verify/review reflow gets ONE fix iteration instead of the
  // full base cap — per-level caps bound loops, not the tree (measured: null
  // defaults produced 140 rtl regens inside one judge stage). null = old
  // full-cap resets.
  nestedLintIters: 1,
  nestedVerifyIters: 1,
  // Training mode (pipeline/training.js, docs/training-mode.md): stop the run at
  // lint (rtl) / lint_test (tb) to harvest + distil errors cheaply and grow a
  // per-model rule corpus. Off by default; set per-run by `rtlforge train` or
  // the GUI Training tab. trainingMode also implies errorsToAvoid for the run.
  trainingMode: "",                 // "" | "rtl" | "tb"
  trainingLoop: "single",           // "single" | "refine"  (Q1)
  trainingRefineMaxPasses: 4,       // cap for the refine loop on one spec
  trainingRuleExpansion: "table",   // "table" | "model"    (Q2)
  trainingAuto: false,              // source specs automatically + self-terminate
  trainingAutoSource: "adaptive",   // "corpus" | "corpus+mutation" | "synth" | "adaptive"
  trainingSeedsPerSpec: 1,          // generations per sourced spec (seed variation)
  trainingAutoMaxRuns: 20,          // budget: hard cap on sourced specs
  trainingAutoMaxMinutes: 30,       // budget: wall-clock cap
  trainingAutoMaxLlmCalls: null,    // budget: LLM-call cap (null = unbounded)
  trainingSaturationWindow: 3,      // stop after N passes that add no new signature
  // Best-of-N cold generation (pipeline/bestOfN.js): draw N RTL/TB candidates at
  // cold generation and keep the one that compiles cleanest under Verilator.
  // 1 = off. Requires a backend (the selector). Clamped to [1,8]. Each extra
  // candidate costs one generation + one lint, so it is off by default.
  bestOfN: 1,
  bestOfNTemp: 0.7,
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
  if (env.RTLFORGE_BEST_OF_N)        out.bestOfN          = parseInt(env.RTLFORGE_BEST_OF_N, 10);
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
