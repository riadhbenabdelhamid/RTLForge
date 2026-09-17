// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { extractRTLInterface, nonNormativeContext, widthEquivalent, interfaceSourceScope } from "../utils/interfaceContract.js";

const ID = "[A-Za-z_][A-Za-z0-9_$]*";
const norm = value => String(value || "").replace(/\s+/g, " ").trim();

export function sourceMatches(source, quote) {
  const pattern = norm(quote).split(" ").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return norm(quote) ? [...String(source || "").matchAll(new RegExp(pattern, "g"))]
    .map(m => ({ quote: m[0], start: m.index, end: m.index + m[0].length })) : [];
}

// `src` remains the legacy single-passage field. `sources` contains separate
// exact passages; it is never interpreted as one concatenated quotation.
export function citationTexts(req) {
  if (req?.provenance?.kind === "interpretation") return Array.isArray(req.provenance.sources) ? req.provenance.sources.map(s => s?.quote) : [];
  if (Array.isArray(req?.sources) && req.sources.length) return req.sources.map(s => s?.quote);
  return norm(req?.src) ? [req.src] : [];
}

// Deliberately narrow grammar for declaration-only requirements. Extra
// behavior (reset, polarity, timing, constant outputs, etc.) cannot acquire
// authority just by being labelled "Interface".
export function interfaceFact(req) {
  const text = norm(req?.desc).replace(/`/g, "");
  const module = new RegExp("^The module (?:shall|should|must) be named (" + ID + ")\\.?$", "i").exec(text);
  if (module) return { kind: "module", name: module[1] };
  const prefix = "^The module (?:shall|should|must) (?:expose|provide|have) (" + ID + ") as (?:a|an) ";
  const direction = new RegExp(prefix + "(input|output|inout)(?: port)?\\.?$", "i").exec(text);
  if (direction) return { kind: "port", name: direction[1], dir: direction[2].toLowerCase() };
  const sized = new RegExp(prefix + "(one|single|\\d+)[- ]bit (input|output|inout)(?: port)?\\.?$", "i").exec(text);
  if (sized) return { kind: "port", name: sized[1], dir: sized[3].toLowerCase(), width: /one|single/i.test(sized[2]) ? "1" : sized[2] };
  const width = new RegExp(prefix + "(input|output|inout)(?: port)? with (?:a )?width (\\[[^\\]]+\\]|\\d+|" + ID + ")\\.?$", "i").exec(text);
  return width ? { kind: "port", name: width[1], dir: width[2].toLowerCase(), width: width[3] } : null;
}

function agrees(fact, spec) {
  if (fact.kind === "module") return fact.name === spec?.modName;
  const port = spec?.iface?.find(p => p.name === fact.name);
  return port && port.dir === fact.dir && (fact.width == null || widthEquivalent(port.width, fact.width));
}

// Reconcile a declaration against both the requirement and the frozen
// interface. Return precise evidence; never change the requested declaration.
export function interfaceCitation(source, req, spec) {
  source = String(source || "");
  const scoped = interfaceSourceScope(source, spec?.modName);
  const fact = interfaceFact(req);
  if (!fact || !agrees(fact, spec)) return null;
  const candidates = [];
  const add = (quote, start, extra = []) => candidates.push({ spans: [{ quote, start, end: start + quote.length }, ...extra] });
  if (fact.kind === "module") {
    for (const m of scoped.matchAll(new RegExp("\\bmodule\\s+(?:(?:named|called)\\s+)?(`?" + ID + "`?)", "g"))) {
      if (m[1].replace(/`/g, "") === fact.name) add(m[0], m.index);
    }
  } else {
    for (const m of scoped.matchAll(/^\s*(?:[-*]\s+)?(?:input|output|inout)\b[^\n;]*/gm)) {
      const raw = m[0].trim(), bullet = /^[-*]\s+/.test(raw);
      const declaration = raw.replace(/^[-*]\s+/, "").replace(/,\s*$/, "");
      const port = extractRTLInterface("module declaration(" + declaration + ");")?.ports.find(p => p.name === fact.name);
      if (!port || port.dir !== fact.dir) continue;
      const extra = [];
      // A width omitted in a prose list is supported by an explicit source
      // default, not a model/domain default. SV scalar declarations stand alone.
      if (fact.width != null && bullet && !/\[|\(\s*\d+\s*(?:-\s*)?bits?\s*\)/i.test(declaration)) {
        const defaults = [...source.matchAll(/\bAll\s+(?:(?:input\s+and\s+output)\s+)?(?:ports|signals)\s+are\s+(one|single|\d+)[-\s]+bits?\s+unless\s+otherwise\s+specified\.?/gi)];
        const rule = defaults.find(d => !nonNormativeContext(source, d.index, { defectsOnly: true }));
        if (!rule) continue;
        port.width = /one|single/i.test(rule[1]) ? "1" : rule[1];
        extra.push({ quote: rule[0], start: rule.index, end: rule.index + rule[0].length });
      }
      if (fact.width != null && !widthEquivalent(port.width, fact.width)) continue;
      add(raw, m.index + m[0].indexOf(raw), extra);
    }
    // Compact ANSI headers are common in repair prompts. Only declarations
    // from the header may support a retained interface choice, never its body.
    for (const m of scoped.matchAll(new RegExp("\\bmodule\\s+" + ID + "\\s*(?:#[\\s\\S]*?)?\\([\\s\\S]*?\\)\\s*;", "g"))) {
      const port = extractRTLInterface(m[0])?.ports.find(p => p.name === fact.name);
      if (port && port.dir === fact.dir && (fact.width == null || widthEquivalent(port.width, fact.width))) add(m[0], m.index);
    }
  }
  for (const candidate of candidates) {
    candidate.provisional = candidate.spans.some(s => nonNormativeContext(source, s.start, { defectsOnly: true }));
  }
  // An independently stated declaration outranks a declaration in buggy code.
  return candidates.find(c => !c.provisional) || candidates[0] || null;
}

