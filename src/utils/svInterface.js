// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// svInterface — extract a module's interface (header) from SystemVerilog text
//
// WHY THIS EXISTS — the anti-self-confirmation guard:
//
// The same LLM writes both the RTL and the testbench. If the TB prompt
// includes the RTL implementation, the model can read how the implementation
// actually behaves and encode an implementation BUG into the TB as "expected
// behavior" — verify then green-lights a wrong design. This is the classic
// correlated-errors trap: generator and checker share one source of
// misunderstanding, so the check stops being independent evidence.
//
// The fix is to blind every TB-facing prompt to the implementation body.
// The TB still needs the exact module header — parameter and port
// declarations — so the DUT instantiation compiles against the real code
// (the spec's port table SHOULD match, but the RTL is the ground truth for
// what Verilator will see). This module slices precisely that: header in,
// body out.
//
// APPROACH — a character-level scanner, not a full SV parser:
//
// We only need enough lexical structure to find the header terminator safely:
//   - line comments  (// … \n)      may contain ';' — must not terminate
//   - block comments (/* … */)      same
//   - string literals ("…" with \") same
//   - the header ends at the first ';' read OUTSIDE all of the above
//
// ANSI-style headers (`module m #(…) (…);`) contain no bare ';' before the
// terminator, so extraction is exact for them. Non-ANSI headers
// (`module m(a, b); input a; …`) yield just the name + port-name list —
// less informative, but the prompt's PORT LIST / PARAMETERS sections (from
// the spec) fill that gap. If no module keyword or no terminator is found,
// we return null and the caller falls back to spec-only context — we never
// fall back to leaking the body.
// ═══════════════════════════════════════════════════════════════════════════

/** True when `code` has the whole word `word` starting at index `i`. */
function isKeywordAt(code, i, word) {
  if (!code.startsWith(word, i)) return false;
  const before = i === 0 ? "" : code[i - 1];
  const after = code[i + word.length] || "";
  const isWord = function(ch) { return /[A-Za-z0-9_$]/.test(ch); };
  return !isWord(before) && !isWord(after);
}

/**
 * Scan `code` from `from`, returning the index of the first ';' that sits
 * outside comments and strings, or -1 when none exists.
 */
function findHeaderEnd(code, from) {
  let state = "normal"; // "normal" | "line" | "block" | "string"
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (state === "line") {
      if (c === "\n") state = "normal";
    } else if (state === "block") {
      if (c === "*" && code[i + 1] === "/") { state = "normal"; i++; }
    } else if (state === "string") {
      if (c === "\\") i++;           // skip escaped char (incl. \")
      else if (c === '"') state = "normal";
    } else {
      if (c === "/" && code[i + 1] === "/") { state = "line"; i++; }
      else if (c === "/" && code[i + 1] === "*") { state = "block"; i++; }
      else if (c === '"') state = "string";
      else if (c === ";") return i;
    }
  }
  return -1;
}

/**
 * Find every `module` keyword that sits outside comments/strings.
 * Returns an array of { start, name } (name may be null if unparsable).
 */
function findModuleKeywords(code) {
  const out = [];
  let state = "normal";
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (state === "line") {
      if (c === "\n") state = "normal";
    } else if (state === "block") {
      if (c === "*" && code[i + 1] === "/") { state = "normal"; i++; }
    } else if (state === "string") {
      if (c === "\\") i++;
      else if (c === '"') state = "normal";
    } else {
      if (c === "/" && code[i + 1] === "/") { state = "line"; i++; }
      else if (c === "/" && code[i + 1] === "*") { state = "block"; i++; }
      else if (c === '"') state = "string";
      else if (c === "m" && isKeywordAt(code, i, "module")) {
        const m = /^module\s+([A-Za-z_][A-Za-z0-9_$]*)/.exec(code.slice(i));
        out.push({ start: i, name: m ? m[1] : null });
      }
    }
  }
  return out;
}

/**
 * Extract a module's interface from SystemVerilog source.
 *
 * @param {string} code        full SV source (may contain several modules)
 * @param {string} [preferName] when given and a module with this name exists,
 *                              extract that one; otherwise the first module
 * @returns {string|null} the module header followed by a body-withheld
 *                        comment and `endmodule`, or null when no header
 *                        could be located (caller must fall back to
 *                        spec-derived context — never to the raw body)
 */
export function extractModuleInterface(code, preferName) {
  if (typeof code !== "string" || code.trim().length === 0) return null;

  const mods = findModuleKeywords(code);
  if (mods.length === 0) return null;

  // Prefer the named module (the DUT) — generated files occasionally carry
  // helper modules; extracting the wrong header would break instantiation.
  let chosen = mods[0];
  if (preferName) {
    const named = mods.find(function(m) { return m.name === preferName; });
    if (named) chosen = named;
  }

  const end = findHeaderEnd(code, chosen.start);
  if (end < 0) return null; // malformed source — no header terminator

  const header = code.slice(chosen.start, end + 1);
  return header +
    "\n  // Implementation body withheld on purpose: derive ALL expected" +
    "\n  // behavior from the specification, never from the implementation." +
    "\nendmodule";
}
