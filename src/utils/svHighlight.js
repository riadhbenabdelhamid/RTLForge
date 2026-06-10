// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// utils/svHighlight — SystemVerilog tokeniser for syntax highlighting
//
// Produces a list of typed tokens that the renderer wraps with colour spans.
// Token types: keyword, type, comment, string, number, directive, operator,
// identifier, whitespace.
//
// Why custom over a syntax-highlighting library:
//   - Bundle size matters (~520kb gzipped already). Prism+sv-grammar adds
//     ~80kb; hljs adds ~50kb; Shiki adds ~200kb. A focused SV tokeniser
//     covering the dialect RTL Forge generates is ~120 lines.
//   - The grammar we need to highlight is narrow: synthesisable RTL plus
//     a slice of testbench / SVA constructs. We don't need full IEEE 1800
//     coverage.
//
// Trade-off: we won't catch every edge case of the SV spec. For example,
// nested block comments are NOT supported (they aren't legal in SV anyway).
// Macro-time evaluation is not interpreted — we just colour `define and
// `ifdef as directives.
// ═══════════════════════════════════════════════════════════════════════════

// Keyword sets are deliberately narrow — only the constructs RTL Forge
// emits. Adding more is fine but increases token-classification cost.
const KEYWORDS = new Set([
  "module", "endmodule", "package", "endpackage", "import", "export",
  "begin", "end", "if", "else", "case", "casex", "casez", "endcase",
  "default", "for", "foreach", "while", "do", "repeat", "forever",
  "break", "continue", "return",
  "always", "always_ff", "always_comb", "always_latch",
  "initial", "final", "fork", "join", "join_any", "join_none",
  "function", "endfunction", "task", "endtask", "automatic", "static",
  "input", "output", "inout", "ref",
  "assign", "deassign", "force", "release",
  "posedge", "negedge", "edge", "or", "and", "not", "xor", "xnor", "nor", "nand",
  "wait", "disable",
  "generate", "endgenerate", "genvar",
  "interface", "endinterface", "modport", "clocking", "endclocking",
  "class", "endclass", "extends", "virtual", "pure", "local", "protected",
  "this", "super", "new", "null",
  "parameter", "localparam", "specparam", "const",
  "typedef", "enum", "struct", "union", "packed", "unpacked",
  "primitive", "endprimitive",
  "config", "endconfig",
  "assert", "assume", "cover", "expect", "property", "endproperty",
  "sequence", "endsequence",
  "covergroup", "endgroup", "coverpoint", "cross", "bins", "binsof",
  "iff", "throughout", "within", "intersect", "first_match",
  "with", "matches", "tagged",
  "rand", "randc", "constraint", "solve", "before",
  "void", "unique", "priority", "unique0",
  "timeunit", "timeprecision",
]);

const TYPES = new Set([
  "logic", "wire", "reg", "bit", "byte", "shortint", "int", "longint",
  "integer", "time", "real", "shortreal", "realtime",
  "string", "chandle", "event", "type",
  "signed", "unsigned",
  "tri", "tri0", "tri1", "trior", "triand", "trireg",
  "wand", "wor", "uwire", "supply0", "supply1",
]);

// Operators that we colour. Multi-char operators must be matched before
// single-char to avoid mis-tokenisation.
const OPERATORS = [
  "<=", ">=", "==", "!=", "===", "!==", "==?", "!=?",
  "&&", "||", "->", "<->", "<<", ">>", "<<<", ">>>",
  "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
  "**", "::",
];

/**
 * Tokenise a SystemVerilog source string into a list of typed tokens.
 *
 * @param {string} source  SV source text.
 * @returns {Array<{type: string, value: string}>}
 *   Tokens preserve the original text — concatenating .value across all
 *   tokens reproduces the source. Whitespace and unrecognised characters
 *   become their own tokens with type "whitespace" or "text".
 */
