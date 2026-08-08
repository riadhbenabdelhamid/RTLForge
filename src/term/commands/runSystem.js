// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/commands/runSystem — Headless multi-module (SoC) run (SoC roadmap S7)
//
//   rtlforge run --system "<description>" [--yes] [options]
//   rtlforge run --system --file <description.txt>
//   rtlforge run --system --resume <projectId>
//
// Flow: decompose → print the module tree → confirm (or --yes) → dependency-
// ordered per-module walk (runAllPipelines; parallelModules honored via
// config) → integration with real lint/sim (S1), fix loops and automatic
// reflowTarget consumption (S3) → checkpoint saved for `rtlforge export
// <id> --all`.
//
// Options (in addition to the shared run options):
//   --yes             skip the decomposition confirmation (required when
//                     stdin is not a TTY, e.g. CI)
//
// Exit codes: 0 system complete + integration judge PASS · 1 failure ·
// 2 usage error.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import readline from "node:readline";
import { loadConfig, loadApiKey } from "../config.js";
import { attachLLMHooks } from "../llmHooks.js";
import { createFsStorage } from "../fsStorage.js";
import { createStore } from "../store.js";
import {
  blankModule,
  runStage as runStageCore,
  runIntegrationPipeline as runIntegrationPipelineCore,
  MODULE_UPSERT,
  INSTANCES_SET,
  DECOMPOSITION_SET,
  SET_ACTIVE_MOD,
  LEDGER_APPEND,
  MODULE_STAGE_RUN_START,
  MODULE_STAGE_COMPLETE,
  MODULE_STAGE_ERROR_SET,
  INTEGRATION_STAGE_COMPLETE,
  INTEGRATION_STAGE_ERROR_SET,
} from "../../projectState/index.js";
import { callLLM, extractJSON, addRetryHint } from "../../llm/index.js";
import { estimateCost } from "../../llm/cost.js";
import { promptDecompose, promptSharedPackage } from "../../prompts/index.js";
import { DECOMP_SCHEMA } from "../../prompts/schemas.js";
import { ALL_STAGES } from "../../constants/stages.js";
import { c, heading } from "../format.js";

/**
 * Decompose a system description into modules + instances, with the same
 * robustness the pipeline nodes get, applied at BOTH levels a weak model
 * fails at (each measured live on lfm2-24b):
 *   syntax   — schema-constrained decoding + hinted re-ask on parse failure
 *   semantics — sanitize each attempt; an unusable result (no top module,
 *               zero valid instances after dropping inconsistent IDs)
 *               retries with a corrective hint naming the inconsistency
 * Truncated responses double maxTokens and retry (GUI parity).
 * @returns {Promise<{decomp, dropped, fixed, llms}>}  throws on hard failure
 */
export async function decomposeSystem(opts) {
  const llm = opts.callLLM;
  const extract = opts.extractJSON;
  const maxRetries = 3;
  let maxTokens = 8000;
  const llms = [];
  let lastErr = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const dp = promptDecompose(opts.userDesc, opts.availableModules || [], true);
      dp.maxTokens = maxTokens;
      // Planning call, not generation: decode deterministically. The
      // corrective hints change the input on each retry, so retries still
      // explore even at temperature 0.
      dp.config = Object.assign({}, opts.config, { temperature: 0 });
      dp.jsonSchema = DECOMP_SCHEMA;
      if (lastErr && lastErr._semantic) {
        dp.userMessage += "\n\n⚠ RETRY — your previous decomposition was inconsistent:\n"
          + lastErr.message + "\n"
          + "Every \"moduleId\", \"parentModuleId\", and \"topModule\" value MUST exactly "
          + "match a \"modId\" defined in \"modules\", and a module is instantiated inside "
          + "a DIFFERENT module, never inside itself.";
      } else if (lastErr) {
        // addRetryHint wants the message STRING and only reacts to parse/
        // truncation errors — unrelated failures retry unhinted.
        addRetryHint(dp, (lastErr && lastErr.message) || String(lastErr));
      }
      const dr = await llm(dp);
      llms.push(dr);
      const truncated = dr.stopReason === "max_tokens" || dr.stopReason === "length";
      if (truncated && attempt < maxRetries - 1) { maxTokens *= 2; continue; }
      const decomp = extract(dr.text);

      // A "single" classification is the caller's decision, not a defect.
      if (decomp.type === "single" || !decomp.modules || decomp.modules.length < 2) {
        return { decomp, dropped: [], fixed: [], llms };
      }
      const s = sanitizeDecomposition(decomp);
      if (s.decomp.topModule && (s.decomp.instances || []).length > 0) {
        return { decomp: s.decomp, dropped: s.dropped, fixed: s.fixed, llms };
      }
      lastErr = new Error("unusable after dropping inconsistent entries — " + s.dropped.join("; "));
      lastErr._semantic = true;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("decompose failed after " + maxRetries + " attempts: "
    + ((lastErr && lastErr.message) || "unknown error"));
}

