// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/commands/evals — Manage eval criteria configuration
//
//   rtlforge evals show                      — print effective config + measurement
//   rtlforge evals get <criterion>           — read one criterion's setting
//   rtlforge evals set <criterion> <field>=<value>
//                                              fields: enabled (true|false),
//                                                      threshold (0..100)
//   rtlforge evals reset [<criterion>]       — restore default(s)
//   rtlforge evals run --project <id>        — debug-run the gate against a saved project
//   rtlforge evals categories                — list category groups
//   rtlforge evals criteria                  — list every criterion id
//
// All eval criteria configuration is persisted in
// ~/.rtlforge/config.json under config.evalCriteria. The GUI's Workflow
// Settings → Evals tab edits the same blob, so a setting changed in the
// CLI shows up in the GUI on next load.
// ═══════════════════════════════════════════════════════════════════════════

import { loadConfig, saveUserConfig } from "../config.js";
import { c, ICON, table, heading } from "../format.js";
import {
  listCriteria, listCategories, getCriterion,
  defaultEvalConfig, normalizeEvalConfig,
} from "../../eval/criteria.js";
import { runEvalGate } from "../../eval/gate.js";
import { createFsStorage } from "../fsStorage.js";
import { createStore } from "../store.js";

function effectiveCriteria(config) {
  const raw = (config && config.evalCriteria) || {};
  return normalizeEvalConfig(raw).config;
}

// ── show ────────────────────────────────────────────────────────────────────
async function cmdShow(args, config) {
  const cfg = effectiveCriteria(config);
  process.stdout.write(heading("Eval criteria configuration") + "\n");

  // Group by category
  const byCat = {};
  for (const cat of listCategories()) byCat[cat] = [];
  for (const meta of listCriteria()) byCat[meta.category].push(meta);

  for (const cat of listCategories()) {
    const metas = byCat[cat];
    if (metas.length === 0) continue;
    process.stdout.write("\n" + c.bold(cat.toUpperCase()) + "\n");
    const rows = metas.map(function(m) {
      const eff = cfg[m.id];
      const enabled = eff && eff.enabled;
      const threshold = eff ? eff.threshold : m.defaultThreshold;
      return {
        id: m.id,
        label: m.label,
        enabled: enabled ? c.green("on") : c.dim("off"),
        threshold: enabled ? threshold + "%" : c.dim(threshold + "%"),
      };
    });
    process.stdout.write(table([
      { key: "id",        label: "ID" },
      { key: "label",     label: "Criterion" },
      { key: "enabled",   label: "Enabled" },
      { key: "threshold", label: "Threshold", align: "right" },
    ], rows) + "\n");
  }
  return 0;
}

// ── get ─────────────────────────────────────────────────────────────────────
async function cmdGet(args, config) {
  const id = args._[1];
  if (!id) {
    process.stderr.write(c.red("error:") + " usage: rtlforge evals get <criterion-id>\n");
    return 2;
  }
  const meta = getCriterion(id);
  if (!meta) {
    process.stderr.write(c.red("error:") + " unknown criterion: " + id + "\n");
    return 1;
  }
  const cfg = effectiveCriteria(config);
  const eff = cfg[id] || { enabled: meta.defaultEnabled, threshold: meta.defaultThreshold };
  process.stdout.write(c.bold(id) + "\n");
  process.stdout.write("  category:  " + meta.category + "\n");
  process.stdout.write("  label:     " + meta.label + "\n");
  process.stdout.write("  enabled:   " + (eff.enabled ? c.green("true") : c.dim("false")) + "\n");
  process.stdout.write("  threshold: " + eff.threshold + "%\n");
  return 0;
}

