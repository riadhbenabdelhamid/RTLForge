// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { nonNormativeContext } from "../utils/interfaceContract.js";
import { sourceMatches } from "./sourceAttribution.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const cells = (line) => line.trim().replace(/^\|\s*|\s*\|$/g, "")
  .split(line.includes("|") ? /\s*\|\s*/ : /\s+/).map(s => s.replace(/^`|`$/g, ""));

export function explicitSourceConventions(text, ports) {
  const byName = new Map(ports.map(p => [p.name, p]));
  const lines = text.split(/\r?\n/);
  // Explicit source conventions always take precedence over interpretations.
  const aliases = new Map(), radices = new Map(), conventions = [], conventionIssues = [];
  lines.forEach((line, index) => {
    const alias = /^\s*Signal alias:\s*([A-Za-z_][\w$]*)\s*=\s*([A-Za-z_][\w$]*)\.\s*$/.exec(line);
    const radix = /^\s*Column ([A-Za-z_][\w$]*) is (hexadecimal|decimal|binary)\.\s*$/i.exec(line);
    if (!alias && !radix || nonNormativeContext(text, lines.slice(0, index).join("\n").length, { defectsOnly: true })) return;
    conventions.push({ line: index + 1, quote: line });
    if (alias) {
      if (!byName.has(alias[2]) || byName.has(alias[1]) && alias[1] !== alias[2]
          || aliases.has(alias[1]) && aliases.get(alias[1]) !== alias[2])
        conventionIssues.push({ id: "SOURCE.CONVENTION", line: index + 1, reason: "conflicting or unknown signal alias" });
      else aliases.set(alias[1], alias[2]);
    }
    if (radix) {
      const base = { hexadecimal: 16, decimal: 10, binary: 2 }[radix[2].toLowerCase()];
      if (radices.has(radix[1]) && radices.get(radix[1]) !== base)
        conventionIssues.push({ id: "SOURCE.CONVENTION", line: index + 1, reason: "conflicting column radix" });
      else radices.set(radix[1], base);
    }
  });
  const before = /^\s*Inputs (?:are )?driven before (?:the )?clock edge\.\s*$/im.test(text);
  const after = /^\s*Inputs (?:are )?(?:driven|changed) after (?:the )?clock edge\.\s*$/im.test(text);
  if (before && after) conventionIssues.push({ id: "SOURCE.CONVENTION", reason: "conflicting source sampling conventions" });
  return { aliases, radices, conventions, issues: conventionIssues,
    phase: before ? "inputs-before-clock" : after ? "clock-before-inputs" : null };
}

export function sourceTables(text, ports, aliases = new Map()) {
  const byName = new Map(ports.map(p => [p.name, p]));
  const lines = text.split(/\r?\n/);
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    const rawHeader = cells(lines[i]);
    const header = rawHeader.map(h => aliases.get(h) || h);
    if (header.length < 2 || !header.some(h => byName.has(h))) continue;
    if (!header.every(h => IDENT.test(h)) || !header.some(h => byName.get(h)?.dir === "output")) continue;
    let j = i + 1;
    if (/^\s*\|?\s*:?-+:?\s*(?:\||\s)/.test(lines[j] || "")) j++;
    const rows = [];
    let malformedLine = null;
    for (; j < lines.length && rows.length < 257; j++) {
      if (!lines[j].trim() || /^\s*```/.test(lines[j])) break;
      const row = cells(lines[j]);
      if (row.length !== header.length) {
        if (/^\s*\|?\s*[0-9x?]/i.test(lines[j])) malformedLine = j + 1;
        break;
      }
      rows.push({ line: j + 1, cells: row });
    }
    if (!rows.length && !malformedLine) continue;
    tables.push({ id: "SOURCE.T" + (tables.length + 1), line: i + 1, header, rawHeader, rows, malformedLine,
      raw: lines.slice(i, j + (malformedLine ? 1 : 0)).join("\n") });
    i = j - 1;
  }
  return tables;
}

// These choices complete notation only. They never edit rows, expected values,
// widths, requirements or RTL. They are unconfirmed, source-triggered model
// interpretations, frozen with the same contract as behavioral requirements.
export function sourceConventionLedger(source, spec) {
  const text = String(source || ""), ports = spec.iface || [];
  const explicit = explicitSourceConventions(text, ports);
  const tables = sourceTables(text, ports, explicit.aliases);
  const entries = [], issues = [], seen = new Set();
  if (spec.sourceConventions == null) return { entries, issues };
  if (!Array.isArray(spec.sourceConventions) || spec.sourceConventions.length > 64)
    return { entries, issues: [{ id: "SOURCE.CONVENTION", reason: "Invalid source convention list" }] };
  for (const [index, choice] of spec.sourceConventions.entries()) {
    const id = "SOURCE.CONVENTION." + (index + 1);
    const bad = reason => issues.push({ id, reason });
    if (!choice || Object.keys(choice).some(k => !["table", "kind", "column", "value", "reasoning", "sources", "alternatives"].includes(k))) {
      bad("Invalid source convention fields"); continue;
    }
    const table = tables.find(t => t.id === choice.table);
    const key = JSON.stringify([choice.table, choice.kind, choice.column || ""]);
    if (!table || !["alias", "radix", "phase"].includes(choice.kind) || seen.has(key)) {
      bad("Unknown table, convention kind or duplicate choice"); continue;
    }
    seen.add(key);
    if (typeof choice.reasoning !== "string" || !choice.reasoning.trim()
        || !Array.isArray(choice.alternatives) || !choice.alternatives.length
        || choice.alternatives.some(a => typeof a !== "string" || !a.trim())
        || !Array.isArray(choice.sources) || !choice.sources.length) {
      bad("Interpretation needs reasoning, alternatives and triggering source passages"); continue;
    }
    const spans = choice.sources.map(s => typeof s?.quote === "string" && s.quote.trim().length >= 8
      ? sourceMatches(text, s.quote)[0] : null);
    if (spans.some(s => !s)) { bad("Triggering quotation is absent from the original source"); continue; }
    const column = choice.column;
    if (choice.kind !== "phase" && !table.rawHeader.includes(column)) { bad("Unknown source column"); continue; }
    if (choice.kind === "alias") {
      if (!ports.some(p => p.name === choice.value) || column === "time"
          || ports.some(p => p.name === column) && column !== choice.value
          || explicit.aliases.has(column) && explicit.aliases.get(column) !== choice.value) {
        bad("Alias conflicts with the interface or explicit source convention"); continue;
      }
    } else if (choice.kind === "radix") {
      const original = explicit.radices.get(column) ?? explicit.radices.get(explicit.aliases.get(column));
      if (column === "time" || ![2, 10, 16].includes(choice.value) || original && original !== choice.value) {
        bad("Radix conflicts with an explicit convention or is unsupported"); continue;
      }
    } else if (column || !table.rawHeader.includes("time")
        || !["inputs-before-clock", "clock-before-inputs"].includes(choice.value)
        || explicit.phase && explicit.phase !== choice.value) {
      bad("Sampling phase conflicts with an explicit convention or is unsupported"); continue;
    }
    entries.push({ id, kind: "interpretation", origin: "llm-interpretation", userConfirmation: "unconfirmed",
      description: `${choice.table}: ${choice.kind} ${column || ""} = ${choice.value}`,
      reasoning: choice.reasoning, alternatives: choice.alternatives, sources: spans,
      convention: { table: choice.table, kind: choice.kind, ...(column ? { column } : {}), value: choice.value } });
  }
  return { entries, issues };
}
