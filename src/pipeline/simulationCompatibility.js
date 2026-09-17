// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { extractChecks, constantCondition } from "./tbCheckCoverage.js";
import { stripOuterParens } from "./svaBind.js";

const REASON = "X-sensitive checks require four-state simulation; Verilator cannot verify this check.";
const X_LITERAL = /^(?:\d*\s*'\s*[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]*[xX][0-9a-fA-F_xXzZ?]*|'[xX])$/;

function hasXComparison(condition) {
  const text = condition.replace(/"(?:[^"\\]|\\.)*"/g, " ");
  if (/\$isunknown\s*\(/.test(text)) return true;
  for (const match of text.matchAll(/===|!==/g)) {
    let start = match.index - 1, end = match.index + 3, depth = 0;
    for (; start >= 0; start--) {
      const c = text[start];
      if (c === ")") depth++;
      else if (c === "(") { if (!depth) break; depth--; }
      else if (!depth && /[&|?:,=<>]/.test(c)) break;
    }
    depth = 0;
    for (; end < text.length; end++) {
      const c = text[end];
      if (c === "(") depth++;
      else if (c === ")") { if (!depth) break; depth--; }
      else if (!depth && /[&|?:,=<>]/.test(c)) break;
    }
    if ([text.slice(start + 1, match.index), text.slice(match.index + 3, end)]
      .some(operand => X_LITERAL.test(stripOuterParens(operand.trim())))) return true;
  }
  return false;
}

// Limit attribution to direct, statically labelled check calls. A label
// reused for another condition is ambiguous, so leave its evidence intact.
// This is a compatibility check, not a general SystemVerilog interpreter.
export function unsupportedSimulationChecks(tb, commands) {
  const command = Array.isArray(commands) ? commands.join("\n") : String(commands || "");
  if (!command.split("\n").some(line => !/^\s*#/.test(line)
      && /(?:^|[\s/])verilator\s+(?=[^\n]*(?:--binary|--cc|--exe|--build)\b)/.test(line))) return [];
  const checks = extractChecks(tb, { literalLabelsOnly: true });
  return checks.filter(check => checks.filter(c => c.label === check.label).length === 1
    && constantCondition(check.cond) === null
    && hasXComparison(check.cond))
    .map(check => ({ label: check.label, condition: check.cond, reason: REASON }));
}

function matchesLabel(name, label) {
  // parseTestLine already removes most metric trailers. The generated
  // "@N cycles @ t=..." form can remain; no arbitrary prefix matching.
  return name === label || name.startsWith(label + " @") &&
    /^ @\d+\s+cycles?(?:\s+@\s*t=\S+)?$/.test(name.slice(label.length));
}

export function qualifySimulationEvidence(measured, tb, commands) {
  if (!measured || measured._simulationCompatibility || measured.cli !== true
      || !/^(MEASURED|PASS|FAIL)$/.test(measured.status || "")
      || measured._compileFailure || measured._runtimeExit || measured._unknownExit || measured._noMarkers || measured._missingMarkers) return measured;
  // A process may emit test markers before a separate assertion or crash.
  // Those diagnostics cannot be attributed to a labelled check safely.
  if (/(?:%Error\b|assertion\s+failed|segmentation\s+fault|core\s+dumped)/i.test(measured.log || "")) return measured;
  const checks = unsupportedSimulationChecks(tb, commands);
  if (!checks.length) return measured;
  const tests = (measured.tests || []).map(test => {
    const check = checks.find(c => matchesLabel(String(test.name || ""), c.label));
    return check && /^(PASS|FAIL)$/.test(test.st)
      ? { ...test, st: "UNSUPPORTED", rawStatus: test.st, reason: check.reason, condition: check.condition }
      : test;
  });
  const unsupported = tests.filter(t => t.st === "UNSUPPORTED").length;
  if (!unsupported) return measured;
  const rawLog = measured.log || "";
  const log = rawLog.split("\n").map(line => {
    const marker = /\[(?:PASS|FAIL)\]\s+(.*?)\s*$/.exec(line);
    const check = marker && checks.find(c => matchesLabel(marker[1], c.label));
    return check ? line.replace(/\[(PASS|FAIL)\]/, "[UNSUPPORTED]") + " — " + check.reason : line;
  }).join("\n");
  return { ...measured, tests, total: tests.length, pass: tests.filter(t => t.st === "PASS").length,
    fail: tests.filter(t => t.st === "FAIL").length, unsupported, log, rawLog,
    _simulationCompatibility: { backend: "verilator", status: "UNVERIFIED", reason: REASON,
      checks: checks.filter(c => tests.some(t => t.st === "UNSUPPORTED" && matchesLabel(String(t.name || ""), c.label))) } };
}

export function simulationEvidenceGap(state) {
  const verify = state?.verify;
  return verify?.unsupported > 0 && verify?._simulationCompatibility
    ? verify.unsupported + " simulation check(s) unsupported by the selected backend. " + verify._simulationCompatibility.reason : null;
}
