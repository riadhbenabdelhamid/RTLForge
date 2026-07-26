// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// training — pure core for "training mode" (docs/training-mode.md)
//
// Training mode runs the pipeline only as far as the stage that harvests the
// lessons (RTL: `lint`; TB: `lint_test`), then stops, so a per-model rule corpus
// can be built cheaply and an automated loop can source its own specs and
// self-terminate.
//
// Everything here is PURE and browser-safe: the LLM call, `runStages`, and the
// catalog adapter are injected by the runtime driver (CLI `term/commands/train`
// or the GUI Training tab), never imported here.
// ═══════════════════════════════════════════════════════════════════════════

import { semanticDistinctCount } from "./embeddings.js";

// ─── stage truncation ────────────────────────────────────────────────────────

/** The stage a training mode stops AFTER. */
export function trainingBoundaryStage(mode) {
  if (mode === "rtl") return "lint";
  if (mode === "tb") return "lint_test";
  return null;
}

/**
 * Truncate the active stage keys at the training boundary (inclusive). The
 * caller is responsible for ensuring the boundary stage is active first
 * (training RTL implies `lint`; training TB implies `lint_test`); when it is
 * absent the list is returned unchanged (no truncation rather than a wrong one).
 */
export function truncateStagesForTraining(stageKeys, mode) {
  const boundary = trainingBoundaryStage(mode);
  if (!boundary || !Array.isArray(stageKeys)) return stageKeys;
  const idx = stageKeys.indexOf(boundary);
  if (idx < 0) return stageKeys;
  return stageKeys.slice(0, idx + 1);
}

// ─── saturation + budget (loop termination) ──────────────────────────────────

/**
 * Distinct error signatures in the catalog, optionally scoped to a domain/model.
 * Monotonic non-decreasing across training passes (the catalog only grows), so a
 * plateau is a reliable convergence signal.
 */
export function distinctSignatureCount(records, opts) {
  const o = opts || {};
  const set = new Set();
  for (const r of (records || [])) {
    if (!r || !r.signature) continue;
    if (o.domain && r.domain !== o.domain) continue;
    if (o.model && (r.model || "") !== o.model) continue;
    set.add(r.signature);
  }
  return set.size;
}

/**
 * The text a lesson is EMBEDDED under for semantic dedup: the distilled rule
 * when one exists, else the raw sample, else the signature — the same
 * precedence formatErrorsToAvoid injects, so what collapses here is what
 * would have rendered near-identically in the prompt.
 */
export function lessonTextOf(record) {
  const r = record || {};
  return String(r.rule || r.sample || r.signature || "");
}

/**
 * Semantic distinct-lesson count: the embedding-clustered counterpart to
 * distinctSignatureCount, for the `train --auto` saturation stop. Exact
 * signatures treat every paraphrase as a new lesson, so high-cardinality
 * noise (measured: a too-weak model leaking spec prose) keeps the plateau
 * detector from ever tripping; clustering by cosine similarity counts
 * distinct MISTAKE CLASSES instead.
 *
 * Rows are scoped (domain/model) and deduped by exact signature first, in
 * CATALOG ORDER — the catalog is append-only, so greedy leader clustering
 * (see clusterByThreshold) keeps existing assignments stable across passes
 * and the count plateaus reliably. Identical texts collapse before the
 * embed call (they cluster at similarity 1 anyway).
 *
 * Pure core with the I/O injected: `embedFn(texts) → Promise<vectors>`
 * (llm/embed.js createEmbedder().embed). Throws whatever embedFn throws —
 * the caller owns the fallback to the exact-signature count.
 */
export async function semanticLessonCount(records, opts, embedFn) {
  const o = opts || {};
  const seenSigs = new Set();
  const seenTexts = new Set();
  const texts = [];
  for (const r of (records || [])) {
    if (!r || !r.signature) continue;
    if (o.domain && r.domain !== o.domain) continue;
    if (o.model && (r.model || "") !== o.model) continue;
    if (seenSigs.has(r.signature)) continue;
    seenSigs.add(r.signature);
    const text = lessonTextOf(r);
    if (seenTexts.has(text)) continue;
    seenTexts.add(text);
    texts.push(text);
  }
  if (texts.length === 0) return 0;
  const vecs = await embedFn(texts);
  return semanticDistinctCount(vecs, o.threshold);
}

/**
 * Saturated when the distinct-signature count hasn't grown for `window`
 * consecutive passes. `countHistory` is the per-pass distinct count (appended
 * after each pass). Needs at least `window + 1` points before it can trip.
 */