export function inspectCitation(source, req, spec = {}) {
  if (req?.provenance?.kind === "interpretation") {
    const p = req.provenance, spans = [];
    const invalid = reason => ({ claimed: true, valid: false, spans: [], reason });
    if (typeof p.reasoning !== "string" || !norm(p.reasoning) || !Array.isArray(p.sources) || !p.sources.length) {
      return invalid("interpretation requires reasoning and triggering source passages");
    }
    // Interpretations cite triggers, including defective code, without claiming
    // those passages explicitly state the inferred behavior. Model prose is never a quote.
    if (norm(req.src) || req.sources?.length) return invalid("interpretation triggers belong in provenance.sources; src must be empty");
    for (const s of p.sources) {
      if (typeof s?.quote !== "string") return invalid("malformed interpretation passage");
      const matches = sourceMatches(source, s.quote);
      const span = matches.find(m => s.start == null && s.end == null || m.start === s.start && m.end === s.end);
      if (!span) return invalid("interpretation trigger or offsets absent from original text");
      spans.push(span);
    }
    const fact = interfaceFact(req);
    if (fact && !agrees(fact, spec)) return invalid("interpretation disagrees with the specified interface");
    return { claimed: true, valid: true, spans, interpretation: true, provisional: true };
  }
  const quotes = citationTexts(req);
  const claimed = quotes.length > 0 || req?.sources != null && !Array.isArray(req.sources);
  const invalid = reason => ({ claimed: true, valid: false, spans: [], reason });
  if (!claimed) return { claimed: false, valid: false, spans: [] };
  const fact = interfaceFact(req);
  if (fact && (spec.modName || spec.iface?.length) && !agrees(fact, spec)) {
    return invalid("declaration requirement disagrees with the specified interface");
  }
  if (!Array.isArray(req.sources) && req.sources != null || !quotes.length
      || quotes.some(q => typeof q !== "string" || !norm(q))) return invalid("malformed source passages");
  if (req.sources?.length && norm(req.src) && !quotes.some(q => norm(q) === norm(req.src))) {
    return invalid("legacy src must match one source passage, not concatenate separate quotations");
  }
  const spans = [];
  let provisional = false;
  for (let i = 0; i < quotes.length; i++) {
    const matches = sourceMatches(source, quotes[i]);
    const supplied = req.sources?.[i];
    const located = supplied?.start != null || supplied?.end != null
      ? matches.filter(m => m.start === supplied.start && m.end === supplied.end) : matches;
    const normative = located.find(m => !nonNormativeContext(source, m.start, { defectsOnly: true }));
    if (normative) { spans.push(normative); continue; }
    const declaration = interfaceCitation(source, req, spec);
    // A quote must be contained in the declaration evidence. Merely appearing
    // elsewhere in the same buggy module does not justify any behavior.
    const retained = declaration?.provisional && located.find(m => declaration.spans.some(s => m.start >= s.start && m.end <= s.end));
    if (retained) { spans.push(retained); provisional = true; continue; }
    return invalid(located.length ? "quotation is supported only by defective code" : "quotation or source offsets are absent from original text");
  }
  return { claimed: true, valid: true, spans, provisional };
}
