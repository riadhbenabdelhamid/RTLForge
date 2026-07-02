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
    // Drop Verilator's embedded source context ("  104 | always_ff …  | ^~~~~")
    // and the doc-link trailer FIRST, so the same error CLASS at different line
    // numbers / source lines collapses to ONE signature. Without this the same
    // mistake on lines 18/29/30 becomes three distinct lessons — inflating the
    // catalog and blocking the saturation stop. distillRule still sees the full
    // message (it doesn't go through normalizeMessage), so rule-matching on the
    // source text (e.g. `timescale`) is unaffected.
    .replace(/\s*\d+\s*\|[\s\S]*$/, "")
    .replace(/\s*\.\.\.\s*see the manual[\s\S]*$/i, "")
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

// Rules are phrased POSITIVELY — they state only the CORRECT form. A/B measured
// (docs/research_investigation_topics.md, F2) that naming the anti-pattern
// ("avoid complex ports", "never name : type") PRIMES the model to produce it
// ("don't think of a pink elephant"), while positive instructions help. So: no
// "avoid / never / not / don't" clauses, and never name the wrong form.
/** code (optional) + message regex → actionable rule. First match wins. */
export const RULE_TABLE = [
  // Variable declared mid-block, after a procedural statement (the recurring TB
  // syntax error). Verilator: "syntax error, unexpected IDENTIFIER, expecting '{".
  { code: "SYNTAX", match: /unexpected\s+IDENTIFIER.*expecting.*\{/i,
    rule: "Declare every variable at the TOP of its block, task, function, or module — before any procedural statement." },
  // Bit/part-select applied directly to a parenthesized expression or call.
  { code: "SYNTAX", match: /unexpected\s+'\['.*expecting\s+';'/i,
    rule: "Assign a parenthesized expression or function result to a sized variable first, then bit- or part-select that variable." },
  // Compiler directive written without its leading backtick — Verilator parses
  // the bare word as an IDENTIFIER and rejects it (seen: `timescale 1ns/1ps`).
  { code: "SYNTAX", match: /unexpected\s+IDENTIFIER[\s\S]*\b(?:timescale|include|define|ifn?def|undef|default_nettype|celldefine|endcelldefine|resetall|begin_keywords|end_keywords|unconnected_drive|nounconnected_drive)\b/i,
    rule: "Prefix every compiler directive with a backtick: write `timescale, `include, `define, `default_nettype, `ifdef/`endif." },
  // ── recurring SYNTAX classes harvested from capable local models (matched by
  //    message so they distil regardless of the exact code) ──
  // Sized-literal errors: non-binary digit in a 'b literal, or value wider than
  // the declared size (e.g. 32'b2…, 2'b10000000).
  { match: /illegal character in binary constant|too many digits for .* bit number/i,
    rule: "Write sized literals correctly: keep the value within the declared width and use only 0/1/x/z in a 'b literal (use 'd or 'h for other digits), e.g. 8'b10000000 or 8'h80." },
  // Packed vector missing its lower bound: logic [W-1] instead of [W-1:0].
  { match: /unexpected\s+'\]'\s*,?\s*expecting\s+':'/i,
    rule: "Give every packed vector a full range with both bounds: 'logic [WIDTH-1:0] name;'." },
  // VHDL-style colon-typed ports/params instead of SystemVerilog. Anchored to a
  // port/param keyword in the embedded source snippet — a colon error from a
  // mistyped ternary or case item must NOT distil to a port rule (measured
  // over-match: any "unexpected ':'" got this rule).
  { match: /unexpected\s+':'\s*,?\s*expecting\s+(?:';'|',')[\s\S]*\b(?:input|output|inout|parameter)\b/i,
    rule: "Declare ports as 'direction type name' (e.g. 'input logic [W-1:0] name') and parameters as 'parameter int NAME = value'." },
  { match: /unsupported:\s*complex ports/i,
    rule: "Declare each port in simple ANSI port style in the module header: 'input logic clk, output logic [7:0] q'." },
  // Procedural blocks placed illegally (in the port list, before the module, …).
  { match: /unexpected\s+always_(?:ff|comb|latch)/i,
    rule: "Put always_ff/always_comb blocks inside the module body (after the declarations, before endmodule), each with a sensitivity list: always_ff @(posedge clk), always_comb." },
  // Continuous assign used where it isn't allowed.
  { match: /unexpected\s+assign\b/i,
    rule: "Use continuous 'assign' at module scope to drive nets, and drive signals inside always/initial blocks with procedural assignment (= or <=)." },
  // Malformed parameter declaration in the header.
  { match: /unexpected\s+parameter\b[\s\S]*expecting\s+'\['/i,
    rule: "Declare parameters in the ANSI header '#(parameter int DATA_W = 8)' before the port list, or as 'parameter DATA_W = 8;' inside the module body." },
  // Common Verilator lint codes (matched by code alone).
  { code: "WIDTH",
    rule: "Match operand bit-widths explicitly: size every literal (e.g. 8'd0) and intermediate signal so operand widths agree." },
  { code: "LATCH",
    rule: "Assign every output in every branch of combinational logic — complete every if/else and give each case a default." },
  { code: "CASEINCOMPLETE",
    rule: "Cover all case items or add a 'default:' branch." },
  { code: "BLKSEQ",
    rule: "Use non-blocking assignments (<=) in clocked sequential (always_ff) blocks, and blocking (=) in combinational logic." },
  { code: "COMBDLY",
    rule: "Use blocking assignments (=) in combinational always_comb blocks, and non-blocking (<=) in clocked always_ff blocks." },
  { code: "UNUSEDSIGNAL",
    rule: "Read or drive every signal you declare; keep the net list to signals the design actually uses." },
  { code: "UNDRIVEN",
    rule: "Drive every declared signal: assign each output or internal net on all paths." },
  { code: "PROCASSINIT",
    rule: "Assign every variable explicitly in procedural code (e.g. in the reset branch)." },
  { code: "IMPLICIT",
    rule: "Declare every signal explicitly before use." },
  { code: "PINMISSING",
    rule: "Connect every port of an instantiated module explicitly." },
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
 * SINGLE SOURCE OF TRUTH for what the cold RTL/TB generator injects — used by
 * both the generation nodes and the `rtlforge run --show-injection` preview, so
 * the preview can never drift from what actually runs. Merges the shipped
 * knowledge-pack records (opt-in via useShippedRules, already model-filtered by
 * shippedRuleRecords) with the harvested catalog (opt-in via errorsToAvoid),
 * then renders the section scoped to the active model.
 *
 * @param {object} config             the run config
 * @param {Array}  harvestedRecords   errorMemory.all() (or [])
 * @param {Array}  shippedRecords     shippedRuleRecords(config) (or [])
 * @param {"rtl"|"tb"} domain
 * @returns {string} the prompt section, or "" when nothing applies
 */
export function resolveAvoidSection(config, harvestedRecords, shippedRecords, domain) {
  const c = config || {};
  const ship = shippedRecords || [];
  const harvest = c.errorsToAvoid ? (harvestedRecords || []) : [];
  if (!ship.length && !harvest.length) return "";
  return formatErrorsToAvoid(ship.concat(harvest), {
    domain: domain, model: c.model || null, crossModel: !!c.errorsToAvoidCrossModel,
  });
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
    // Refresh auto-distilled rules on re-harvest: RULE_TABLE text evolves (e.g.
    // the positive-phrasing fix) and a stale rule must not outlive the table
    // that produced it. Model-authored and curated rules are never overwritten.
    if (rec.rule && rec.rule !== ex.rule && ex.ruleSource !== "model" && ex.ruleSource !== "curated") {
      ex.rule = rec.rule;
      ex.ruleSource = rec.ruleSource || "table";
    }
  } else {
    rows.push(rec);
  }
  return rows;
}

/**
 * Migrate a persisted/imported catalog to the current signature + rule scheme.
 * Two drifts accumulate in old catalogs (both measured):
 *  - SIGNATURES: normalizeMessage now strips Verilator's source gutter, so rows
 *    signed under the old scheme never merge with new harvests of the same
 *    error — re-sign each row from its stored raw sample.
 *  - RULES: RULE_TABLE text evolves (e.g. the positive-phrasing fix after the
 *    measured negation backfire) — re-distil every auto rule from the sample so
 *    a stale (possibly harmful) rule cannot outlive the table that produced it.
 *    Model-authored ("model") and shipped ("curated") rules are never touched.
 * Re-signing can create duplicates (line-variants of one error) — they are
 * merged with counts summed. Pure; applied on file-adapter load and on
 * federation import (NOT to in-memory seeds, which are current-format).
 * @returns {{rows: Array, changed: boolean}}
 */
export function migrateCatalog(rows) {
  let changed = false;
  const out = [];
  for (const r of (rows || [])) {
    if (!r || !r.signature) continue;
    const n = Object.assign({}, r);
    const raw = n.sample || n.msg || "";
    if (raw) {
      const freshSig = errorSignature({ code: n.code, msg: raw });
      if (freshSig !== n.signature) { n.signature = freshSig; changed = true; }
      if (n.ruleSource !== "model" && n.ruleSource !== "curated") {
        const freshRule = distillRule({ code: n.code, msg: raw });
        if ((freshRule || null) !== (n.rule || null)) {
          n.rule = freshRule || null;
          n.ruleSource = freshRule ? "table" : null;
          changed = true;
        }
      }
    }
    out.push(n);
  }
  if (!changed) return { rows: out, changed: false };
  const res = mergeErrorCatalogs([], out);   // fold re-sign duplicates, summing counts
  return { rows: res.merged, changed: true };
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
  let migrated = false;
  try {
    if (fs.existsSync(path)) {
      const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) {
        // Bring old catalogs onto the current signature + rule scheme (see
        // migrateCatalog) so stale rules and pre-gutter-strip duplicates die here.
        const mig = migrateCatalog(parsed);
        rows = mig.rows;
        migrated = mig.changed;
      }
    }
  } catch (_e) { rows = []; /* corrupt/missing → start fresh */ }

  function persist() {
    try { fs.writeFileSync(path, JSON.stringify(rows.slice(-maxRows))); }
    catch (_e) { /* best-effort; advisory, never fatal */ }
  }
  if (migrated) persist();
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
    // Imported rows may come from an old install — migrate them first.
    importCatalog(srcRows) {
      const res = mergeErrorCatalogs(rows, migrateCatalog(srcRows).rows);
      rows = res.merged.slice(-maxRows);
      persist();
      return { added: res.added, summed: res.summed, total: rows.length };
    },
    wipe() { rows = []; persist(); },
  };
}