// ── set ─────────────────────────────────────────────────────────────────────
async function cmdSet(args, config) {
  const id = args._[1];
  const assignment = args._[2];
  if (!id || !assignment) {
    process.stderr.write(c.red("error:") + " usage: rtlforge evals set <criterion-id> <field>=<value>\n");
    process.stderr.write(c.dim("  fields: enabled=(true|false), threshold=(0..100)") + "\n");
    return 2;
  }
  const meta = getCriterion(id);
  if (!meta) {
    process.stderr.write(c.red("error:") + " unknown criterion: " + id + "\n");
    return 1;
  }
  const eqIdx = assignment.indexOf("=");
  if (eqIdx < 0) {
    process.stderr.write(c.red("error:") + " expected <field>=<value>, got '" + assignment + "'\n");
    return 2;
  }
  const field = assignment.slice(0, eqIdx);
  const valStr = assignment.slice(eqIdx + 1);

  // Load full config (file-only, not env-overlaid) so saveUserConfig
  // doesn't bake env vars into the file.
  const fileCfg = loadConfig({ skipFiles: false });
  if (!fileCfg.evalCriteria) fileCfg.evalCriteria = defaultEvalConfig();
  const entry = Object.assign({},
    fileCfg.evalCriteria[id] || { enabled: meta.defaultEnabled, threshold: meta.defaultThreshold });

  if (field === "enabled") {
    if (valStr === "true")       entry.enabled = true;
    else if (valStr === "false") entry.enabled = false;
    else {
      process.stderr.write(c.red("error:") + " enabled must be 'true' or 'false', got '" + valStr + "'\n");
      return 2;
    }
  } else if (field === "threshold") {
    const n = parseInt(valStr, 10);
    if (isNaN(n) || n < 0 || n > 100) {
      process.stderr.write(c.red("error:") + " threshold must be 0..100, got '" + valStr + "'\n");
      return 2;
    }
    entry.threshold = n;
  } else {
    process.stderr.write(c.red("error:") + " unknown field '" + field + "' (allowed: enabled, threshold)\n");
    return 2;
  }
  fileCfg.evalCriteria[id] = entry;
  const path = saveUserConfig(fileCfg);
  process.stdout.write(c.green("✓") + " saved " + id + "." + field + " = " + valStr + " → " + path + "\n");
  return 0;
}

// ── reset ───────────────────────────────────────────────────────────────────
async function cmdReset(args /*, config */) {
  const id = args._[1];
  const fileCfg = loadConfig({ skipFiles: false });
  if (id) {
    const meta = getCriterion(id);
    if (!meta) {
      process.stderr.write(c.red("error:") + " unknown criterion: " + id + "\n");
      return 1;
    }
    if (!fileCfg.evalCriteria) fileCfg.evalCriteria = {};
    fileCfg.evalCriteria[id] = {
      enabled: meta.defaultEnabled,
      threshold: meta.defaultThreshold,
    };
    saveUserConfig(fileCfg);
    process.stdout.write(c.green("✓") + " reset " + id + " to defaults\n");
    return 0;
  }
  // Reset all
  fileCfg.evalCriteria = defaultEvalConfig();
  saveUserConfig(fileCfg);
  process.stdout.write(c.green("✓") + " reset all eval criteria to defaults\n");
  return 0;
}

