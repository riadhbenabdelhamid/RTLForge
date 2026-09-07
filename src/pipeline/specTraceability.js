// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
// ═══════════════════════════════════════════════════════════════════════════
// specTraceability — flag requirement wording the description never supports
//
// WHY THIS EXISTS:
//
// The spec stage resolves a vague sentence by appending a parenthetical to the
// requirement it writes. Measured on two unrelated designs, that invented
// reading was wrong and nothing downstream could see it — the RTL implements
// the requirement, the testbench is generated from it, and a formal property
// would be derived from it, so all three agree with each other and disagree
// with what was actually asked for:
//
//   run 55: "... exceeded 20 clock cycles (counter reached 21 or more)".
//           With a counter that starts at 0 on entry, "more than 20" is >= 20.
//   run 57: "... on three consecutive clock cycles (non-overlapping detection)".
//           The description says nothing about overlap; the right reading is a
//           sliding detector. The design missed 422 of 1002 samples.
//
// THIS MODULE ONLY REPORTS. It never edits a requirement.
//
// An earlier attempt deleted the offending parenthetical, and that was the
// wrong shape: it judged meaning with a word-overlap heuristic and then removed
// text, so a miss lost information silently. It stripped four sensor encodings
// out of the one requirement that defined them — "above_s2 (s=3'b111), ..." —
// and that design missed 1803 of 2040 samples. A wrong flag costs a glance; a
// wrong edit costs a design. So the requirement is left exactly as written and
// the observation lands on spec.unsupportedTerms for review.
// ═══════════════════════════════════════════════════════════════════════════

// Words whose absence from the description proves nothing.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "then", "than", "from", "into",
  "when", "while", "shall", "must", "only", "each", "any", "all", "not", "but",
  "are", "was", "were", "has", "have", "had", "its", "their", "which", "where",
  "there", "here", "such", "same", "other", "more", "less", "one", "two",
  "three", "both", "either", "neither", "per", "via", "etc", "see", "note",
  "value", "values", "cycle", "cycles", "clock", "clocks", "state", "states",
  "input", "inputs", "output", "outputs", "signal", "signals", "module",
  "bit", "bits", "high", "low", "set", "clear", "assert", "asserted",
  "transition", "transitions", "enter", "enters", "entering", "remain",
  "remains", "following", "immediately", "permanently", "respectively",
]);

function contentWords(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9_]+/)
    .filter(function(w) { return w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w); });
}

/** 0 and 1 are bit literals, everywhere, and say nothing about interpretation. */
function numbersIn(text) {
  return (String(text || "").match(/\b\d+\b/g) || [])
    .filter(function(n) { return n !== "0" && n !== "1"; });
}

/** Inflection tolerance: the description's "faulting" supports a requirement's "fault". */
function seenInSource(word, srcWords) {
  if (srcWords.has(word)) return true;
  for (const s of srcWords) {
    if (Math.min(word.length, s.length) >= 4 && (s.startsWith(word) || word.startsWith(s))) return true;
  }
  return false;
}

/**
 * A parenthetical carrying an assignment, sized literal or bit select is the
 * requirement turning prose into concrete values — the description says "above
 * the highest sensor s[2]" and the requirement names the encoding that means.
 * That is the spec stage doing its job, not inventing a reading, and flagging it
 * would bury the real signal in noise.
 */
function isFormalisation(inner) {
  const t = String(inner || "");
  return /\b\w+\s*(=|==|<=|>=|!=)\s*\S/.test(t)   // s=3'b111, floor=1, count >= 4
      || /\d+\s*'\s*[bodhBODH]/.test(t)            // 3'b111, 8'hFF
      || /\[\s*\d+\s*(:\s*\d+\s*)?\]/.test(t);     // s[2], data[7:0]
}

/**
 * Report — never edit — parentheticals whose wording the description never uses.
 *
 * @param {Array}  requirements  spec.requirements
 * @param {string} sourceText    the user's original description
 * @returns {Array} [{ req, text, terms, desc }] — empty when nothing is flagged
 */
export function unsupportedParentheticals(requirements, sourceText) {
  const srcWords = new Set(contentWords(sourceText));
  const srcNumbers = new Set(numbersIn(sourceText));
  const out = [];
  for (const req of (requirements || [])) {
    if (!req || typeof req.desc !== "string") continue;
    let m;
    const re = /\(([^()]*)\)/g;
    while ((m = re.exec(req.desc)) !== null) {
      const inner = m[1].trim();
      if (inner.length < 4 || isFormalisation(inner)) continue;
      const terms = contentWords(inner).filter(function(w) { return !seenInSource(w, srcWords); })
        .concat(numbersIn(inner).filter(function(n) { return !srcNumbers.has(n); }));
      if (terms.length === 0) continue;
      out.push({ req: req.id || null, text: inner, terms: terms, desc: req.desc });
    }
  }
  return out;
}

/**
 * Citation check: does a requirement's claimed source quote actually appear in
 * the description?
 *
 * The word-overlap flag above is a heuristic about meaning. This is not: the
 * spec stage is asked to quote the sentence each requirement derives from, and
 * the quote either occurs in the description or it does not. String containment,
 * nothing to tune, no false positives from vocabulary.
 *
 * Backward compatible on purpose: a requirement with NO `src` is not checked.
 * Older specs and recorded corpora predate the field, and treating "absent" as
 * "uncited" would turn every one of them into a wall of flags. Absent is
 * unknown; only a quote that is present and wrong is evidence.
 *
 * @returns {Array} [{ req, quote, reason }]
 */
export function uncitedRequirements(requirements, sourceText) {
  const hay = normalise(sourceText);
  if (!hay) return [];
  const out = [];
  for (const req of (requirements || [])) {
    if (!req || typeof req.src !== "string") continue;      // no claim made — nothing to check
    const quote = req.src.trim();
    // An EMPTY src is the sanctioned answer for "nothing in the description
    // supports this" — a default, a domain convention, an ambiguity resolved by
    // judgement. That is an honest declaration, not a failed citation, and
    // flagging it would punish the very candour the prompt asks for.
    if (quote === "") continue;
    if (quote.length < 8) {
      out.push({ req: req.id || null, quote: quote, reason: "quote too short to verify" });
      continue;
    }
    if (!hay.includes(normalise(quote))) {
      out.push({ req: req.id || null, quote: quote, reason: "not found in the description" });
    }
  }
  return out;
}

/** Whitespace- and case-insensitive form, so line wrapping never breaks a match. */
function normalise(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Human-readable block for uncited requirements. */
export function describeUncited(flags) {
  if (!flags || flags.length === 0) return "";
  return flags.map(function(f) {
    return "  " + (f.req || "?") + ': cites "' + String(f.quote).slice(0, 90) + '" — ' + f.reason;
  }).join("\n");
}

/** Human-readable block for the stage log and the export report. */
export function describeUnsupported(flags) {
  if (!flags || flags.length === 0) return "";
  return flags.map(function(f) {
    return "  " + (f.req || "?") + ': "' + f.text + '" — uses '
      + f.terms.slice(0, 4).map(function(t) { return "`" + t + "`"; }).join(", ")
      + ", not found in the description";
  }).join("\n");
}
