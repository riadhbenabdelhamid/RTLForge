// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// mutate — deterministic single-edit mutants of a SystemVerilog module
//
// The eval gate scores a testbench by its PASS RATE, which a vacuous suite
// maximises trivially: run 46's local model shipped `check(1, …)` and an
// inequality that admits every value but one, and a pass rate cannot tell
// those from real checks. Mutation testing asks the only question that
// settles it — break the design on purpose, and see whether the testbench
// notices.
//
// A mutant is ONE textual edit at a known offset. Sites are enumerated in
// source order so a run is reproducible without a seed, and three regions
// are never touched:
//   • comments and string literals — editing them changes nothing
//   • `ifdef FORMAL … `endif — the assertions are not the testbench under
//     test, and mutating them would measure the wrong thing
//   • the `timescale directive
//
// Survivors are evidence, not proof: some mutants are semantically
// equivalent to the original (a constant that never reaches an output, a
// relational edge no stimulus visits), so a surviving mutant means "this
// testbench did not distinguish this change", which is exactly the claim
// worth reporting.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mark every character that must not be mutated: comments, string literals,
 * the timescale line, and any `ifdef FORMAL … `endif region.
 * @returns {Uint8Array} 1 = protected
 */
export function protectedMask(code) {
  const s = String(code || "");
  const mask = new Uint8Array(s.length);
  const mark = (from, to) => { for (let i = from; i < to && i < s.length; i++) mask[i] = 1; };

  // line comments, block comments, string literals
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "/" && s[i + 1] === "/") {
      const end = s.indexOf("\n", i); const to = end < 0 ? s.length : end;
      mark(i, to); i = to;
    } else if (s[i] === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2); const to = end < 0 ? s.length : end + 2;
      mark(i, to); i = to;
    } else if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && !(s[j] === '"' && s[j - 1] !== "\\")) j++;
      mark(i, Math.min(j + 1, s.length)); i = j;
    }
  }
  // `timescale line
  const ts = s.indexOf("`timescale");
  if (ts >= 0) { const e = s.indexOf("\n", ts); mark(ts, e < 0 ? s.length : e); }
  // `ifdef FORMAL … `endif (the assertions are not under test here)
  const re = /`ifdef\s+FORMAL\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const end = s.indexOf("`endif", m.index);
    mark(m.index, end < 0 ? s.length : end + 6);
  }
  return mask;
}

// Operator swaps. Each entry is [pattern, replacement, kind]; the pattern is
// matched on a word/operator boundary so `<=` inside `<<=` or a `<=` that is
// a non-blocking assignment are handled by the guards below rather than by
// a looser regex.
const SWAPS = [
  [">=", "> ", "relational"],
  ["<=", "< ", "relational"],
  ["==", "!=", "equality"],
  ["!=", "==", "equality"],
  ["&&", "||", "logical"],
  ["||", "&&", "logical"],
  ["+",  "-",  "arithmetic"],
  ["-",  "+",  "arithmetic"],
  // Bitwise swaps matter for datapath-heavy designs: a hash core is mostly
  // ^ and &, and without these a SHA-256 module offers almost no sites.
  ["^",  "&",  "bitwise"],
  ["&",  "|",  "bitwise"],
  ["|",  "^",  "bitwise"],
];

/** Operator characters that must be treated with the unary/compound guards. */
const SINGLE_CHAR = new Set(["+", "-", "^", "&", "|"]);

/** True when the `<=` at `i` is a non-blocking assignment rather than a comparison. */
function isNonBlockingAssign(s, i) {
  // A comparison sits inside an expression; an assignment is followed by a
  // value and terminated by ';' with no closing paren in between at depth 0.
  let j = i + 2, depth = 0;
  while (j < s.length) {
    const ch = s[j];
    if (ch === "(") depth++;
    else if (ch === ")") { if (depth === 0) return false; depth--; }
    else if (ch === ";") return depth === 0;
    else if (ch === "\n" && depth === 0) { /* keep scanning: multi-line RHS */ }
    j++;
  }
  return false;
}

