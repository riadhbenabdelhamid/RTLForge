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