/** Render the decomposition as an instance tree rooted at the top module. */
export function formatDecompTree(decomp) {
  const mods = decomp.modules || [];
  const insts = decomp.instances || [];
  const byParent = {};
  insts.forEach(function(i) {
    (byParent[i.parentModuleId] = byParent[i.parentModuleId] || []).push(i);
  });
  const lines = [];
  function walk(modId, prefix, seen) {
    if (seen.has(modId)) { lines.push(prefix + "… (cycle: " + modId + ")"); return; }
    const nextSeen = new Set(seen); nextSeen.add(modId);
    const kids = byParent[modId] || [];
    kids.forEach(function(inst, i) {
      const last = i === kids.length - 1;
      const over = Object.keys(inst.paramOverrides || {})
        .map(function(k) { return k + "=" + inst.paramOverrides[k]; }).join(", ");
      lines.push(prefix + (last ? "└─ " : "├─ ") + inst.instanceName + " : "
        + inst.moduleId + (over ? "  (" + over + ")" : ""));
      walk(inst.moduleId, prefix + (last ? "   " : "│  "), nextSeen);
    });
  }
  lines.push((decomp.systemName || decomp.topModule || "system") + "  —  top: " + decomp.topModule);
  walk(decomp.topModule, "", new Set());
  const modSummary = mods.map(function(m) { return m.modId + (m.level != null ? " (L" + m.level + ")" : ""); }).join(", ");
  lines.push(mods.length + " module(s): " + modSummary + " · " + insts.length + " instance(s)");
  return lines.join("\n");
}

/**
 * Repair decomposition defects a weak model actually produces (all measured
 * on lfm2-24b): instances referencing undefined modules, SELF-instantiations
 * (a module placed inside itself — deadlocks the dependency walk), and a
 * missing/unknown topModule. The GUI's review screen lets a human catch
 * these; the headless --yes path must defend itself. Pure.
 * @returns {{decomp: object, dropped: string[], fixed: string[]}}
 */
export function sanitizeDecomposition(decomp) {
  const known = new Set((decomp.modules || []).map(function(m) { return m.modId; }));
  const dropped = [];
  const fixed = [];
  const instances = (decomp.instances || []).filter(function(inst) {
    if (inst.moduleId === inst.parentModuleId) {
      dropped.push("instance '" + inst.instId + "' places module '" + inst.moduleId + "' inside itself");
      return false;
    }
    const ok = known.has(inst.moduleId) && known.has(inst.parentModuleId);
    if (!ok) {
      dropped.push("instance '" + inst.instId + "' references undefined module '"
        + (known.has(inst.moduleId) ? inst.parentModuleId : inst.moduleId) + "'");
    }
    return ok;
  });

  let topModule = decomp.topModule;
  if (topModule && !known.has(topModule)) {
    dropped.push("topModule '" + topModule + "' is not a defined module");
    topModule = null;
  }
  if (!topModule) {
    // Infer: the top is the only module never placed as a child. When
    // several are unplaced, the decompose levels break the tie (L0 = top)
    // if exactly one root sits at the minimum level.
    const placed = new Set(instances.map(function(i) { return i.moduleId; }));
    let roots = (decomp.modules || []).filter(function(m) { return !placed.has(m.modId); });
    if (roots.length > 1 && roots.some(function(m) { return m.level != null; })) {
      const minLevel = Math.min.apply(null, roots.map(function(m) { return m.level != null ? m.level : Infinity; }));
      const atMin = roots.filter(function(m) { return m.level === minLevel; });
      if (atMin.length === 1) roots = atMin;
    }
    if (roots.length === 1) {
      topModule = roots[0].modId;
      fixed.push("topModule inferred as '" + topModule + "' (root of the instance tree)");
    }
  }
  const systemName = decomp.systemName
    || (topModule ? topModule + "_system" : "system");
  if (!decomp.systemName) fixed.push("systemName defaulted to '" + systemName + "'");

  return {
    decomp: Object.assign({}, decomp, { instances, topModule, systemName }),
    dropped,
    fixed,
  };
}

