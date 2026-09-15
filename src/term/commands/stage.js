// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/commands/stage — Run a single pipeline stage
//
//   rtlforge stage <stage-id-or-key> --project <projectId> [--module <name>]
//
// Useful for re-running a single stage without redoing the whole pipeline,
// e.g. after editing the spec or testbench by hand.
// ═══════════════════════════════════════════════════════════════════════════

import { loadConfig, loadApiKey } from "../config.js";
import { createFsStorage } from "../fsStorage.js";
import { createStore } from "../store.js";
import { ALL_STAGES } from "../../constants/stages.js";
import { c, ICON, heading } from "../format.js";
import { outcomePresentation, UNVERIFIED_EXPLANATION } from "../../utils/verificationPresentation.js";
import { printVerificationSummary } from "../verificationSummary.js";

function resolveStage(ref) {
  if (ref == null) return null;
  if (/^\d+$/.test(ref)) {
    const id = parseInt(ref, 10);
    return ALL_STAGES.find(function(s) { return s.id === id; }) || null;
  }
  return ALL_STAGES.find(function(s) { return s.key === ref || s.label.toLowerCase() === String(ref).toLowerCase(); }) || null;
}

export async function cmdStage(args) {
  const stageRef = args._[0];
  const stage = resolveStage(stageRef);
  if (!stage) {
    process.stderr.write(c.red("error:") + " unknown stage: " + (stageRef || "(missing)") + "\n");
    process.stderr.write("       known stages: " + ALL_STAGES.map(function(s) { return s.id + ":" + s.key; }).join(", ") + "\n");
    return 2;
  }
  const projectId = args.project;
  if (!projectId) {
    process.stderr.write(c.red("error:") + " missing --project <id>\n");
    return 2;
  }

  const config = loadConfig({ flags: args });
  const apiKey = loadApiKey(config.provider);
  if (!apiKey && config.provider !== "ollama") {
    process.stderr.write(c.red("error:") + " no API key for " + config.provider + "\n");
    return 2;
  }
  const runtimeConfig = Object.assign({}, config, { apiKey: apiKey });
  const storage = createFsStorage();
  const store = createStore({ config: runtimeConfig, storage: storage, projectId: projectId });
  const loaded = await store.loadCheckpoint();
  if (!loaded) {
    process.stderr.write(c.red("error:") + " no checkpoint found for project " + projectId + "\n");
    return 1;
  }
  const modName = args.module || store.getState().activeModId;
  if (!modName) {
    process.stderr.write(c.red("error:") + " no active module — pass --module <name>\n");
    return 1;
  }

  process.stdout.write(heading("Re-running " + stage.label + " for " + modName) + "\n");

  try {
    const result = await store.runStage({
      stageId:    stage.id,
      stageKey:   stage.key,
      targetModId: modName,
      trigger:    "manual",
    });
    if (result && result.ok === false) {
      process.stderr.write(c.red(ICON.fail() + " " + (result.error || "stage failed")) + "\n");
      return 1;
    }
    await store.saveCheckpoint();
    const sd = store.getState().modules?.[modName]?.stageData || {};
    const outcome = outcomePresentation(sd[stage.id]);
    const color = outcome.unresolved ? c.yellow : outcome.failed ? c.red : c.green;
    const icon = outcome.unresolved ? ICON.warn() : outcome.failed ? ICON.fail() : ICON.ok();
    process.stdout.write(color(icon + " " + stage.label + " " + (outcome.unresolved || outcome.failed ? outcome.status : "complete")) + "\n");
    if ([8, 9, 13].includes(stage.id)) printVerificationSummary(sd);
    else if (outcome.status === "UNVERIFIED") process.stdout.write(UNVERIFIED_EXPLANATION + "\n");
    return 0;
  } catch (e) {
    process.stderr.write(c.red(ICON.fail() + " " + (e.message || e)) + "\n");
    return 1;
  }
}