// ── run ─────────────────────────────────────────────────────────────────────
// Run the gate against a saved project to debug what's failing.
async function cmdRun(args, config) {
  const projectId = args.project || args._[1];
  if (!projectId) {
    process.stderr.write(c.red("error:") + " usage: rtlforge evals run --project <id> [--module <name>]\n");
    return 2;
  }
  const storage = createFsStorage();
  const store = createStore({ config: config, storage: storage, projectId: projectId });
  const loaded = await store.loadCheckpoint();
  if (!loaded) {
    process.stderr.write(c.red("error:") + " no checkpoint for project " + projectId + "\n");
    return 1;
  }
  const state = store.getState();
  const modName = args.module || state.activeModId;
  const mod = state.modules[modName];
  if (!mod) {
    process.stderr.write(c.red("error:") + " module not found: " + modName + "\n");
    return 1;
  }

  // Build the synthetic module-state shape that runEvalGate expects.
  // (judge.js calls runEvalGate(currentState, …) where currentState is
  // accState — a flat object keyed by stage. We unbox stageData here.)
  const sd = mod.stageData || {};
  const synthState = {
    spec:           sd[2]  || {},
    rtl_generate:   sd[4]  || {},
    formal_props:   sd[5]  || {},
    lint:           sd[6]  || {},
    test_generate:  sd[7]  || {},
    verify:         sd[8]  || {},
    judge:          sd[9]  || {},
    rtl_review:     sd[10] || {},
    test_review:    sd[11] || {},
    lint_test:      sd[12] || {},
  };

  const verdict = runEvalGate(synthState, effectiveCriteria(config));

  process.stdout.write(heading("Eval gate verdict for " + projectId + " / " + modName) + "\n");
  process.stdout.write("  " + (verdict.overall === "PASS" ? c.green(ICON.ok() + " PASS") : c.red(ICON.fail() + " FAIL")) + "\n");
  process.stdout.write("  score:        " + verdict.score + "% (" + verdict.passed + " of "
    + verdict.totalEnabled + " enabled criteria)\n\n");

  process.stdout.write(c.bold("Per-criterion results") + "\n");
  const rows = verdict.results.filter(function(r) { return r.enabled; }).map(function(r) {
    let status;
    if (r.status === "PASS") status = c.green(ICON.ok() + " PASS");
    else if (r.status === "FAIL") status = c.red(ICON.fail() + " FAIL");
    else status = c.dim("· skip");
    return {
      id: r.id,
      label: r.label,
      measured: r.measured + "%",
      threshold: r.threshold + "%",
      status: status,
      detail: r.detail || "",
    };
  });
  process.stdout.write(table([
    { key: "id",        label: "ID" },
    { key: "label",     label: "Criterion" },
    { key: "measured",  label: "Measured", align: "right" },
    { key: "threshold", label: "Need ≥",   align: "right" },
    { key: "status",    label: "Status" },
    { key: "detail",    label: "Detail" },
  ], rows) + "\n");
  return verdict.overall === "PASS" ? 0 : 1;
}

// ── categories ──────────────────────────────────────────────────────────────
async function cmdCategories() {
  const all = listCriteria();
  const byCat = {};
  for (const meta of all) {
    byCat[meta.category] = (byCat[meta.category] || 0) + 1;
  }
  const rows = listCategories().map(function(cat) {
    return { category: cat, count: byCat[cat] || 0 };
  });
  process.stdout.write(heading("Eval categories") + "\n");
  process.stdout.write(table([
    { key: "category", label: "Category" },
    { key: "count",    label: "# criteria", align: "right" },
  ], rows) + "\n");
  return 0;
}

// ── criteria ────────────────────────────────────────────────────────────────
async function cmdList() {
  const rows = listCriteria().map(function(m) {
    return {
      id: m.id,
      category: m.category,
      label: m.label,
      defaultEnabled: m.defaultEnabled ? c.green("on") : c.dim("off"),
      defaultThreshold: m.defaultThreshold + "%",
    };
  });
  process.stdout.write(heading("All registered eval criteria (" + rows.length + ")") + "\n");
  process.stdout.write(table([
    { key: "id",               label: "ID" },
    { key: "category",         label: "Category" },
    { key: "label",            label: "Label" },
    { key: "defaultEnabled",   label: "Default" },
    { key: "defaultThreshold", label: "Threshold", align: "right" },
  ], rows) + "\n");
  return 0;
}

// ── dispatch ────────────────────────────────────────────────────────────────
export async function cmdEvals(args) {
  const sub = args._[0] || "show";
  const config = loadConfig({ flags: args });

  if (sub === "show")        return cmdShow(args, config);
  if (sub === "get")         return cmdGet(args, config);
  if (sub === "set")         return cmdSet(args, config);
  if (sub === "reset")       return cmdReset(args, config);
  if (sub === "run")         return cmdRun(args, config);
  if (sub === "categories")  return cmdCategories(args, config);
  if (sub === "criteria")    return cmdList(args, config);

  process.stderr.write(c.red("error:") + " unknown evals subcommand: " + sub + "\n");
  process.stderr.write(c.dim("  try: show, get, set, reset, run, categories, criteria") + "\n");
  return 2;
}
