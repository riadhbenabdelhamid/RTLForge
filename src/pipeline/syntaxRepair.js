// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// syntaxRepair — deterministic mechanical fixes for generated SV (opt-in, T3)
//
// Weak local models' dominant lint errors are MECHANICAL (measured on
// lfm2-24b-a2b / gpt-oss-120b / nemotron — docs/syntax-repair.md): a packed
// vector missing its lower bound, a decimal value in a 'b literal, a compiler
// directive missing its backtick, a VHDL-style colon-typed port, a variable
// declared mid-block. Each is fixable by a text transform at zero LLM cost,
// where a prompt hint measured no lift and an LLM fix-loop iteration costs
// minutes.
//
// CONSERVATIVE BY CONSTRUCTION: every transform fires only on a construct that
// is invalid where it stands (so a repair can only help — a wrong guess still
// fails lint and enters the fix loop exactly as before), and anchors on context
// so legal look-alikes (unpacked dims, hex literals, generate-block decls) are
// untouched. Idempotent: repairing repaired code is a no-op.
//
// Pure + browser-safe. Nodes call maybeRepair(config, code) — the opt-in gate
// (config.syntaxRepair, default off → input returned byte-identical).
// ═══════════════════════════════════════════════════════════════════════════

/** replace() with a fix counter; $1…$9 in `sub` refer to capture groups. */
function countedReplace(code, re, sub) {
  let count = 0;
  code = code.replace(re, function(...args) {
    count++;
    return sub.replace(/\$(\d)/g, function(_, i) { return args[+i] == null ? "" : args[+i]; });
  });
  return { code, count };
}

// ─── individual transforms (each: code → { code, count }) ───────────────────

// 1. Bare compiler directives → backticked. Anchored per-directive (timescale
//    must be followed by a time literal, include by a quote, …) so identifiers
//    merely starting with these words are untouched. An already-backticked
//    directive can't match (the backtick sits between ^(\s*) and the word).
const DIRECTIVE_FIXES = [
  [/^(\s*)timescale(\s+\d+\s*[munpf]?s\s*\/\s*\d+\s*[munpf]?s)/gm, "$1`timescale$2"],
  [/^(\s*)include(\s+["<])/gm, "$1`include$2"],
  [/^(\s*)define(\s+[A-Za-z_])/gm, "$1`define$2"],
  [/^(\s*)(ifdef|ifndef|undef)(\s+[A-Za-z_])/gm, "$1`$2$3"],
  [/^(\s*)endif\s*$/gm, "$1`endif"],
  [/^(\s*)default_nettype(\s+(?:wire|none|tri0|tri1|tri|wand|wor|uwire))\b/gm, "$1`default_nettype$2"],
];
function fixDirectives(code) {
  let count = 0;
  for (const [re, sub] of DIRECTIVE_FIXES) {
    const r = countedReplace(code, re, sub);
    code = r.code; count += r.count;
  }
  return { code, count };
}

// 2. VHDL-style colon-typed ports/params → SystemVerilog order.
//    input rst_n : logic        → input logic rst_n
//    output data : logic [7:0]  → output logic [7:0] data
//    parameter W : int = 8      → parameter int W = 8
function fixColonPorts(code) {
  let count = 0;
  code = code.replace(
    /\b(input|output|inout)\s+([A-Za-z_]\w*)\s*:\s*(logic|wire|reg|bit|byte|integer|int)\b[ \t]*(\[[^\]]+\])?/g,
    function(m, dir, name, type, range) {
      count++;
      return dir + " " + type + (range ? " " + range : "") + " " + name;
    });
  code = code.replace(
    /\bparameter\s+([A-Za-z_]\w*)\s*:\s*(int|integer|logic|bit)\b[ \t]*(\[[^\]]+\])?\s*=/g,
    function(m, name, type, range) {
      count++;
      return "parameter " + type + (range ? " " + range : "") + " " + name + " =";
    });
  return { code, count };
}

// 3. Packed range missing its lower bound: a bracket with NO colon in packed
//    position — right after a type or direction keyword, before the identifier.
//    Unpacked dims after the name (mem [8]) and indexing (mem[addr]) never
//    match because an identifier intervenes before the bracket.
function fixPackedRange(code) {
  let count = 0;
  let r = countedReplace(code,
    /\b(logic|reg|wire|bit|byte|shortint|longint|integer|int)((?:\s+(?:signed|unsigned))?)\s*\[([^\][:]+)\]/g,
    "$1$2 [$3:0]");
  code = r.code; count += r.count;
  r = countedReplace(code,
    /\b(input|output|inout)\s+\[([^\][:]+)\]/g,
    "$1 [$2:0]");
  code = r.code; count += r.count;
  return { code, count };
}

// 4. Sized 'b literal whose value is plainly decimal (contains 2-9, only
//    [0-9_]) → 'd, preserving the value the author actually typed. Ambiguous
//    cases (all-binary digits but too wide, hex-looking values) are left for
//    the fix loop — we repair only what has one obvious reading.
function fixLiteralBase(code) {
  return countedReplace(code, /(\d+)'[bB]([0-9_]*[2-9][0-9_]*)\b/g, "$1'd$2");
}

// 5. Mid-block declaration hoisting. Only inside blocks known PROCEDURAL (a
//    begin opened by always*/initial/final/task/function, or nested inside
//    one) — generate/module-scope begins are never touched, because there a
//    decl-after-item is legal and splitting its initializer would be wrong.
//    A single-variable decl AFTER the first statement is hoisted to just
//    below its block's begin; an initializer stays in place as an assignment
//    (semantically identical in procedural context).
const DECL_RE = /^(\s*)(logic|reg|bit|byte|integer|int|longint|shortint|real|time)((?:\s+(?:signed|unsigned))?(?:\s*\[[^\]]+\])?)\s+([A-Za-z_]\w*)((?:\s*\[[^\]]+\])?)\s*(?:=\s*([^;]+))?;\s*(\/\/.*)?$/;
const PROC_OPENER_RE = /\b(always(?:_ff|_comb|_latch)?|initial|final|task|function)\b/;