export function tokenizeSV(source) {
  if (typeof source !== "string" || source.length === 0) return [];
  const tokens = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];

    // Line comment
    if (c === "/" && source[i + 1] === "/") {
      let j = i + 2;
      while (j < n && source[j] !== "\n") j++;
      tokens.push({ type: "comment", value: source.slice(i, j) });
      i = j;
      continue;
    }

    // Block comment
    if (c === "/" && source[i + 1] === "*") {
      let j = i + 2;
      while (j < n - 1 && !(source[j] === "*" && source[j + 1] === "/")) j++;
      j = Math.min(j + 2, n);
      tokens.push({ type: "comment", value: source.slice(i, j) });
      i = j;
      continue;
    }

    // String literal — basic, handles \" and \\ escapes
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\" && j + 1 < n) { j += 2; continue; }
        if (source[j] === '"') { j++; break; }
        j++;
      }
      tokens.push({ type: "string", value: source.slice(i, j) });
      i = j;
      continue;
    }

    // Whitespace
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      let j = i;
      while (j < n && (source[j] === " " || source[j] === "\t" || source[j] === "\n" || source[j] === "\r")) j++;
      tokens.push({ type: "whitespace", value: source.slice(i, j) });
      i = j;
      continue;
    }

    // Directive (`define, `include, `timescale, etc.)
    if (c === "`") {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) j++;
      tokens.push({ type: "directive", value: source.slice(i, j) });
      i = j;
      continue;
    }

    // System task ($display, $finish, $urandom, etc.)
    if (c === "$") {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) j++;
      // System task names need at least one alpha char; bare $ is operator
      if (j > i + 1) {
        tokens.push({ type: "system", value: source.slice(i, j) });
        i = j;
        continue;
      }
    }

    // Number — base-prefixed (8'b1010, 4'hF, 'sb0) or plain decimal.
    // The outer guard accepts a leading apostrophe followed by an optional
    // signed prefix (s/S) and a base letter (b/d/o/h, case-insensitive) so
    // both `'b101` and `'sb101` enter this branch. Plain `'` (e.g. as part
    // of an operator) falls through to the operator branch.
    if (/[0-9]/.test(c) || (c === "'" && /[sSbBdDoOhH]/.test(source[i + 1] || ""))) {
      let j = i;
      // optional width
      while (j < n && /[0-9_]/.test(source[j])) j++;
      // optional base+digits
      if (source[j] === "'") {
        j++;
        if (/[sSbBdDoOhH]/.test(source[j] || "")) j++;
        if (/[bBdDoOhH]/.test(source[j] || "")) j++;
        while (j < n && /[0-9a-fA-F_xXzZ?]/.test(source[j])) j++;
      } else if (j === i) {
        // bare ' — skip, fall through
      }
      if (j > i) {
        tokens.push({ type: "number", value: source.slice(i, j) });
        i = j;
        continue;
      }
    }

    // Identifier or keyword — start with letter or _, continue with alnum/_/$
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++;
      const word = source.slice(i, j);
      let type = "identifier";
      if      (KEYWORDS.has(word)) type = "keyword";
      else if (TYPES.has(word))    type = "type";
      tokens.push({ type: type, value: word });
      i = j;
      continue;
    }

    // Multi-char operators
    let matched = false;
    for (let k = 0; k < OPERATORS.length; k++) {
      const op = OPERATORS[k];
      if (source.slice(i, i + op.length) === op) {
        tokens.push({ type: "operator", value: op });
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Single-char operator or punctuation — anything not handled above
    if (/[+\-*\/%&|^~!<>=?:;,.(){}\[\]@#]/.test(c)) {
      tokens.push({ type: "operator", value: c });
      i++;
      continue;
    }

    // Anything else — including stray chars — gets a generic text type
    tokens.push({ type: "text", value: c });
    i++;
  }

  return tokens;
}

/**
 * Token-type → CSS colour. Used by the renderer to produce coloured spans.
 * Caller can override individual entries via the second argument.
 *
 * @param {object} TH  Theme palette (must define colours used here).
 * @returns {object} Map from token type to a colour string.
 */
export function svTokenColors(TH) {
  return {
    keyword:    TH.accent  || "#7c8aff",
    type:       TH.blue    || "#5fa8d3",
    comment:    TH.text2   || "#7a8a99",
    string:     TH.green   || "#86c97e",
    number:     TH.orange  || "#e0a04a",
    directive:  TH.yellow  || "#e8c66a",
    system:     TH.yellow  || "#e8c66a",
    operator:   TH.text1   || "#cfd5e0",
    identifier: TH.text0   || "#e8eaef",
    whitespace: TH.text0   || "#e8eaef",
    text:       TH.text0   || "#e8eaef",
  };
}
