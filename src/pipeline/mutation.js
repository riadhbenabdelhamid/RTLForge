// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// mutation — testbench-strength gate via RTL mutation testing
//
// WHY THIS EXISTS:
//
// A green verify run proves the TB didn't find a problem — it cannot prove
// the TB *would* find one. A testbench that drives stimulus but checks
// nothing meaningful passes everything forever, and every gate downstream
// (verify pass rate, judge verdict) inherits that false confidence.
// Mutation testing measures TB strength directly: inject small, deliberate
// bugs ("mutants") into the PASSING RTL and re-run the simulation. A strong
// TB fails ("kills") the mutants; a mutant that survives marks a behavior
// change the TB never noticed.
//
// HOW IT FITS THE PIPELINE:
//
// verify.js calls runMutationGate as an opt-in sub-phase
// (config.mutationTesting) after the final verify PASSed on the real CLI
// backend. The result lands on verify.mutation = { total, invalid, killed,
// survived[], score } and the opt-in eval criterion `mutation_score` gates
// on it (see eval/criteria.js). Mutation runs are CLI-only — no LLM spend.
//
// MUTATION OPERATORS (deliberately conservative):
//
//   eq_to_neq / neq_to_eq    ==  ↔  !=     (guards against ===, ==?)
//   and_to_or / or_to_and    &&  ↔  ||
//   plus_to_minus            a + b → a - b (guards against the +: part-select)
//   const_flip               1'b1 ↔ 1'b0
//   if_negate                if (cond) → if (!(cond))
//
// NOT mutated, on purpose: anything involving `<=` (indistinguishable from
// the non-blocking assignment by text), unary minus (sign-flip ambiguity),
// and relational operators (most rewrite to or from `<=`/`>=`). Operators
// are matched on a comment/string-MASKED copy of the source so a `==` inside
// a comment or $display string is never touched; the edit itself is applied
// to the original text at the same index.
//
// SCORING:
//
//   killed   — sim failed (non-zero exit or any [FAIL] marker): TB caught it
//   survived — sim exited 0 with no [FAIL]: TB is blind to this bug
//   invalid  — mutant didn't even compile/run a test ("stillborn"); excluded
//              from the score, as is standard for mutation testing
//   score    — killed / (total − invalid) × 100; 100 when nothing valid ran
//              (no evidence ≠ negative evidence — the criterion's
//              denominator field exposes that case)
// ═══════════════════════════════════════════════════════════════════════════

import { runCli } from "../cli/index.js";

/**
 * Return a same-length copy of `code` where every character inside a line
 * comment, block comment, or string literal is replaced by a space. Regex
 * matching runs on the mask; edits index back into the original unchanged.
 */
export function maskNonCode(code) {
  const src = String(code || "");
  const out = src.split("");
  let state = "normal"; // normal | line | block | string
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (state === "line") {
      if (c === "\n") state = "normal"; else out[i] = " ";
    } else if (state === "block") {
      if (c === "*" && src[i + 1] === "/") { out[i] = " "; out[i + 1] = " "; i++; state = "normal"; }
      else out[i] = " ";
    } else if (state === "string") {
      if (c === "\\") { out[i] = " "; if (i + 1 < src.length) { out[i + 1] = " "; i++; } }
      else if (c === '"') { out[i] = " "; state = "normal"; }
      else out[i] = " ";
    } else {
      if (c === "/" && src[i + 1] === "/") { out[i] = " "; out[i + 1] = " "; i++; state = "line"; }
      else if (c === "/" && src[i + 1] === "*") { out[i] = " "; out[i + 1] = " "; i++; state = "block"; }
      else if (c === '"') { out[i] = " "; state = "string"; }
    }
  }
  return out.join("");
}

/** 1-based line number of a character index. */
function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

