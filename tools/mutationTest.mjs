#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// mutationTest — score a testbench by what it CATCHES, not by what it passes
//
//   node tools/mutationTest.mjs <rtl.sv> <tb.sv> --top <tb_module> [--limit N]
//
// The eval gate scores verification by pass rate, which a vacuous suite
// maximises trivially (run 46: `check(1, …)` passes forever). This asks the
// question a pass rate cannot: break the design on purpose, one edit at a
// time, and see whether the testbench notices.
//
//   killed     the testbench failed on a design it should reject — good
//   survived   the testbench passed a broken design — the vacuity signal
//   uncompiled the edit does not build; excluded, it measures nothing
//
// Mutation score = killed / compiled. A survivor is evidence rather than
// proof: some edits are semantically equivalent to the original, so the
// honest reading of a survivor is "this testbench did not distinguish this
// change", which is exactly what the report says.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { enumerateMutants, applyMutant, sampleMutants, mutationScore } from "../src/pipeline/mutate.js";

export function haveVerilator() {
  return spawnSync("verilator", ["--version"], { encoding: "utf8" }).status === 0;
}

/**
 * Build and run one (rtl, tb) pair. Returns { compiled, passed, fails, out }.
 * `passed` means the testbench reported no failures AND exited zero.
 */
export function runPair(rtlSrc, tbSrc, topModule, opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtlforge-mut-"));
  try {
    const rtlPath = path.join(dir, "dut.sv");
    const tbPath = path.join(dir, "tb.sv");
    fs.writeFileSync(rtlPath, rtlSrc);
    fs.writeFileSync(tbPath, tbSrc);
    const build = spawnSync("verilator", [
      "--binary", "--timing", "-Wno-fatal", "-Wno-DECLFILENAME", "-j", "4",
      "--Mdir", path.join(dir, "obj"), "-o", "sim",
      rtlPath, tbPath, "--top-module", topModule,
    ], { encoding: "utf8", timeout: (o.buildTimeoutSec || 180) * 1000 });
    const sim = path.join(dir, "obj", "sim");
    if (build.status !== 0 || !fs.existsSync(sim)) {
      return { compiled: false, passed: false, fails: 0, out: (build.stderr || "").slice(0, 400) };
    }
    const run = spawnSync(sim, [], { encoding: "utf8", timeout: (o.runTimeoutSec || 120) * 1000 });
    const out = (run.stdout || "") + (run.stderr || "");
    const fails = (out.match(/\[FAIL\]/g) || []).length;
    // A timeout (null status) counts as a failure to pass: the mutant made
    // the testbench hang, which is a detection, not a pass.
    const passed = fails === 0 && run.status === 0;
    return { compiled: true, passed, fails, out: out.slice(-400) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Score one testbench against mutants of one RTL.
 * @returns {{ baseline, results, ...mutationScore }}
 */
export function scoreTestbench(rtlSrc, tbSrc, topModule, opts) {
  const o = opts || {};
  // The baseline must PASS, or a "kill" cannot be attributed to the mutation.
  const baseline = runPair(rtlSrc, tbSrc, topModule, o);
  if (!baseline.compiled || !baseline.passed) {
    return { baseline, results: [], total: 0, compiled: 0, uncompiled: 0,
      killed: 0, survived: 0, score: null, survivors: [],
      note: baseline.compiled
        ? "baseline testbench FAILS on the unmutated design — mutation scoring is meaningless until it passes"
        : "baseline pair does not compile — nothing to score" };
  }
  const all = enumerateMutants(rtlSrc, o);
  const chosen = sampleMutants(all, o.limit);
  const results = [];
  for (const m of chosen) {
    const r = runPair(applyMutant(rtlSrc, m), tbSrc, topModule, o);
    results.push(Object.assign({}, m, {
      compiled: r.compiled, killed: r.compiled && !r.passed, fails: r.fails,
    }));
    if (o.onMutant) o.onMutant(results[results.length - 1], results.length, chosen.length);
  }
  return Object.assign({ baseline, results, siteTotal: all.length }, mutationScore(results));
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith("--"));
  const flag = (n, d) => {
    const i = args.indexOf("--" + n);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  if (files.length < 2) {
    console.error("usage: node tools/mutationTest.mjs <rtl.sv> <tb.sv> --top <tb_module> [--limit N]");
    process.exit(2);
  }
  if (!haveVerilator()) {
    console.error("verilator not on PATH");
    process.exit(2);
  }
  const rtl = fs.readFileSync(files[0], "utf8");
  const tb = fs.readFileSync(files[1], "utf8");
  const top = flag("top", "tb");
  const limit = Number(flag("limit", "0")) || 0;

  process.stdout.write("mutating " + files[0] + " against " + files[1] + "\n");
  const res = scoreTestbench(rtl, tb, top, {
    limit,
    onMutant: (m, i, n) => process.stdout.write(
      "  [" + String(i).padStart(3) + "/" + n + "] L" + String(m.line).padEnd(4)
      + m.kind.padEnd(11) + (m.from + "→" + m.to).padEnd(7)
      + (m.compiled ? (m.killed ? "KILLED" : "SURVIVED") : "uncompiled") + "\n"),
  });
  if (res.note) { console.error("\n" + res.note); process.exit(1); }
  process.stdout.write("\n  sites available : " + res.siteTotal + "\n");
  process.stdout.write("  mutants run     : " + res.total
    + "  (compiled " + res.compiled + ", uncompiled " + res.uncompiled + ")\n");
  process.stdout.write("  killed          : " + res.killed + "\n");
  process.stdout.write("  survived        : " + res.survived + "\n");
  process.stdout.write("  MUTATION SCORE  : " + res.score + "%\n");
  if (res.survivors.length) {
    process.stdout.write("\n  survivors (the testbench did not distinguish these):\n");
    for (const sv of res.survivors.slice(0, 20)) {
      process.stdout.write("    L" + String(sv.line).padEnd(4) + sv.kind.padEnd(11)
        + (sv.from + "→" + sv.to).padEnd(7) + sv.context.slice(16, 60) + "\n");
    }
  }
  process.exit(0);
}
