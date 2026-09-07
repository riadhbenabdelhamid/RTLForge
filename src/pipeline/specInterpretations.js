// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
// ═══════════════════════════════════════════════════════════════════════════
// specInterpretations — keep invented disambiguation out of Must requirements
//
// WHY THIS EXISTS:
//
// The spec stage tends to disambiguate a vague sentence by appending a
// parenthetical to the requirement it writes. When that reading is wrong,
// every stage downstream inherits it and nothing can catch it: the RTL
// implements the requirement faithfully, the testbench is generated from the
// same requirement, and formal (which proves the RTL against properties
// derived from these requirements) proves the wrong thing. The defect is
// upstream of every gate we have.
//
// Measured twice, on two unrelated designs:
//
//   run 55: source said "falls for more than 20 clock cycles"; the requirement
//           came out as "... exceeded 20 clock cycles (counter reached 21 or
//           more)". The prose half was right and the parenthetical was wrong —
//           with a counter that starts at 0 on entry, "more than 20 cycles" is
//           `counter >= 20`, not 21. The design implemented the parenthetical.
//
//   run 57: source said "when x has produced the values 1, 0, 1 in three
//           successive clock cycles"; the requirement came out as "... on three
//           consecutive clock cycles, resetting match progress on any
//           non-matching bit (non-overlapping detection)". The source says
//           nothing about overlap; the correct reading is a sliding detector.
//           The design implemented the parenthetical and missed 422 of 1002
//           samples.
//
// In both cases the invented text is the half that was wrong, and in both cases
// it arrived inside parentheses. So: a parenthetical that introduces terms or
// numbers the source description never used is not a requirement, it is an
// interpretation. It is stripped from the requirement's text and recorded on
// spec.interpretations for review, where a wrong guess is visible instead of
// normative.
//
// DELIBERATELY CONSERVATIVE: a parenthetical whose every content word already
// appears in the source is a restatement, not an invention, and is left alone
// ("(ground=0)", "(active high)"). Only novel terms move.
// ═══════════════════════════════════════════════════════════════════════════

// Words that carry no domain meaning; their absence from the source proves nothing.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "then", "than", "from", "into",
  "when", "while", "shall", "must", "only", "each", "any", "all", "not", "but",
  "are", "was", "were", "has", "have", "had", "its", "his", "her", "their",
  "which", "where", "there", "here", "such", "same", "other", "more", "less",
  "one", "two", "three", "both", "either", "neither", "per", "via", "e.g", "i.e",
  "etc", "see", "note", "value", "values", "cycle", "cycles", "clock", "clocks",
  "state", "states", "input", "inputs", "output", "outputs", "signal", "signals",
  "module", "bit", "bits", "high", "low", "set", "clear", "assert", "asserted",
  // Generic design vocabulary: present in almost every requirement, carries no
  // interpretation of its own, and its absence from the source proves nothing.
  "transition", "transitions", "enter", "enters", "entering", "remain", "remains",
  "following", "immediately", "permanently", "respectively", "corresponding",
]);

/** Content words worth testing against the source: alphabetic, ≥3 chars, not a stopword. */
function contentWords(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(function(w) {
      return w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w);
    });
}

/**
 * Integers worth testing. A novel number is the strongest signal of all — but 0
 * and 1 are bit literals that appear in nearly every requirement ("ground=1"),
 * so they say nothing about interpretation and are ignored.
 */
function numbersIn(text) {
  return (String(text || "").match(/\b\d+\b/g) || []).filter(function(n) {
    return n !== "0" && n !== "1";
  });
}

/**
 * Is this word present in the source, allowing for inflection? The source says
 * "splatter" and a requirement says "splat"; treating those as different words
 * would flag a plain restatement. A shared prefix of 4+ characters is enough for
 * the morphology that shows up here (splat/splatter, walk/walking, overlap/
 * overlapping) without matching unrelated words.
 */
function seenInSource(word, srcWords) {
  if (srcWords.has(word)) return true;
  for (const s of srcWords) {
    const n = Math.min(word.length, s.length);
    if (n >= 4 && (s.startsWith(word) || word.startsWith(s))) return true;
  }
  return false;
}

