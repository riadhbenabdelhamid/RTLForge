// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/lintFindings — turn raw lint findings into a clean, RULE-annotated
// list for the RTL/TB fixers.
//
// A raw Verilator finding is a SYMPTOM plus gutter noise — the source-line echo
// ("  5 | code"), the "| ^~~~" caret, a doc-URL trailer, a lint_off hint — and
// parseCLIOutput folds all of that into one `msg` string. Feeding that to the
// fixer verbatim (and twice: structured JSON + the whole raw log) is noisy and
// tells the model nothing about HOW to resolve the class of error.
//
// distillFindings turns each finding into: a stable id (CODE#LINE), the
// offending source line pulled from the actual RTL, a cleaned one-line message,
// and the standard FIX RULE for its class — reusing the SAME distillRule table
// the `train` command harvests lint errors into (pipeline/errorsToAvoid). One
// source of truth for "lint code → actionable, positively-phrased rule", shared
// by cold-generation avoidance and the in-loop fixer.
// ═══════════════════════════════════════════════════════════════════════════

import { distillRule, errorSignature } from "../pipeline/errorsToAvoid.js";

// Strip the gutter noise parseCLIOutput appends to `msg`: the source-line echo,
// the caret, the doc-URL, and the lint_off hint. Keeps the core diagnostic plus
// any inline note/Suggest guidance Verilator prints before the echo.
function cleanMessage(msg) {
  let s = String(msg || "");
  const echo = s.search(/\b\d+\s*\|/);          // source-line echo starts here…
  if (echo >= 0) s = s.slice(0, echo);           // …drop it + caret + URL + lint_off
  return s.replace(/:?\s*\.\.\.\s*/g, " ").replace(/\s+/g, " ").trim();
}

// The offending source line, pulled from the ACTUAL RTL by line number — more
// reliable than the echo Verilator embeds, and shown exactly once.
function sourceLineOf(code, line) {
  if (!line || line < 1) return null;
  const l = String(code || "").split("\n")[line - 1];
  return (l != null && l.trim()) ? l.trim() : null;
}

/**
 * Distil raw lint findings into a clean, de-duplicated, rule-annotated list.
 * Accepts the parseCLIOutput shape ({code, sev, line, col, msg}) and the
 * LLM-lint shape ({type|code, severity|sev, message|description}). De-dups
 * repeats of the same CODE#LINE(#COL).
 *
 * Rule resolution mirrors the split between the trained catalog and the static
 * table: prefer an UPGRADE for the finding's signature from `ruleIndex`
 * (buildRuleIndex — model-rewritten / shipped-curated rules the `train` command
 * produces), and fall back to distillRule (the static RULE_TABLE the catalog is
 * seeded from). So a code you've retrained fixes with your sharpened rule; a
 * novel code you've taught the catalog gets its learned rule; everything else
 * gets the table default; unknown-and-untrained gets none.
 *
 * @param {Array} findings   errors + warnings
 * @param {string} code      the RTL/TB source the findings refer to
 * @param {Map} [ruleIndex]  errorSignature → {rule} from buildRuleIndex (optional)
 * @returns {Array<{id, code, sev, line, col, message, source, rule}>}
 */
export function distillFindings(findings, code, ruleIndex) {
  const seen = new Set();
  const out = [];
  for (const f of (findings || [])) {
    if (!f) continue;
    const cd  = String(f.code || f.type || "LINT").toUpperCase();
    const ln  = (f.line != null) ? f.line : null;
    const col = (f.col != null) ? f.col : null;
    const raw = f.msg || f.message || f.description || "";
    const id  = cd + (ln != null ? "#" + ln : "");
    const key = id + "|" + (col != null ? col : "");
    if (seen.has(key)) continue;
    seen.add(key);
    const upgrade = ruleIndex ? ruleIndex.get(errorSignature({ code: cd, msg: raw })) : null;
    out.push({
      id: id, code: cd, sev: f.sev || f.severity || "error",
      line: ln, col: col,
      message: cleanMessage(raw),
      source: sourceLineOf(code, ln),
      // catalog upgrade (model/curated) → static table → null
      rule: (upgrade && upgrade.rule) || distillRule({ code: cd, msg: raw }),
    });
  }
  return out;
}

/**
 * Render distilled findings for a fixer prompt: one block per finding with its
 * id, location, cleaned message, offending source line, and the class fix rule.
 * Each finding keeps its own line, but the "fix" rule tells the model the
 * standard, functional-behaviour-preserving remedy for that class.
 */
export function formatFindings(distilled) {
  if (!distilled || distilled.length === 0) return "(none)";
  return distilled.map(function(f) {
    const loc = f.line != null ? " (line " + f.line + (f.col != null ? ":" + f.col : "") + ")" : "";
    const rows = ["[" + f.id + "] " + String(f.sev).toUpperCase() + " " + f.code + loc + ": " + f.message];
    if (f.source) rows.push("      source ↳ " + f.source);
    if (f.rule)   rows.push("      fix    ↳ " + f.rule);
    return rows.join("\n");
  }).join("\n\n");
}

/**
 * Strip ECHOED finding lines out of a fix candidate. Measured (live run,
 * lfm2-24b): the model pasted the findings block above — `[SYNTAX#8] ERROR
 * SYNTAX (line 8:5): …`, `fix    ↳ …` — verbatim INTO the module body, and
 * every echoed line became a fresh syntax error the classifier then read as
 * "revealed" progress. The format is ours (bracketed CODE#LINE tags, the ↳
 * rows), never legal SystemVerilog, so removing whole matching lines is a
 * deterministic repair with no false-positive surface. Pure + idempotent.
 * @returns {{code: string, stripped: number}}
 */
export function stripFindingEchoes(code) {
  if (typeof code !== "string" || code.length === 0) return { code, stripped: 0 };
  const lines = code.split("\n");
  const kept = [];
  let stripped = 0;
  const TAG = /^\s*\[[A-Z][A-Z0-9_]*(?:#\d+)?\]\s+(?:ERROR|WARNING)\b/;
  const ARROW = /^\s*(?:source|fix)\s+↳/;
  const HEADER = /^\s*LINT FINDINGS TO RESOLVE\b/;
  for (const l of lines) {
    if (TAG.test(l) || ARROW.test(l) || HEADER.test(l)) { stripped++; continue; }
    kept.push(l);
  }
  return stripped > 0 ? { code: kept.join("\n"), stripped } : { code, stripped: 0 };
}
