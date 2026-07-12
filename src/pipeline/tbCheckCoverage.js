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
export function extractChecks(tbCode) {
  const clean = String(tbCode || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  const checks = [];
  const re = /\bcheck\s*\(/g;
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
