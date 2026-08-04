// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// tbCheckCoverage — deterministic self-referential-check analysis
//
// Measured (gpt-oss-20b run 13, sync FIFO): the generated TB "passed" a
// design with a classic pointer-width bug (capacity DEPTH-1, wrap
// corruption losing all stored words) because most of its check() calls
// verified the REFERENCE MODEL AGAINST ITSELF — check(ref_count == DEPTH),
// check(ref_empty == 1'b1) — and never observed a DUT output. The judge
// then reported a verified PASS on a broken design: the exact false-PASS
// the product exists to prevent.
//
// A check whose condition references no signal connected to the DUT
// instance verifies nothing about the DUT. That is statically decidable:
//   1. collect the TB-side signal names from every `.port(signal)`
//      connection in the TB's module instantiations,
//   2. extract each check(...) condition and its label,
//   3. a check is DUT-observing iff its condition mentions at least one
//      connected signal; group by the label's REQ prefix.
// A requirement whose EVERY check is self-referential is unverified.
// ═══════════════════════════════════════════════════════════════════════════

const SV_KEYWORDS = new Set([
  "begin", "end", "if", "else", "logic", "bit", "int", "byte", "string",
  "posedge", "negedge", "or", "and", "not", "inside", "with",
]);

/** Strip comments and strings so identifier scans see only code. */
function stripNoise(code) {
  return String(code || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/** TB-side signal names connected in named port maps: `.port( expr )`. */
export function dutConnectedSignals(tbCode) {
  const clean = stripNoise(tbCode);
  const out = new Set();
  const re = /\.\s*[A-Za-z_]\w*\s*\(([^()]*)\)/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const ids = m[1].match(/[A-Za-z_]\w*/g) || [];
    for (const id of ids) {
      if (!SV_KEYWORDS.has(id) && !/^\d/.test(id)) out.add(id);
    }
  }
  return out;
}

/** Extract check(<condition>, "<label>") calls with paren-balanced parsing. */
/**
 * Helper tasks that FORWARD a comparison into check() — e.g.
 *   task automatic check_val(input logic [31:0] got, exp, input string label);
 *     check(got === exp, label);
 *   endtask
 * A call to one of these carries the DUT signal in ITS argument list, so the
 * check's condition is the caller's arguments, not the task-local names.
 * Without this the analysis reads `check_val(dout, ref_dout, "…")` as
 * self-referential (measured, run 45: four requirements wrongly flagged
 * critical because the comparison sat one call deep).
 *
 * @returns {Map<string, {args: string[]}>} task name → its formal argument names
 */
export function checkForwardingTasks(clean) {
  const out = new Map();
  const re = /\btask\s+(?:automatic\s+|static\s+)?([A-Za-z_]\w*)\s*\(([\s\S]*?)\)\s*;([\s\S]*?)\bendtask\b/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const name = m[1];
    if (name === "check") continue;               // the primitive itself
    const formals = (m[2].match(/[A-Za-z_]\w*/g) || [])
      .filter(function(t) { return !SV_KEYWORDS.has(t) && !/^\d/.test(t); });
    const body = m[3];
    const inner = /\bcheck\s*\(([\s\S]*?)\)\s*;/.exec(body);
    if (!inner) continue;
    // It forwards only if the inner condition is built from its own formals.
    const usedIds = inner[1].match(/[A-Za-z_]\w*/g) || [];
    if (!usedIds.some(function(id) { return formals.indexOf(id) >= 0; })) continue;
    out.set(name, { args: formals });
  }
  return out;
}

export function extractChecks(tbCode) {
  const clean = String(tbCode || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  const checks = [];
  const forwarders = checkForwardingTasks(clean);
  const names = ["check"].concat(Array.from(forwarders.keys()));
  const re = new RegExp("\\b(?:" + names.join("|") + ")\\s*\\(", "g");
  let m;
  while ((m = re.exec(clean)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < clean.length && depth > 0) {
      const c = clean[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    const args = clean.slice(re.lastIndex, i - 1);
    // Skip the task's own DECLARATION (`task automatic check(input bit cond,
    // ...)`) — an argument list starting with a direction keyword is a port
    // list, not a call.
    if (/^\s*(input|output|inout|ref)\b/.test(args)) continue;
    // A forwarding call's condition IS its argument list: the DUT signal the
    // caller passed in is what the comparison ultimately observes.
    const callee = (clean.slice(0, m.index + m[0].length).match(/([A-Za-z_]\w*)\s*\($/) || [])[1];
    if (callee && callee !== "check") {
      const lm2 = args.match(/"([^"]*)"/);
      checks.push({ cond: args.replace(/"[^"]*"/g, " ").trim(), label: lm2 ? lm2[1] : "" });
      continue;
    }
    // Split at the LAST top-level comma: condition , label. (The label is
    // the final argument; commas inside the condition sit under parens or
    // inside the $sformatf label call.)
    let split = -1;
    let d = 0;
    for (let k = 0; k < args.length; k++) {
      if (args[k] === "(") d++;
      else if (args[k] === ")") d--;
      else if (args[k] === "," && d === 0) split = k;
    }
    const cond = split >= 0 ? args.slice(0, split) : args;
    const labelSrc = split >= 0 ? args.slice(split + 1) : "";
    const lm = labelSrc.match(/"([^"]*)"/);
    checks.push({ cond: cond.trim(), label: lm ? lm[1] : labelSrc.trim() });
  }
  return checks;
}

/** REQ id prefix of a label ("REQ-FUNC-001.2" → "REQ-FUNC-001"), or null. */
function reqOf(label) {
  const m = /([A-Z]+-[A-Z]+-\d+)/.exec(String(label || ""));
  return m ? m[1] : null;
}

/**
 * Analyze which check() calls actually observe the DUT.
 * @param {string} tbCode  the generated testbench source
 * @returns {{ total, dutObserving, selfOnly: Array<{cond,label}>,
 *             unverifiedReqs: string[] }}
 *   unverifiedReqs — requirement ids whose EVERY labeled check is
 *   self-referential (none mention a DUT-connected signal).
 */
export function analyzeCheckCoverage(tbCode) {
  const connected = dutConnectedSignals(tbCode);
  const checks = extractChecks(tbCode);
  const selfOnly = [];
  const byReq = new Map();   // req → { total, observing }
  for (const c of checks) {
    const condClean = stripNoise(c.cond);
    const ids = condClean.match(/[A-Za-z_]\w*/g) || [];
    const observing = ids.some(function(id) { return connected.has(id); });
    if (!observing) selfOnly.push(c);
    const req = reqOf(c.label);
    if (req) {
      const e = byReq.get(req) || { total: 0, observing: 0 };
      e.total++;
      if (observing) e.observing++;
      byReq.set(req, e);
    }
  }
  const unverifiedReqs = [];
  for (const [req, e] of byReq) {
    if (e.total > 0 && e.observing === 0) unverifiedReqs.push(req);
  }
  return {
    total: checks.length,
    dutObserving: checks.length - selfOnly.length,
    selfOnly: selfOnly,
    unverifiedReqs: unverifiedReqs,
  };
}