export function isSaturated(countHistory, window) {
  const w = window || 3;
  const n = (countHistory || []).length;
  if (n <= w) return false;
  return countHistory[n - 1] === countHistory[n - 1 - w];
}

/**
 * Hard budget backstop. First limit hit wins (runs → minutes → llm calls).
 * @param {{runs:number, startMs?:number, llmCalls?:number, nowMs?:number}} state
 * @param {{maxRuns?:number, maxMinutes?:number, maxLlmCalls?:number}} limits
 * @returns {{stop:boolean, reason?:string}}
 */
export function budgetState(state, limits) {
  const s = state || {};
  const l = limits || {};
  const now = s.nowMs != null ? s.nowMs : Date.now();
  if (l.maxRuns != null && (s.runs || 0) >= l.maxRuns) return { stop: true, reason: "max-runs (" + l.maxRuns + ")" };
  if (l.maxMinutes != null && s.startMs != null && (now - s.startMs) >= l.maxMinutes * 60000) return { stop: true, reason: "max-minutes (" + l.maxMinutes + ")" };
  if (l.maxLlmCalls != null && (s.llmCalls || 0) >= l.maxLlmCalls) return { stop: true, reason: "max-llm-calls (" + l.maxLlmCalls + ")" };
  return { stop: false };
}

// ─── adaptive curriculum ─────────────────────────────────────────────────────
//
// Map an error class to a design archetype that tends to surface it, so the
// loop can target the THINNEST class next (close gaps, don't re-count). Mirrors
// RULE_TABLE: a bounded, dependency-free table, not embeddings.

export const ARCHETYPE_TABLE = [
  { code: "WIDTH",          tag: "datapath",      archetype: "an arithmetic datapath mixing operand widths (an adder/subtractor/ALU or a multiplier with a wider result) so width matching is exercised" },
  { code: "LATCH",          tag: "combinational", archetype: "a purely combinational block with multi-way conditionals (a decoder, mux, or priority encoder) where every branch must assign every output" },
  { code: "CASEINCOMPLETE", tag: "fsm",           archetype: "a finite state machine with several states selected by a case statement (a small protocol or bus controller)" },
  { code: "BLKSEQ",         tag: "sequential",    archetype: "a clocked sequential design with registers and a synchronous reset (a counter, shift register, or accumulator)" },
  { code: "COMBDLY",        tag: "combinational", archetype: "a combinational always_comb block that feeds a separately-registered output" },
  { code: "UNDRIVEN",       tag: "control",       archetype: "a control block with several outputs that must be driven on every path" },
  { code: "UNUSEDSIGNAL",   tag: "datapath",      archetype: "a datapath with named intermediate signals that must all be used" },
];

/**
 * Pick the thinnest target error class for a domain and the archetype to drive
 * the synth generator toward. Ties resolve in table order; an empty catalog
 * returns the first entry (start broad).
 * @returns {{code, tag, archetype, count, reason}}
 */
export function selectCurriculumTarget(records, domain) {
  const counts = {};
  for (const r of (records || [])) {
    if (domain && r.domain !== domain) continue;
    const code = (r.code || "").toUpperCase();
    counts[code] = (counts[code] || 0) + (r.count || 1);
  }
  let best = null;
  for (const e of ARCHETYPE_TABLE) {
    const c = counts[e.code] || 0;
    if (best === null || c < best.count) best = { code: e.code, tag: e.tag, archetype: e.archetype, count: c };
  }
  best.reason = best.count === 0
    ? ("no " + best.code + " lessons yet — target a design that surfaces it")
    : (best.code + " is the thinnest class (" + best.count + "×) — reinforce it");
  return best;
}

// ─── synthesized specs (the `synth` source) ──────────────────────────────────

/** Prompt the model for ONE concrete RTL design exercise for a curriculum target. */
export function buildSynthSpecPrompt(target, opts) {
  const o = opts || {};
  const recent = (o.recentTitles || []).slice(0, 8);
  return [
    "You are generating ONE concrete RTL design exercise to train a SystemVerilog generator.",
    "Target: " + (target && target.archetype ? target.archetype : "any synthesizable RTL design") + ".",
    recent.length ? ("Avoid repeating these recent designs: " + recent.join("; ") + ".") : "",
    "Return ONLY a JSON object with keys:",
    '  id          (snake_case identifier),',
    "  title       (short human title),",
    "  tags        (array of short strings),",
    "  description (a self-contained spec a user would type — name every port and its bit width,",
    "               the clock and reset if sequential, any parameters with defaults, and the exact",
    "               behavior). 60-160 words, concrete and unambiguous. Do NOT include any code.",
  ].filter(Boolean).join("\n");
}

