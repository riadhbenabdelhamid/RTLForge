// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// cli/formalRunner — bounded model checking via SymbiYosys (roadmap #8)
//
// The formal_props stage generates SVA that was only ever SIMULATED — checked
// by whatever stimulus the TB happens to drive, which is not verification of
// the property. This runner proves/refutes the bound properties with real BMC:
// yosys `read -formal` + smtbmc via `sby` (oss-cad-suite ships sby + yices/z3).
//
// NODE-ONLY (child_process/fs) — dynamically imported by the formal_verify
// node with the same @vite-ignore variable-specifier trick as localExecutor,
// so the browser bundle never touches it.
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

/** Pure: render the .sby job file. Exported for tests. */
export function buildSbyFile(opts) {
  const o = opts || {};
  // mode bmc   — bug hunting: no violation within `depth` cycles of reset.
  // mode prove — k-induction: base case + inductive step; a PASS holds for
  //              ALL time (unbounded). Used opportunistically — see the
  //              formal_verify node's `proven` upgrade.
  const mode = o.mode === "prove" ? "prove" : "bmc";
  return [
    "[options]",
    "mode " + mode,
    "depth " + (o.depth || 15),
    "",
    "[engines]",
    "smtbmc",
    "",
    "[script]",
    "read -formal -sv " + (o.fileName || "dut.sv"),
    "prep -top " + o.top,
    "",
    "[files]",
    o.fileName || "dut.sv",
    "",
  ].join("\n");
}

