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
