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
    // A forwarder may ALSO name DUT signals of its own — `check(got === v &&
    // tx_serial === SERIAL_IDLE, tag)`. Analysing its call site on the
    // arguments alone would throw that away and report the requirement as
    // unverified even though the helper observes the DUT on every call, so
    // the names it uses travel with it.
    out.set(name, { args: formals, ownIds: usedIds.slice() });
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
      const fwd = forwarders.get(callee);
      // The call's arguments PLUS whatever the helper names itself: either can
      // supply the DUT signal that makes the check meaningful.
      const own = fwd && fwd.ownIds ? " " + fwd.ownIds.join(" ") : "";
      checks.push({
        cond: args.replace(/"[^"]*"/g, " ").trim() + own,
        label: lm2 ? lm2[1] : "",
      });
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

/**
 * Constant-valued conditions — a check that cannot discriminate ANY design
 * from any other (run 46, qwen3.6:35b, measured in a shipped testbench):
 *   check(1, "REQ-FUNC-003.1")        → always passes, verifies nothing
 *   check($isunknown(0), "REQ-INTF-001.1") → always fails, for every design
 * Observing a DUT signal is not enough to make a check meaningful, and both
 * of these sailed past the DUT-signal test — the first because it mentions
 * no signal at all, the second because it looks like a call.
 *
 * @returns {"true"|"false"|null} the constant it always evaluates to, or null
 */
export function constantCondition(cond) {
  let c = String(cond || "").trim();
  // peel balanced outer parens
  for (let i = 0; i < 4 && /^\(.*\)$/.test(c); i++) {
    const inner = c.slice(1, -1);
    let d = 0, ok = true;
    for (const ch of inner) {
      if (ch === "(") d++;
      else if (ch === ")") { d--; if (d < 0) { ok = false; break; } }
    }
    if (!ok || d !== 0) break;
    c = inner.trim();
  }
  if (/^(1|1'b1|1'd1|1'h1|'1)$/i.test(c)) return "true";
  if (/^(0|1'b0|1'd0|1'h0|'0)$/i.test(c)) return "false";
  // $isunknown / $isunknown of a LITERAL is decided at elaboration
  const m = /^\$isunknown\s*\(([^()]*)\)$/i.exec(c);
  if (m && /^\s*(\d+\s*'\s*[bdoh]\s*[0-9a-f_]+|\d+|'[01])\s*$/i.test(m[1])) return "false";
  return null;
}

/**
 * Weak-but-not-constant conditions — reported as advisories rather than
 * treated as unverified, because each has a legitimate use and a false
 * positive here costs a wasted fix round (measured in run 45, where a
 * helper-task false positive forced four requirements critical):
 *   check(digest !== '0, …)     admits every value but one
 *   check(x === f(x), …)        compares a DUT output against itself
 * A comparison involving $past/$sampled is EXCLUDED — `q === $past(q)` is
 * the ordinary way to assert stability.
 */
export function weakCondition(cond, connected) {
  const c = String(cond || "").trim();
  if (/\$past|\$sampled|\$stable|\$rose|\$fell/i.test(c)) return null;
  const ids = function(t) {
    return (String(t).match(/[A-Za-z_]\w*/g) || []).filter(function(x) { return connected.has(x); });
  };
  const cmp = /^([\s\S]+?)(===|!==|==|!=)([\s\S]+)$/.exec(c);
  if (!cmp) return null;
  const left = cmp[1], op = cmp[2], right = cmp[3];
  const lIds = ids(left), rIds = ids(right);
  // (a) inequality against a side holding no DUT signal and no reference —
  //     a literal. "not equal to one specific value" constrains almost nothing.
  const literalSide = /^[\s(]*(\d+\s*'\s*[bdoh][0-9a-f_]+|'[01]|\d+)[\s)]*$/i;
  if ((op === "!==" || op === "!=")
      && ((lIds.length > 0 && literalSide.test(right)) || (rIds.length > 0 && literalSide.test(left)))) {
    return "inequality-against-literal";
  }
  // (b) the SAME single DUT signal on both sides and no other DUT signal —
  //     the design is being compared against itself.
  if (lIds.length > 0 && rIds.length > 0) {
    const lSet = new Set(lIds), rSet = new Set(rIds);
    const union = new Set([...lSet, ...rSet]);
    if (union.size === 1) return "self-comparison";
  }
  return null;
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
  const constantChecks = [];
  const weakChecks = [];
  for (const c of checks) {
    const condClean = stripNoise(c.cond);
    const ids = condClean.match(/[A-Za-z_]\w*/g) || [];
    // A constant-valued condition discriminates nothing, whether or not it
    // happens to mention a DUT signal.
    const konst = constantCondition(condClean);
    if (konst) constantChecks.push({ cond: c.cond, label: c.label, always: konst });
    else {
      const weak = weakCondition(condClean, connected);
      if (weak) weakChecks.push({ cond: c.cond, label: c.label, kind: weak });
    }
    const observing = !konst && ids.some(function(id) { return connected.has(id); });
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
    constantChecks: constantChecks,
    weakChecks: weakChecks,
  };
}