// Binary-operator site finders. Each returns [{ index, length, replacement,
// op }] discovered on the MASKED text. The guards in each regex are the
// whole reason these are safe — see the operator table in the header.
const OPERATOR_RULES = [
  // `==` → `!=` : not preceded by =/!/</> (rules out <=, >=, !=, ===-ish
  // typos) and not followed by = or ? (rules out ==? wildcard equality).
  { op: "eq_to_neq", re: /[^=!<>]==(?![=?])/g, offset: 1, length: 2, replacement: "!=" },
  // `!=` → `==` : not followed by = or ?.
  { op: "neq_to_eq", re: /!=(?![=?])/g, offset: 0, length: 2, replacement: "==" },
  { op: "and_to_or", re: /&&/g, offset: 0, length: 2, replacement: "||" },
  { op: "or_to_and", re: /\|\|/g, offset: 0, length: 2, replacement: "&&" },
  // Binary plus: word/closing-bracket on the left, word/open-paren on the
  // right, and NOT the `+:` indexed part-select.
  { op: "plus_to_minus", re: /[\w\])]\s*(\+)(?![:+])\s*[\w(]/g, group: 1, replacement: "-" },
  { op: "const_flip", re: /1'b1/g, offset: 0, length: 4, replacement: "1'b0" },
  { op: "const_flip", re: /1'b0/g, offset: 0, length: 4, replacement: "1'b1" },
];

/**
 * Find `if (` conditions on the masked text and produce negation sites.
 * The matching close-paren is found by depth scan (masked text has no
 * parens inside comments/strings, so plain counting is exact).
 */
function findIfNegations(masked) {
  const sites = [];
  const re = /\bif\s*\(/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1; // index of '('
    let depth = 1;
    let close = -1;
    for (let i = open + 1; i < masked.length; i++) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")") { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) continue; // malformed — skip
    sites.push({ op: "if_negate", open: open, close: close });
  }
  return sites;
}

/**
 * Generate up to `maxMutants` single-edit mutants of the RTL source.
 * Deterministic: sites are discovered in source order and, when over the
 * cap, selected evenly across the file so mutants spread over the design
 * instead of clustering at the top.
 *
 * @param {string} rtl
 * @param {object} [opts]
 * @param {number} [opts.maxMutants=5]
 * @returns {Array<{id, op, line, code, snippet}>}
 */
export function generateMutants(rtl, opts) {
  const src = String(rtl || "");
  if (src.length === 0) return [];
  const maxMutants = (opts && opts.maxMutants) || 5;
  const masked = maskNonCode(src);

  // Collect operator sites
  const sites = [];
  for (const rule of OPERATOR_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(masked)) !== null) {
      let index, length;
      if (rule.group != null) {
        // Position of the captured group inside the match (the '+' itself).
        index = m.index + m[0].indexOf(m[rule.group]);
        length = m[rule.group].length;
      } else {
        index = m.index + rule.offset;
        length = rule.length;
      }
      sites.push({ kind: "replace", op: rule.op, index: index, length: length, replacement: rule.replacement });
      // Avoid overlapping rediscovery when a match consumed a lookahead char.
      rule.re.lastIndex = m.index + m[0].length;
    }
  }
  for (const s of findIfNegations(masked)) {
    sites.push({ kind: "negate", op: s.op, index: s.open, open: s.open, close: s.close });
  }

  // Source order, then even-spread selection under the cap (deterministic).
  sites.sort(function(a, b) { return a.index - b.index; });
  let chosen = sites;
  if (sites.length > maxMutants) {
    chosen = [];
    for (let i = 0; i < maxMutants; i++) {
      chosen.push(sites[Math.floor((i * sites.length) / maxMutants)]);
    }
  }

  return chosen.map(function(s, i) {
    let mutated;
    let snippet;
    if (s.kind === "negate") {
      const cond = src.slice(s.open + 1, s.close);
      mutated = src.slice(0, s.open + 1) + "!(" + cond + ")" + src.slice(s.close);
      snippet = "if (" + cond.trim().slice(0, 40) + ") → if (!(…))";
    } else {
      mutated = src.slice(0, s.index) + s.replacement + src.slice(s.index + s.length);
      snippet = src.slice(s.index, s.index + s.length) + " → " + s.replacement;
    }
    return {
      id: "M" + (i + 1),
      op: s.op,
      line: lineOf(src, s.index),
      code: mutated,
      snippet: snippet,
    };
  });
}

