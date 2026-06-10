// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// skills/compose — Combine core prompt + ordered skills → final prompt
//
// Loaded skills arrive sorted (low priority first; project after user).
// The compose step interleaves them with the core prompt according to
// each skill's `mode`:
//
//   mode: append (default) — skill body goes AFTER the core prompt
//   mode: prepend          — skill body goes BEFORE the core prompt
//   mode: replace          — skill body REPLACES the core prompt entirely
//                             (loader has already filtered to one replace
//                             skill if multiple were declared)
//
// We delimit each skill block with a header so the LLM sees a clear
// boundary and the user can read the composed prompt and tell which
// guidance came from where.
//
// The composed result includes a `provenance` array — useful for the
// `rtlforge skills check` command and for surfacing in error messages.
// ═══════════════════════════════════════════════════════════════════════════

const FENCE = "──────────────────────────────────────────────────";

/**
 * @typedef {Object} ComposedPrompt
 * @property {string} text          - the final string sent to the LLM
 * @property {string} corePrompt    - the original core prompt (untouched)
 * @property {Array<{kind: "core"|"skill", id?: string, scope?: string, mode?: string, priority?: number, range: [number, number]}>} provenance
 *                                    - each segment of the composed text
 *                                      with its source. range = [start, end)
 *                                      character indexes into `text`.
 * @property {boolean} replaced     - true if a `mode: replace` skill won
 *                                    and the core prompt was dropped
 */

/**
 * @param {string} corePrompt     - the prompt produced by src/prompts/<stage>.js
 * @param {Array} skills          - ordered loaded skills (from loader.js)
 * @param {object} [opts]
 * @param {string} [opts.stageLabel] - human-readable label for the header
 * @returns {ComposedPrompt}
 */
export function composeWithSkills(corePrompt, skills, opts) {
  const o = opts || {};
  const list = Array.isArray(skills) ? skills.slice() : [];
  const provenance = [];

  // mode:replace path — loader already kept only one. If present,
  // we drop the core prompt entirely and emit just the replace skill's
  // body (with a header).
  const replaceSkill = list.find(function(s) { return s.mode === "replace"; });
  if (replaceSkill) {
    const block = headerFor(replaceSkill, o.stageLabel) + "\n" + replaceSkill.body + "\n";
    provenance.push({
      kind: "skill", id: replaceSkill.id, scope: replaceSkill.scope,
      mode: "replace", priority: replaceSkill.priority,
      range: [0, block.length],
    });
    return { text: block, corePrompt: corePrompt, provenance: provenance, replaced: true };
  }

  // append + prepend path — we partition skills by mode, preserving order.
  const prepends = list.filter(function(s) { return s.mode === "prepend"; });
  const appends  = list.filter(function(s) { return s.mode === "append"; });

  const segments = [];
  let cursor = 0;

  for (const s of prepends) {
    const block = headerFor(s, o.stageLabel) + "\n" + s.body + "\n";
    segments.push({ text: block, prov: { kind: "skill", id: s.id, scope: s.scope, mode: "prepend", priority: s.priority } });
  }
  segments.push({ text: corePrompt, prov: { kind: "core" } });
  for (const s of appends) {
    const block = "\n" + headerFor(s, o.stageLabel) + "\n" + s.body + "\n";
    segments.push({ text: block, prov: { kind: "skill", id: s.id, scope: s.scope, mode: "append", priority: s.priority } });
  }

  let text = "";
  for (const seg of segments) {
    const start = cursor;
    text += seg.text;
    cursor += seg.text.length;
    provenance.push(Object.assign({}, seg.prov, { range: [start, cursor] }));
  }

  return { text: text, corePrompt: corePrompt, provenance: provenance, replaced: false };
}

function headerFor(skill, stageLabel) {
  // The header is plain text designed to be visible in the LLM's input
  // without confusing structured-output parsing — no JSON-conflicting
  // characters in the header itself.
  const stage = stageLabel || skill.stageKey || "stage";
  return [
    "# " + FENCE,
    "# SKILL: " + skill.id + "  (mode=" + skill.mode + ", priority=" + skill.priority + ", scope=" + skill.scope + ")",
    "# Applies to " + stage + ". Source: " + skill.path,
    "# " + FENCE,
  ].join("\n");
}
