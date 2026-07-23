// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// vcdWindow — signals-over-time context for verify fix prompts (roadmap #7)
//
// On capable models the residual failures are FUNCTIONAL, and the verify fix
// prompt reasons blind — it sees pass/fail text but never signals over time.
// This module extracts a compact window from the simulation's VCD around the
// first failure so the fix prompt can see what the DUT actually did.
//
// Minimal ASCII-VCD parser (header $var/$scope + #time value changes) — no
// dependencies, pure, browser-safe. Windows are bounded hard (≤ MAX_ROWS
// rows, ≤ MAX_SIGNALS columns, ≤ ~2 KB rendered) so a prompt can never blow up.
// ═══════════════════════════════════════════════════════════════════════════

const MAX_SIGNALS = 8;
const MAX_ROWS = 24;
const MAX_CHARS = 2048;

/** Parse the change section of an ASCII VCD → { changes: [[t, id, value]], endTime }. */
export function parseVCD(text) {
  const changes = [];
  let t = 0, endTime = 0, inHeader = true;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (inHeader) {
      if (line.startsWith("$enddefinitions")) inHeader = false;
      continue;
    }
    if (line[0] === "#") {
      t = parseInt(line.slice(1), 10) || 0;
      if (t > endTime) endTime = t;
    } else if (line[0] === "b" || line[0] === "B") {
      // vector change: bVALUE<space>id
      const sp = line.indexOf(" ");
      if (sp > 0) changes.push([t, line.slice(sp + 1), line.slice(1, sp)]);
    } else if (/^[01xzXZ]/.test(line)) {
      // scalar change: <bit><id>
      changes.push([t, line.slice(1), line[0]]);
    }
    // $dumpvars/$end wrapper lines around the initial values need no handling —
    // the value lines between them match the branches above.
  }
  return { changes, endTime };
}

/** Header signals: [{id, name, path, width}] from $scope/$var declarations. */
export function parseVCDSignals(text) {
  const out = [];
  const scope = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("$scope")) {
      const m = line.match(/^\$scope\s+\S+\s+(\S+)/);
      if (m) scope.push(m[1]);
    } else if (line.startsWith("$upscope")) {
      scope.pop();
    } else if (line.startsWith("$var")) {
      const m = line.match(/^\$var\s+\S+\s+(\d+)\s+(\S+)\s+([^\s[]+)/);
      if (m) out.push({ id: m[2], name: m[3], path: scope.join("."), width: parseInt(m[1], 10) });
    } else if (line.startsWith("$enddefinitions")) {
      break;
    }
  }
  return out;
}

/** First failure time from sim output, or null. Verify TBs print times in
 *  several dialects — accept the common ones on failing lines only. */
export function firstFailTime(simOutput) {
  for (const line of String(simOutput || "").split("\n")) {
    if (!/fail|assert|error/i.test(line)) continue;
    let m = line.match(/\btime\s*[=:]?\s*(\d+)/i);
    if (!m) m = line.match(/^\s*\[?\s*(\d+)\s*\]?\s*(?:ns|ps)?\s*[:%]/);
    if (!m) m = line.match(/@\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Render a compact table of the top-level signals around `aroundTime`
 * (falls back to the end of the dump — usually where a failing sim stopped).
 * `preferSignals` names float to the front of the column order.
 */
export function signalWindow(vcdText, opts) {
  const o = opts || {};
  const sigs = parseVCDSignals(vcdText);
  const { changes, endTime } = parseVCD(vcdText);
  if (sigs.length === 0 || changes.length === 0) return "";

  // Column selection: dedupe by NAME (Verilator dumps the same signal at both
  // the tb and dut scopes), then preferred names first, then clk/rst, then
  // declaration order.
  const seen = new Set();
  const uniq = sigs.filter((s) =>
    // Solver/tool-internal nets (smtbmc counterexamples carry smt_*/anyinit_*)
    // are noise to a fix prompt; design signals never use these prefixes.
    !/^(smt_|anyinit_|anyseq_|__|\$)/.test(s.name)
    && !seen.has(s.name) && seen.add(s.name));
  const prefer = (o.preferSignals || []).map((s) => String(s).toLowerCase());
  const score = (s) => {
    const n = s.name.toLowerCase();
    if (prefer.some((p) => n.includes(p))) return 0;
    if (/^(clk|clock)/.test(n)) return 1;
    if (/^(rst|reset)/.test(n)) return 2;
    return 3;
  };
  const cols = uniq.slice().sort((a, b) => score(a) - score(b)).slice(0, o.maxSignals || MAX_SIGNALS);
  const colIds = new Set(cols.map((c) => c.id));

  // Window bounds: ± span around the anchor (default: dump end).
  const anchor = (typeof o.aroundTime === "number" && o.aroundTime > 0) ? o.aroundTime : endTime;
  const span = o.span || Math.max(1, Math.round(endTime * 0.15));
  const t0 = Math.max(0, anchor - span), t1 = Math.min(endTime, anchor + span);

  // One row per in-window change-time of a column signal, snapshotting the
  // running values AFTER all changes at that time have been applied.
  const rowTimes = [];
  for (const [t, id] of changes) {
    if (colIds.has(id) && t >= t0 && t <= t1 && rowTimes[rowTimes.length - 1] !== t) rowTimes.push(t);
  }
  const cur = {};
  const rows = [];
  let ri = 0;
  const snap = (t) => rows.push([t, ...cols.map((c) => cur[c.id] == null ? "x" : cur[c.id])]);
  for (const [t, id, v] of changes) {
    while (ri < rowTimes.length && t > rowTimes[ri]) snap(rowTimes[ri++]);
    if (colIds.has(id)) cur[id] = v;
  }
  while (ri < rowTimes.length) snap(rowTimes[ri++]);
  const windowRows = rows.slice(-MAX_ROWS);
  if (windowRows.length === 0) return "";

  const header = ["time", ...cols.map((c) => c.name)].join(" | ");
  let out = header + "\n" + windowRows.map((r) => r.join(" | ")).join("\n");
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS) + "\n… (window truncated)";
  return "SIGNALS AROUND THE FIRST FAILURE (time " + anchor + ", from the simulation VCD):\n" + out;
}

/**
 * Ensure the TB dumps a VCD: inject $dumpfile/$dumpvars before the LAST
 * endmodule when the TB doesn't already dump. Pure; unchanged input when a
 * dump exists or no endmodule is found.
 */
export function injectDumpvars(tbCode, fileName) {
  const code = String(tbCode || "");
  if (/\$dumpvars/.test(code)) return code;
  const idx = code.lastIndexOf("endmodule");
  if (idx === -1) return code;
  const snippet = '  initial begin $dumpfile("' + (fileName || "wave.vcd") + '"); $dumpvars(0); end\n';
  return code.slice(0, idx) + snippet + code.slice(idx);
}
