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
function extractIdentifiers(code) {
  const cleaned = String(code)
    .replace(/\d*'[sS]?[bodhBODH][0-9a-fA-F_xzXZ?]+/g, " ")  // based literals
    .replace(/\$[A-Za-z0-9_$]*/g, " ");                       // $functions
  const ids = cleaned.match(/[A-Za-z_][A-Za-z0-9_$]*/g) || [];
  return ids.filter(function(id) { return !SVA_KEYWORDS.has(id); });
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
 * @returns {null | {
 *   text: string,            // SV snippet to append to the RTL file
 *   checkerName: string,     // for compile-failure detection
 *   included: string[],      // property ids that were bound
 *   skipped: {id, reason}[], // property ids that were not, and why
 * }} null when there is nothing safe to bind.
 */
export function buildSvaChecker(formalProps, spec, modName) {
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
      return !portNames.has(idn) && !paramNames.has(idn);
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
    "// Verilator evaluates them during simulation (compile with --assert).",
    "// " + included.length + " of " + props.length + " properties bound; the rest were skipped for",
    "// referencing signals not on the DUT interface (see verify log).",
    "module " + checkerName + paramSection + " (",
    ports.map(function(p) { return "  " + portDecl(p); }).join(",\n"),
    ");",
    bodyLines.join("\n"),
    "endmodule",
    "bind " + modName + " " + checkerName + " u_rtlforge_sva (.*);",
    "",
  ].join("\n");

  return { text: text, checkerName: checkerName, included: included, skipped: skipped };
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
export function svaCompileFailed(cliResult, checkerName) {
  if (!cliResult || cliResult.exitCode === 0) return false;
  const out = (cliResult.stdout || "") + "\n" + (cliResult.stderr || "");
  return out.indexOf(checkerName) >= 0;
}
