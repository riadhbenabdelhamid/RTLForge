// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// errorsToAvoid — cross-run error memory fed into RTL/TB generation (#26–28)
//
// The in-run fix loop catches a class of mistake (width mismatch, undriven
// signal, inferred latch, …) and then FORGETS it: the next project re-makes it
// from scratch. This module persists those lint lessons across runs and feeds
// the most recurring ones into the COLD generation prompts so the model avoids
// them up front.
//
// ARCHITECTURE — mirrors triageMemory.js: the logic here is PURE and the
// persistence is a pluggable ADAPTER. Nodes consume `st._services.errorMemory`;
// the runtime supplies an adapter (in-memory for the GUI, a JSON file for the
// CLI). When no adapter is wired the feature simply no-ops. An adapter exposes:
//
//   record(rec)   // merge by (signature, domain, model), bumping count
//   all()         // every catalog record
//
// This file is bundled into the browser via the pipeline barrel, so it MUST
// NOT top-level-import node:fs — the file adapter takes `opts.fs` injected.
//
// SIGNATURE: code + a NORMALIZED message template, so "signal 'foo' undriven"
// and "signal 'bar' undriven" collapse to one lesson. Without normalization the
// catalog never dedups and becomes noise.
//
// Part E (model attribution): each record also carries the `model` whose
// generated code triggered the error, and `errorsToAvoidCrossModel` decides
// whether one model's lessons may be injected into another's prompt. See
// docs/training-mode.md.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonicalize an error message into a stable template: drop quoted
 * identifiers, numbers/hex, and file paths so semantically-identical errors
 * with different operands collapse together.
 */
