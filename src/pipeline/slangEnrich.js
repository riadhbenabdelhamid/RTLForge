// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// slangEnrich — complete-error-list enrichment for the lint fix loops.
//
// Measured problem (nemotron e2e runs 6 & 8): Verilator stops at the FIRST
// syntax error, so a fix iteration only ever learns one defect — run 6's TB
// burned its whole fix budget on a string-decl error and the fixer never saw
// that clk/rst_n/en were undeclared. slang parses with error recovery and
// reports everything in one ~1 ms pass (tools/slang_check.py prints it as
// JSON).
//
// Merge policy — enrichment can never become a new failure source:
//   • runs ONLY when Verilator already reported FAIL with ≥1 error;
//   • codes slang treats stricter than Verilator are excluded (measured:
//     UsedBeforeDeclared fires on declare-after-use TBs Verilator accepts);
//   • one slang error per line not already covered by a Verilator error,
//     capped, appended with code "SLANG" so the UI and rule distillation can
//     tell the source;
//   • any sidecar failure (no config, backend error, bad JSON, ok:false)
//     returns null and the loop proceeds exactly as before.
// ═══════════════════════════════════════════════════════════════════════════

import { runCli } from "../cli/index.js";

// slang-stricter-than-Verilator diagnostics: never merged.
const EXCLUDED_CODES = /UsedBeforeDeclared/;
const MAX_EXTRA = 10;

/**
 * @param {object} config   run config — reads slangCmd, backendUrl
 * @param {object} files    the exact staged-file map the Verilator lint used
 * @param {Array}  existingErrors  Verilator's parsed errors ({line, …})
 * @param {AbortSignal|null} signal
 * @param {object|null} logger
 * @returns {Promise<Array|null>} extra findings to append, or null
 */
export async function slangEnrich(config, files, existingErrors, signal, logger) {
  if (!config || !config.slangCmd || !config.backendUrl) return null;
  let res;
  try {
    res = await runCli(config.backendUrl, { command: config.slangCmd, files: files },
      signal, { retries: 0, timeoutMs: 30_000, logger: logger || null });
  } catch (e) {
    return null;
  }
  if (!res || res._error || res.exitCode === undefined) return null;
  let parsed = null;
  try {
    // The sidecar prints one JSON object; tolerate wrapper noise by taking
    // the last non-empty stdout line.
    const lines = String(res.stdout || "").trim().split("\n").filter(function(l) { return l.trim(); });
    parsed = JSON.parse(lines[lines.length - 1]);
  } catch (e) {
    return null;
  }
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.errors)) return null;

  const covered = new Set((existingErrors || []).map(function(e) { return e.file + "|" + e.line; }));
  const extra = [];
  for (const e of parsed.errors) {
    if (EXCLUDED_CODES.test(String(e.code || ""))) continue;
    const file = String(e.file || "").split("/").pop();
    const key = file + "|" + e.line;
    if (covered.has(key)) continue;
    covered.add(key);
    extra.push({ code: "SLANG", sev: "error", file: file, line: e.line || 0, col: e.col || 0, msg: e.msg || "" });
    if (extra.length >= MAX_EXTRA) break;
  }
  return extra.length > 0 ? extra : null;
}
