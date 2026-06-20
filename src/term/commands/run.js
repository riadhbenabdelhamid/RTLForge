// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/commands/run — Drive the pipeline for a single module
//
//   rtlforge run "<description>" [options]
//   rtlforge run --file <description.txt>
//   rtlforge run --module <name>           # name to use; otherwise extracted
//
// Options:
//   --resume <projectId>      load existing checkpoint and continue
//   --no-checkpoint           don't persist progress
//   --stage <id|key>          stop after this stage
//   --until <id|key>          run through (and including) this stage
//   --semi                    semi-auto: only run elicit, then exit
//   --no-color                disable ANSI colors
//
// Returns: exit code 0 on success, 1 on stage failure, 2 on usage error.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import { loadConfig, loadApiKey } from "../config.js";
import { createFsStorage } from "../fsStorage.js";
import { createStore } from "../store.js";
import { ALL_STAGES, getActiveStages } from "../../constants/stages.js";
import { createProgressRenderer } from "../progress.js";
import { c, ICON, heading } from "../format.js";
import { openDb, insertEvent, summarizeRun, synthStateFromStageData } from "../../observer/index.js";
import { runEvalGate } from "../../eval/gate.js";
import { normalizeEvalConfig } from "../../eval/criteria.js";
import { estimateCost } from "../../llm/cost.js";

function resolveStageRef(ref) {
  if (ref == null) return null;
  if (typeof ref === "number" || /^\d+$/.test(ref)) {
    const id = parseInt(ref, 10);
    return ALL_STAGES.find(function(s) { return s.id === id; }) || null;
  }
  return ALL_STAGES.find(function(s) { return s.key === ref || s.label.toLowerCase() === String(ref).toLowerCase(); }) || null;
}