export function normalizeMessage(msg) {
  return String(msg || "")
    .toLowerCase()
    .replace(/'[^']*'/g, "X").replace(/"[^"]*"/g, "X")        // quoted identifiers
    .replace(/\b[\w./-]+\.(?:svh?|vh?)\b/gi, "FILE")          // file paths
    .replace(/\b0x[0-9a-f]+\b/gi, "N").replace(/\b\d+\b/g, "N") // hex + decimal
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Stable lesson key for an error. Lint errors are { code, sev, line, msg }.
 * @returns {string} e.g. "WIDTH|operand X width N != N"
 */
export function errorSignature(err) {
  const code = (err && err.code) ? String(err.code).toUpperCase() : "GENERIC";
  return code + "|" + normalizeMessage(err && err.msg);
}

// ─── rule distillation (Part D) ──────────────────────────────────────────────
//
// The raw lint message is a SYMPTOM ("unexpected IDENTIFIER, expecting '{'"),
// not a RULE ("declare variables before statements"). Injecting the symptom
// doesn't steer the model (measured: gpt-oss-120b reproduced the same class).
// distillRule maps a harvested error → a written, actionable rule. Unknown
// errors return null and the raw `sample` is kept as a fallback AND for a future
// model-driven rewrite (see rulesNeedingReview).

/** code (optional) + message regex → actionable rule. First match wins. */
export const RULE_TABLE = [
  // Variable declared mid-block, after a procedural statement (the recurring TB
  // syntax error). Verilator: "syntax error, unexpected IDENTIFIER, expecting '{".
  { code: "SYNTAX", match: /unexpected\s+IDENTIFIER.*expecting.*\{/i,
    rule: "Declare every variable at the TOP of its block, task, function, or module — before any procedural statement. Never place a 'logic …;' / 'int …;' declaration mid-block after an assignment or call." },
  // Bit/part-select applied directly to a parenthesized expression or call.
  { code: "SYNTAX", match: /unexpected\s+'\['.*expecting\s+';'/i,
    rule: "Do not bit-select or part-select a parenthesized expression or function result directly (e.g. (a+b)[7:0]). Assign it to a sized variable first, then index that variable." },
  // Compiler directive written without its leading backtick — Verilator parses
  // the bare word as an IDENTIFIER and rejects it (seen: `timescale 1ns/1ps`).
  { code: "SYNTAX", match: /unexpected\s+IDENTIFIER[\s\S]*\b(?:timescale|include|define|ifn?def|undef|default_nettype|celldefine|endcelldefine|resetall|begin_keywords|end_keywords|unconnected_drive|nounconnected_drive)\b/i,
    rule: "Prefix every compiler directive with a backtick: write `timescale, `include, `define, `default_nettype, `ifdef/`endif — never the bare word. A directive without its leading backtick is parsed as an identifier and rejected." },
  // Common Verilator lint codes (matched by code alone).
  { code: "WIDTH",
    rule: "Match operand bit-widths explicitly: size literals (e.g. 8'd0) and intermediate signals so there is no implicit truncation or zero-extension." },
  { code: "LATCH",
    rule: "Assign every output in every branch of combinational logic (complete if/else, default in case) so no latch is inferred." },
  { code: "CASEINCOMPLETE",
    rule: "Cover all case items or add a 'default:' branch." },
  { code: "BLKSEQ",
    rule: "Use non-blocking assignments (<=) in clocked sequential (always_ff) blocks; reserve blocking (=) for combinational logic." },
  { code: "COMBDLY",
    rule: "Use blocking assignments (=) in combinational always_comb blocks; do not use <= there." },
  { code: "UNUSEDSIGNAL",
    rule: "Remove signals you never read, or wire them up; do not leave declared-but-unused nets." },
  { code: "UNDRIVEN",
    rule: "Drive every declared signal: an output or internal net must be assigned on all paths." },
  { code: "PROCASSINIT",
    rule: "Do not rely on a variable's declaration-initializer inside procedural code; assign it explicitly (e.g. in reset)." },
  { code: "IMPLICIT",
    rule: "Declare every signal before use; do not rely on implicit net creation." },
  { code: "PINMISSING",
    rule: "Connect every port of an instantiated module; leave none implicitly unconnected." },
];

/**
 * Distil a raw harvested error into an actionable rule, or null when unknown.
 * Pure; matches RULE_TABLE on code (+ optional message regex).
 * @param {{code?:string, msg?:string}} err
 * @returns {string|null}
 */
export function distillRule(err) {
  if (!err) return null;
  const code = err.code ? String(err.code).toUpperCase() : "";
  const msg = String(err.msg || "");
  for (const r of RULE_TABLE) {
    if (r.code && r.code !== code) continue;
    if (r.match && !r.match.test(msg)) continue;
    return r.rule;
  }
  return null;
}

// ─── harvest-quality guard ───────────────────────────────────────────────────
//
// A model too weak to emit code (measured: liquid/lfm2.5-1.2b) dumps the SPEC
// PROSE / requirement bullets / markdown fences into the RTL file, and Verilator
// chokes on the prose. Those "errors" are over-specific (tied to spec wording),
// don't generalize, and — being high-cardinality — keep the saturation detector
// from ever plateauing. isProseLeak recognizes them from the offending SOURCE
// line Verilator embeds, so the harvest can skip them (see lint.js/lint_test.js).

const _SV_TOKENS = /[;=]|<=|[[\](){}]|\b(?:logic|reg|wire|assign|always|always_ff|always_comb|module|endmodule|input|output|inout|parameter|localparam|begin|end|case|endcase|if|else|for|while|posedge|negedge|typedef|struct|enum|function|task|generate|genvar|integer|bit|byte|int)\b/i;

/**
 * True when a lint error is natural-language prose leaked into the source rather
 * than a genuine code mistake — pure, conservative (only fires on clear prose,
 * so real syntax errors are never dropped).
 * @param {{code?:string, msg?:string}} err
 */
export function isProseLeak(err) {
  const msg = String((err && err.msg) || "");
  if (!msg) return false;
  // A markdown language tag leaked as a compiler directive (e.g. `json, ```sv).
  if (/directive not defined:\s*'?`?(?:json|markdown|md|yaml|python|c\+\+|sv|systemverilog|verilog|text|bash|sh|html)\b/i.test(msg)) return true;
  // The offending source line Verilator embeds after "  NN | <source>  | ^".
  const m = msg.match(/\b\d+\s*\|\s*(.+?)(?:\s*\|\s*\^|$)/);
  if (!m) return false;                        // no source snippet → don't classify the bare message
  const src = m[1].trim();
  if (!src) return false;
  if (/^[-*]\s+/.test(src)) return true;                                              // markdown bullet ("- Require: …")
  if (/\b(?:require|must|should|shall)\s*:/i.test(src)) return true;                  // requirement label
  if (/\b(?:this|the)\s+(?:module|design|architecture|output|input|block|system|circuit)\b/i.test(src)) return true; // prose sentence
  // Multi-word natural-language line with no SystemVerilog tokens at all.
  const words = src.split(/\s+/).filter(Boolean);
  if (words.length >= 3 && !_SV_TOKENS.test(src)) return true;
  return false;
}

/**
 * Lessons whose injected text is still the raw symptom (no rule) or an
 * auto-distilled `table` rule — the worklist for a more powerful model to
 * rewrite into a better rule. Each row keeps its connected raw `sample`.
 */
export function rulesNeedingReview(records) {
  return aggregateErrors(records).filter(function(r) {
    return !r.rule || r.ruleSource === "table";
  });
}

/**
 * Identity key for dedup/merge: signature + domain + model (Part E). JSON-tuple
 * encoded so the segments can never collide (a normalized signature may itself
 * contain spaces — a plain separator is NOT safe). The `model` segment keeps the
 * SAME error from two different models as separate rows (correct per-model
 * attribution); legacy records with no `model` use "" — so old catalogs keep
 * deduping exactly as before and the no-regression prompt locks are unaffected.
 *
 * (Replaces an earlier NUL-byte separator that made this source file read as
 * binary — broke grep/tooling/Edit. JSON encoding is collision-proof AND text.)
 */
function recordKey(r) {
  return JSON.stringify([r.signature, r.domain || "", r.model || ""]);
}

/**
 * Should a lesson be injected for the current model? (Part E.) Default scoping
 * (crossModel false) keeps each model to its own lessons plus unattributed
 * (legacy/federated-shared) ones; crossModel true injects every model's.
 */
function modelMatch(r, model, crossModel) {
  if (crossModel) return true;
  if (!model) return true;                 // no current model → can't scope, allow all
  return r.model === model || !r.model;    // same model, or unattributed/shared
}

/**
 * Collapse raw records into deduped lessons (by signature+domain+model), summing
 * counts and keeping the most-recent sample. Sorted most-recurring first.
 * @returns {Array<{signature, code, sev, sample, rule, ruleSource, domain, model, count, lastTs}>}
 */
export function aggregateErrors(records) {
  const byKey = new Map();
  for (const r of (records || [])) {
    if (!r || !r.signature) continue;
    const key = recordKey(r);
    const inc = typeof r.count === "number" ? r.count : 1;
    const ts = r.lastTs || r.ts || 0;
    const cur = byKey.get(key);
    if (cur) {
      cur.count += inc;
      if (ts >= cur.lastTs) { cur.lastTs = ts; cur.sample = r.sample || r.msg || cur.sample; }
      // Backfill a rule from any record that carries one (old catalogs lack it).
      if (!cur.rule && r.rule) { cur.rule = r.rule; cur.ruleSource = r.ruleSource || cur.ruleSource; }
    } else {
      byKey.set(key, {
        signature: r.signature, code: r.code || null, sev: r.sev || "error",
        sample: r.sample || r.msg || "",
        rule: r.rule || null, ruleSource: r.ruleSource || null,
        domain: r.domain || null, model: r.model || null,
        count: inc, lastTs: ts,
      });
    }
  }
  const out = Array.from(byKey.values());
  out.sort(function(a, b) { return b.count - a.count || b.lastTs - a.lastTs; });
  return out;
}

/**
 * Render the prompt section. "" when there is nothing to say.
 * @param {Array} records
 * @param {object} [opts] { domain?: "rtl"|"tb", topN?: number,
 *                          model?: string, crossModel?: boolean }
 *   model + crossModel (Part E): when crossModel is false (default) and a model
 *   is given, only that model's lessons (plus unattributed ones) are injected.
 */
export function formatErrorsToAvoid(records, opts) {
  const o = opts || {};
  const topN = o.topN || 8;
  let agg = aggregateErrors(records);
  if (o.domain) agg = agg.filter(function(r) { return r.domain === o.domain; });
  // Model scoping (Part E): by default a model only sees its own lessons (plus
  // unattributed/legacy ones); crossModel opt-in injects every model's.
  agg = agg.filter(function(r) { return modelMatch(r, o.model, o.crossModel); });
  // Collapse entries that render to the SAME injected text — several raw
  // symptoms (distinct signatures, since Verilator embeds the offending source
  // line) often distil to ONE rule; show the lesson once, summing its count.
  const byText = new Map();
  for (const r of agg) {
    // Inject the distilled actionable RULE; fall back to the raw symptom only
    // when no rule has been distilled yet (unknown error / old catalog).
    const text = (r.rule || r.sample || r.signature).slice(0, 220);
    const cur = byText.get(text);
    if (cur) { cur.count += r.count; }
    else { byText.set(text, { code: r.code, text: text, count: r.count }); }
  }
  let merged = Array.from(byText.values()).sort(function(a, b) { return b.count - a.count; });
  merged = merged.slice(0, topN);
  if (merged.length === 0) return "";
  const lines = merged.map(function(r) {
    const tag = r.code ? "[" + r.code + "] " : "";
    return "  • " + tag + r.text + "  (seen " + r.count + "×)";
  });
  return [
    "COMMON MISTAKES TO AVOID (recurring lint errors from prior runs — treat as",
    "hints to watch for, NOT hard rules; a correct design may legitimately differ):",
    lines.join("\n"),
  ].join("\n");
}

/**
 * Merge two catalogs (federation import). Pure — dest/src are record arrays.
 * Dedups by (signature, domain, model), summing counts.
 * @returns {{merged: Array, added: number, summed: number}}
 */
export function mergeErrorCatalogs(dest, src) {
  const byKey = new Map();
  for (const r of (dest || [])) { if (r && r.signature) byKey.set(recordKey(r), Object.assign({}, r)); }
  let added = 0, summed = 0;
  for (const r of (src || [])) {
    if (!r || !r.signature) continue;
    const k = recordKey(r);
    const cur = byKey.get(k);
    if (cur) {
      cur.count = (cur.count || 1) + (r.count || 1);
      if ((r.lastTs || 0) >= (cur.lastTs || 0)) { cur.lastTs = r.lastTs || cur.lastTs; cur.sample = r.sample || cur.sample; }
      if (!cur.rule && r.rule) { cur.rule = r.rule; cur.ruleSource = r.ruleSource || cur.ruleSource; }
      summed++;
    } else {
      byKey.set(k, Object.assign({}, r));
      added++;
    }
  }
  return { merged: Array.from(byKey.values()), added: added, summed: summed };
}

// Build a normalized stored record from a raw harvest call.
function toRecord(rec) {
  if (!rec) return null;
  const signature = rec.signature || (rec.code || rec.msg ? errorSignature(rec) : null);
  if (!signature) return null;
  const now = Date.now();
  // Distil the symptom into an actionable rule at harvest time; keep the raw
  // `sample` connected so a stronger model can rewrite the rule later.
  const rule = rec.rule != null ? rec.rule : distillRule(rec);
  return {
    signature: signature,
    code: rec.code || null,
    sev: rec.sev || "error",
    sample: rec.sample || rec.msg || "",
    rule: rule || null,
    ruleSource: rec.ruleSource || (rule ? "table" : null),
    domain: rec.domain || null,
    model: rec.model || null,    // Part E: which model's code triggered this
    count: 1,
    lastTs: now,
    ts: now,
  };
}

// Merge a new record into an array in place (by signature+domain+model). Returns the array.
function mergeInto(rows, rec) {
  const key = recordKey(rec);
  const ex = rows.find(function(r) { return recordKey(r) === key; });
  if (ex) {
    ex.count = (ex.count || 1) + 1;
    ex.lastTs = rec.lastTs;
    if (rec.sample) ex.sample = rec.sample;
    if (!ex.rule && rec.rule) { ex.rule = rec.rule; ex.ruleSource = rec.ruleSource || ex.ruleSource; }
  } else {
    rows.push(rec);
  }
  return rows;
}

// ─── adapters ────────────────────────────────────────────────────────────────

/** In-memory adapter — a GUI session, the benchmark, or tests. */
export function createInMemoryErrorMemory(seed) {
  const rows = Array.isArray(seed) ? seed.slice() : [];
  return {
    record(rec) { const r = toRecord(rec); if (r) mergeInto(rows, r); },
    all() { return rows.slice(); },
    // Replace the whole catalog (training Q2 rule rewrite writes rows back).
    replaceAll(newRows) { rows.length = 0; for (const r of (newRows || [])) rows.push(r); },
  };
}

/**
 * JSON-file adapter — cross-run catalog for the CLI. Loads on construct, merges
 * by signature on record, caps to the most-recent `maxRows` (default 500).
 * `opts.fs` (node:fs or a mock) is REQUIRED and injected — this module is in the
 * browser-bundled pipeline barrel and must never top-level-import a node builtin.
 */
export function createFileErrorMemory(path, opts) {
  const o = opts || {};
  const fs = o.fs;
  if (!fs) throw new Error("createFileErrorMemory: opts.fs (node:fs) is required");
  const maxRows = o.maxRows || 500;
  let rows = [];
  try {
    if (fs.existsSync(path)) {
      const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) rows = parsed;
    }
  } catch (_e) { rows = []; /* corrupt/missing → start fresh */ }

  function persist() {
    try { fs.writeFileSync(path, JSON.stringify(rows.slice(-maxRows))); }
    catch (_e) { /* best-effort; advisory, never fatal */ }
  }
  return {
    record(rec) {
      const r = toRecord(rec);
      if (!r) return;
      mergeInto(rows, r);
      if (rows.length > maxRows) { rows.sort(function(a, b) { return (a.lastTs || 0) - (b.lastTs || 0); }); rows = rows.slice(-maxRows); }
      persist();
    },
    all() { return rows.slice(); },
    // Replace the whole catalog and persist (training Q2 rule rewrite).
    replaceAll(newRows) { rows = (newRows || []).slice(-maxRows); persist(); },
    // Federation: merge an imported catalog and persist. Returns merge stats.
    importCatalog(srcRows) {
      const res = mergeErrorCatalogs(rows, srcRows);
      rows = res.merged.slice(-maxRows);
      persist();
      return { added: res.added, summed: res.summed, total: rows.length };
    },
    wipe() { rows = []; persist(); },
  };
}
