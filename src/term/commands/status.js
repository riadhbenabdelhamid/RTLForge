// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/commands/status — Show the state of one or all saved projects
//
//   rtlforge status                  # list all projects
//   rtlforge status <projectId>      # detail view for one project
// ═══════════════════════════════════════════════════════════════════════════

import { loadConfig } from "../config.js";
import { createFsStorage } from "../fsStorage.js";
import { createStore } from "../store.js";
import { getActiveStages } from "../../constants/stages.js";
import { c, ICON, table, heading, duration } from "../format.js";

export async function cmdStatus(args) {
  const config = loadConfig({ flags: args });
  const storage = createFsStorage();

  const projectId = args._[0];

  if (!projectId) {
    // List all projects
    const store = createStore({ config: config, storage: storage });
    const index = await store.listCheckpoints();
    if (!index || index.length === 0) {
      process.stdout.write(c.dim("(no saved projects)") + "\n");
      process.stdout.write(c.dim("start one with: ") + "rtlforge run \"<your design description>\"\n");
      return 0;
    }
    const rows = index.map(function(e) {
      const ts = e.timestamp ? new Date(e.timestamp) : null;
      return {
        projectId: e.projectId,
        modules:   e.moduleCount,
        progress:  e.completedStages + "/" + e.totalStages,
        furthest:  e.furthestStage || "—",
        when:      ts ? duration(Date.now() - ts.getTime()) + " ago" : "—",
        desc:      (e.userDesc || "").slice(0, 40) || c.dim("(no description)"),
      };
    });
    process.stdout.write(heading("Saved projects (" + rows.length + ")") + "\n");
    process.stdout.write(table([
      { key: "projectId", label: "ID" },
      { key: "modules",   label: "Mods", align: "right" },
      { key: "progress",  label: "Stages", align: "right" },
      { key: "furthest",  label: "Furthest" },
      { key: "when",      label: "Updated" },
      { key: "desc",      label: "Description" },
    ], rows) + "\n");
    return 0;
  }

  // Detail view for one project
  const store = createStore({ config: config, storage: storage, projectId: projectId });
  const loaded = await store.loadCheckpoint();
  if (!loaded) {
    process.stderr.write(c.red("error:") + " no checkpoint found for project " + c.bold(projectId) + "\n");
    return 1;
  }
  const state = store.getState();
  const activeStages = getActiveStages(loaded.uiState && loaded.uiState.config || config);

  process.stdout.write(heading("Project " + c.bold(projectId)) + "\n");
  process.stdout.write("  " + c.dim("active module:") + " " + (state.activeModId || "—") + "\n");
  process.stdout.write("  " + c.dim("phase:")         + " " + (state.projectPhase || "—") + "\n");
  process.stdout.write("\n");

  const mods = Object.keys(state.modules || {});
  if (mods.length === 0) {
    process.stdout.write(c.dim("(no modules)") + "\n");
    return 0;
  }

  for (const modId of mods) {
    const mod = state.modules[modId];
    process.stdout.write(c.bold("module " + modId) + "\n");
    const completed = mod.completed || new Set();
    const errors = mod.stageErrors || {};
    const sd = mod.stageData || {};
    const rows = activeStages.map(function(s) {
      let icon, label;
      if (errors[s.id]) {
        icon = ICON.fail();
        label = c.red("FAIL");
      } else if (completed.has && completed.has(s.id)) {
        // Functional fail check — mirrors the GUI logic
        const d = sd[s.id];
        const funcFail = d && (d.status === "FAIL" || d.overall === "FAIL" ||
          (d.fail != null && d.fail > 0) || d.verdict === "NEEDS_FIX");
        icon = funcFail ? ICON.warn() : ICON.ok();
        label = funcFail ? c.yellow("FUNC-FAIL") : c.green("ok");
      } else {
        icon = ICON.pending();
        label = c.dim("pending");
      }
      return { icon: icon, id: s.id, name: s.label, status: label };
    });
    process.stdout.write(table([
      { key: "icon",   label: "" },
      { key: "id",     label: "#", align: "right" },
      { key: "name",   label: "Stage" },
      { key: "status", label: "Status" },
    ], rows) + "\n\n");
  }
  return 0;
}
