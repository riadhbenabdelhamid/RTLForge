#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// stageReplay — A/B a single pipeline stage against a FROZEN failure state.
//
//   node tools/stageReplay.mjs <fixtureHome> <projectId> <stage> [rtlforge flags…]
//
//   e.g. node tools/stageReplay.mjs talk/run18/home 190161aa verify \
//          --provider ollama --model qwen3.6:35b --baseUrl http://localhost:11434 \
//          --backendUrl local --localRecoveryTimeoutSec 900
//
// WHY: every robustness fix in this repo came from a multi-hour e2e run.
// The failure states are already saved (talk/runN/home checkpoints) — so a
// fix can be tested by re-entering the pipeline AT the failing stage with
// the frozen upstream artifacts (spec/arch/RTL/TB untouched) and comparing
// the stage's outcome against what the original run recorded. Minutes per
// experiment instead of hours, and a true A/B: same inputs, old vs new code.
//
// MECHANISM: clones the fixture home into a scratch dir (the fixture is
// never written), overlays the CURRENT config via CLI flags (modelRouting
// stays whatever the clone's config.json says — edit it or pass flags), and
// shells out to `rtlforge stage <stage> --project <id>`, which loads the
// checkpoint and runs exactly one stage through the full store (services,
// chains, budget). Before/after metrics are read from the checkpoint.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [fixtureHome, projectId, stageRef, ...passFlags] = process.argv.slice(2);
if (!fixtureHome || !projectId || !stageRef) {
  console.error("usage: node tools/stageReplay.mjs <fixtureHome> <projectId> <stage> [rtlforge flags…]");
  process.exit(2);
}

function loadCheckpoint(home) {
  const dir = path.join(home, "projects");
  const f = fs.readdirSync(dir).find((x) => x.includes("checkpoint") && x.includes(projectId));
  if (!f) throw new Error("no checkpoint for " + projectId + " under " + dir);
  return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
}

// Stage-relevant summary for the before/after comparison. Unknown stages
// fall back to a key listing so the tool stays usable for any slot.
function metrics(d, stage) {
  const modId = d.activeModId || Object.keys(d.modules || {})[0];
  const sd = ((d.modules || {})[modId] || {}).stageData || {};
  const byKey = { verify: "8", judge: "9", lint: "6", lint_test: "12", rtl_review: "10", test_review: "11" };
  const slot = sd[byKey[stage]] || {};
  if (stage === "verify") {
    return {
      pass: slot.pass, total: slot.total, budgetHalted: !!slot._budgetHalted,
      history: (slot.verifyHistory || []).map((h) => ({
        iter: h.iter, prior: !!h._prior, pass: h.pass, target: h.triageTarget || null,
        investigated: !!h.triageInvestigated, flipped: !!h.triageFlipped,
      })),
    };
  }
  if (stage === "judge") {
    return { score: slot.score, overall: slot.overall,
      targets: (slot.judgeHistory || []).map((h) => h.triageTarget) };
  }
  if (stage === "lint" || stage === "lint_test") {
    return { status: slot.status, errors: (slot.errors || []).length,
      rtlErrorsOnly: !!slot._rtlErrorsOnly, iterations: slot.iteration };
  }
  if (stage === "rtl_review" || stage === "test_review") {
    return { verdict: slot.verdict, score: slot.score, compileErrors: slot._compileErrors };
  }
  return { keys: Object.keys(slot).slice(0, 10) };
}

// 1. Clone the fixture (read-only source) into a scratch home.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rtlforge-replay-"));
fs.cpSync(path.resolve(fixtureHome), scratch, { recursive: true });
console.log("fixture:", fixtureHome, "→ scratch:", scratch);

const before = metrics(loadCheckpoint(scratch), stageRef);
console.log("\nBEFORE (as the original run recorded it):");
console.log(JSON.stringify(before, null, 1));

// 2. Re-run the single stage with CURRENT code.
console.log("\nre-running stage '" + stageRef + "' …\n");
const t0 = Date.now();
const r = spawnSync("node", [path.join(REPO, "bin", "rtlforge"), "stage", stageRef,
  "--project", projectId, ...passFlags], {
  cwd: REPO,
  env: Object.assign({}, process.env, {
    RTLFORGE_HOME: scratch,
    RTLFORGE_API_KEY: process.env.RTLFORGE_API_KEY || "local",
    NO_COLOR: "1",
  }),
  stdio: "inherit",
});
const mins = ((Date.now() - t0) / 60000).toFixed(1);

// 3. Compare.
const after = metrics(loadCheckpoint(scratch), stageRef);
console.log("\nAFTER (current code, same frozen inputs, " + mins + " min):");
console.log(JSON.stringify(after, null, 1));
console.log("\nscratch home kept for inspection:", scratch);
process.exit(r.status || 0);