function hoistMidBlockDecls(code) {
  const lines = code.split("\n");
  const replaced = new Map();     // lineIdx → replacement text (null = drop)
  const insertions = new Map();   // beginLineIdx → hoisted decl texts
  const stack = [];               // { beginIdx, procedural, sawStatement }
  let prevMeaningful = "";
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bare = line.replace(/\/\/.*$/, "").trim();
    const begins = (bare.match(/\bbegin\b/g) || []).length;
    const ends = (bare.match(/\bend\b/g) || []).length;

    if (begins === 1 && ends === 0) {
      // Block opens. Procedural if the parent is, or the opener context is.
      const parentProc = stack.length > 0 && stack[stack.length - 1].procedural;
      const opener = PROC_OPENER_RE.test(bare) || PROC_OPENER_RE.test(prevMeaningful);
      stack.push({ beginIdx: i, procedural: parentProc || opener, sawStatement: false });
    } else if (begins === 0 && ends >= 1) {
      for (let k = 0; k < ends && stack.length; k++) stack.pop();
    } else if (begins > 0 && begins === ends) {
      // "end else begin": the new block inherits proceduralness.
      const top = stack.pop() || { procedural: false };
      const parentProc = (stack.length > 0 && stack[stack.length - 1].procedural) || top.procedural;
      stack.push({ beginIdx: i, procedural: parentProc, sawStatement: false });
    } else if (begins > 0 || ends > 0) {
      // Odd formatting (unbalanced multi-begin/end on one line) — keep depth,
      // conservatively untrackable (no hoisting in these frames).
      for (let k = 0; k < ends && stack.length; k++) stack.pop();
      for (let k = 0; k < begins; k++) stack.push({ beginIdx: i, procedural: false, sawStatement: false });
    } else if (bare && stack.length) {
      const frame = stack[stack.length - 1];
      const m = line.match(DECL_RE);
      if (m) {
        if (frame.procedural && frame.sawStatement) {
          const indent = m[1], type = m[2], mods = m[3] || "", name = m[4], unpacked = m[5] || "", init = m[6];
          const decl = indent + type + mods + " " + name + unpacked + ";";
          if (!insertions.has(frame.beginIdx)) insertions.set(frame.beginIdx, []);
          insertions.get(frame.beginIdx).push(decl);
          replaced.set(i, init != null ? (indent + name + " = " + init.trim() + ";") : null);
          count++;
        }
        // A decl before the first statement is already legal — left in place.
      } else {
        frame.sawStatement = true;   // any other meaningful line is a statement
      }
    }

    if (bare) prevMeaningful = bare;
  }

  if (count === 0) return { code, count: 0 };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (replaced.has(i)) { const r = replaced.get(i); if (r !== null) out.push(r); }
    else out.push(lines[i]);
    if (insertions.has(i)) for (const d of insertions.get(i)) out.push(d);
  }
  return { code: out.join("\n"), count };
}

// ─── public API ──────────────────────────────────────────────────────────────

const TRANSFORMS = [
  ["backtick-directive", fixDirectives],
  ["vhdl-colon-port", fixColonPorts],      // before packed-range (it emits full ranges)
  ["packed-range-bound", fixPackedRange],
  ["literal-base", fixLiteralBase],
  ["midblock-decl-hoist", hoistMidBlockDecls],
];

/**
 * Run every repair transform. Pure + idempotent.
 * @param {string} code generated SystemVerilog
 * @returns {{code: string, fixes: Array<{rule: string, count: number}>, total: number}}
 */
export function repairSV(code) {
  let cur = String(code || "");
  const fixes = [];
  let total = 0;
  for (const [rule, fn] of TRANSFORMS) {
    const r = fn(cur);
    cur = r.code;
    if (r.count > 0) { fixes.push({ rule, count: r.count }); total += r.count; }
  }
  return { code: cur, fixes, total };
}

/**
 * The opt-in gate the generation nodes call. Off (default) → the input is
 * returned byte-identical and fixes is null, so the pipeline is unchanged.
 * @param {object} config   run config (reads config.syntaxRepair)
 * @param {string} code
 * @returns {{code: string, fixes: Array|null, total: number}}
 */
export function maybeRepair(config, code) {
  if (!config || !config.syntaxRepair) return { code, fixes: null, total: 0 };
  const r = repairSV(code);
  return { code: r.code, fixes: r.total > 0 ? r.fixes : null, total: r.total };
}
