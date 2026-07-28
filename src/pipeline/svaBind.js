// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// svaBind — materialize formal_props output into a simulation-checkable file
//
// WHY THIS EXISTS:
//
// The formal_props stage generates SVA property STATEMENTS (e.g.
// `assert property (@(posedge clk) disable iff (!rst_n) a |-> b);`) plus a
// `bind` directive — but nothing ever compiled them. Without this module the
// generated SVA was decorative: it shipped in the export, was never checked
// by anything, and could silently rot. Binding the properties into the
// Verilator simulation makes every verify run also evaluate the formal
// properties dynamically (not a proof, but real evidence — a violated
// assertion fails the sim and routes through the normal fix loops).
//
// WHAT IT BUILDS — one self-contained SV snippet appended to the RTL file:
//
//   module <dut>_rtlforge_sva #(<params mirrored from spec>) (
//     input logic <every DUT port, as input>
//   );
//     <the property statements>
//   endmodule
//   bind <dut> <dut>_rtlforge_sva u_rtlforge_sva (.*);
//
// `bind` instantiates the checker INSIDE the DUT; `.*` connects each checker
// port to the same-named signal in the DUT scope. Appending to the RTL file
// (rather than shipping a separate file) means user-customized simCmds keep
// working unchanged — the compile line still only lists {RTL} {TB}.
//
// SAFETY FILTER — why properties can be skipped:
//
// A property that references a signal we can't declare as a checker port
// would break the whole compile, turning a "nice to have" check into a
// verify failure on a perfectly good design. So each property is admitted
// only when every identifier it references is a known DUT port, a known
// parameter, or an SVA/SV keyword. Skipped properties are reported (id +
// reason) so the UI/log can show what wasn't bound and why. The verify node
// adds a second safety net: if the augmented build still fails to compile
// with errors naming the checker, it retries the build without SVA.
//
// SCOPE (deliberate first cut — contributors, these are good follow-ups):
//   - Only concurrent `assert property` / `assume property` statements are
//     bound. Immediate assertions (`assert #0`) need a procedural context
//     and Verilator support is shakier — skipped with a reason.
//   - `cover property` statements are skipped (need --coverage-user wiring
//     and a results-harvesting story to be useful).
//   - autoAssumptions (derived parameter constraints) are not bound — they
//     constrain parameters that are compile-time constants in sim anyway.
// ═══════════════════════════════════════════════════════════════════════════

// Words that may legitimately appear in a property expression without being
// DUT signals. Covers SV/SVA structural keywords plus sequence operators.
// $-prefixed system functions ($past, $rose, …) are stripped before the
// identifier check, so they don't need listing here.
const SVA_KEYWORDS = new Set([
  "assert", "assume", "cover", "restrict", "property", "sequence",
  "posedge", "negedge", "edge", "disable", "iff",
  "not", "and", "or", "throughout", "within", "intersect",
  "first_match", "until", "until_with", "s_until", "s_until_with",
  "nexttime", "s_nexttime", "eventually", "s_eventually", "always",
  "if", "else", "begin", "end", "logic", "bit", "signed", "unsigned",
]);

/**
 * Pull candidate identifiers out of a property-code string, after removing
 * the lexical noise that would create false identifiers:
 *   - based literals (8'hFF → would otherwise yield "hFF")
 *   - $system functions ($past(x) → "$past" stripped, "x" kept)
 */
