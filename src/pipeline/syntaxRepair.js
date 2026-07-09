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

// ─── string/comment protection ──────────────────────────────────────────────
//
// Generated TBs are full of $display/$error text and comments that QUOTE
// code-like fragments. Transforms must never rewrite those (measured: a
// $display string had its 'b literal, range, and port text mutated — changing
// simulation output), and the hoist scanner must not count begin/end tokens
// inside them (measured: 'end' in a $display popped the real frame).

/** [start, end) ranges of double-quoted strings, // and /* *​/ comments. */
function protectedRanges(code) {
  const ranges = [];
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && code[j] !== '"' && code[j] !== "\n") { if (code[j] === "\\") j++; j++; }
      ranges.push([i, Math.min(j + 1, n)]);
      i = j + 1;
    } else if (c === "/" && code[i + 1] === "/") {
      let j = code.indexOf("\n", i);
      if (j < 0) j = n;
      ranges.push([i, j]);
      i = j;
    } else if (c === "/" && code[i + 1] === "*") {
      let j = code.indexOf("*/", i + 2);
      j = j < 0 ? n : j + 2;
      ranges.push([i, j]);
      i = j;
    } else {
      i++;
    }
  }
  return ranges;
}

/** Copy of `code` with protected chars blanked to spaces (newlines kept, so
 *  line structure and indices survive) — the hoist scanner reads this. */
function maskProtected(code) {
  const ranges = protectedRanges(code);
  if (ranges.length === 0) return code;
  const arr = code.split("");
  for (const [s, e] of ranges) {
    for (let k = s; k < e && k < arr.length; k++) if (arr[k] !== "\n") arr[k] = " ";
  }
  return arr.join("");
}

/** replace() that leaves matches inside strings/comments untouched. */
function guardedReplace(code, re, cb) {
  const ranges = protectedRanges(code);
  const isProtected = function(off, len) {
    for (const [s, e] of ranges) { if (off < e && off + len > s) return true; }
    return false;
  };
  return code.replace(re, function(...args) {
    const m = args[0];
    const off = args[args.length - 2];
    if (isProtected(off, m.length)) return m;
    return cb(...args);
  });
}

/** guardedReplace with a fix counter; $1…$9 in `sub` refer to capture groups. */
function countedReplace(code, re, sub) {
  let count = 0;
  code = guardedReplace(code, re, function(...args) {
    count++;
    return sub.replace(/\$(\d)/g, function(_, i) { return args[+i] == null ? "" : args[+i]; });
  });
  return { code, count };
}

// ─── individual transforms (each: code → { code, count }) ───────────────────