export async function cmdRun(args) {
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
    process.stderr.write("usage: rtlforge run \"<description>\"\n");
    process.stderr.write("       rtlforge run --file <path>\n");
    process.stderr.write("       rtlforge run --resume <projectId>\n");
    return 2;
  }

  // ── Config + auth ────────────────────────────────────────────────────
  const config = loadConfig({ flags: stripStoreFlags(args) });
  const apiKey = loadApiKey(config.provider);
  if (!apiKey && config.provider !== "ollama") {
    process.stderr.write(c.red("error:") + " no API key for provider " + c.bold(config.provider) + "\n");
    process.stderr.write("       set with: rtlforge config login --provider " + config.provider + "\n");
    process.stderr.write("       or env:   ANTHROPIC_API_KEY=... (or RTLFORGE_API_KEY=...)\n");
    return 2;
  }
  // Inject the key into the config the pipeline sees, but it never gets
  // persisted (serializeCheckpoint drops the field explicitly, and we
  // don't write it back via saveUserConfig either).
  const runtimeConfig = Object.assign({}, config, { apiKey: apiKey });

  // ── Build store ──────────────────────────────────────────────────────
  const useCheckpoint = !args["no-checkpoint"];
  const storage = useCheckpoint ? createFsStorage() : null;
  const store = createStore({
    config: runtimeConfig,
    storage: storage,
    projectId: args.resume || undefined,
  });

  if (args.resume) {
    const loaded = await store.loadCheckpoint();
    if (!loaded) {
      process.stderr.write(c.red("error:") + " no checkpoint found for project " + args.resume + "\n");
      return 1;
    }
    process.stdout.write(c.green("✓") + " resumed project " + c.bold(args.resume) + "\n");
  }

  // ── Determine target stages ──────────────────────────────────────────
  const activeStages = getActiveStages(runtimeConfig);
  let stopAt = null;
  if (args.until) stopAt = resolveStageRef(args.until);
  else if (args.stage) stopAt = resolveStageRef(args.stage);
  if ((args.until || args.stage) && !stopAt) {
    process.stderr.write(c.red("error:") + " unknown stage: " + (args.until || args.stage) + "\n");
    return 2;
  }

  const stagesToRun = stopAt
    ? activeStages.slice(0, activeStages.findIndex(function(s) { return s.id === stopAt.id; }) + 1)
    : activeStages.slice();

  if (stagesToRun.length === 0) {
    process.stderr.write(c.red("error:") + " no stages selected (check --stage / --until / optional-stages config)\n");
    return 2;
  }

  // ── Module setup ─────────────────────────────────────────────────────
  const modName = args.module || (args.resume ? store.getState().activeModId : null) || "design";
  store.ensureModule(modName);

  // ── Progress renderer ────────────────────────────────────────────────
  process.stdout.write(heading("RTL Forge — " + modName) + "\n");
  if (userDesc) {
    process.stdout.write(c.dim("description: ") + userDesc.slice(0, 100) + (userDesc.length > 100 ? "…" : "") + "\n");
  }
  process.stdout.write(c.dim("project:     ") + store.projectId + "\n");
  process.stdout.write(c.dim("provider:    ") + runtimeConfig.provider + " / " + runtimeConfig.model + "\n");
  if (runtimeConfig.backendUrl) process.stdout.write(c.dim("backend:     ") + runtimeConfig.backendUrl + "\n");
  process.stdout.write(c.dim("stages:      ") + stagesToRun.map(function(s) { return s.label; }).join(" → ") + "\n");
  process.stdout.write("\n");

  const progress = createProgressRenderer(stagesToRun);
  progress.paint();

  // ── Drive each stage in order ─────────────────────────────────────────
  let lastError = null;
  for (let i = 0; i < stagesToRun.length; i++) {
    const stage = stagesToRun[i];
    const completed = (store.activeMod() && store.activeMod().completed) || new Set();
    if (completed.has(stage.id)) {
      progress.finish(stage.id, "ok", "(already complete)");
      continue;
    }

    progress.start(stage.id);

    try {
      const result = await store.runStage({
        stageId: stage.id,
        stageKey: stage.key,
        targetModId: modName,
        overrideDesc: userDesc,
        trigger: "auto",
      });
      if (result && result.ok === false) {
        const errMsg = (result.error && result.error.message) || result.error || "stage failed";
        progress.finish(stage.id, "fail", String(errMsg).slice(0, 60));
        lastError = errMsg;
        break;
      }
      // Did the stage produce a functional failure but not throw?
      const sd = (store.activeMod() && store.activeMod().stageData) || {};
      const d = sd[stage.id];
      const funcFail = d && (d.status === "FAIL" || d.overall === "FAIL" ||
        (d.fail != null && d.fail > 0) || d.verdict === "NEEDS_FIX");
      progress.finish(stage.id, funcFail ? "warn" : "ok",
        funcFail ? "func-fail (" + ((d.fail != null) ? d.fail + " fail" : d.status || "needs fix") + ")" : null);

      if (useCheckpoint) {
        try { await store.saveCheckpoint(); }
        catch (e) { /* don't fail the run on checkpoint persistence error */ }
      }
    } catch (e) {
      progress.finish(stage.id, "fail", (e && e.message ? e.message : String(e)).slice(0, 60));
      lastError = e;
      break;
    }
  }

  progress.flush();
  process.stdout.write("\n");

  if (lastError) {
    process.stderr.write(c.red("✗") + " pipeline halted: " + (lastError.message || lastError) + "\n");
    if (useCheckpoint) {
      process.stderr.write(c.dim("  resume with: ") + "rtlforge run --resume " + store.projectId + "\n");
    }
    return 1;
  }

  // Record a deterministic run_summary (local, no LLM) so `observe trends` can
  // chart cost + gate-PASS rate over time. Opt out: config trackRunSummaries=false.
  if (runtimeConfig.trackRunSummaries !== false) {
    try { await recordRunSummary(store, runtimeConfig, modName); }
    catch (_e) { /* telemetry is best-effort — never fail the run */ }
  }

  process.stdout.write(c.green("✓") + " pipeline complete\n");
  if (useCheckpoint) {
    process.stdout.write(c.dim("  project saved as: ") + store.projectId + "\n");
    process.stdout.write(c.dim("  export with: ") + "rtlforge export " + store.projectId + "\n");
  }
  return 0;
}

/**
 * Persist a per-run summary into the observer DB (event_kind "run_summary").
 * Pure-deterministic: it runs the eval gate over the finished stageData and
 * folds in token cost — no LLM, no network. A no-op when better-sqlite3 is
 * absent (handle.available === false).
 */
async function recordRunSummary(store, config, modName) {
  const mod = store.activeMod();
  const sd = (mod && mod.stageData) || {};
  const verdict = runEvalGate(synthStateFromStageData(sd), normalizeEvalConfig(config.evalCriteria || {}).config);
  const summary = summarizeRun({
    stageData:    sd,
    verdict:      verdict,
    estimateCost: estimateCost,
    provider:     config.provider,
    model:        config.model,
    ts:           Date.now(),
  });
  const handle = await openDb(config);
  if (!handle.available) return;
  insertEvent(handle, {
    ts:         summary.ts,
    workflow:   config.workflow || "rtl",
    project_id: store.projectId,
    module_id:  modName,
    event_kind: "run_summary",
    extracted:  summary,
    severity:   "info",
  });
}

/**
 * The argv parser places store-management flags into the same flat object
 * as config-overlay flags. Strip the ones we don't want bleeding into the
 * effective config.
 */
function stripStoreFlags(args) {
  const out = Object.assign({}, args);
  delete out._;
  delete out.resume;
  delete out["no-checkpoint"];
  delete out.stage;
  delete out.until;
  delete out.semi;
  delete out.module;
  delete out.file;
  delete out["no-color"];
  return out;
}
