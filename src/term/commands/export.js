// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/commands/export — Write the generated RTL/TB/SVA to disk
//
//   rtlforge export <projectId> [--out <dir>] [--module <name>]
//
// Writes (per module):
//   <module>.sv         — RTL Gen output
//   <module>_tb.sv      — Test Gen output
//   <module>_sva.sv     — SVA props if produced
//   <module>.spec.json  — full spec object
//   <module>.report.txt — one-page summary (verdicts, coverage, warnings)
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { createFsStorage } from "../fsStorage.js";
import { createStore } from "../store.js";
import { c, ICON } from "../format.js";

function writeIf(filePath, content) {
  if (content == null || content === "") return false;
  fs.writeFileSync(filePath, content, { mode: 0o644 });
  return true;
}

function summarizeModule(mod, modName) {
  const lines = [];
  lines.push("RTL Forge — " + modName);
  lines.push("─".repeat(50));
  const sd = mod.stageData || {};
  const verifyD = sd[8];
  if (verifyD) {
    lines.push("Verify: " + (verifyD.pass || 0) + "/" + (verifyD.total || 0) + " passing"
      + (verifyD.cli ? " (CLI)" : " (LLM-est)"));
    if (verifyD.cov) {
      lines.push("Coverage: line " + (verifyD.cov.line || 0) + "%, branch " + (verifyD.cov.branch || 0) + "%, toggle " + (verifyD.cov.toggle || 0) + "%");
    }
  }
  const judgeD = sd[9];
  if (judgeD) {
    lines.push("Judge: " + (judgeD.verdict || judgeD.overall || "—"));
    // Verification provenance: a PASS only means something when the
    // underlying simulation actually ran. judge.verified is stamped by the
    // judge node's provenance gate (see judge.js); older checkpoints predate
    // that field, so fall back to the verify stage's cli flag.
    const verified = judgeD.verified != null
      ? judgeD.verified
      : !!(verifyD && verifyD.cli);
    lines.push("Verification: " + (verified
      ? "real simulation (CLI backend)"
      : "NOT verified — simulation results were LLM-estimated"));
  }
  const lintD = sd[6];
  if (lintD) {
    lines.push("Lint RTL: " + (lintD.status || "—") + ", "
      + ((lintD.errors || []).length || 0) + " errors, "
      + ((lintD.warnings || []).length || 0) + " warnings");
  }
  return lines.join("\n") + "\n";
}