// 0. Markdown fence leakage (measured: nemotron via the reasoning channel —
//    a stray "`" glued to a comment line and a lone "`" after endmodule made
//    the RTL unparseable for the entire rest of the pipeline). Three forms,
//    each with no legal SV reading:
//      ```sv / ``` fence lines            → removed
//      a line that is only "`" (or "``")  → removed
//      `// comment                        → backtick stripped (a directive
//                                           name never starts with '/')
//    Real directives (`timescale, `endif, `MACRO) have a word character after
//    the backtick and can never match.
function fixFenceBackticks(code) {
  let count = 0;
  let r = countedReplace(code, /^[ \t]*`{3}[A-Za-z]*[ \t]*$/gm, "");
  code = r.code; count += r.count;
  r = countedReplace(code, /^[ \t]*`{1,2}[ \t]*$/gm, "");
  code = r.code; count += r.count;
  // Lookahead (not consume) the comment: '//' opens a protected range and
  // consuming it would make the guard skip the whole match.
  r = countedReplace(code, /^([ \t]*)`(?=[ \t]*\/\/)/gm, "$1");
  code = r.code; count += r.count;
  // Markdown HEADING wrapping a directive (measured: a TB began
  // "# `timescale 1ns/1ps"). Anchored on hash + whitespace + backtick — a
  // legal delay is #10 or #(expr), never hash-space-backtick.
  r = countedReplace(code, /^([ \t]*)#[ \t]+(?=`)/gm, "$1");
  code = r.code; count += r.count;
  return { code, count };
}

// 0b. C leakage (measured: nemotron run 5 — a TB opened with
//     `#include "verilator_top.h"`). A line-leading `#include` is C
//     preprocessor syntax with no legal SV reading (SV includes use the
//     `include directive, and a delay control `#` is never followed by the
//     word include) — the line is removed.
function fixCInclude(code) {
  // Line-based on the MASKED text: the include's quoted filename is a
  // protected string range, so a guardedReplace consuming the whole line
  // would skip it (measured in this transform's own test).
  const lines = code.split("\n");
  const masked = maskProtected(code).split("\n");
  let count = 0;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^[ \t]*#[ \t]*include\b/.test(masked[i])) { count++; continue; }
    out.push(lines[i]);
  }
  return count === 0 ? { code, count: 0 } : { code: out.join("\n"), count };
}

// 0c. C char-literal quoting on unsized fill literals (measured: nemotron
//     run 5 — `check(q == '0', …)` written as `'0'`; the closing apostrophe
//     starts a new literal token and Verilator errors "expecting '('" on
//     whatever follows). SV has no single-quoted character literal, so
//     '0'/'1'/'x'/'z' wrapped in apostrophes has exactly one reading: the
//     unsized fill literal plus a stray quote. Strings are protected, so a
//     quoted "'0'" inside $display text never matches.
function fixCharLiteral(code) {
  return countedReplace(code, /'([01xzXZ])'/g, "'$1");
}

// 0d. Hallucinated system task (measured: nemotron run 5 — `$describe(...)`
//     four times where $display was meant; Verilator: "Unsupported or unknown
//     PLI call"). Only measured hallucinations are mapped — each entry has no
//     legal reading, so a rewrite can only help.
const PLI_TYPO_MAP = [
  [/\$describe\b/g, "$display"],
];
function fixPliTypos(code) {
  let count = 0;
  for (const [re, sub] of PLI_TYPO_MAP) {
    const r = countedReplace(code, re, sub);
    code = r.code; count += r.count;
  }
  return { code, count };
}

// 1. Bare compiler directives → backticked. Anchored per-directive (timescale
//    must be followed by a time literal, include by a quote, …) so identifiers
//    merely starting with these words are untouched. An already-backticked
//    directive can't match (the backtick sits between ^(\s*) and the word).
const DIRECTIVE_FIXES = [
  [/^(\s*)timescale(\s+\d+\s*[munpf]?s\s*\/\s*\d+\s*[munpf]?s)/gm, "$1`timescale$2"],
  // Lookahead (not consume) the quote: the quote opens a protected string
  // range and consuming it would make the guard skip the whole match.
  [/^(\s*)include(\s+)(?=["<])/gm, "$1`include$2"],
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
  code = guardedReplace(code,
    /\b(input|output|inout)\s+([A-Za-z_]\w*)\s*:\s*(logic|wire|reg|bit|byte|integer|int)\b[ \t]*(\[[^\]]+\])?/g,
    function(m, dir, name, type, range) {
      count++;
      return dir + " " + type + (range ? " " + range : "") + " " + name;
    });
  code = guardedReplace(code,
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
const DECL_RE = /^(\s*)(logic|reg|bit|byte|integer|int|longint|shortint|real|time|string)((?:\s+(?:signed|unsigned))?(?:\s*\[[^\]]+\])?)\s+([A-Za-z_]\w*)((?:\s*\[[^\]]+\])?)\s*(?:=\s*([^;]+))?;\s*(\/\/.*)?$/;
const PROC_OPENER_RE = /\b(always(?:_ff|_comb|_latch)?|initial|final|task|function)\b/;

function hoistMidBlockDecls(code) {
  const lines = code.split("\n");
  // Depth counting + statement gating read the MASKED lines: begin/end tokens
  // inside $display strings or comments must not move the frame stack
  // (measured: a string 'end' popped the real frame → hoists silently skipped).
  const maskedLines = maskProtected(code).split("\n");
  const replaced = new Map();     // lineIdx → replacement text (null = drop)
  const insertions = new Map();   // beginLineIdx → hoisted decl texts
  const stack = [];               // { beginIdx, procedural, sawStatement }
  let prevMeaningful = "";
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bare = maskedLines[i].trim();
    const begins = (bare.match(/\bbegin\b/g) || []).length;
    const ends = (bare.match(/\bend\b/g) || []).length;

    if (begins === 1 && ends === 0) {
      // Block opens. Opening a nested block IS a statement of the parent (per
      // the LRM, decls may not follow it), so mark the parent before pushing.
      const parentProc = stack.length > 0 && stack[stack.length - 1].procedural;
      if (stack.length) stack[stack.length - 1].sawStatement = true;
      const opener = PROC_OPENER_RE.test(bare) || PROC_OPENER_RE.test(prevMeaningful);
      stack.push({ beginIdx: i, procedural: parentProc || opener, sawStatement: false });
    } else if (begins === 0 && ends >= 1) {
      for (let k = 0; k < ends && stack.length; k++) stack.pop();
    } else if (begins === 1 && ends === 1) {
      const bi = bare.search(/\bbegin\b/);
      const ei = bare.search(/\bend\b/);
      if (ei !== -1 && ei < bi) {
        // "end else begin": close + reopen; the new block inherits proceduralness.
        const top = stack.pop() || { procedural: false };
        const parentProc = (stack.length > 0 && stack[stack.length - 1].procedural) || top.procedural;
        stack.push({ beginIdx: i, procedural: parentProc, sawStatement: false });
      } else if (stack.length) {
        // Self-contained one-liner "if (x) begin y = 1; end": depth-neutral —
        // it must NOT pop the enclosing frame (measured: doing so re-anchored
        // later hoists to the one-liner, mid-block). It is itself a statement.
        stack[stack.length - 1].sawStatement = true;
      }
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

// 6. Procedurally-assigned wire → variable (measured: nemotron's counter —
//    `output [3:0] q`, implicitly a wire, driven from always_ff; Verilator:
//    "Procedural assignment to wire, perhaps intended var"). For every signal
//    assigned inside a procedural region, a declaration that makes it a NET
//    is rewritten to `logic`:
//      output [3:0] q;        → output logic [3:0] q;
//      output wire [3:0] q;   → output logic [3:0] q;
//      wire [3:0] state;      → logic [3:0] state;
//    Detection walks the masked lines with the same begin/end + proc-opener
//    stack the hoist transform uses, so only statements genuinely inside
//    always*/initial/final/task/function regions mark a name — an
//    `a <= b` COMPARISON in an assign/port expression never does. `inout`
//    is deliberately untouched (tristates must stay nets). A false positive
//    is structurally impossible for ports (output logic is legal whether
//    driven procedurally or continuously); single-driver internal wires
//    remain legal as logic too.
function fixProceduralWire(code) {
  const maskedLines = maskProtected(code).split("\n");
  const assigned = new Set();
  const stack = [];               // procedural begin/end frames (see hoist)
  let prevMeaningful = "";
  let pendingProcOneLiner = false; // `always_ff @(…)` line without begin → next stmt is procedural
  const ASSIGN_RE = /(^|[;{]|\bbegin\b|\belse\b|\)\s*)([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?(?:<=|=)(?!=)/g;

  for (let i = 0; i < maskedLines.length; i++) {
    const bare = maskedLines[i].trim();
    const begins = (bare.match(/\bbegin\b/g) || []).length;
    const ends = (bare.match(/\bend\b/g) || []).length;
    const opensProc = PROC_OPENER_RE.test(bare) || (begins > 0 && PROC_OPENER_RE.test(prevMeaningful))
      || pendingProcOneLiner;
    const inProc = stack.length > 0 || opensProc;

    if (inProc && bare) {
      for (const m of bare.matchAll(ASSIGN_RE)) assigned.add(m[2]);
    }

    // Track begin/end depth; a proc opener without begin marks the NEXT
    // statement line as procedural (single-statement always).
    if (begins > ends) {
      for (let k = 0; k < begins - ends; k++) stack.push(1);
      pendingProcOneLiner = false;
    } else if (ends > begins) {
      for (let k = 0; k < ends - begins && stack.length; k++) stack.pop();
    } else if (PROC_OPENER_RE.test(bare) && begins === 0) {
      // `always_ff @(posedge clk)` alone (or with the stmt on the same line)
      pendingProcOneLiner = !/;/.test(bare);
    } else if (bare && pendingProcOneLiner && /;/.test(bare)) {
      pendingProcOneLiner = false;
    }
    if (bare) prevMeaningful = bare;
  }
  if (assigned.size === 0) return { code, count: 0 };

  let count = 0;
  // Output port declarations lacking a variable type: add/replace with logic.
  code = guardedReplace(code,
    /\boutput(\s+)(wire\s+)?((?:signed\s+)?(?:\[[^\]]+\]\s*)?)([A-Za-z_]\w*)\b/g,
    function(m0, sp, wire, mid, name) {
      if (!assigned.has(name)) return m0;
      if (/^(logic|reg|wire|signed)$/.test(name)) return m0;   // typed decl — name grabbed a keyword
      count++;
      return "output" + sp + "logic " + mid + name;
    });
  // Standalone net declarations: wire … name → logic … name.
  code = guardedReplace(code,
    /\bwire(\s+(?:signed\s+)?(?:\[[^\]]+\]\s*)?)([A-Za-z_]\w*)/g,
    function(m0, mid, name) {
      if (!assigned.has(name)) return m0;
      count++;
      return "logic" + mid + name;
    });
  return { code, count };
}

// 7. Missing `endtask` before the next task / endmodule (measured: nemotron's
//    TB closed a task's begin…end but dropped the endtask — the next `task`
//    keyword then cascades into 30 "unexpected task" errors, and the fixer
//    only ever sees the symptoms, never the cause). When a new task
//    declaration (or endmodule) is reached while a previous task is still
//    open AND its begin/end depth is balanced, the only legal reading is that
//    `endtask` was dropped — insert it. An unbalanced begin/end inside the
//    open task means a DIFFERENT defect; nothing is inserted (conservative).
function fixMissingEndtask(code) {
  const lines = code.split("\n");
  const maskedLines = maskProtected(code).split("\n");
  const insertions = new Map();   // lineIdx → insert "endtask" BEFORE this line
  let inTask = false;
  let depth = 0;                  // begin/end depth inside the open task
  let taskIndent = "";
  let count = 0;

  for (let i = 0; i < maskedLines.length; i++) {
    const bare = maskedLines[i];
    const opensTask = /^\s*task\b/.test(bare);
    // Constructs that can only exist at MODULE scope — reaching one while a
    // task is still open (and balanced) proves the endtask was dropped.
    const moduleScope = /^\s*(endmodule|initial|final|always(_ff|_comb|_latch)?|assign|generate|function)\b/.test(bare);
    if ((opensTask || moduleScope) && inTask && depth === 0) {
      insertions.set(i, taskIndent + "endtask");
      count++;
      inTask = false;
    }
    if (opensTask) {
      inTask = true;
      depth = 0;
      taskIndent = (lines[i].match(/^\s*/) || [""])[0];
    } else if (/\bendtask\b/.test(bare)) {
      inTask = false;
      depth = 0;
    } else if (inTask) {
      depth += (bare.match(/\bbegin\b/g) || []).length;
      depth -= (bare.match(/\bend\b/g) || []).length;   // \bend\b never matches endtask/endmodule
    }
  }
  if (count === 0) return { code, count: 0 };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (insertions.has(i)) { out.push(insertions.get(i)); if (lines[i - 1] && lines[i - 1].trim() !== "") out.push(""); }
    out.push(lines[i]);
  }
  return { code: out.join("\n"), count };
}

// 8. Hyphenated task/function names → underscores (measured: a test-review
//    fix emitted `task automatic test_REQ-FUNC-001();` — requirement ids
//    pasted as identifiers; `-` parses as minus and every declaration AND
//    call errors). Anchored to declaration lines and bare call statements,
//    where a hyphenated name has no legal reading — a genuine subtraction in
//    an expression is never touched.
function fixHyphenatedTaskNames(code) {
  let count = 0;
  code = guardedReplace(code, /^(\s*task\s+(?:automatic\s+)?)([A-Za-z_][\w-]*)(\s*\()/gm,
    function(m0, head, name, paren) {
      if (name.indexOf("-") < 0) return m0;
      count++;
      return head + name.replace(/-/g, "_") + paren;
    });
  // Bare call statements: `   test_REQ-FUNC-001();`
  code = guardedReplace(code, /^(\s*)([A-Za-z_][\w-]*)(\s*\(\s*\)\s*;)/gm,
    function(m0, indent, name, tail) {
      if (name.indexOf("-") < 0) return m0;
      count++;
      return indent + name.replace(/-/g, "_") + tail;
    });
  return { code, count };
}

// 9. Instance-override syntax in a MODULE HEADER's #(…) → parameter
//    declarations (measured: nemotron wrote `module up_counter #( .DATA_W(4) )`
//    — a two-token error that survived 3 lint fix iterations and 2 verify
//    triage rounds; the golden sim passed 7/7 the moment it was corrected).
//    The .NAME(value) form is legal ONLY in instantiations; an instantiation
//    can never match here because the anchor requires the `module` keyword.
function fixParamHeader(code) {
  const masked = maskProtected(code);
  const headRe = /\bmodule\s+[A-Za-z_]\w*\s*(?:import\s+[^;]+;\s*)?#\s*\(/g;
  let count = 0;
  let out = code;
  const regions = [];               // [contentStart, contentEnd) of each #(…)
  let m;
  while ((m = headRe.exec(masked))) {
    const open = m.index + m[0].length - 1;
    let depth = 1, j = open + 1;
    while (j < masked.length && depth > 0) {
      if (masked[j] === "(") depth++;
      else if (masked[j] === ")") depth--;
      j++;
    }
    if (depth === 0) regions.push([open + 1, j - 1]);
  }
  // Rewrite right-to-left so earlier offsets stay valid. Matches are located
  // on the MASKED slice (a ".N(v)" quoted in a header comment never fires)
  // and spliced into the raw text.
  for (let r = regions.length - 1; r >= 0; r--) {
    const [s, e] = regions[r];
    const maskedSlice = masked.slice(s, e);
    const edits = [];
    for (const it of maskedSlice.matchAll(/\.\s*([A-Za-z_]\w*)\s*\(\s*([^()]*?)\s*\)/g)) {
      edits.push({ idx: it.index, len: it[0].length, name: it[1], val: it[2] });
    }
    if (edits.length === 0) continue;
    let slice = out.slice(s, e);
    for (let k = edits.length - 1; k >= 0; k--) {
      const ed = edits[k];
      // Value text comes from the RAW slice so comments/strings in the value
      // position (none are legal, but be safe) survive verbatim.
      const rawVal = out.slice(s + ed.idx, s + ed.idx + ed.len)
        .replace(/^\.\s*[A-Za-z_]\w*\s*\(\s*/, "").replace(/\s*\)$/, "");
      slice = slice.slice(0, ed.idx) + "parameter " + ed.name + " = " + rawVal
        + slice.slice(ed.idx + ed.len);
      count++;
    }
    out = out.slice(0, s) + slice + out.slice(e);
  }
  return { code: out, count };
}

// 9b. Replication missing its outer braces (measured: nemotron run 7 — an
//     RTL-review fix rewrote a clean reset to `q <= (DATA_W){1'b0};`; the
//     legal form is {DATA_W{1'b0}}). Anchored to assignment context: right
//     after = or <=, a parenthesized count followed by a braced value has no
//     legal reading (a conditional would have '?' between, a cast an
//     apostrophe). Inside braces `{(N){v}}` is already legal replication and
//     never matches (the anchor requires the assignment operator).
function fixParenReplication(code) {
  return countedReplace(code,
    /(<=|(?<![<>=!])=(?!=))(\s*)\(([^()]+)\)\s*\{([^{}]+)\}/g,
    "$1$2{$3{$4}}");
}

// 10. Sampling race: a check() reading DUT outputs in the same instant the
//    clock edge updates them — `@(posedge clk);` immediately followed by a
//    check call samples mid-update (measured TB failure class: expectation
//    checks off by the settling delta). Per the user's chosen policy
//    (docs/tb-correctness.md): insert a `#1;` settle between the edge wait
//    and the check — minimal diff, same cycle, post-update value. CHECK
//    statements only (drive-side timing is never rewritten); already-settled
//    code (`#1;`, negedge sampling, step()-based tests) passes through, so
//    the transform is idempotent.
function fixSamplingRace(code) {
  let count = 0;
  // One-liner form: `@(posedge clk); check(...)` → settle inline.
  code = guardedReplace(code,
    /(@\(\s*posedge\s+\w+\s*\)\s*;)([ \t]*)((?:`)?check\s*\()/gi,
    function(m0, edge, sp, chk) {
      count++;
      return edge + " #1;" + (sp || " ") + chk;
    });
  // Two-line form: edge wait on its own line, check on the next non-blank
  // line. Masked scan so strings/comments never anchor.
  const lines = code.split("\n");
  const masked = maskProtected(code).split("\n");
  const insertions = new Map();
  for (let i = 0; i < masked.length; i++) {
    if (!/^\s*@\(\s*posedge\s+\w+\s*\)\s*;\s*$/.test(masked[i])) continue;
    let j = i + 1;
    while (j < masked.length && masked[j].trim() === "") j++;
    if (j >= masked.length) continue;
    const next = masked[j];
    if (/^\s*(?:`)?check\s*\(/i.test(next)) {
      insertions.set(j, (lines[j].match(/^\s*/) || [""])[0] + "#1;");
      count++;
    }
  }
  if (insertions.size > 0) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (insertions.has(i)) out.push(insertions.get(i));
      out.push(lines[i]);
    }
    code = out.join("\n");
  }
  return { code, count };
}

// ─── public API ──────────────────────────────────────────────────────────────

const TRANSFORMS = [
  ["fence-backtick-strip", fixFenceBackticks],   // first: later transforms see clean lines
  ["c-include-strip", fixCInclude],
  ["char-literal-unsized", fixCharLiteral],
  ["hallucinated-pli", fixPliTypos],
  ["backtick-directive", fixDirectives],
  ["vhdl-colon-port", fixColonPorts],      // before packed-range (it emits full ranges)
  ["packed-range-bound", fixPackedRange],
  ["literal-base", fixLiteralBase],
  ["midblock-decl-hoist", hoistMidBlockDecls],
  ["procedural-wire-to-var", fixProceduralWire],
  ["missing-endtask", fixMissingEndtask],
  ["hyphenated-task-name", fixHyphenatedTaskNames],
  ["ansi-param-header", fixParamHeader],
  ["paren-replication", fixParenReplication],
  ["sampling-race-settle", fixSamplingRace],
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
/**
 * maybeRepair + the standard log line when fixes fired. `logFn(title, body)` is
 * the node's appendLog. One helper so the wiring isn't copy-pasted per site.
 */
export function maybeRepairWithLog(config, code, logFn) {
  const r = maybeRepair(config, code);
  if (r.fixes && logFn) {
    logFn("Deterministic syntax repair", r.total + " mechanical fix(es): "
      + r.fixes.map(function(f) { return f.rule + "×" + f.count; }).join(", "));
  }
  return r;
}

export function maybeRepair(config, code) {
  // Non-string code (a flaky model returned a nested object) passes through
  // untouched on BOTH paths — String()-coercing it here would destroy the
  // artifact ("[object Object]") where the off path forwards it as-is.
  if (typeof code !== "string") return { code, fixes: null, total: 0 };
  if (!config || !config.syntaxRepair) return { code, fixes: null, total: 0 };
  const r = repairSV(code);
  return { code: r.code, fixes: r.total > 0 ? r.fixes : null, total: r.total };
}
