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
import { spawnSync } from "node:child_process";

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
  if (/DONE \(PASS/.test(out)) return "PASS";
  if (/DONE \(FAIL/.test(out)) return "FAIL";
  if (/DONE \(TIMEOUT/.test(out)) return "TIMEOUT";
  // PROVE MODE ONLY: UNKNOWN means the induction step didn't close — that
  // says NOTHING about the design (correct designs commonly fail induction
  // from unreachable states); callers treat anything except PASS as "not
  // proven". In bmc mode an UNKNOWN is a solver abort and keeps the
  // pre-existing classification (TOOL_ERROR on nonzero exit) so bmc
  // consumers and the GUI verdict legend see only their documented states.
  if (mode === "prove" && /DONE \(UNKNOWN/.test(out)) return "UNKNOWN";
  if (exitCode === 0) return "PASS";
  return "TOOL_ERROR";
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
 * @returns {{status, log, cexVcd: string|null, elapsedMs}}
 */
export function runBmc(opts) {
  const o = opts || {};
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "rtlforge-sby-"));
  try {
    writeFileSync(join(dir, "dut.sv"), o.source || "");
    writeFileSync(join(dir, "task.sby"), buildSbyFile({ top: o.top, depth: o.depth, mode: o.mode }));
    const res = spawnSync("sby", ["-f", "task.sby"], {
      cwd: dir, timeout: o.timeoutMs || 120000, encoding: "utf8",
    });
    const log = (res.stdout || "") + "\n" + (res.stderr || "");
    const status = res.error ? "TOOL_ERROR" : parseSbyOutput(res.stdout, res.status, o.mode);
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
