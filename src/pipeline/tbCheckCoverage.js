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

/**
 * Names of instances whose port maps use named connection — the DUT and any
 * children a testbench reaches into.
 *
 * These matter because a hierarchical reference is a DUT observation, and
 * often the ONLY one available. Architectural state is not at the ports: a
 * processor's registers live inside its register file, and a testbench that
 * wants to know whether an instruction produced the right result has to look
 * there. `dut.u_regfile.regs[n]` observes the design more directly than a port
 * does, but a scan for port-map signal names sees only the identifiers `dut`,
 * `u_regfile` and `regs`, none of which is connected to anything.
 */
export function dutInstanceNames(clean) {
  const out = new Set();
  const re = /\b([A-Za-z_]\w*)\s*\(\s*\./g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    if (!SV_KEYWORDS.has(m[1])) out.add(m[1]);
  }
  return out;
}

/**
 * Helper functions and tasks whose own body reads the DUT.
 *
 * A condition need not name a DUT signal itself if it calls something that
 * does. The idiom this exists for is the accessor:
 *
 *   function automatic logic [31:0] xreg(input logic [4:0] n);
 *     return dut.u_regfile.regs[n];
 *   endfunction
 *   ...
 *   check_eq(xreg(7), 32'h12345679, "REQ-VERIF-002.0 …");
 *
 * Every architectural check in such a testbench routes through that one
 * accessor, so a condition-only scan reports EVERY requirement as verified
 * against the reference model alone (measured, run 51: rv_pipeline, where the
 * register file's contents are the only place a program's results exist).
 *
 * Reads exclude assignment targets for the same reason as in accumulatorVars:
 * a helper that DRIVES a DUT input observes nothing. That keeps `drive(...)`
 * and `write_reg(...)` out of the set while letting accessors in, and it is
 * what stops this from degrading into "any helper in a testbench that has a
 * DUT", which would forgive run 13's pattern outright.
 *
 * `carries` is the same idea one step further out. A monitor helper does not
 * return what it saw — it records it:
 *
 *   task automatic observe();
 *     if (rst_n === 1'b0 && (dmem_we === 1'b1 || dmem_re === 1'b1))
 *       mem_enable_in_reset++;
 *   endtask
 *   ...
 *   check(mem_enable_in_reset == 0, "REQ-ERR-001.0 …");
 *
 * A never-event like "no memory enable during reset" can only be covered this
 * way — an end-of-run check cannot see a pulse that happened and stopped — so
 * the variables such a helper writes carry its observation to the check, just
 * as a sweep accumulator does.
 *
 * @returns {{helpers: Set<string>, carries: Set<string>}}
 */
export function dutObservingHelpers(clean, connected, instances) {
  const helpers = new Set();
  const carries = new Set();
  const WRITE = /\b([A-Za-z_]\w*)\s*(\+\+|--|\+=|-=|\|=|&=|=(?!=))/g;
  const re = /\b(?:function|task)\b([\s\S]*?)\b(?:endfunction|endtask)\b/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const body = m[1];
    const nm = /([A-Za-z_]\w*)\s*(?:\(|;)/.exec(body);
    if (!nm || SV_KEYWORDS.has(nm[1])) continue;
    const readable = body.replace(WRITE, function(_, id, op) {
      return " ".repeat(id.length) + op;
    });
    const ids = readable.match(/[A-Za-z_]\w*/g) || [];
    if (!ids.some(function(id) { return connected.has(id) || instances.has(id); }))
      continue;
    // A helper that DELIVERS VERDICTS is not an observation source for someone
    // else's condition — it is the place the checks already live. Its locals
    // are the reference values those checks compare against, so harvesting
    // them would vouch for exactly the comparisons this analysis exists to
    // reject: run 46's vacuous testbench keeps its expected digests in the
    // test tasks, and counting them made every requirement look verified.
    // A monitor records and does not judge, which is what separates the two.
    if (VERDICT_MARKER_RE.test(body) || /\bcheck\w*\s*\(/.test(body)) continue;
    helpers.add(nm[1]);
    let w;
    WRITE.lastIndex = 0;
    while ((w = WRITE.exec(body)) !== null) carries.add(w[1]);
  }
  return { helpers: helpers, carries: carries };
}

/** Extract check(<condition>, "<label>") calls with paren-balanced parsing. */
/**
 * A task that DELIVERS A VERDICT is a check, whichever way it delivers it.
 * Two forms exist, and both have to be recognised or the analysis reads a
 * perfectly good testbench as verifying nothing:
 *
 *   (a) it FORWARDS into check() —
 *         task automatic check_val(input logic [31:0] got, exp, input string label);
 *           check(got === exp, label);
 *         endtask
 *       A call carries the DUT signal in ITS argument list, so the check's
 *       condition is the caller's arguments, not the task-local names.
 *       Without this the analysis reads `check_val(dout, ref_dout, "…")` as
 *       self-referential (measured, run 45: four requirements wrongly flagged
 *       critical because the comparison sat one call deep).
 *
 *   (b) it REPORTS THE VERDICT ITSELF, emitting the [PASS]/[FAIL] markers and
 *       counting the result without going through check() — which is exactly
 *       the shape the test-generation prompt PRESCRIBES for value comparisons:
 *         task automatic check_eq(input logic [W-1:0] expected, actual, input string label);
 *           if (expected === actual) begin passes++; $display("[PASS] %s …"); end
 *           else begin fails++; $display("[FAIL] %s …"); end
 *         endtask
 *       Recognising only (a) made every such call invisible: a testbench that
 *       followed the prompt's own instruction had 34 of its 45 checks dropped,
 *       eight of its fifteen requirements never seen at all, and four more
 *       reported CRITICAL "compares the reference model to itself" while their
 *       check_eq calls named the DUT port directly (measured, run 48).
 *
 * The marker is what makes a task a verdict source — it is the contract the
 * TB prompt states ("check(...) emits every [PASS]/[FAIL] line"). A helper
 * that only $displays a diagnostic line, like `show(got, exp, tag)`, decides
 * nothing and is correctly NOT counted here.
 *
 * @returns {Map<string, {args: string[], ownIds: string[]}>} task name → its
 *   formal argument names plus the identifiers its own body names
 */
const VERDICT_MARKER_RE = /\[\s*(?:PASS|FAIL)\s*\]/;

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
    let usedIds;
    if (inner) {
      usedIds = inner[1].match(/[A-Za-z_]\w*/g) || [];
    } else if (VERDICT_MARKER_RE.test(body)) {
      // Self-reporting form: the decision is somewhere in the body, so the
      // whole body supplies the names. String literals are dropped first —
      // a format string's words are not identifiers, and one colliding with
      // a port name would make every call look DUT-observing.
      usedIds = body.replace(/"(?:[^"\\\n]|\\.)*"/g, " ").match(/[A-Za-z_]\w*/g) || [];
    } else {
      continue;
    }
    // Either form counts only if its decision is built from its own formals.
    if (!usedIds.some(function(id) { return formals.indexOf(id) >= 0; })) continue;
    // A helper may ALSO name DUT signals of its own — `check(got === v &&
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