export async function cmdExport(args) {
  const projectId = args._[0];

  // Fine-tuning export across EVERY saved project (roadmap #11 follow-up):
  //   rtlforge export --training-data --all [--out dir]
  if (args["training-data"] && args.all) {
    const outDir = path.resolve(args.out || "./rtlforge-training");
    fs.mkdirSync(outDir, { recursive: true, mode: 0o755 });
    const { sftPairs, repairPairs } = await import("../../pipeline/trainingExport.js");
    const config = loadConfig({ flags: args });
    const storage = createFsStorage();
    const index = await createStore({ config, storage }).listCheckpoints();
    const rows = [];
    let projects = 0;
    for (const entry of (index || [])) {
      try {
        const st = createStore({ config, storage, projectId: entry.projectId });
        if (!(await st.loadCheckpoint())) continue;
        projects++;
        const state = st.getState();
        for (const modId of Object.keys(state.modules || {})) {
          const sd = (state.modules[modId] && state.modules[modId].stageData) || {};
          const meta = { project: entry.projectId, module: modId };
          rows.push(...sftPairs(sd, meta), ...repairPairs(sd, meta));
        }
      } catch (_e) { /* a corrupt checkpoint must not sink the walk */ }
    }
    const file = path.join(outDir, "training-all.jsonl");
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    const sft = rows.filter((r) => r.meta.kind.startsWith("sft")).length;
    process.stdout.write(c.green("✓") + " walked " + projects + " project(s) → " + rows.length
      + " training row(s) (" + sft + " SFT, " + (rows.length - sft) + " repair) → " + file + "\n");
    return 0;
  }

  if (!projectId) {
    process.stderr.write(c.red("error:") + " missing projectId. usage: rtlforge export <projectId> [--out <dir>]\n");
    return 2;
  }
  const outDir = path.resolve(args.out || ("./rtlforge-out-" + projectId));
  const config = loadConfig({ flags: args });
  const storage = createFsStorage();
  const store = createStore({ config: config, storage: storage, projectId: projectId });
  const loaded = await store.loadCheckpoint();
  if (!loaded) {
    process.stderr.write(c.red("error:") + " no checkpoint found for project " + projectId + "\n");
    return 1;
  }
  const state = store.getState();
  const mods = Object.keys(state.modules || {});
  if (mods.length === 0) {
    process.stderr.write(c.red("error:") + " project has no modules\n");
    return 1;
  }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o755 });

  // Fine-tuning data export (roadmap #11):
  //   rtlforge export <id> --training-data [--out dir]
  // Emits JSONL: SFT pairs from judge-PASSED modules + DPO repair triples from
  // improving fix iterations. Nothing is emitted from unverified code.
  if (args["training-data"]) {
    const { sftPairs, repairPairs } = await import("../../pipeline/trainingExport.js");
    const rows = [];
    for (const modId of mods) {
      const sd = (state.modules[modId] && state.modules[modId].stageData) || {};
      const meta = { project: projectId, module: modId };
      rows.push(...sftPairs(sd, meta), ...repairPairs(sd, meta));
    }
    const file = path.join(outDir, "training-" + projectId + ".jsonl");
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    const sft = rows.filter((r) => r.meta.kind.startsWith("sft")).length;
    process.stdout.write(c.green("✓") + " " + rows.length + " training row(s) (" + sft + " SFT, "
      + (rows.length - sft) + " repair) → " + file + "\n");
    if (rows.length === 0) {
      process.stdout.write(c.dim("  (no judge-PASSED modules and no improving fix iterations in this project)") + "\n");
    }
    return 0;
  }

  const filterModule = args.module || null;
  let totalFiles = 0;

  for (const modId of mods) {
    const mod = state.modules[modId];
    const sd = mod.stageData || {};
    const elicit = sd[1] || {};
    const modName = elicit.modName || modId;
    if (filterModule && filterModule !== modId && filterModule !== modName) continue;

    process.stdout.write(c.bold("module " + modName) + "\n");

    const rtl = sd[4] && sd[4].code;
    const tb  = sd[7] && sd[7].code;
    const sva = sd[5] && sd[5].properties && JSON.stringify(sd[5].properties, null, 2);
    const spec = sd[2] || null;

    const writes = [
      [path.join(outDir, modName + ".sv"), rtl, "RTL"],
      [path.join(outDir, modName + "_tb.sv"), tb, "Testbench"],
      [path.join(outDir, modName + "_sva.json"), sva, "SVA properties"],
      [spec ? path.join(outDir, modName + ".spec.json") : null,
        spec ? JSON.stringify(spec, null, 2) : null, "Spec"],
      [path.join(outDir, modName + ".report.txt"), summarizeModule(mod, modName), "Summary"],
    ];

    for (const [fp, content, label] of writes) {
      if (!fp) continue;
      const wrote = writeIf(fp, content);
      if (wrote) {
        totalFiles++;
        process.stdout.write("  " + ICON.ok() + "  " + label + " → " + path.relative(process.cwd(), fp) + "\n");
      } else {
        process.stdout.write("  " + ICON.pending() + "  " + label + " " + c.dim("(empty, skipped)") + "\n");
      }
    }
    process.stdout.write("\n");
  }

  process.stdout.write(c.green("✓") + " wrote " + totalFiles + " files to " + outDir + "\n");
  return 0;
}