/**
 * Enumerate every mutation site, in source order.
 * @param {string} code
 * @param {object} [opts] { kinds?: string[] }
 * @returns {Array<{index, offset, line, kind, from, to, context}>}
 */
export function enumerateMutants(code, opts) {
  const s = String(code || "");
  const mask = protectedMask(s);
  const kinds = (opts && opts.kinds) || null;
  const out = [];
  const lineOf = (off) => s.slice(0, off).split("\n").length;

  for (let i = 0; i < s.length; i++) {
    if (mask[i]) continue;
    for (const [from, to, kind] of SWAPS) {
      if (kinds && kinds.indexOf(kind) < 0) continue;
      if (!s.startsWith(from, i)) continue;
      // two-character operators must not be a slice of a longer one
      if (from.length === 2) {
        const prev = s[i - 1] || "", next = s[i + 2] || "";
        if ("=<>!&|+-".includes(prev)) continue;
        if (next === "=") continue;
      } else if (SINGLE_CHAR.has(from)) {
        // single-char operators: skip unary use, compound forms, and literals
        // last non-space BEFORE the operator (a space between operand and
        // operator is the common formatting, so an immediate-neighbour test
        // rejects nearly every real site)
        const prev = (s.slice(0, i).match(/(\S)\s*$/) || ["", ""])[1];
        const next = (s.slice(i + 1).match(/^\s*(\S)/) || ["", ""])[1];
        if (prev === "" || "=<>!&|+-(,?:{[".includes(prev)) continue;   // unary
        if (next === "+" || next === "-" || next === "=") continue;      // ++ -- +=
        if (from === "&" && (next === "&" || prev === "&")) continue;    // && handled above
        if (from === "|" && (next === "|" || prev === "|")) continue;    // ||
        if (/[0-9a-fA-F_]/.test(prev) && /'/.test(s.slice(Math.max(0, i - 12), i))) {
          // inside something like 32'h1234_5678 — never mutate a literal's body
          const tick = s.lastIndexOf("'", i);
          if (tick >= 0 && !/\s/.test(s.slice(tick, i))) continue;
        }
      }
      if (from === "<=" && isNonBlockingAssign(s, i)) continue;          // assignment, not a comparison
      out.push({
        index: out.length, offset: i, line: lineOf(i), kind,
        from, to: to.trim() || to,
        context: s.slice(Math.max(0, i - 28), Math.min(s.length, i + 28)).replace(/\n/g, "⏎"),
      });
      break;   // one mutation per offset
    }
  }
  return out;
}

/** Apply one enumerated mutant, returning the mutated source. */
export function applyMutant(code, mutant) {
  const s = String(code || "");
  return s.slice(0, mutant.offset) + mutant.to + s.slice(mutant.offset + mutant.from.length);
}

/**
 * Even sampling across the enumerated sites — a prefix would test only the
 * top of the file, which for an RTL module is its declarations.
 */
export function sampleMutants(mutants, limit) {
  if (!limit || mutants.length <= limit) return mutants.slice();
  const step = mutants.length / limit;
  const out = [];
  for (let k = 0; k < limit; k++) out.push(mutants[Math.floor(k * step)]);
  return out;
}

/**
 * Mutation score from per-mutant outcomes.
 *   killed    — the testbench failed (or the simulation exited non-zero)
 *   survived  — the testbench passed a design it should have rejected
 *   uncompiled— excluded entirely: an edit that does not build tests nothing
 */
export function mutationScore(results) {
  const compiled = results.filter((r) => r.compiled);
  const killed = compiled.filter((r) => r.killed);
  return {
    total: results.length,
    compiled: compiled.length,
    uncompiled: results.length - compiled.length,
    killed: killed.length,
    survived: compiled.length - killed.length,
    score: compiled.length === 0 ? null : Math.round((killed.length / compiled.length) * 100),
    survivors: compiled.filter((r) => !r.killed)
      .map((r) => ({ line: r.line, kind: r.kind, from: r.from, to: r.to, context: r.context })),
  };
}