/**
 * Variables that carry a DUT observation out of a sweep.
 *
 * A check does not have to name a DUT port to observe one. The standard way to
 * cover a property over many vectors is to sweep, count the violations, and
 * assert the count is zero:
 *
 *   for (int i = 0; i < 2000; i++) begin
 *     present($urandom());
 *     if ($isunknown({rs1_addr, rs2_addr, imm, alu_op})) bad++;
 *   end
 *   check(bad == 0, "REQ-ERR-002.0 no output is undefined");
 *
 * Every DUT signal in that requirement's verification sits inside the loop, so
 * a condition-only scan sees `bad == 0` and reports the requirement as never
 * verified against the DUT — a CRITICAL that stops a correct testbench
 * (measured, run 51: rv_decode's REQ-ERR-002 and REQ-VERIF-003, both of which
 * sweep every opcode).
 *
 * The rule is deliberately narrow, because the check it feeds exists to catch
 * run 13's false PASS — a broken FIFO scoring 20/20 on checks that compared
 * the reference model to itself. Three things must hold together: the write is
 * inside a LOOP body, that same loop body READS a DUT-connected signal, and
 * the variable is not the loop's own induction variable (only the body is
 * scanned, never the header). A testbench that never observes the DUT has no
 * such loop to borrow from.
 *
 * "Reads" excludes assignment targets, and that distinction is load-bearing
 * rather than pedantic: almost every sweep drives a DUT INPUT in its body, so
 * counting `instr = $urandom()` as an observation would promote the
 * accumulator of a loop that looks at nothing the DUT produced — which is
 * precisely run 13's pattern wearing a for-loop.
 *
 * Non-blocking writes are not counted: `<=` is also a comparison, and reading
 * it as an assignment would let `if (x <= y)` promote x on sight.
 */
export function accumulatorVars(clean, connected) {
  const out = new Set();
  const heads = /\b(?:for|while|repeat|foreach|do)\s*\(/g;
  let m;
  while ((m = heads.exec(clean)) !== null) {
    let i = heads.lastIndex;
    let d = 1;
    while (i < clean.length && d > 0) {
      if (clean[i] === "(") d++;
      else if (clean[i] === ")") d--;
      i++;
    }
    const rest = clean.slice(i);
    const bm = /^\s*begin\b/.exec(rest);
    let body;
    if (bm) {
      const tok = /\b(begin|end)\b/g;
      let depth = 0;
      let t;
      let endIdx = rest.length;
      while ((t = tok.exec(rest)) !== null) {
        if (t[1] === "begin") depth++;
        else {
          depth--;
          if (depth === 0) { endIdx = t.index; break; }
        }
      }
      body = rest.slice(bm[0].length, endIdx);
    } else {
      const semi = rest.indexOf(";");
      body = semi >= 0 ? rest.slice(0, semi + 1) : rest;
    }
    const WRITE = /\b([A-Za-z_]\w*)\s*(\+\+|--|\+=|-=|\|=|&=|=(?!=))/g;
    // blank out assignment targets so only genuine reads remain
    const readable = body.replace(WRITE, function(_, id, op) {
      return " ".repeat(id.length) + op;
    });
    const ids = readable.match(/[A-Za-z_]\w*/g) || [];
    if (!ids.some(function(id) { return connected.has(id); })) continue;
    let w;
    WRITE.lastIndex = 0;
    while ((w = WRITE.exec(body)) !== null) out.add(w[1]);
  }
  return out;
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
  // Three ways a condition reaches the DUT without naming a port-connected
  // signal: a hierarchical reference into an instance, a helper that makes one
  // on the condition's behalf, and a sweep accumulator that carries the loop's
  // observation out to the check. Each is drawn narrowly — see the individual
  // comments — because the check they feed is what caught run 13's false PASS.
  const clean = stripNoise(String(tbCode || ""));
  const instances = dutInstanceNames(clean);
  const helper = dutObservingHelpers(clean, connected, instances);
  const accumulators = accumulatorVars(clean, connected);
  const observesDut = function(id) {
    return connected.has(id) || instances.has(id) || helper.helpers.has(id)
        || helper.carries.has(id) || accumulators.has(id);
  };
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
    const observing = !konst && ids.some(observesDut);
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
