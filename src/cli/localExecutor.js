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
  "wave.vcd",            // waveform dump (roadmap #7 waveGroundedFixes)
];
const MAX_HARVEST_BYTES = 1_000_000;   // 1 MB per file

// Keep per-call handles so concurrent callers do not cancel one another when
// each carries its own AbortSignal. abortLocal remains as a compatibility
// escape hatch and cancels every active local task.
const activeChildren = new Map();

function terminateProcessGroup(proc, signal) {
  if (!proc) return;
  if (process.platform !== "win32" && proc.pid) {
    try { process.kill(-proc.pid, signal || "SIGTERM"); return; } catch (_) { /* gone */ }
  }
  try { proc.kill(signal || "SIGTERM"); } catch (_) { /* gone */ }
}

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
 * @param {object} [opts]   { onSpawn?(proc), timeoutMs?, signal? }
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
      // POSIX text file: end with a newline. Generated SV routinely lacks it
      // (measured: Verilator EOFNEWLINE on otherwise-clean code); fixing it at
      // write time is invisible to every code comparison upstream.
      const text = (typeof content === "string" && content.length > 0 && !content.endsWith("\n"))
        ? content + "\n" : content;
      writeFileSync(join(workDir, sanitizeFilename(name)), text);
    }

    const commands = body.commands ? body.commands : (body.command ? [body.command] : []);
    let allStdout = "";
    let allStderr = "";
    let lastExitCode = 0;
    let wasAborted = false;

    for (const cmd of commands) {
      if (o.signal && o.signal.aborted) {
        wasAborted = true;
        lastExitCode = 130;
        break;
      }
      const expanded = expandPlaceholders(cmd, files);
      const result = await new Promise((resolve) => {
        const proc = spawn("sh", ["-c", expanded], {
          cwd: workDir,
          // A detached POSIX shell is its own process-group leader. Killing
          // -pid below then reaches Verilator/Yosys grandchildren too; the
          // child_process timeout option only killed the shell and left pipes
          // open indefinitely.
          detached: process.platform !== "win32",
          env: Object.assign({}, process.env, { TERM: "dumb" }),
        });
        if (typeof o.onSpawn === "function") { try { o.onSpawn(proc); } catch (_e) { /* ignore */ } }

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer = null;
        let hardTimer = null;
        let stopCode = null;
        let onAbort = null;
        const signal = o.signal || null;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (hardTimer) clearTimeout(hardTimer);
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          // The shell can close its pipes while a descendant that ignores
          // TERM is still alive. Finish cleanup of this owned process group
          // before resolving, even when there is no pipe left to keep us open.
          if (stopCode != null) terminateProcessGroup(proc, "SIGKILL");
          activeChildren.delete(proc);
          resolve(Object.assign({}, value, stopCode == null ? {} : {
            exitCode: stopCode, aborted: stopCode === 130,
          }));
        };
        const requestStop = (why) => {
          if (settled || stopCode != null) return;
          stopCode = why === "aborted" ? 130 : 124;
          if (timer) clearTimeout(timer);
          stderr += "\n" + why;
          terminateProcessGroup(proc, "SIGTERM");
          hardTimer = setTimeout(() => {
            terminateProcessGroup(proc, "SIGKILL");
            // Do not wait for inherited stdout/stderr descriptors held by a
            // grandchild. They are destroyed after the process group is dead.
            try { if (proc.stdout) proc.stdout.destroy(); } catch (_) { /* noop */ }
            try { if (proc.stderr) proc.stderr.destroy(); } catch (_) { /* noop */ }
            finish({ stdout, stderr, exitCode: 124, aborted: !!(signal && signal.aborted) });
          }, 1000);
          if (hardTimer && typeof hardTimer.unref === "function") hardTimer.unref();
        };
        proc.stdout.on("data", (d) => { stdout += d; });
        proc.stderr.on("data", (d) => { stderr += d; });
        proc.on("close", (code) => finish({ stdout, stderr, exitCode: code ?? 1, aborted: !!(signal && signal.aborted) }));
        proc.on("error", (e) => finish({ stdout, stderr: stderr + "\n" + e.message, exitCode: 127, aborted: !!(signal && signal.aborted) }));
        activeChildren.set(proc, requestStop);
        timer = setTimeout(() => requestStop("local command timeout"), cmdTimeoutMs);
        if (timer && typeof timer.unref === "function") timer.unref();
        if (signal && typeof signal.addEventListener === "function") {
          onAbort = () => requestStop("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }
      });

      allStdout += result.stdout;
      allStderr += result.stderr;
      lastExitCode = result.exitCode;
      wasAborted = wasAborted || !!result.aborted;
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

    return { stdout: allStdout, stderr: allStderr, exitCode: lastExitCode, files: harvestedFiles, aborted: wasAborted };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
}

/** SIGTERM all active local children (legacy emergency escape hatch). */
export function abortLocal() {
  for (const stop of Array.from(activeChildren.values())) stop("aborted");
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
