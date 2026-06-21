// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// localExecutor — run EDA tools (Verilator/Yosys/…) in-process, no HTTP backend
//
// NODE-ONLY. This module imports node:child_process / node:fs and MUST NOT be
// pulled into the browser bundle. It is reached two ways, both Node:
//   • runCli() dynamically imports it (with /* @vite-ignore */ + an isNode
//     guard) when backendUrl === "local" — so the CLI runs Verilator directly
//     with no separate server to start.
//   • backend.js imports it so the HTTP backend and the embedded path share ONE
//     execution implementation instead of drifting.
//
// It mirrors the backend's /api/execute contract exactly: stage the given files
// into a temp dir, expand {RTL}/{TB}/{SVA} placeholders, run the command(s),
// harvest a small allow-list of output files, clean up, and return
// { stdout, stderr, exitCode, files } — the same shape runCli's HTTP path
// returns, so every caller (lint/verify/lint_test/best-of-N/coverage/mutation)
// is unchanged.
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execSync } from "node:child_process";
import { sanitizeFilename } from "../../backend/sanitize.js";

// Output files harvested from the work dir after a run (bounded, no recursion)
// — matches backend.js exactly so both paths surface the same artifacts.
const HARVEST_PATHS = [
  "logs/coverage.dat",   // Verilator --coverage default
  "coverage.dat",        // alt location
  "logs/coverage.info",  // some configs use this name
  "coverage.xml",        // covgroup XML
];
const MAX_HARVEST_BYTES = 1_000_000;   // 1 MB per file

// The currently-running child, so abortLocal() can kill it (mirror of the
// backend's per-task tracking). Single-flight: the linear CLI pipeline runs one
// tool at a time, so a module-level handle is correct for the embedded path.
let activeChild = null;

/**
 * Expand {RTL}/{TB}/{SVA} placeholders to the staged filenames, the same way
 * backend.js does: a name with `_tb` → {TB}, `_sva` → {SVA}, else → {RTL};
 * only .sv/.v files participate. Global replace so every occurrence is hit.
 */
export function expandPlaceholders(cmd, files) {
  let expanded = cmd;
  for (const name of Object.keys(files || {})) {
    if (!name.endsWith(".sv") && !name.endsWith(".v")) continue;
    const safe = sanitizeFilename(name);
    if (name.includes("_tb")) expanded = expanded.replace(/\{TB\}/g, safe);
    else if (name.includes("_sva")) expanded = expanded.replace(/\{SVA\}/g, safe);
    else expanded = expanded.replace(/\{RTL\}/g, safe);
  }
  return expanded;
}

/**
 * Run a command bundle in-process. Mirrors backend.js handleExecute's core.
 * @param {object} payload  { command|commands, files: {name:contents}, timeoutMs? }
 * @param {object} [opts]   { onSpawn?(proc), timeoutMs? }
 * @returns {Promise<{stdout, stderr, exitCode, files}>}
 */
export async function executeLocal(payload, opts) {
  const o = opts || {};
  const body = payload || {};
  const requestedTimeout = parseInt(o.timeoutMs != null ? o.timeoutMs : body.timeoutMs, 10);
  const cmdTimeoutMs = (Number.isFinite(requestedTimeout) && requestedTimeout > 0)
    ? Math.min(Math.max(requestedTimeout, 5_000), 3_600_000)   // 5s..1h
    : 600_000;                                                 // default 10 min

  const workDir = mkdtempSync(join(tmpdir(), "rtlforge-local-"));
  try {
    const files = body.files || {};
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(workDir, sanitizeFilename(name)), content);
    }

    const commands = body.commands ? body.commands : (body.command ? [body.command] : []);
    let allStdout = "";
    let allStderr = "";
    let lastExitCode = 0;

    for (const cmd of commands) {
      const expanded = expandPlaceholders(cmd, files);
      const result = await new Promise((resolve) => {
        const proc = spawn("sh", ["-c", expanded], {
          cwd: workDir,
          timeout: cmdTimeoutMs,
          env: Object.assign({}, process.env, { TERM: "dumb" }),
        });
        activeChild = proc;
        if (typeof o.onSpawn === "function") { try { o.onSpawn(proc); } catch (_e) { /* ignore */ } }

        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => { stdout += d; });
        proc.stderr.on("data", (d) => { stderr += d; });
        proc.on("close", (code) => { activeChild = null; resolve({ stdout, stderr, exitCode: code ?? 1 }); });
        proc.on("error", (e) => { activeChild = null; resolve({ stdout, stderr: stderr + "\n" + e.message, exitCode: 127 }); });
      });

      allStdout += result.stdout;
      allStderr += result.stderr;
      lastExitCode = result.exitCode;
      if (lastExitCode !== 0 && commands.length > 1) break;   // stop on first failure
    }

    const harvestedFiles = {};
    for (const relPath of HARVEST_PATHS) {
      try {
        const abs = join(workDir, relPath);
        if (existsSync(abs)) {
          const st = statSync(abs);
          if (st.isFile() && st.size <= MAX_HARVEST_BYTES) harvestedFiles[relPath] = readFileSync(abs, "utf8");
        }
      } catch (_e) { /* best-effort */ }
    }

    return { stdout: allStdout, stderr: allStderr, exitCode: lastExitCode, files: harvestedFiles };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
}

/** SIGTERM the in-flight local child, if any (single-flight CLI abort). */
export function abortLocal() {
  if (activeChild) { try { activeChild.kill("SIGTERM"); } catch (_e) { /* ignore */ } activeChild = null; }
}

/** In-process backend probe — returns Verilator availability + version. */
export function probeLocal() {
  try {
    const v = execSync("verilator --version", { encoding: "utf8", timeout: 10_000 }).trim();
    return { ok: true, version: v };
  } catch (e) {
    return { ok: false, version: null, error: (e && e.message) || "verilator not found" };
  }
}