/** Pure: classify sby stdout. Exported for tests. */
export function parseSbyOutput(stdout, exitCode, mode) {
  const out = String(stdout || "");
  // A zero exit code alone is not proof evidence: wrappers and interrupted
  // jobs can exit cleanly after emitting only a log prefix.  Require sby's
  // terminal DONE marker and a successful process exit for PASS.
  const markers = Array.from(out.matchAll(/DONE\s+\((PASS|FAIL|TIMEOUT|UNKNOWN)\b/g));
  if (markers.length !== 1) return "TOOL_ERROR";
  const marker = markers[0][1];
  if (marker === "PASS") return exitCode === 0 ? "PASS" : "TOOL_ERROR";
  if (marker === "FAIL") return "FAIL";
  if (marker === "TIMEOUT") return "TIMEOUT";
  // PROVE MODE ONLY: UNKNOWN means the induction step didn't close — that
  // says NOTHING about the design (correct designs commonly fail induction
  // from unreachable states); callers treat anything except PASS as "not
  // proven". In bmc mode an UNKNOWN is a solver abort and keeps the
  // pre-existing classification (TOOL_ERROR on nonzero exit) so bmc
  // consumers and the GUI verdict legend see only their documented states.
  if (mode === "prove" && marker === "UNKNOWN") return "UNKNOWN";
  return "TOOL_ERROR";
}

function terminateProcessGroup(pid, signal) {
  if (!pid || process.platform === "win32") return;
  try { process.kill(-pid, signal || "SIGTERM"); } catch (_e) { /* already gone */ }
}

// One parent-signal listener serves all concurrent formal jobs. A listener per
// worker would exceed Node's default EventEmitter warning threshold during a
// parallel run and would make cleanup bookkeeping needlessly fragile.
const activeCancellation = new Set();
let cancellationHooksInstalled = false;
const dispatchCancellation = function() {
  Array.from(activeCancellation).forEach(function(cancel) { cancel(); });
};
function registerParentCancellation(cancel) {
  activeCancellation.add(cancel);
  if (!cancellationHooksInstalled) {
    process.on("SIGTERM", dispatchCancellation);
    process.on("SIGINT", dispatchCancellation);
    cancellationHooksInstalled = true;
  }
  return function() {
    activeCancellation.delete(cancel);
    if (activeCancellation.size === 0 && cancellationHooksInstalled) {
      process.removeListener("SIGTERM", dispatchCancellation);
      process.removeListener("SIGINT", dispatchCancellation);
      cancellationHooksInstalled = false;
    }
  };
}

/** Is sby runnable in this environment? */
export function sbyAvailable() {
  try { return spawnSync("sby", ["--help"], { timeout: 10000 }).status === 0; }
  catch (_e) { return false; }
}

/**
 * Run one bounded model check.
 * @param {object} opts { source, top, depth?, timeoutMs?, mode? }
 *                 mode "bmc" (default) or "prove" (k-induction).
 * @returns {Promise<{status, log, cexVcd: string|null, elapsedMs}>}
 */
export async function runBmc(opts) {
  const o = opts || {};
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "rtlforge-sby-"));
  try {
    writeFileSync(join(dir, "dut.sv"), o.source || "");
    writeFileSync(join(dir, "task.sby"), buildSbyFile({ top: o.top, depth: o.depth, mode: o.mode }));
    const timeoutMs = o.timeoutMs || 120000;
    const result = await new Promise(function(resolve) {
      let settled = false;
      let stopRequested = false;
      let childClosed = false;
      let hardKilled = false;
      let stdout = "";
      let stderr = "";
      let killTimer = null;
      let hardKillTimer = null;
      const signal = o.signal || null;
      // A detached POSIX child is the leader of its own process group, so a
      // timeout or parent cancellation can terminate sby and every solver it
      // spawned with one negative-pid signal. Windows uses the child handle
      // fallback below because process groups have different semantics there.
      const child = spawn("sby", ["-f", "task.sby"], {
        cwd: dir, encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const onParentSignal = function() {
        requestStop("TIMEOUT", "parent process cancellation");
      };
      const unregisterParentCancellation = registerParentCancellation(onParentSignal);
      const detachListeners = function() {
        unregisterParentCancellation();
        if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onParentSignal);
      };
      const finish = function(status, exitCode, errorText) {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        detachListeners();
        const log = stdout + "\n" + stderr + (errorText ? "\n" + errorText : "");
        resolve({ status: status || parseSbyOutput(stdout, exitCode, o.mode), stdout, log });
      };
      const finishStopped = function(code) {
        if (!childClosed || !hardKilled) return;
        finish("TIMEOUT", code, null);
      };
      function requestStop(status, errorText) {
        if (stopRequested || settled) return;
        stopRequested = true;
        if (killTimer) clearTimeout(killTimer);
        if (process.platform === "win32") {
          try { child.kill("SIGTERM"); } catch (_e) { /* already gone */ }
        } else {
          terminateProcessGroup(child.pid, "SIGTERM");
        }
        hardKillTimer = setTimeout(function() {
          if (process.platform === "win32") {
            try { child.kill("SIGKILL"); } catch (_e) { /* already gone */ }
          } else {
            terminateProcessGroup(child.pid, "SIGKILL");
          }
          hardKilled = true;
          finishStopped(null);
        }, 1000);
        // Keep the reason in the captured log even when the child exits before
        // the escalation timer. It is diagnostic context, never PASS evidence.
        if (errorText) stderr += "\\n" + errorText;
        if (status !== "TIMEOUT") status = "TIMEOUT";
      }
      if (child.stdout) child.stdout.on("data", function(x) { stdout += x.toString(); });
      if (child.stderr) child.stderr.on("data", function(x) { stderr += x.toString(); });
      if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", onParentSignal, { once: true });
      child.on("error", function(err) {
        if (stopRequested) return;
        finish("TOOL_ERROR", null, String(err && err.message || err));
      });
      child.on("close", function(code) {
        childClosed = true;
        if (stopRequested) finishStopped(code);
        else finish(null, code, null);
      });
      killTimer = setTimeout(function() {
        requestStop("TIMEOUT", "formal solver timeout");
      }, timeoutMs);
      if (signal && signal.aborted) requestStop("TIMEOUT", "formal run aborted");
    });
    const log = result.log;
    const status = result.status;
    let cexVcd = null;
    if (status === "FAIL") {
      for (const p of ["task/engine_0/trace.vcd", "task/engine_0/trace0.vcd"]) {
        const abs = join(dir, p);
        if (existsSync(abs)) { cexVcd = readFileSync(abs, "utf8").slice(0, 1_000_000); break; }
      }
    }
    return { status, log: log.split("\n").slice(-40).join("\n"), cexVcd, elapsedMs: Date.now() - t0 };
  } catch (e) {
    return { status: "TOOL_ERROR", log: String(e && e.message || e), cexVcd: null, elapsedMs: Date.now() - t0 };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* temp cleanup */ }
  }
}