/**
 * Parse + VALIDATE a synthesized spec so a degenerate generation can't poison
 * the curriculum. Returns a clean { id, title, description, tags } or null.
 */
export function parseSynthSpec(text) {
  if (!text) return null;
  let obj = null;
  try { obj = JSON.parse(text); }
  catch (_e) {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch (_e2) { obj = null; } }
  }
  if (!obj || typeof obj !== "object") return null;
  const description = String(obj.description || "").trim();
  if (description.length < 40) return null;                       // too thin to train on
  // Must look like a real hardware spec: names ports, a clock, or is explicitly combinational.
  if (!/\bclk\b|\bclock\b|\breset\b|\brst|combinational|\bport\b|\binput\b|\boutput\b|\[\s*\d/i.test(description)) return null;
  const id = String(obj.id || obj.title || "synth")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "synth";
  return {
    id: id,
    title: String(obj.title || id).slice(0, 80),
    description: description,
    tags: Array.isArray(obj.tags) ? obj.tags.map(String).slice(0, 6) : [],
  };
}

// ─── Q2 "model" rule rewrite ─────────────────────────────────────────────────

/** Prompt a stronger model to rewrite a lesson's raw symptom into a crisp rule. */
export function buildRuleRewritePrompt(lesson) {
  const sample = (lesson && lesson.sample) || "";
  const cur = (lesson && lesson.rule) || "";
  return [
    "A SystemVerilog linter produced this error (raw symptom):",
    "  " + sample,
    cur ? ("A draft rule exists: " + cur) : "There is no rule yet.",
    "Rewrite it as ONE crisp, general, actionable rule (max 200 characters) telling an",
    "RTL/TB author how to AVOID this class of mistake up front. Output ONLY the rule",
    "sentence — no preamble, no quotes, no code.",
  ].join("\n");
}

/**
 * Accept a model-rewritten rule? Reject empty, over-long, or text that merely
 * echoes the raw symptom (so we never replace a good rule with garbage).
 */
export function isValidRewrite(rule, lesson) {
  const r = String(rule || "").trim();
  if (r.length < 8 || r.length > 240) return false;
  const sample = String((lesson && lesson.sample) || "").trim().toLowerCase();
  if (sample && r.toLowerCase() === sample) return false;
  return true;
}

/**
 * Synthesize the `rtlforge train` command for a config (the GUI Training tab
 * shows this so the unattended loop can be launched from a terminal). Only
 * non-default flags are emitted. Returns null when no training mode is set.
 */
export function trainCommand(config) {
  const c = config || {};
  const mode = c.trainingMode;
  if (mode !== "rtl" && mode !== "tb") return null;
  const parts = ["rtlforge", "train", mode];
  if (c.trainingAuto) parts.push("--auto");
  if (c.trainingLoop && c.trainingLoop !== "single") parts.push("--loop", c.trainingLoop);
  if (c.trainingRuleExpansion && c.trainingRuleExpansion !== "table") parts.push("--expand", c.trainingRuleExpansion);
  if (c.trainingAuto && c.trainingAutoSource && c.trainingAutoSource !== "adaptive") parts.push("--source", c.trainingAutoSource);
  if (c.trainingSeedsPerSpec && c.trainingSeedsPerSpec !== 1) parts.push("--seeds", String(c.trainingSeedsPerSpec));
  if (c.trainingAuto) {
    if (c.trainingAutoMaxRuns != null && c.trainingAutoMaxRuns !== 20) parts.push("--max-runs", String(c.trainingAutoMaxRuns));
    if (c.trainingAutoMaxMinutes != null && c.trainingAutoMaxMinutes !== 30) parts.push("--max-minutes", String(c.trainingAutoMaxMinutes));
    if (c.trainingSaturationWindow != null && c.trainingSaturationWindow !== 3) parts.push("--saturation", String(c.trainingSaturationWindow));
  }
  return parts.join(" ");
}

/**
 * Pure: return a NEW records array with the matching lesson's rule replaced
 * (ruleSource → "model"). Match on signature + domain + model.
 */
export function applyRuleRewrite(records, key, rule) {
  const k = key || {};
  return (records || []).map(function(r) {
    if (r && r.signature === k.signature && (r.domain || "") === (k.domain || "") && (r.model || "") === (k.model || "")) {
      return Object.assign({}, r, { rule: rule, ruleSource: "model" });
    }
    return Object.assign({}, r);
  });
}