/** Seed the store's reducer state from a decomposition (the GUI's confirmDecomp path). */
export function seedDecomposition(dispatch, decomp) {
  (decomp.modules || []).forEach(function(m) {
    dispatch({
      type: MODULE_UPSERT, modId: m.modId,
      mod: Object.assign(blankModule(), {
        name: m.name, description: m.description, level: m.level, params: m.params || [],
      }),
    });
  });
  const instances = {};
  (decomp.instances || []).forEach(function(inst) {
    instances[inst.instId] = {
      instId: inst.instId, moduleId: inst.moduleId, parentModuleId: inst.parentModuleId,
      instanceName: inst.instanceName, paramOverrides: inst.paramOverrides || {},
      description: inst.description || "",
    };
  });
  dispatch({ type: INSTANCES_SET, instances });
  dispatch({ type: DECOMPOSITION_SET, decomposition: decomp });
  dispatch({
    type: SET_ACTIVE_MOD,
    modId: decomp.topModule || ((decomp.modules && decomp.modules[0]) ? decomp.modules[0].modId : null),
  });
}

function askYesNo(question) {
  return new Promise(function(resolve) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, function(answer) {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer).trim()));
    });
  });
}

/**
 * `rtlforge run --system` entry point. `deps` is an injection seam for tests:
 * { callLLM, extractJSON, runStage, runIntegrationPipeline (both receive the
 * live store as their last arg), confirm }.
 */
