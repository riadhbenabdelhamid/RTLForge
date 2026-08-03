#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// replayRun — replay a WHOLE recorded run against the current code
//
//   node tools/replayRun.mjs tests/fixtures/runs/run45
//
// The pipeline has stage tests and single-stage replays (tools/stageReplay.mjs),
// but nothing that catches a prompt edit three stages upstream quietly
// changing the judge's verdict. This closes that: a corpus is one run's
// description, its config, the completion for every LLM call keyed by prompt
// hash, and the verdict that run reached.
//
// The bridge (src/llm/bridge.js) does the work. With every answer already on
// disk, every call is a cache hit and the whole thirteen-stage run executes
// with ZERO model calls. If a prompt has changed, its hash no longer matches
// any answer: the bridge parks the new prompt and blocks, and the short
// timeout turns that into a loud failure naming the stage and the file — a
// changed prompt IS the regression signal, exactly as recordReplay intended.
//
// Deterministic stages still run for real (Verilator, SymbiYosys), so this
// exercises the actual lint/verify/formal path, not a mock. It needs those
// tools on PATH; without them it reports NOT-RUN rather than failing.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function haveEdaTools() {
  const r = spawnSync("verilator", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

/**
 * Replay one corpus. Returns
 *   { ok, reason, actual, expected, stages, timedOutOn, log }
 * `ok` is false on a bridge timeout (prompt drift), a pipeline halt, or any
 * mismatch against the recorded verdict.
 */
export function replayRun(corpusDir, opts) {
  const o = opts || {};
  const dir = path.resolve(corpusDir);
  const expected = JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8"));

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rtlforge-replayrun-"));
  const home = path.join(scratch, "home");
  const bridge = path.join(scratch, "bridge");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(bridge, "answers"), { recursive: true });
  fs.copyFileSync(path.join(dir, "config.json"), path.join(home, "config.json"));
  for (const f of fs.readdirSync(path.join(dir, "answers"))) {
    fs.copyFileSync(path.join(dir, "answers", f), path.join(bridge, "answers", f));
  }

  const r = spawnSync("node", [
    path.join(REPO, "bin", "rtlforge"), "run",
    "--file", path.join(dir, "desc.txt"),
    "--llm-bridge", bridge,
    // A miss must fail fast and loudly instead of parking the run forever.
    "--llm-bridge-timeout", String(o.missTimeoutSec || 20),
  ], {
    cwd: REPO,
    encoding: "utf8",
    timeout: (o.timeoutSec || 900) * 1000,
    env: Object.assign({}, process.env, {
      RTLFORGE_HOME: home,
      RTLFORGE_API_KEY: "local",
      NO_COLOR: "1",
    }),
  });
  const log = (r.stdout || "") + (r.stderr || "");

  const stages = [];
  for (const m of log.matchAll(/^\s*(✓|⚠|✗)\s+([A-Za-z ]+?)\s{2,}\(([^)]+)\)/gm)) {
    stages.push({ mark: m[1], stage: m[2].trim(), time: m[3] });
  }

  const timeout = log.match(/LLM BRIDGE TIMEOUT — no answer for prompt (\w+)/);
  if (timeout) {
    return {
      ok: false, scratch, log, stages, timedOutOn: timeout[1], expected, actual: null,
      reason: "prompt drift: no recorded answer for prompt " + timeout[1]
        + " (a prompt changed since this run was recorded — re-record or bless the change)",
    };
  }

  // Read the verdict the replay actually reached.
  let actual = null;
  const projDir = path.join(home, "projects");
  if (fs.existsSync(projDir)) {
    const f = fs.readdirSync(projDir)[0];
    if (f) {
      const d = JSON.parse(fs.readFileSync(path.join(projDir, f), "utf8"));
      const mod = d.modules[d.activeModId] || d.modules[Object.keys(d.modules)[0]];
      const sd = (mod || {}).stageData || {};
      const V = sd["8"] || {}, J = sd["9"] || {}, FV = sd["13"] || {};
      actual = {
        judgeScore: (J.eval || {}).score, judgeOverall: J.overall,
        verifyPass: V.pass, verifyTotal: V.total,
        formalProven: FV.proven === true, formalSkipped: (FV.formalSkipped || []).length,
        lintRtl: (sd["6"] || {}).status, lintTest: (sd["12"] || {}).status,
        traceCovered: (J.trace || []).filter((t) => t.ok).length,
        traceTotal: (J.trace || []).length,
      };
    }
  }
  if (!actual) {
    return { ok: false, scratch, log, stages, expected, actual: null,
      reason: "the replay produced no project state (pipeline halted before saving)" };
  }

  const diffs = [];
  for (const k of Object.keys(expected)) {
    if (k === "project") continue;
    if (String(actual[k]) !== String(expected[k])) {
      diffs.push(k + ": recorded " + expected[k] + " → replayed " + actual[k]);
    }
  }
  return {
    ok: diffs.length === 0, scratch, log, stages, expected, actual, diffs,
    reason: diffs.length ? "verdict changed — " + diffs.join("; ") : "",
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const corpora = process.argv.slice(2);
  if (corpora.length === 0) {
    console.error("usage: node tools/replayRun.mjs <corpusDir> [<corpusDir>…]");
    process.exit(2);
  }
  if (!haveEdaTools()) {
    console.error("verilator not on PATH — the deterministic stages cannot run");
    process.exit(2);
  }
  let bad = 0;
  for (const c of corpora) {
    process.stdout.write("\n── replay " + c + " ──\n");
    const t0 = Date.now();
    const res = replayRun(c);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    for (const s of res.stages) process.stdout.write("  " + s.mark + " " + s.stage.padEnd(14) + s.time + "\n");
    if (res.ok) {
      process.stdout.write("  ✓ replayed in " + secs + "s with zero model calls; verdict matches: "
        + JSON.stringify(res.actual) + "\n");
    } else {
      bad++;
      process.stdout.write("  ✗ " + res.reason + "\n  scratch kept: " + res.scratch + "\n");
    }
  }
  process.exit(bad === 0 ? 0 : 1);
}