/**
 * Run the mutation gate: simulate every mutant with the unchanged TB and
 * classify killed / survived / invalid.
 *
 * Called by verify.js only when the final verify PASSed on the real CLI
 * backend — mutating a failing design measures nothing, and the LLM-estimate
 * path has no simulator to run mutants on.
 *
 * @param {object} args
 * @param {string} args.rtl          passing RTL (pre-SVA-append)
 * @param {string} args.tb           the testbench that just passed
 * @param {Array}  args.cmds         sim command list (already coverage/assert
 *                                   adjusted), with {RTL}/{TB} placeholders
 * @param {string} args.rtlFileName / args.tbFileName
 * @param {object} args.config       st._config (backendUrl, mutationMaxMutants)
 * @param {object} args.cliOpts      retries/timeout/logger for runCli
 * @param {object} args.signal       AbortSignal
 * @param {function} args.appendLog
 * @returns {Promise<{total, invalid, killed, survived, score}>}
 *          survived: [{id, op, line, snippet}]
 */
export async function runMutationGate(args) {
  const mutants = generateMutants(args.rtl, {
    maxMutants: (args.config && args.config.mutationMaxMutants) || 5,
  });
  if (mutants.length === 0) {
    return { total: 0, invalid: 0, killed: 0, survived: [], score: 100 };
  }

  args.appendLog("Mutation gate — testing TB strength",
    mutants.length + " mutant(s): "
    + mutants.map(function(m) { return m.id + "[" + m.op + "@" + m.line + "]"; }).join(", "));

  let killed = 0;
  let invalid = 0;
  const survived = [];

  for (const mut of mutants) {
    // Abort honors the user's stop button between mutants (each sim run can
    // be seconds long; bailing mid-gate loses nothing — partial results are
    // not reported, same as if the gate were disabled).
    if (args.signal && args.signal.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    const cliResult = await runCli(args.config.backendUrl, {
      commands: args.cmds.map(function(c) {
        return c.replace("{RTL}", args.rtlFileName).replace("{TB}", args.tbFileName);
      }),
      files: { [args.rtlFileName]: mut.code, [args.tbFileName]: args.tb },
    }, args.signal, args.cliOpts);

    if (!cliResult || cliResult._error) {
      // Backend trouble (not a mutant property) — count as invalid so a
      // flaky backend can't masquerade as a strong testbench.
      invalid++;
      continue;
    }
    const out = (cliResult.stdout || "");
    const sawFail = /\[FAIL\]/.test(out);
    const sawPass = /\[PASS\]/.test(out);
    if (cliResult.exitCode !== 0 || sawFail) {
      // Stillborn check: non-zero exit with NO test markers at all means the
      // mutant broke the compile — that's not TB strength, exclude it.
      if (!sawFail && !sawPass) { invalid++; continue; }
      killed++;
    } else {
      survived.push({ id: mut.id, op: mut.op, line: mut.line, snippet: mut.snippet });
    }
  }

  const valid = mutants.length - invalid;
  const score = valid > 0 ? Math.round((killed / valid) * 100) : 100;

  args.appendLog(
    survived.length === 0 ? "✓ Mutation gate" : "⚠ Mutation gate — TB blind spots found",
    killed + "/" + valid + " mutants killed (score " + score + "%)"
    + (invalid > 0 ? ", " + invalid + " invalid (excluded)" : "")
    + (survived.length > 0
      ? "\nSurvivors (the TB never noticed these bugs):\n"
        + survived.map(function(s) {
            return "  - " + s.id + " line " + s.line + ": " + s.snippet;
          }).join("\n")
      : ""));

  return { total: mutants.length, invalid: invalid, killed: killed, survived: survived, score: score };
}