/**
 * Is this parenthetical a FORMALISATION rather than an interpretation?
 *
 * Two very different things arrive in parentheses. One is a semantic claim the
 * description never made — "(counter reached 21 or more)", "(non-overlapping
 * detection)" — and when that is wrong it poisons every stage downstream. The
 * other is prose turned into concrete values — "(s=3'b111)", "(floor=1)" — which
 * is the requirement doing its job: the description says "above the highest
 * sensor s[2]" and the requirement names the encoding that means.
 *
 * Measured the hard way. An earlier cut of this module judged both by "does the
 * source use these words", so it stripped the four sensor encodings out of the
 * one requirement that defined them, leaving "classify the water level into one
 * of four states: above_s2, between_s2_s1, between_s1_s0, below_s0" with no
 * statement of what any of them mean. That design then missed 1803 of 2040
 * samples — far worse than any other in the batch.
 *
 * So: a parenthetical carrying an assignment or a sized literal is a
 * formalisation and stays. Only prose can be lifted.
 */
function isFormalisation(inner) {
  const t = String(inner || "");
  if (/\b\w+\s*(=|==|<=|>=|!=)\s*\S/.test(t)) return true;   // s=3'b111, floor=1, count >= 4
  if (/\d+\s*'\s*[bodhBODH]/.test(t)) return true;             // 3'b111, 8'hFF — a sized literal
  if (/\[\s*\d+\s*(:\s*\d+\s*)?\]/.test(t)) return true;        // s[2], data[7:0] — a bit select
  return false;
}

/**
 * Split invented parentheticals out of requirement text.
 *
 * @param {Array}  requirements  spec.requirements ([{id, desc, …}])
 * @param {string} sourceText    the user's original description — the only
 *                               authority on what the design is supposed to do
 * @returns {{requirements: Array, interpretations: Array}}
 *          interpretations: [{ req, text, novel: [...], desc, revisedDesc }]
 */
export function splitInventedParentheticals(requirements, sourceText) {
  const src = String(sourceText || "").toLowerCase();
  const srcWords = new Set(contentWords(src));
  const srcNumbers = new Set(numbersIn(src));
  const interpretations = [];

  const out = (requirements || []).map(function(req) {
    if (!req || typeof req.desc !== "string" || !/\(/.test(req.desc)) return req;
    let desc = req.desc;
    const removed = [];

    // Innermost-first, so a nested pair is handled without regex recursion.
    let m;
    const re = /\(([^()]*)\)/g;
    const keep = [];
    while ((m = re.exec(req.desc)) !== null) {
      const inner = m[1].trim();
      if (inner.length < 4) { keep.push(m[0]); continue; }   // "(s)", "(ns)" — noise, not interpretation
      if (isFormalisation(inner)) { keep.push(m[0]); continue; }  // a value binding, not a reading
      const novelWords = contentWords(inner).filter(function(w) { return !seenInSource(w, srcWords); });
      const novelNums = numbersIn(inner).filter(function(n) { return !srcNumbers.has(n); });
      const novel = novelWords.concat(novelNums);
      if (novel.length === 0) { keep.push(m[0]); continue; } // pure restatement — leave it
      removed.push({ fragment: m[0], inner: inner, novel: novel });
    }
    if (removed.length === 0) return req;

    for (const r of removed) desc = desc.replace(r.fragment, "");
    // Tidy the seams the removal leaves behind.
    desc = desc.replace(/\s{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").replace(/,\s*\./g, ".").trim();

    for (const r of removed) {
      interpretations.push({
        req: req.id || null,
        text: r.inner,
        novel: r.novel,
        desc: req.desc,
        revisedDesc: desc,
      });
    }
    return Object.assign({}, req, { desc: desc, _interpretationsRemoved: removed.map(function(r) { return r.inner; }) });
  });

  return { requirements: out, interpretations: interpretations };
}

/** One log line per interpretation, for the stage log and the report. */
export function describeInterpretations(interpretations) {
  if (!interpretations || interpretations.length === 0) return "";
  return interpretations.map(function(i) {
    return "  " + (i.req || "?") + ': "' + i.text + '" — introduces '
      + i.novel.slice(0, 4).map(function(w) { return "`" + w + "`"; }).join(", ")
      + ", which the description never uses";
  }).join("\n");
}