// Comment stripping shared by identifier extraction and the aux decl scan
// (run 28: an aux block's prose comment tokenized into "identifiers" —
// "would, require, deeper, tracking" — and the whole aux model was dropped,
// taking the connecting properties with it).
function stripComments(code) {
  return String(code)
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

function extractIdentifiers(code) {
  const cleaned = stripComments(code)
    .replace(/\d*'[sS]?[bodhBODH][0-9a-fA-F_xzXZ?]+/g, " ")  // based literals
    .replace(/\$[A-Za-z0-9_$]*/g, " ");                       // $functions
  const ids = cleaned.match(/[A-Za-z_][A-Za-z0-9_$]*/g) || [];
  return ids.filter(function(id) { return !SVA_KEYWORDS.has(id); });
}

// Additional words legal in an AUX MODEL block (procedural modeling code,
// not just property expressions).
const AUX_KEYWORDS = new Set([
  "always_ff", "always_comb", "always_latch", "initial",
  "int", "integer", "reg", "byte", "longint", "shortint",
  "case", "endcase", "default", "unique", "priority", "for", "genvar",
]);

/**
 * Validate a formal_props AUX MODEL block (measured need: run 13 — every
 * occupancy property was skipped as "references non-port identifier", formal
 * never ran, and a broken FIFO passed. The checker cannot see DUT internals,
 * so invariants over hidden state need checker-local MODEL state driven from
 * ports).
 *
 * Deterministic admission rules (same safety story as property admission —
 * one unknown name would break the whole compile):
 *   - every name the block declares is prefixed "f_" (collision-proof when
 *     the block is inlined into the DUT for the yosys/sby path),
 *   - every identifier in the block resolves to a DUT port, a parameter, an
 *     f_ name declared here, or a keyword.
 *
 * @returns {{ names: Set<string>, text: string } | { error: string }}
 */
/**
 * Output-port property coverage (run 18 autopsy). The dout bug — an output
 * register loaded unconditionally instead of gated on its accept condition —
 * is exactly the class an update-gating property catches, yet nothing
 * guaranteed the generated property set observed every output at all. This
 * check is deterministic: every spec output port must appear (as a whole
 * identifier) in at least one property or cover expression. The formal_props
 * node re-asks ONCE for the uncovered names; still-uncovered afterwards is a
 * loud log, never a halt.
 *
 * @returns {string[]} output port names no property/cover references
 */
export function uncoveredOutputPorts(fpResult, spec) {
  const outputs = (((spec && spec.iface) || []))
    .filter(function(p) { return /^out/i.test(String((p && p.dir) || "")); })
    .map(function(p) { return String((p && p.name) || ""); })
    .filter(Boolean);
  if (outputs.length === 0) return [];
  const codes = []
    .concat(((fpResult && fpResult.properties) || []).map(function(x) { return (x && x.code) || ""; }))
    .concat(((fpResult && fpResult.covers) || []).map(function(x) { return (x && x.code) || ""; }))
    .join("\n");
  return outputs.filter(function(name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp("\\b" + esc + "\\b").test(codes);
  });
}

export function validateAuxModel(aux, portNames, paramNames) {
  const text = String(aux || "").trim();
  if (!text) return { error: "empty" };
  const names = new Set();
  // Scan declarations on comment-stripped text so a commented-out
  // declaration can't trip the f_ prefix rule; the RETURNED text keeps the
  // comments (they're legal in the emitted checker).
  const scanText = stripComments(text);
  const declRe = /\b(?:logic|bit|int|integer|reg|byte|longint|shortint)\b([^;]*);/g;
  let m;
  while ((m = declRe.exec(scanText)) !== null) {
    const seg = m[1];
    // The declared name is the last identifier outside brackets, before any
    // initializer.
    const head = seg.split("=")[0];
    const noRanges = head.replace(/\[[^\]]*\]/g, " ");
    const ids = noRanges.match(/[A-Za-z_]\w*/g) || [];
    const name = ids[ids.length - 1];
    if (!name) continue;
    if (!/^f_/.test(name)) {
      return { error: "aux declares \"" + name + "\" — every aux name must be prefixed f_" };
    }
    names.add(name);
  }
  if (names.size === 0) return { error: "aux declares no f_ state" };
  const unknown = extractIdentifiers(text).filter(function(idn) {
    return !portNames.has(idn) && !paramNames.has(idn)
      && !names.has(idn) && !AUX_KEYWORDS.has(idn);
  });
  if (unknown.length > 0) {
    return { error: "aux references non-port identifier(s): " + unknown.join(", ") };
  }
  return { names: names, text: text };
}

/** Render one spec.iface entry as a checker input port declaration. */
function portDecl(p) {
  const w = String(p.width == null ? "1" : p.width).trim();
  if (w === "" || w === "1") return "input logic " + p.name;
  // Width may already be a full range ("[7:0]") — use verbatim; otherwise
  // it's a width expression (a number or a parameter name like DATA_W).
  if (/^\[.*\]$/.test(w)) return "input logic " + w + " " + p.name;
  return "input logic [" + w + "-1:0] " + p.name;
}

/**
 * Build the checker module + bind directive from a formal_props result.
 *
 * @param {object} formalProps  the formal_props stage output
 *                              ({ properties: [{id, type, code, desc, req}], … })
 * @param {object} spec         the spec stage output (iface + params)
 * @param {string} modName      DUT module name (bind target)
 * @param {object} [diag]    optional out-param: receives { skipped } even
 *                            when the return is null, so callers can say WHY
 *                            nothing was bindable (run 16: a dropped aux
 *                            model silently took all 5 properties with it).
 * @returns {null | {
 *   text: string,            // SV snippet to append to the RTL file
 *   checkerName: string,     // for compile-failure detection
 *   included: string[],      // property ids that were bound
 *   skipped: {id, reason}[], // property ids that were not, and why
 *   auxLines: string[],      // validated aux model lines (may be empty)
 * }} null when there is nothing safe to bind.
 */
export function buildSvaChecker(formalProps, spec, modName, diag) {
  const props = (formalProps && formalProps.properties) || [];
  if (props.length === 0) return null;

  const ports = ((spec && spec.iface) || []).filter(function(p) { return p && p.name; });
  if (ports.length === 0) return null; // no ports → nothing to connect via .*

  const portNames = new Set(ports.map(function(p) { return p.name; }));
  const params = ((spec && spec.params) || []).filter(function(p) { return p && p.name; });
  const paramNames = new Set(params.map(function(p) { return p.name; }));

  const included = [];
  const skipped = [];
  const bodyLines = [];

  // ── AUX MODEL (optional) ──────────────────────────────────────────────
  // Checker-local state driven only by ports, so properties over hidden DUT
  // state (occupancy, credits) become expressible. Invalid aux is dropped
  // with a reason — properties that reference its names then skip through
  // the normal admission filter, and the build never breaks.
  let auxNames = new Set();
  let auxText = "";
  if (formalProps && formalProps.aux) {
    const v = validateAuxModel(formalProps.aux, portNames, paramNames);
    if (v.error) {
      skipped.push({ id: "AUX", reason: "aux model dropped: " + v.error });
    } else {
      auxNames = v.names;
      auxText = v.text;
    }
  }

  props.forEach(function(pr, idx) {
    const id = pr.id || ("SVA-" + (idx + 1));
    const code = (pr.code || "").trim();
    if (!code) { skipped.push({ id: id, reason: "empty code" }); return; }

    // Concurrent assertions only (see SCOPE note in the header).
    if (!/^(assert|assume)\s+property\s*\(/.test(code)) {
      skipped.push({
        id: id,
        reason: /^cover/.test(code)
          ? "cover statements not bound in simulation yet"
          : "not a concurrent assert/assume property",
      });
      return;
    }

    // Admit only properties whose identifiers are all resolvable in the
    // checker scope. One unknown name would break the entire compile.
    const unknown = extractIdentifiers(code).filter(function(idn) {
      return !portNames.has(idn) && !paramNames.has(idn) && !auxNames.has(idn);
    });
    if (unknown.length > 0) {
      skipped.push({ id: id, reason: "references non-port identifier(s): " + unknown.join(", ") });
      return;
    }

    included.push(id);
    bodyLines.push("  // " + id + (pr.req ? " (covers " + pr.req + ")" : "")
      + (pr.desc ? " — " + pr.desc : ""));
    bodyLines.push("  " + code);
  });

  if (diag && typeof diag === "object") diag.skipped = skipped;
  if (included.length === 0) return null;

  const checkerName = modName + "_rtlforge_sva";

  // Mirror the DUT's parameters with their spec defaults so width
  // expressions like [DATA_W-1:0] resolve inside the checker. NOTE: bind
  // does not propagate the DUT instance's parameter overrides — the checker
  // sees the defaults. The generated TB instantiates the DUT with default
  // parameters (testGen.js mandates it), so the two agree in practice.
  const paramSection = params.length > 0
    ? " #(\n" + params.map(function(p) {
        return "  parameter " + p.name + " = " + (p.def != null ? p.def : 0);
      }).join(",\n") + "\n)"
    : "";

  const text = [
    "",
    "// ── Auto-generated by RTL Forge (svaBind) ───────────────────────────",
    "// Formal properties from the formal_props stage, bound into the DUT so",
    // A comment whose FIRST token is "verilator" is parsed as a metacomment;
    // an unknown keyword after it is a fatal BADVLTPRAGMA (measured live:
    // nemotron run 10). No generated comment line may start with that token.
    "// the simulator evaluates them during the run (compile with --assert).",
    "// " + included.length + " of " + props.length + " properties bound; the rest were skipped for",
    "// referencing signals not on the DUT interface (see verify log).",
    "module " + checkerName + paramSection + " (",
    ports.map(function(p) { return "  " + portDecl(p); }).join(",\n"),
    ");",
    auxText
      ? "  // ── aux model: checker-local state driven only by DUT ports ──\n"
        + auxText.split("\n").map(function(l) { return "  " + l; }).join("\n")
      : null,
    bodyLines.join("\n"),
    "endmodule",
    "bind " + modName + " " + checkerName + " u_rtlforge_sva (.*);",
    "",
  ].filter(function(x) { return x != null; }).join("\n");

  return {
    text: text, checkerName: checkerName, included: included, skipped: skipped,
    // For the yosys/sby path: aux lines are inlined into the DUT alongside
    // the translated assertions (f_ prefix keeps them collision-free).
    auxLines: auxText ? auxText.split("\n") : [],
  };
}

/**
 * Idempotently add a flag (e.g. "--assert") to every verilator COMPILE line
 * in a simCmds list. Mirrors the --coverage auto-injection in verify.js:
 * compile lines are detected by "verilator" + a build/output flag, and
 * standalone verilator_coverage post-steps are left alone.
 */
export function injectVerilatorFlag(cmds, flag) {
  return cmds.map(function(c) {
    const isCompile = /verilator(\s|$)/.test(c) &&
      /(--binary|--cc|--main|--exe|-o\s)/.test(c) &&
      !/verilator_coverage/.test(c);
    if (isCompile && c.indexOf(flag) < 0) {
      return c.replace(/verilator(\s|$)/, "verilator " + flag + "$1");
    }
    return c;
  });
}

/**
 * True when a CLI result looks like the SVA checker itself broke the build —
 * non-zero exit AND the combined output names the checker module. Used by
 * verify/judge to retry the build without SVA instead of failing a good
 * design on a bad property.
 */
export function svaCompileFailed(cliResult, checkerName, opts) {
  if (!cliResult || cliResult.exitCode === 0) return false;
  const out = (cliResult.stdout || "") + "\n" + (cliResult.stderr || "");
  if (out.indexOf(checkerName) >= 0) return true;
  // The checker text is APPENDED to the RTL file, so a compile error can sit
  // inside it without naming the checker module (measured live in run 10: a
  // BADVLTPRAGMA on the checker's own header comment). Any error located in
  // the RTL file PAST the raw RTL's last line is the checker's fault.
  const fileName = opts && opts.rtlFileName;
  const rawLines = opts && opts.rtlLineCount;
  if (fileName && rawLines > 0) {
    const re = new RegExp("%(?:Error|Warning)[^\\n]*?" +
      fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":(\\d+)");
    let m;
    const scan = new RegExp(re.source, "g");
    while ((m = scan.exec(out)) !== null) {
      if (parseInt(m[1], 10) > rawLines) return true;
    }
  }
  return false;
}

// ─── formal translation (roadmap #8) ─────────────────────────────────────────
//
// Open-source yosys (`read -formal`) cannot parse CONCURRENT SVA — the exact
// checker verify binds for Verilator dies with "syntax error, unexpected '@'".
// It does support clocked IMMEDIATE assertions and $past. This pure pass
// rewrites the checker's simple concurrent forms:
//   assert property (@(posedge CLK) [disable iff (D)] A |-> B);
//     → always @(posedge CLK) if (!(D)) begin if (A) assert (B); end
//   assert property (@(posedge CLK) [disable iff (D)] EXPR);
//     → always @(posedge CLK) if (!(D)) begin assert (EXPR); end
// Sequence operators yosys can't express this way (##, |=>, s_eventually,
// until, throughout) make a property formal-skipped — it stays sim-checked.

// Sequence forms yosys cannot express as immediate assertions — plus
// $isunknown: X-detection is a SIMULATION construct; in the BMC model the
// solver chooses undef values, so an X-check property fails on solver
// artifacts, not design behavior (run 24: `$isunknown(full||empty) |-> 0`
// FAILed the whole formal stage and two fix iterations chased a non-bug).
// All of these remain sim-checked through the bound checker.
const UNTRANSLATABLE_RE = /##|\|=>|s_eventually|s_until|throughout|\buntil\b|first_match|\[\*|\[=|\[->|\$isunknown/;

/**
 * Strip balanced whole-expression outer parentheses: "(A |-> B)" → "A |-> B".
 * Only strips when the leading "(" closes at the VERY END of the string, so
 * "(a || b) && c" is untouched. Repeats for nested wrappers. Pure.
 */
export function stripOuterParens(s) {
  let cur = String(s || "").trim();
  for (;;) {
    if (!cur.startsWith("(") || !cur.endsWith(")")) return cur;
    let depth = 0;
    for (let i = 0; i < cur.length; i++) {
      if (cur[i] === "(") depth++;
      else if (cur[i] === ")") {
        depth--;
        if (depth === 0 && i < cur.length - 1) return cur;   // closes early → not a wrapper
      }
    }
    if (depth !== 0) return cur;   // unbalanced → leave untouched
    cur = cur.slice(1, -1).trim();
  }
}

export function svaCheckerToImmediate(checkerText) {
  const lines = String(checkerText || "").split("\n");
  const out = [];
  const assertLines = [];   // just the translated assertions — for INLINING
  const skippedFormal = [];
  let translated = 0;
  let lastComment = null;
  for (const line of lines) {
    // Property-id label: buildSvaChecker emits "  // SVA-008 (covers …) — …"
    // above each property. Capture id-shaped first tokens (SVA-008,
    // AUTO-ASSUME-001) so skippedFormal names the property — the old
    // whole-line-token match never fit that format and every skip was
    // labeled the fallback "prop" (seen live, run 24).
    const cm = line.match(/^\s*\/\/\s*([A-Za-z]\w*(?:-[\w.]+)+)\b/) || line.match(/^\s*\/\/\s*(\S+)\s*$/);
    if (cm) { lastComment = cm[1]; out.push(line); continue; }
    const m = line.match(/^(\s*)(assert|assume)\s+property\s*\(\s*@\(posedge\s+(\w+)\)\s*([\s\S]*)\);\s*$/);
    if (!m) { out.push(line); continue; }
    const [, indent, kind, clk] = m;
    let rest = m[4].trim();
    if (UNTRANSLATABLE_RE.test(rest)) {
      skippedFormal.push(lastComment || "prop");
      out.push(indent + "// formal-skipped (sequence form): " + (lastComment || ""));
      continue;
    }
    let disable = null;
    const dm = rest.match(/^disable\s+iff\s*\(([\s\S]*?)\)\s*/);
    if (dm) { disable = dm[1]; rest = rest.slice(dm[0].length).trim(); }
    // Strip a WHOLE-EXPRESSION paren wrapper before splitting on |->.
    // Run 29 (laguna): "(full |-> f_occ == DEPTH)" — the naive indexOf split
    // left one dangling outer paren on each fragment and emitted
    // "if ((full) assert (f_occ == DEPTH));" — yosys TOK_ASSERT, whole sby
    // task TOOL_ERROR. Repeated stripping handles "((A |-> B))" too; a
    // paren that closes before the end (e.g. "(a || b) && c") never strips.
    rest = stripOuterParens(rest);
    const imp = rest.indexOf("|->");
    const body = imp >= 0
      ? "if (" + rest.slice(0, imp).trim() + ") " + kind + " (" + rest.slice(imp + 3).trim() + ");"
      : kind + " (" + rest + ");";
    const guard = disable ? "if (!(" + disable + ")) " : "";
    const stmt = "always @(posedge " + clk + ") " + guard + "begin " + body + " end";
    out.push(indent + stmt);
    if (lastComment) assertLines.push("// " + lastComment);
    assertLines.push(stmt);
    translated++;
  }
  return { text: out.join("\n"), translated, skippedFormal, assertLines };
}

/**
 * Inline formal assertions INTO the DUT before its last endmodule. Needed
 * because open-source yosys silently IGNORES `bind` (measured: the buggy
 * design "PASSed" vacuously through the bound checker) — inside the module
 * the asserts see every port and internal directly.
 */
/**
 * Remove DUT-authored `ifdef FORMAL … `endif regions. sby reads the source
 * with `read -formal`, which defines FORMAL and exposes whatever hand-written
 * formal code the LLM put in the DUT — measured live in run 10: yosys died
 * with "syntax error, unexpected '@'" on an event-controlled concurrent
 * property, killing the whole BMC task. We verify OUR translated checker;
 * the DUT's inline block is only ever a liability here. An `else branch (the
 * non-formal path) is kept. The simulation RTL is never touched by this.
 */
export function stripDutFormalRegions(rtl) {
  const lines = String(rtl || "").split("\n");
  const out = [];
  let mode = 0;   // 0 normal, 1 dropping the FORMAL branch, 2 keeping its `else branch
  let depth = 0;  // conditional nesting inside the region
  for (const line of lines) {
    if (mode === 0) {
      if (/^\s*`ifdef\s+FORMAL\b/.test(line)) { mode = 1; depth = 0; continue; }
      out.push(line);
      continue;
    }
    if (/^\s*`if(n?)def\b/.test(line)) { depth++; if (mode === 2) out.push(line); continue; }
    if (/^\s*`endif\b/.test(line)) {
      if (depth === 0) { mode = 0; } else { depth--; if (mode === 2) out.push(line); }
      continue;
    }
    if (/^\s*`else\b/.test(line) && depth === 0 && mode === 1) { mode = 2; continue; }
    if (mode === 2) out.push(line);
  }
  return out.join("\n");
}

/**
 * Deterministic initial-reset assumption for BMC. Without it the solver
 * starts from an ARBITRARY register state and refutes properties over
 * modeled state with unreachable "initial" values (measured while building
 * the aux-model path: a correct FIFO "FAILed" f_occ <= DEPTH because occ
 * woke up at 31). Reset port + polarity come from the spec iface: a name
 * containing rst/reset; active-low when it ends in _n or its desc says
 * active-low. Returns the assume line, or null when no reset port exists.
 */
export function formalResetAssume(spec) {
  const iface = (spec && spec.iface) || [];
  const rst = iface.find(function(p) {
    return p && p.dir === "input" && /rst|reset/i.test(p.name || "");
  });
  if (!rst) return null;
  const desc = String(rst.desc || "").toLowerCase();
  const activeLow = /_n$/i.test(rst.name) || desc.indexOf("active-low") >= 0
    || desc.indexOf("active low") >= 0;
  return "initial assume (" + (activeLow ? "!" : "") + rst.name + ");";
}

// yosys-frontend compatibility for the FORMAL build only (simulation reads
// the original RTL). Verilator-legal SV that yosys's parser rejects is
// normalized to an equivalent form yosys accepts. Measured: run 26 —
// `dout <= '{default: '0};` on a packed vector made the whole BMC task
// TOOL_ERROR with "syntax error, unexpected TOK_DEFAULT" on an otherwise
// clean RTL. The all-zero/all-one assignment-pattern is exactly the fill
// literal, so the rewrite is semantics-preserving.
function yosysCompat(code) {
  return expandInside(code
    .replace(/'\{\s*default\s*:\s*(?:'0|1'b0|0)\s*\}/g, "'0")
    .replace(/'\{\s*default\s*:\s*(?:'1|1'b1)\s*\}/g, "'1"));
}

/**
 * Rewrite the SystemVerilog set-membership operator into an OR chain for the
 * FORMAL build only: `state inside {A, B, C}` → `(state == A || state == B
 * || state == C)`. Verilator accepts `inside` and simulates it correctly;
 * yosys's frontend rejects it outright ("syntax error, unexpected TOK_ID"),
 * which kills the WHOLE sby task on an otherwise clean design (measured,
 * run 34: a UART FSM used it in one continuous assign). Semantics-preserving
 * for the value-list form. Ranges (`inside {[lo:hi]}`) are LEFT ALONE — no
 * safe one-line equivalent — so a design using them still fails loudly
 * rather than being silently mistranslated.
 * Exported for testing.
 */
export function expandInside(code) {
  return String(code || "").replace(
    /([A-Za-z_]\w*(?:\s*\[[^\]]*\])?)\s+inside\s*\{([^{}\[\]]+)\}/g,
    function(whole, lhs, body) {
      const items = body.split(",").map(function(x) { return x.trim(); }).filter(Boolean);
      if (items.length === 0) return whole;
      return "(" + items.map(function(it) { return lhs.trim() + " == " + it; }).join(" || ") + ")";
    });
}

// System functions yosys accepts ONLY inside clocked always blocks. The
// formal FIXER's candidates are the measured source (run 30: a fix wrote
// $past into an assign; yosys killed the whole sby task with a terse
// "only allowed in clocked blocks" the next iteration couldn't map).
const CLOCKED_ONLY_RE = /\$(past|rose|fell|stable|changed|sampled)\b/;

/**
 * Lines using $past/$rose/$fell/$stable/$changed/$sampled OUTSIDE a clocked
 * always block. Pure, comment-stripped, line-based: a clocked region starts
 * at an `always @(posedge|negedge …)` / `always_ff` header and ends when its
 * begin/end nesting closes (or at the first `;` when the block never opens
 * a begin). always_comb / initial / assign contexts count as violations —
 * exactly yosys's rule.
 * @returns {Array<{line: number, fn: string, text: string}>} 1-indexed
 */
export function clockedOnlyViolations(code) {
  const lines = String(code || "")
    .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, " "); })
    .split("\n");
  const out = [];
  let inClocked = false;
  let depth = 0;
  let sawBegin = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\/\/.*$/, "");
    const header = /\balways_ff\b/.test(line)
      || (/\balways\b/.test(line) && /@\s*\(\s*(posedge|negedge)/.test(line));
    if (!inClocked && header) { inClocked = true; depth = 0; sawBegin = false; }
    const inClockedNow = inClocked;
    if (inClocked) {
      const b = (line.match(/\bbegin\b/g) || []).length;
      const e = (line.match(/\bend\b/g) || []).length;
      if (b > 0) sawBegin = true;
      depth += b - e;
      if (sawBegin && depth <= 0) inClocked = false;                    // block closed
      else if (!sawBegin && /;/.test(line) && !header) inClocked = false; // single-stmt body
      else if (!sawBegin && header && /;\s*$/.test(line)) inClocked = false; // one-liner
    }
    const m = line.match(CLOCKED_ONLY_RE);
    if (m && !inClockedNow) {
      out.push({ line: i + 1, fn: "$" + m[1], text: lines[i].trim().slice(0, 120) });
    }
  }
  return out;
}

export function inlineFormalAsserts(rtl, assertLines) {
  const code = yosysCompat(stripDutFormalRegions(rtl));
  const idx = code.lastIndexOf("endmodule");
  if (idx === -1 || !assertLines || assertLines.length === 0) return code;
  // Collision-rename: when the RTL itself declares an f_-prefixed name the
  // aux model also uses (run 26: the formal fixer rebuilt occupancy as its
  // own `f_occ`, primed by the assertion text in the prompt), the injected
  // duplicate becomes "multiple drivers" and kills the whole sby task.
  // Renaming the HARNESS side keeps the RTL untouched and the reference
  // model independent of the design's registers.
  let lines = assertLines;
  const auxNames = new Set();
  for (const l of lines) {
    for (const m of String(l).matchAll(/\bf_\w+\b/g)) auxNames.add(m[0]);
  }
  for (const name of auxNames) {
    if (!new RegExp("\\b" + name + "\\b").test(code)) continue;
    let renamed = name;
    do { renamed += "_chk"; } while (new RegExp("\\b" + renamed + "\\b").test(code));
    const re = new RegExp("\\b" + name + "\\b", "g");
    lines = lines.map(function(l) { return String(l).replace(re, renamed); });
  }
  const block = "\n  // rtlforge formal assertions (translated from bound SVA)\n"
    + lines.map(function(l) { return "  " + l; }).join("\n") + "\n";
  return code.slice(0, idx) + block + code.slice(idx);
}