export async function cmdRunSystem(args, deps) {
  const d = deps || {};
  const llm = d.callLLM || callLLM;
  const extract = d.extractJSON || extractJSON;

  // ── Resolve description ──────────────────────────────────────────────
  let userDesc = args._.join(" ").trim();
  if (args.file) {
    if (!fs.existsSync(args.file)) {
      process.stderr.write(c.red("error:") + " file not found: " + args.file + "\n");
      return 2;
    }
    userDesc = fs.readFileSync(args.file, "utf8").trim();
  }
  if (!userDesc && !args.resume) {
    process.stderr.write(c.red("error:") + " missing description.\n");
    process.stderr.write("usage: rtlforge run --system \"<description>\" [--yes]\n");
    process.stderr.write("       rtlforge run --system --file <path>\n");
    process.stderr.write("       rtlforge run --system --resume <projectId>\n");
    return 2;
  }

  // ── Config + auth (same policy as the single-module run) ────────────
  const config = loadConfig({ flags: stripSystemFlags(args) });
  const apiKey = loadApiKey(config.provider);
  if (!apiKey && config.provider !== "ollama" && !d.callLLM) {
    process.stderr.write(c.red("error:") + " no API key for provider " + c.bold(config.provider) + "\n");
    process.stderr.write("       set with: rtlforge config login --provider " + config.provider + "\n");
    return 2;
  }
  const runtimeConfig = Object.assign({}, config, { apiKey: apiKey });
  // Same record/bridge hooks the single-module run has: a system run must be
  // recordable and bridgeable too, or the multi-module flow cannot be
  // replayed or driven by an external model.
  await attachLLMHooks(runtimeConfig, args, function(line) {
    process.stdout.write(c.dim(line) + "\n");
  });

  // ── Store ─────────────────────────────────────────────────────────────
  const useCheckpoint = !args["no-checkpoint"];
  const storage = useCheckpoint ? createFsStorage() : null;
  const store = createStore({
    config: runtimeConfig,
    storage: storage,
    projectId: args.resume || undefined,
    callLLM: llm,
    // The user's own words. Each module's pipeline attributes its paragraph
    // out of this; without it every deterministic validator downstream checks
    // decompose's paraphrase of the module against itself (run 49).
    userDesc: userDesc,
  });

  if (args.resume) {
    const loaded = await store.loadCheckpoint();
    if (!loaded) {
      process.stderr.write(c.red("error:") + " no checkpoint found for project " + args.resume + "\n");
      return 1;
    }
    process.stdout.write(c.green("✓") + " resumed project " + c.bold(args.resume) + "\n");
    process.stdout.write(c.dim("  note: the system walk re-runs each module's remaining pipeline\n"));
  }

  // ── Decompose (skip when a resume restored a module tree) ────────────
  const haveModules = Object.keys(store.getState().modules).length > 1;
  if (!haveModules) {
    process.stdout.write(heading("RTL Forge — system run") + "\n");
    process.stdout.write(c.dim("description: ") + userDesc.slice(0, 100) + (userDesc.length > 100 ? "…" : "") + "\n");
    process.stdout.write(c.dim("provider:    ") + runtimeConfig.provider + " / " + runtimeConfig.model + "\n");
    if (runtimeConfig.backendUrl) process.stdout.write(c.dim("backend:     ") + runtimeConfig.backendUrl + "\n");
    process.stdout.write(c.dim("project:     ") + store.projectId + "\n\n");
    process.stdout.write(c.dim("decomposing…") + "\n");

    let decomp, decompNotes;
    try {
      const res = await decomposeSystem({
        userDesc: userDesc, config: runtimeConfig, callLLM: llm, extractJSON: extract,
      });
      decomp = res.decomp;
      decompNotes = res;
      res.llms.forEach(function(r) {
        store.dispatch({
          type: LEDGER_APPEND,
          entry: {
            stage: "decompose", model: r.model, provider: r.provider || runtimeConfig.provider,
            tIn: r.tokensIn, tOut: r.tokensOut,
            cost: estimateCost(r.tokensIn, r.tokensOut, r.provider || runtimeConfig.provider),
            ms: r.latencyMs,
          },
        });
      });
    } catch (e) {
      process.stderr.write(c.red("✗ decompose failed: ") + ((e && e.message) || String(e)) + "\n");
      return 1;
    }

    if (decomp.type === "single" || !decomp.modules || decomp.modules.length < 2) {
      process.stderr.write(c.red("error:") + " the model classified this as a SINGLE module.\n");
      process.stderr.write("       run it without --system:  rtlforge run \"<description>\"\n");
      return 1;
    }

    // decomposeSystem already sanitized (drops + inferences below are its
    // repair notes; an unusable result retried with a corrective hint and,
    // if still unusable, threw above).
    decompNotes.dropped.forEach(function(msg) {
      process.stdout.write(c.yellow("⚠ dropped: ") + msg + "\n");
    });
    decompNotes.fixed.forEach(function(msg) {
      process.stdout.write(c.dim("· " + msg) + "\n");
    });

    process.stdout.write("\n" + formatDecompTree(decomp) + "\n\n");

    // ── Confirm the tree ────────────────────────────────────────────────
    if (!args.yes) {
      if (!process.stdin.isTTY && !d.confirm) {
        process.stderr.write(c.red("error:") + " stdin is not a TTY — pass --yes to accept the decomposition non-interactively.\n");
        return 2;
      }
      const ok = d.confirm ? await d.confirm(decomp) : await askYesNo("proceed with this decomposition? [y/N] ");
      if (!ok) {
        process.stdout.write(c.dim("aborted — nothing was run.") + "\n");
        return 0;
      }
    }

    seedDecomposition(store.dispatch, decomp);
    if (useCheckpoint) {
      try { await store.saveCheckpoint(); } catch (_e) { /* non-fatal */ }
    }
  }

  // ── Progress: line-per-event from reducer actions ─────────────────────
  const t0 = Date.now();
  const unsub = store.subscribe(function(_state, action) {
    if (action.type === MODULE_STAGE_RUN_START) {
      process.stdout.write(c.dim("▶ ") + action.modId + c.dim(" · " + action.stageKey) + "\n");
    } else if (action.type === MODULE_STAGE_COMPLETE) {
      const meta = ALL_STAGES.find(function(s) { return s.id === action.stageId; });
      process.stdout.write(c.green("  ✓ ") + action.modId + c.dim(" · " + ((meta && meta.key) || action.stageId)) + "\n");
    } else if (action.type === MODULE_STAGE_ERROR_SET) {
      process.stdout.write(c.red("  ✗ ") + action.modId + " · stage " + action.stageId
        + c.dim(" — " + String(action.message).slice(0, 80)) + "\n");
    } else if (action.type === INTEGRATION_STAGE_COMPLETE) {
      process.stdout.write(c.green("  ✓ ") + c.bold("integration") + c.dim(" · " + action.stageId) + "\n");
    } else if (action.type === INTEGRATION_STAGE_ERROR_SET) {
      process.stdout.write(c.red("  ✗ ") + c.bold("integration") + " · " + action.stageId
        + c.dim(" — " + String(action.message).slice(0, 80)) + "\n");
    }
  });

  const logger = {
    info: function(msg) { process.stdout.write(c.dim(String(msg)) + "\n"); },
    warn: function(msg) { process.stdout.write(c.yellow(String(msg)) + "\n"); },
    error: function(msg) { process.stderr.write(c.red(String(msg)) + "\n"); },
  };

  // ── Integration runner bound with change-detection hashes (GUI parity) ─
  let lastHashes = {};
  let lastIntResult = null;
  async function boundIntegration() {
    const r = d.runIntegrationPipeline
      ? await d.runIntegrationPipeline(store)
      : await runIntegrationPipelineCore({
          reducerState: store.getState(),
          uiState: { config: runtimeConfig },
          services: { callLLM: llm, extractJSON: extract, estimateCost: estimateCost, logger: logger },
          dispatch: store.dispatch,
          lastHashes: lastHashes,
        });
    if (r && r.currentHashes) lastHashes = r.currentHashes;
    lastIntResult = r;
    return r;
  }

  // ── Walk every module, then integrate (reflowTarget consumed inside) ──
  // Checkpoint after every stage so a crash/abort resumes cheaply, and skip
  // stages a resumed module already completed (single-module cmdRun parity).
  // Reflow re-runs carry trigger "reflow" and are never skipped — they
  // intentionally re-run completed stages.
  const baseRunStage = d.runStage
    ? function(a) { return d.runStage(a, store); }
    : async function(a) {
        const r = await runStageCore(a);
        if (useCheckpoint) { try { await store.saveCheckpoint(); } catch (_e) { /* non-fatal */ } }
        return r;
      };
  let result;
  try {
    result = await store.runAllPipelines("full-auto", {
      extractJSON: extract,
      promptSharedPackage: promptSharedPackage,
      logger: logger,
      runIntegrationPipeline: boundIntegration,
      runStage: async function(a) {
        const mod = store.getState().modules[a.targetModId];
        if (a.trigger === "auto" && mod && mod.completed && mod.completed.has(a.stageId)) {
          process.stdout.write(c.dim("  ↷ " + a.targetModId + " · " + (a.stageKey || a.stageId) + " (already complete)") + "\n");
          return { ok: true, skipped: true };
        }
        return baseRunStage(a);
      },
      // Keep the checkpoint on success — `rtlforge export <id> --all` reads it.
      deleteCheckpoint: null,
    });
  } finally {
    unsub();
  }

  if (useCheckpoint) {
    try { await store.saveCheckpoint(); } catch (_e) { /* non-fatal */ }
  }

  // ── Verdict ───────────────────────────────────────────────────────────
  process.stdout.write("\n");
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  if (!result || result.ok === false) {
    process.stderr.write(c.red("✗") + " system run halted: " + ((result && result.error) || "unknown error") + "\n");
    if (useCheckpoint) {
      process.stderr.write(c.dim("  resume with: ") + "rtlforge run --system --resume " + store.projectId + "\n");
    }
    return 1;
  }

  const ist = store.getState().integrationState || {};
  const judge = ist.stageData && ist.stageData.int_judge;
  const lint = ist.stageData && ist.stageData.int_lint;
  const test = ist.stageData && ist.stageData.int_test;
  process.stdout.write(heading("System verdict") + "\n");
  process.stdout.write(c.dim("modules:     ") + result.modulesCompleted + "/" + result.modulesTotal + " complete\n");
  if (lint) process.stdout.write(c.dim("int lint:    ") + lint.status + (lint.fixIterations ? c.dim(" (" + lint.fixIterations + " fix iteration(s))") : "") + "\n");
  if (test && test.verify) {
    process.stdout.write(c.dim("int sim:     ") + test.verify.pass + "/" + test.verify.total + " pass"
      + (test.verify.cli ? "" : c.yellow(" (LLM-estimated)")) + "\n");
  }
  if (judge) {
    const col = judge.overall === "PASS" ? c.green : c.red;
    process.stdout.write(c.dim("judge:       ") + col(judge.overall + " (" + (judge.score || 0) + "/100)") + "\n");
  }
  process.stdout.write(c.dim("elapsed:     ") + elapsed + "s\n");
  if (lastIntResult && lastIntResult.ok === false) {
    process.stderr.write(c.red("✗") + " integration did not converge: " + (lastIntResult.reason || lastIntResult.error) + "\n");
    if (useCheckpoint) {
      process.stderr.write(c.dim("  resume with: ") + "rtlforge run --system --resume " + store.projectId + "\n");
    }
    return 1;
  }
  if (useCheckpoint) {
    process.stdout.write(c.dim("  project saved as: ") + store.projectId + "\n");
    process.stdout.write(c.dim("  export with: ") + "rtlforge export " + store.projectId + " --all\n");
  }
  return judge && judge.overall === "PASS" ? 0 : 1;
}

/** Strip run-management flags so they don't overlay onto the effective config. */
function stripSystemFlags(args) {
  const out = Object.assign({}, args);
  delete out._;
  delete out.resume;
  delete out["no-checkpoint"];
  delete out.system;
  delete out.yes;
  delete out.file;
  delete out.module;
  delete out["no-color"];
  // The LLM-hook flags configure the RUN, not the model identity — leaving
  // them in would persist a bridge path into the checkpoint's config.
  delete out["record-llm"];
  delete out["llm-bridge"];
  delete out["llm-bridge-timeout"];
  delete out["llm-bridge-models"];
  return out;
}
