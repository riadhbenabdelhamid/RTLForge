// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/base — Shared system identity, sys() wrapper, j() embed helper
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Core system identity shared by all stages.
 * Explicit output contract at the top prevents model drift on long outputs.
 */
export const BASE_SYS = `\
You are RTL Forge, an expert digital hardware design assistant specialising in \
SystemVerilog RTL, formal verification, and design methodology.

OUTPUT CONTRACT — follow unconditionally:
• Respond with ONLY a single, valid JSON object. No markdown, no code fences, \
no preamble, no commentary, no trailing text after the closing brace.
• Every string value that contains a newline MUST use the two-character \
escape \\n (backslash + n). Never embed a literal newline inside a JSON string.
• Every string value that contains a double-quote MUST escape it as \\".
• Do not truncate arrays or string values. If a value would exceed the token \
budget, summarise rather than cut mid-token.
• If you are uncertain about a value, use your best engineering judgement and \
flag it with a trailing " [estimated]" in that field — do not omit the field.
• Validate the JSON in your head before outputting it.`;

/**
 * Thin wrapper so every call site stays consistent.
 * @param {string} extra  Stage-specific system addendum (optional).
 */
export function sys(extra = "") {
  return extra ? `${BASE_SYS}\n\n${extra}` : BASE_SYS;
}

/**
 * Safe JSON embed for prompt interpolation.
 * Prevents accidental injection when spec data contains quotes / newlines.
 */
export function j(obj) {
  return JSON.stringify(obj);
}

/**
 * Shallow copy of a STAGE OBJECT without its underscore meta keys (_llms,
 * _llm, _syntaxRepairs, _bestOfN, …). Prompts that embed a whole stage object
 * (architect embeds spec, rtl embeds arch) must strip meta first: the
 * telemetry carries timestamps and the full previous RESPONSE TEXT — kilobytes
 * of duplicated garbage tokens per call, and a nondeterministic prompt that
 * breaks record/replay (roadmap #5, where this was found). Shallow on purpose:
 * nested underscore tags elsewhere (e.g. tagFixes' _text/_iter in
 * previousFixes) are content, not meta.
 */
export function stripMeta(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const k of Object.keys(obj)) {
    if (k[0] !== "_") out[k] = obj[k];
  }
  return out;
}

/**
 * Resolve a safe module name. Every prompt builder that interpolates
 * `el.modName` should run the value through this first. Accepts `el` (the elicit
 * object) and `spec` (optional fallback) and returns "module" if no name could
 * be resolved — preventing "Cannot read properties of undefined (reading
 * 'modName')" errors when a project is resumed without a complete elicit blob,
 * or a stage is rerun without spec/elicit context.
 */
export function resolveModName(el, spec) {
  const _el = el || {};
  return (
    _el.modName ||
    _el.moduleName ||
    (spec && (spec.modName || spec.moduleName)) ||
    "module"
  );
}

/**
 * Render a classifier result (classifyDiagnostics / classifyTestResults —
 * see pipeline/classifiers.js) as a prompt section for the NEXT fix call.
 *
 * Why: fix loops previously told the model only "here are the current
 * findings" plus a list of its own past fix descriptions. The model couldn't
 * see what its last patch actually achieved, so it happily repeated
 * strategies that had already failed. This section closes the loop:
 * resolved = don't regress, persisting = your approach didn't work — try a
 * different one, introduced = damage to undo.
 *
 * @param {object|null} cls     classification ({resolved, persisting,
 *                              introduced, revealed, patchDecision}) or null
 *                              on the first iteration / when no recheck ran
 * @param {function}    labelOf renders one resolved/persisting/... item to a
 *                              short string (diagnostics and tests differ)
 * @returns {string} a prompt section, or "" when there is nothing to report
 */
/**
 * Compact attempt ledger for fix loops (run 18 working-set curation): one
 * line per completed fix iteration — target, measured outcome, and the patch
 * decision — instead of the model re-deriving history from accumulated fix
 * lists. What iteration N+1 actually needs is "iter 1: regenerated the TB →
 * 33/54, no change", not an ever-growing JSON dump.
 *
 * @param {Array} attempts rows of { iter, target, pass, total, decision?,
 *                         flipped? } — already shaped by the caller
 * @returns {string} a prompt section, or "" when there is no history
 */
export function attemptLedgerSection(attempts) {
  const rows = (attempts || []).filter(function(a) { return a && a.target; });
  if (rows.length === 0) return "";
  const lines = rows.map(function(a, i) {
    const prev = i > 0 ? rows[i - 1] : null;
    const delta = (prev && typeof prev.pass === "number" && typeof a.pass === "number")
      ? (a.pass === prev.pass ? "no change" : (a.pass > prev.pass ? "+" + (a.pass - prev.pass) : String(a.pass - prev.pass)))
      : null;
    return "  iter " + a.iter + ": " + a.target + " regenerated → "
      + (typeof a.pass === "number" ? a.pass + "/" + (a.total || "?") : "no measurement")
      + (delta ? " (" + delta + ")" : "")
      + (a.decision ? ", " + a.decision : "")
      + (a.flipped ? " [target forced by no-improvement flip]" : "");
  });
  return `

PREVIOUS FIX ATTEMPTS (measured outcomes — do not repeat a strategy that
measurably went nowhere):
${lines.join("\n")}`;
}

/**
 * JSON-render a list capped at `cap` entries, with an explicit omission note
 * so truncation is never silent (a capped list that looks complete reads as
 * "that's everything"). Used for failing-test lists and accumulated fix
 * lists, whose unbounded growth was the main working-set bloat in run 18's
 * fix loops (21 failing tests × full objects × every iteration).
 */
export function cappedJson(arr, cap, noun) {
  const a = arr || [];
  if (a.length <= cap) return j(a);
  return j(a.slice(0, cap))
    + "\n  …and " + (a.length - cap) + " more " + (noun || "entries") + " omitted for brevity.";
}

export function patchOutcomeSection(cls, labelOf) {
  if (!cls) return "";
  const fmt = function(arr) {
    const items = (arr || []).slice(0, 8).map(function(x) { return "  - " + labelOf(x); });
    return items.length > 0 ? items.join("\n") : "  (none)";
  };
  const revealedPart = (cls.revealed && cls.revealed.length > 0) ? `
Newly revealed (pre-existing issues uncovered by progress — address normally):
${fmt(cls.revealed)}` : "";
  return `

OUTCOME OF YOUR PREVIOUS EDITS (classified ${cls.patchDecision || "n/a"} vs the original baseline):
Resolved so far (do NOT regress these):
${fmt(cls.resolved)}
Still unresolved (HIGHEST PRIORITY — your previous strategy did not fix
these; analyse WHY it failed and take a different approach):
${fmt(cls.persisting)}
Introduced by your edits (undo this damage without reverting resolved items):
${fmt(cls.introduced)}${revealedPart}`;
}
