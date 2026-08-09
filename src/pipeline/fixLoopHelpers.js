// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// fixLoopHelpers — Small reusable primitives for the iterative fix loops
// in lint/verify/judge nodes.
//
// The fix loops share structural patterns but their bodies diverge enough that
// a fully generic loop would be more complex than the code it replaces. These
// are the pieces that are genuinely reusable with no parameterization cost:
//
//   createStagnationDetector(maxRepeats)
//     → tracks consecutive identical outcome signatures and signals
//       when to break the loop.
//
//   createBestKnownTracker(compareFn)
//     → records state snapshots with a comparable score; at the end of
//       the loop, callers can ask for the best-known entry to restore
//       from if the final iteration wasn't the best.
//
//   tagFixes(fixes, iter)
//     → normalises an LLM `fixes` array into { ..., _iter } objects so the
//       UI fix-list can show which iteration produced each fix.
//
//   createCodeChurnTracker(opts)
//     → remembers every candidate a fix loop has already tried and flags
//       new candidates that exactly repeat (oscillation, A→B→A) or
//       near-repeat (cosmetic churn) an earlier attempt — the outcome of
//       such a candidate is already known, so re-validating it wastes a
//       CLI run and the loop cannot progress.
//
// These are plain factories/functions with no shared state and no global side
// effects. Safe to instantiate inside each node call.
// ═══════════════════════════════════════════════════════════════════════════

import { levenshtein } from "../utils/levenshtein.js";
import { maybeRepairWithLog } from "./syntaxRepair.js";
import { FUNCTIONAL_CAT_RE } from "../eval/criteria.js";

/**
 * Stagnation detector: tracks consecutive identical outcome signatures and
 * signals when to break out of a fix loop that isn't making progress.
 *
 * Usage:
 *   const stag = createStagnationDetector(2);
 *   for (let iter = 1; iter <= maxIters; iter++) {
 *     // ... do work ...
 *     const sig = "score=" + score + "|errors=" + errs;
 *     if (stag.check(sig)) {
 *       // Same sig repeated N times in a row — break out.
 *       break;
 *     }
 *   }
 *   if (stag.stagnated()) console.log("stopped due to stagnation");
 *
 * @param {number} [maxRepeats=2]  How many consecutive identical signatures
 *                                 trigger stagnation. The default of 2 means
 *                                 "after the signature repeats twice in a row,
 *                                 stop".
 */
export function createStagnationDetector(maxRepeats) {
  const limit = maxRepeats == null ? 2 : maxRepeats;
  let lastSig = null;
  let count = 0;
  let stagnatedFlag = false;

  return {
    /**
     * Record a new outcome signature and return true if stagnation is detected.
     * Resets the counter if the signature changed since last call.
     */
    check(sig) {
      if (sig === lastSig) {
        count++;
        if (count >= limit) {
          stagnatedFlag = true;
          return true;
        }
      } else {
        count = 0;
      }
      lastSig = sig;
      return false;
    },

    /** Whether stagnation was ever triggered during this session. */
    stagnated() {
      return stagnatedFlag;
    },

    /** Current consecutive-repeat count (useful for logging). */
    count() {
      return count;
    },

    /** Reset state so the detector can be reused. */
    reset() {
      lastSig = null;
      count = 0;
      stagnatedFlag = false;
    },
  };
}

/**
 * Code-churn tracker: remembers every candidate a fix loop has tried and
 * flags candidates whose outcome is already known.
 *
 * Why the plain `candidate === base` integrity check isn't enough:
 *   - OSCILLATION: the model produces A, then B, then A again. Each step
 *     differs from the current base, so identity checks pass — but A was
 *     already validated and found wanting. Re-validating burns a CLI run
 *     per cycle and the loop can ping-pong until maxIters.
 *   - COSMETIC CHURN: the model re-emits an earlier attempt with shuffled
 *     whitespace or a new comment. Behaviourally the same candidate, same
 *     wasted validation.
 *
 * What this deliberately does NOT flag: a SMALL DIFF against the current
 * base. The fix prompts demand minimal diffs, so a 1-character change is
 * often a correct fix — smallness is a virtue, not churn. Only similarity
 * to a PREVIOUSLY TRIED candidate is suspicious, because that candidate's
 * outcome is already on record.
 *
 * Comparison is whitespace-insensitive (candidates are normalised by
 * collapsing runs of whitespace). In principle two candidates could differ
 * only inside a string literal's spacing and be wrongly flagged — accepted:
 * the harm is bounded (an early stagnation break after two hits) and such
 * candidates are practically always genuine churn.
 *
 * Usage (inside a fix loop):
 *   const churn = createCodeChurnTracker();
 *   churn.record(originalCode, 0);                  // seed with the baseline
 *   ...
 *   const verdict = churn.assess(candidateCode);
 *   if (verdict.verdict !== "new") { count it as stagnation; skip recheck; }
 *   else churn.record(candidateCode, iter);
 *
 * @param {object} [opts]
 * @param {number} [opts.nearThreshold=0.02]    flag as near-repeat when the
 *        normalised levenshtein distance is ≤ 2% of the longer string
 * @param {number} [opts.maxCompareLength=20000] skip the O(n·m) levenshtein
 *        for very large sources (exact-repeat detection still applies)
 */
export function createCodeChurnTracker(opts) {
  const o = opts || {};
  const nearThreshold = o.nearThreshold == null ? 0.02 : o.nearThreshold;
  const maxCompareLength = o.maxCompareLength == null ? 20000 : o.maxCompareLength;
  const history = []; // [{ normalized, iter }] in record order

  function normalize(code) {
    return String(code || "").replace(/\s+/g, " ").trim();
  }

  return {
    /** Remember a candidate that is about to be (or was) validated. */
    record(code, iter) {
      history.push({ normalized: normalize(code), iter: iter });
    },

    /**
     * Compare a new candidate against everything tried so far.
     * @returns {{verdict: "new"|"repeat"|"near-repeat",
     *            matchedIter: number|null, similarity: number}}
     */
    assess(code) {
      const cand = normalize(code);
      // Exact (whitespace-insensitive) repeat — scan newest-first so the
      // reported matchedIter is the most recent occurrence.
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].normalized === cand) {
          return { verdict: "repeat", matchedIter: history[i].iter, similarity: 1 };
        }
      }
      // Near-repeat via levenshtein, guarded by two cheap pre-filters:
      // total size (cost cap) and length delta (a distance lower bound —
      // strings whose lengths differ by more than the threshold can't be
      // within it).
      if (cand.length > 0 && cand.length <= maxCompareLength) {
        for (let i = history.length - 1; i >= 0; i--) {
          const h = history[i].normalized;
          if (h.length === 0 || h.length > maxCompareLength) continue;
          const maxLen = Math.max(cand.length, h.length);
          if (Math.abs(cand.length - h.length) / maxLen > nearThreshold) continue;
          const d = levenshtein(cand, h);
          if (d / maxLen <= nearThreshold) {
            return {
              verdict: "near-repeat",
              matchedIter: history[i].iter,
              similarity: 1 - d / maxLen,
            };
          }
        }
      }
      return { verdict: "new", matchedIter: null, similarity: 0 };
    },

    /** Number of recorded candidates (useful for logging/tests). */
    size() {
      return history.length;
    },
  };
}

/**
 * Best-known state tracker: records (state, score) snapshots during a fix
 * loop and lets callers restore the best-known entry at the end if the
 * final iteration wasn't the best.
 *
 * The comparison function takes two scores and returns true if the LEFT
 * score is strictly better than the RIGHT score. Defaults to numeric
 * "higher is better" — pass `(a, b) => a < b` for "lower is better"
 * (e.g. lint's issue-count tracking).
 *
 * Usage:
 *   const tracker = createBestKnownTracker();                     // higher is better
 *   const tracker = createBestKnownTracker((a, b) => a < b);      // lower is better
 *
 *   for (let iter = 1; iter <= maxIters; iter++) {
 *     // ... compute currentScore ...
 *     tracker.record({ code: finalCode }, currentScore);
 *   }
 *   const best = tracker.best();   // { state, score } | null
 *   if (best && best.state !== finalState) finalState = best.state;
 *
 * @param {(a: number, b: number) => boolean} [isBetter]  Comparator; default numeric >
 */
export function createBestKnownTracker(isBetter) {
  const cmp = isBetter || function(a, b) { return a > b; };
  let bestState = null;
  let bestScore = null;

  return {
    /**
     * Record a new snapshot. Replaces the best-known entry if the new score
     * is strictly better per the comparator.
     */
    record(state, score) {
      if (bestState === null || cmp(score, bestScore)) {
        bestState = state;
        bestScore = score;
      }
    },

    /** Get the best-known entry, or null if nothing was recorded. */
    best() {
      if (bestState === null) return null;
      return { state: bestState, score: bestScore };
    },

    /** Reset state so the tracker can be reused. */
    reset() {
      bestState = null;
      bestScore = null;
    },
  };
}

/**
 * Normalise an LLM-returned `fixes` array into a list of objects tagged with
 * the iteration that produced them. String entries become { _text, _iter };
 * object entries are shallow-cloned with `_iter` attached. A non-array input
 * (including the null returned on the chain path) yields an empty array.
 *
 * @param {*}      fixes  The raw `fixes` value from an extracted fix payload.
 * @param {number} iter   The fix-loop iteration that produced these fixes.
 * @returns {Array<object>}
 */
export function tagFixes(fixes, iter) {
  if (!Array.isArray(fixes)) return [];
  return fixes.map(function(f) {
    if (typeof f === "string") return { _text: f, _iter: iter };
    if (f && typeof f === "object") return Object.assign({}, f, { _iter: iter });
    return { _text: String(f), _iter: iter };
  });
}

/**
 * Structural-collapse guard for RTL fix loops.
 *
 * MEASURED FAILURE (this bug): a fix/regen candidate can "resolve" a lint
 * finding or review issue by DELETING the code that caused it — collapsing the
 * module to an empty shell (`module four_bit_counter;\nendmodule`) or dropping
 * most of its body. An empty module LINTS CLEAN (zero findings) and REVIEWS
 * CLEAN (no issues in nothing), so it scores BEST on every accept-by-metric
 * loop: the lint classifier reads the baseline findings as "resolved", the
 * issue-count best-known tracker prefers 0 over N, and the reviewer returns
 * PASS. The stub then ships. Deleting the design is never a fix.
 *
 * Returns true when `candidate` has gutted `current`:
 *   - EMPTY BODY: a `module … ; endmodule` with nothing between the header's
 *     terminating ';' and 'endmodule' (the exact reported symptom), OR
 *   - SEVERE CONTENT LOSS: `current` was substantial and `candidate` retains
 *     less than `ratio` of its meaningful (comment/whitespace-stripped) size
 *     (catches partial truncations that also game the metric).
 *
 * Conservative by construction: the fix prompts demand MINIMAL diffs, so a
 * real fix never halves the file — and when this misfires the caller merely
 * keeps the current (working) code, so a false positive costs one skipped
 * candidate, never a broken artifact.
 *
 * @param {string} current    the code the loop currently holds
 * @param {string} candidate  the fix/regen output under consideration
 * @param {object} [opts]     { minChars=120, ratio=0.4 }
 * @returns {boolean}
 */
export function detectGuttedRewrite(current, candidate, opts) {
  const o = opts || {};
  const minChars = o.minChars == null ? 120 : o.minChars;
  const ratio    = o.ratio == null ? 0.4 : o.ratio;
  const meaningful = function(s) {
    return String(s == null ? "" : s)
      .replace(/\/\*[\s\S]*?\*\//g, " ")   // block comments
      .replace(/\/\/[^\n]*/g, " ")          // line comments
      .replace(/\s+/g, " ")
      .trim();
  };
  const cur = meaningful(current);
  // Only protect a substantial module — there is nothing to gut in code that
  // is already tiny (a legitimately minimal stub, or an empty baseline).
  if (cur.length < minChars) return false;
  const cand = meaningful(candidate);
  // Empty module body: the header's terminating ';' sits immediately before
  // 'endmodule'. `[^;]*` cannot cross that ';', so a module WITH a body (whose
  // first statement's ';' precedes 'endmodule') can never match here.
  if (/\bmodule\b[^;]*;\s*endmodule\b/.test(cand)) return true;
  if (cand.length === 0) return true;                 // candidate emptied entirely
  return cand.length / cur.length < ratio;            // severe partial loss
}

/**
 * Strip testbench modules that leaked into an RTL artifact (measured,
 * nemotron e2e run 7: an rtl_review fix APPENDED a complete
 * `module up_counter_4bit_tb; … endmodule` after the DUT — downstream,
 * verify compiles the RTL artifact next to the real TB artifact and the
 * duplicate module definition breaks the build).
 *
 * RTL-SIDE CHOKEPOINTS ONLY: a `_tb` module is exactly what a TB artifact IS,
 * so this must never run on the TB path — which is why it lives here (called
 * from the rtl-family adoption sites) and not in repairSV (which runs on both
 * kinds). Conservative: only strips when a non-`_tb` module remains, so a
 * pathological all-TB candidate passes through untouched (and fails lint
 * loudly rather than being emptied silently). Modules cannot nest in SV, so
 * a line-anchored module…endmodule walk is exact.
 *
 * @param {string} code  RTL artifact candidate
 * @returns {{code: string, stripped: string[]}} stripped names ([] = unchanged)
 */
/**
 * Detect a cold-generation output that is not plausibly SystemVerilog
 * (measured, nemotron run 9: reasoning-token exhaustion made the model echo
 * the prompt's JSON template, and the literal string
 * "<complete testbench source>" shipped as the TB — Test Gen showed ✓ and the
 * next 2+ hours measured a placeholder). Deterministic: real generated code
 * always declares a module; a placeholder/prose/template echo never does.
 *
 * The `module` keyword is the load-bearing signal — the measured placeholder,
 * empty strings, and prose all lack it. The length floor is deliberately LOW
 * (a legal minimal module is ~20 chars); it only catches fragments.
 *
 * @param {*} code   the extracted `code` field
 * @param {object} [opts]  { minChars=20 }
 * @returns {boolean} true when the artifact cannot be generated HDL
 */
export function detectImplausibleArtifact(code, opts) {
  const minChars = (opts && opts.minChars) || 20;
  if (typeof code !== "string") return true;
  const t = code.trim();
  if (t.length < minChars) return true;
  if (!/\bmodule\b/.test(t)) return true;
  return false;
}

/**
 * Spec-stage counterpart of detectImplausibleArtifact (measured: nemotron
 * run 12 — the spec LLM returned a bare port-map with NO requirements/iface
 * arrays and silently dropped the user-named wr_en port; every downstream
 * stage faithfully built and reviewed a write-enable-less FIFO against it,
 * and the judge's requirements criterion passed vacuously).
 *
 * Returns { schema: string[], missingPorts: string[] } | null.
 * - schema problems make the spec structurally unusable (halt-worthy after
 *   a corrective re-ask).
 * - missingPorts are identifier tokens the user literally typed that are
 *   absent from every iface port name. Two extraction rules:
 *     (a) underscore-containing tokens (e.g. "wr_en"), and
 *     (b) the word right after a port-introducing noun — "input din",
 *       "output dout", "clock clk" (measured: run 18 — the spec renamed the
 *       user's "din" to "data_i" and rule (a) alone was blind to it because
 *       "din" carries no underscore).
 *   They join the re-ask; if the model still omits them after being told,
 *   that is logged loudly but not fatal — a deliberate rename stays possible.
 */

// Rule (b): a signal name the user introduces with a port-flavored noun.
// The captured word is only treated as a port name when it survives the
// stopword screen below — prose like "the clock edge of an accepted read"
// matches the pattern but "edge" is not a port.
const PORT_INTRO_RE = /\b(?:inputs?|outputs?|clock|reset|enable|strobes?|flags?)\s+([a-z][a-z0-9_]{1,15})\b/gi;

// English words that legitimately follow a port-introducing noun in prose.
// A captured token in this set is ignored rather than reported missing.
const PORT_TOKEN_STOPWORDS = new Set([
  "a", "an", "and", "or", "the", "of", "to", "with", "that", "which", "when",
  "is", "are", "was", "were", "must", "shall", "should", "may", "can", "will",
  "if", "on", "in", "for", "its", "this", "each", "every", "any", "all", "no",
  "signal", "signals", "port", "ports", "pin", "pins", "bus", "buses", "data",
  "value", "values", "word", "words", "line", "lines", "bit", "bits", "vector",
  "edge", "edges", "cycle", "cycles", "domain", "domains", "state", "states",
  "level", "levels", "logic", "period", "frequency", "rate", "pulse", "tree",
  "high", "low", "wide", "width", "active", "polarity", "asserted", "deasserted",
  "input", "inputs", "output", "outputs", "clock", "reset", "enable", "enables",
  "name", "named", "called", "condition", "behavior", "behaviour", "source",
  "gating", "gated", "release", "assertion", "deassertion", "synchronizer",
  // Verbs that follow "reset"/"enable"/"clock" as the SUBJECT of a sentence
  // ("Reset sets count to 0" — measured false positive on the counter_updown
  // replay fixture, where "sets" was reported as a missing port).
  "set", "sets", "clear", "clears", "resets", "force", "forces", "drive",
  "drives", "puts", "loads", "load", "holds", "hold", "keeps", "keep",
  "empties", "fills", "causes", "makes", "brings", "returns", "restores",
  "zeroes", "zeros", "initializes", "initialises", "asserts", "deasserts",
  "triggers", "toggles", "remains", "stays", "becomes", "takes", "occurs",
  "applies", "happens", "starts", "stops", "begins", "ends", "goes",
]);


// ─── Description-fidelity extraction (runs 37/38/41/42) ─────────────────────
// Four sightings across BOTH models of the spec stage quietly rewriting the
// user's explicit interface: run 37 dropped `done` and invented `ssel`; run
// 38 dropped the CLK_DIV parameter; run 41 set WIDTH's default to 32 against
// a described 8; run 42 renamed six ports, dropped `write` entirely — which
// made read-vs-write confusion UNDETECTABLE downstream, because the TB is
// built from the same wrong contract — and a 32-bit constant was later
// scrambled three independent ways. These extract the parts of a description
// that are LITERAL (an enumerated port list, "Parameter X (default N)",
// SystemVerilog literals) — where a deterministic check needs no judgement.
// A description without those forms yields empty lists and the checks abstain.

/** Identifiers from an enumerated "Ports: a, b[W-1:0], c" clause. */
export function portsClauseOf(desc) {
  const m = /\bPorts?\s*:\s*([^.;]+)/i.exec(String(desc || ""));
  if (!m) return [];
  // English enumerations close with a conjunction — "a, b and c", and just as
  // often "a, b, and c". Splitting on commas alone leaves "b and c" (or "and
  // c") as one chunk, which is not a bare identifier and so is dropped
  // SILENTLY, taking the trailing port name with it.
  //
  // Measured (run 51, rv_hazard): "Ports: … fwd_a, fwd_b, stall_if_id and
  // flush_id_ex" yielded a list holding neither stall_if_id nor flush_id_ex,
  // so the port validator read a correct spec as carrying two ports the
  // description "does not enumerate" and demanded they be removed. The failure
  // direction is what makes it serious: the check does not merely abstain, it
  // argues for breaking a correct design. 4 of that run's 7 modules were hit.
  //
  // The conjunction is expanded ONLY in a chunk that is nothing but ports —
  // never in prose. A descriptive clause ("…, and status outputs full and
  // empty") must keep yielding NOTHING, because an enumeration is read as
  // exhaustive: harvesting a stray "empty" from prose would fabricate a
  // one-port list and silence the port-introducer rule that such descriptions
  // rely on instead. That regression is what tests/run18Robustness covers.
  const PORT = "[A-Za-z_]\\w*(?:\\s*\\[[^\\]]*\\])?";
  const SEP = "\\s+(?:and|&)\\s+";
  const JOINED = new RegExp("^(?:(?:and|&)\\s+)?" + PORT + "(?:" + SEP + PORT + ")*$", "i");
  const out = [];
  for (const chunk of m[1].split(",")) {
    const t = chunk.trim();
    if (!JOINED.test(t)) continue;
    for (const piece of t.replace(/^(?:and|&)\s+/i, "").split(new RegExp(SEP, "i"))) {
      const name = piece.trim().replace(/\[[^\]]*\]\s*$/, "").trim();
      if (/^[A-Za-z_]\w*$/.test(name) && !/^(?:and)$/i.test(name)) out.push(name);
    }
  }
  return out;
}

/**
 * The paragraph of a SYSTEM description that belongs to one module.
 *
 * In a system run each module's pipeline is driven by the DESCRIPTION that
 * decompose wrote for it — a model paraphrase — so every deterministic check
 * downstream validates the spec against the model's summary of itself rather
 * than against the user's words. Measured (run 49): the user's text enumerates
 * "Ports: clk, rst_n, req, done, gnt" for rr_arbiter; the paraphrase dropped
 * the reset entirely, portsClauseOf returned [], the port validator abstained
 * by design, and elicit correctly applied the documented "description is
 * silent → active-high `rst`" default. Every stage behaved correctly on what
 * it was handed; the information died upstream. This is the system-mode face
 * of run 43's root cause (fa6a4b4), whose fix reaches single-module runs only.
 *
 * Attribution rule: a paragraph belongs to the FIRST module it names, and it
 * must carry a Ports: clause. Closest-name-before-the-clause was tried first
 * and is wrong — "The top level, pkt_merge_top, instantiates two
 * ingress_channel modules and one rr_arbiter. Ports: …" would hand the top's
 * ports to rr_arbiter. First-named matches how such a paragraph is written:
 * it introduces its subject before mentioning what that subject contains.
 *
 * Ambiguity abstains: zero or several candidate paragraphs return null and
 * the caller keeps the decomposition's description alone, which is exactly
 * today's behaviour. Attaching the WRONG module's ports would be far worse
 * than attaching none.
 *
 * The Ports: clause is required by DEFAULT because it is what makes the
 * attribution trustworthy enough to drive a deterministic port check. It is
 * not required for PROSE: a user who describes a module without enumerating
 * its ports still deserves to have those words reach the model, and the cost
 * of attaching a slightly-off paragraph as context is far lower than the cost
 * of attaching the wrong port list. Hence `requirePorts`.
 *
 * @param {string} systemDesc   the user's original system description
 * @param {string} modName      the module to attribute
 * @param {string[]} allModNames every module id in the decomposition
 * @param {object} [opts]
 * @param {boolean} [opts.requirePorts=true] demand a Ports: clause
 * @returns {string|null} the paragraph, or null when it cannot be attributed
 */
export function moduleParagraphOf(systemDesc, modName, allModNames, opts) {
  const requirePorts = !opts || opts.requirePorts !== false;
  const paras = String(systemDesc || "").split(/\n\s*\n/);
  const names = (allModNames || []).filter(Boolean);
  if (!modName || names.length === 0) return null;
  const firstNamed = function(p) {
    let best = null;
    let bestAt = Infinity;
    for (const n of names) {
      const m = new RegExp("\\b" + n + "\\b").exec(p);
      if (m && m.index < bestAt) { bestAt = m.index; best = n; }
    }
    return best;
  };
  const hits = paras.filter(function(p) {
    if (requirePorts && !/\bPorts?\s*:/i.test(p)) return false;
    return firstNamed(p) === modName;
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * A module's driving description for a system run: the user's own paragraph
 * about it, followed by decompose's elaboration. The user's words lead so the
 * enumerated port clause the validators read is theirs, not a paraphrase of
 * it — and so the model writing the spec sees what was actually asked for.
 */
export function systemModuleDesc(systemDesc, modDescription, modName, allModNames) {
  // Strict first — a paragraph carrying an enumerated Ports: clause is what
  // gives the port validator something of the USER's to check against. If
  // there is none, fall back to attributing the paragraph on its subject
  // alone: the user's words about this module still belong in the prompt,
  // even when they never enumerated its ports (measured gap, run 49 review).
  const own = moduleParagraphOf(systemDesc, modName, allModNames)
    || moduleParagraphOf(systemDesc, modName, allModNames, { requirePorts: false });
  const para = String(modDescription || "").trim();
  if (!own) return para || String(systemDesc || "");
  return para ? (own.trim() + "\n\n" + para) : own.trim();
}

/** [{name, def}] from "Parameter X (default N)" phrases. */
export function paramClausesOf(desc) {
  const out = [];
  const re = /\bparameters?\s+([A-Za-z_]\w*)\s*\(\s*default\s+([^)]+?)\s*\)/gi;
  let m;
  while ((m = re.exec(String(desc || ""))) !== null) {
    out.push({ name: m[1], def: m[2].trim() });
  }
  return out;
}

const normLit = function(s) { return String(s).toLowerCase().replace(/[_\s]/g, ""); };

/** SystemVerilog literals quoted in the description, normalized. */
export function literalsOf(desc) {
  return (String(desc || "").match(/\b\d+'\s*[shbodSHBOD]{1,2}[0-9a-fA-F_xzXZ]+/g) || [])
    .map(normLit);
}


/**
 * Deterministic port-name repair (run 43: three Spec attempts, three halts,
 * and nearly every violation was a pure DECORATION of a described name —
 * wdata_i, rdata_o, ready_o, irq_o, sel_i, write_i, event_in_i). Renaming a
 * decorated port back to the described name needs no judgement: strip the
 * conventional prefixes/suffixes (i_/o_ and _i/_o/_in/_out — NOT _n, which
 * is active-low semantics, rst_n must survive) and rename only when the stem
 * matches exactly one described port that is otherwise missing. Anything
 * else — invented ports, semantic inversions like a `read` enable where the
 * description says `write` — is left for the re-ask/halt, which is correct
 * there. Returns { spec, renamed } with a NEW spec object; input untouched.
 */
export function repairSpecPortNames(spec, userDesc) {
  const renamed = [];
  if (!spec || !Array.isArray(spec.iface)) return { spec, renamed };
  const declared = portsClauseOf(userDesc);
  if (declared.length === 0) return { spec, renamed };
  // Prose-introduced ports ("a separate input port event_in") are rename
  // targets too — run 43 left event_in_i standing because the target list
  // covered only the enumerated clause.
  const targets = declared.slice();
  let im;
  const introPort = /\b(?:input|output|inout)?\s*ports?\s+([A-Za-z_]\w{1,20})\b/gi;
  while ((im = introPort.exec(String(userDesc || ""))) !== null) {
    if (!targets.some(function(t) { return t.toLowerCase() === im[1].toLowerCase(); })) targets.push(im[1]);
  }
  const present = new Set(spec.iface.map(function(p) { return String((p && p.name) || "").toLowerCase(); }));
  const missing = targets.filter(function(w) { return !present.has(w.toLowerCase()); });
  if (missing.length === 0) return { spec, renamed };
  const stem = function(n) {
    return String(n).toLowerCase()
      .replace(/^(i_|o_)/, "")
      .replace(/(_i|_o|_in|_out)$/, "");
  };
  const iface = spec.iface.map(function(p) { return Object.assign({}, p); });
  for (const want of missing) {
    const cands = iface.filter(function(p) {
      return p && p.name && stem(p.name) === want.toLowerCase()
        && String(p.name).toLowerCase() !== want.toLowerCase()
        && !targets.some(function(d) { return d.toLowerCase() === String(p.name).toLowerCase(); });
    });
    if (cands.length === 1) {
      renamed.push({ from: cands[0].name, to: want });
      cands[0].name = want;
    }
  }
  if (renamed.length === 0) return { spec, renamed };
  return { spec: Object.assign({}, spec, { iface: iface }), renamed };
}

/**
 * A fix loop that has stopped converging (run 46): the RTL lint loop ran its
 * iterations against a model that could not repair what it had written, and
 * ended with the same blocking-error count it started with. Iterating harder
 * against the same model buys nothing; escalating the NEXT attempt to a
 * different one is the move the mixed-tier work made possible.
 *
 * `history` is the loop's per-iteration record; each entry supplies
 * `blockingAfter` (falling back to an explicit error count). Stalled means
 * the last `after` attempts failed to reduce the count below the best seen
 * before them.
 *
 * @param {Array<object>} history  iteration records, oldest first
 * @param {object} [opts] { after = 2 }
 * @returns {boolean} true when the next attempt should escalate
 */
export function fixLoopStalled(history, opts) {
  const after = (opts && opts.after) || 2;
  const counts = (Array.isArray(history) ? history : [])
    .map(function(h) {
      // Loops record the count under different names: blockingAfter (the
      // classified count), errorCount, or lint.js's plain `errors`.
      const v = h && (h.blockingAfter != null ? h.blockingAfter
        : (h.errorCount != null ? h.errorCount
        : (typeof h.errors === "number" ? h.errors : null)));
      return typeof v === "number" ? v : null;
    })
    .filter(function(v) { return v != null; });
  if (counts.length < after + 1) return false;
  const recent = counts.slice(-after);
  const bestBefore = Math.min.apply(null, counts.slice(0, counts.length - after));
  // Still blocking, and no attempt in the window improved on the best count
  // that preceded it.
  return recent[recent.length - 1] > 0 && recent.every(function(c) { return c >= bestBefore; });
}

/**
 * The identity to escalate a stalled fix attempt to, or null when the run
 * has not configured one. Kept beside the stall test so both live with the
 * rest of the fix-loop policy.
 *
 *   config.fixEscalation = { after: 2, provider: "...", model: "...",
 *                            apiKey?: "...", baseUrl?: "..." }
 *
 * Returning null means "carry on with the configured model" — escalation is
 * opt-in, so a run that never sets it behaves exactly as before.
 */
export function fixEscalationConfig(config, baseStageConfig) {
  const esc = (config || {}).fixEscalation;
  if (!esc || typeof esc !== "object") return null;
  if (!esc.model && !esc.provider) return null;
  const out = Object.assign({}, baseStageConfig || {});
  for (const k of ["provider", "model", "apiKey", "baseUrl"]) {
    if (esc[k] != null && esc[k] !== "") out[k] = esc[k];
  }
  return out;
}

/**
 * Hard fidelity violations: the description's LITERAL interface facts that
 * the spec contradicts. Returned as strings ready for the corrective re-ask;
 * spec.js halts the run if they survive it (config.specFidelity: "warn"
 * downgrades). Kept separate from the softer substring-heuristic port check
 * below, which has no enumerated list to be exact against.
 */
/**
 * Clock and reset port names. Matched whole: `clk`, `clk_i`, `i_clk`, `clock`,
 * `rst`, `rst_n`, `reset`, `resetn`, `arst_n`, `nreset` and the like — but not
 * a data port that merely contains the letters, such as `clk_div_ratio` or
 * `reset_count`, which are real signals a description should enumerate.
 */
const STRUCTURAL_PORT_RE = /^(?:i_)?(?:clk|clock|rst|reset|arst|nrst|nreset|resetn|rstn)(?:_?n)?(?:_i|_o)?$/i;

export function specFidelityViolations(spec, userDesc) {
  const out = [];
  if (!spec || typeof spec !== "object") return out;
  const iface = Array.isArray(spec.iface) ? spec.iface : [];
  const names = iface.map(function(p) { return String((p && p.name) || ""); });
  const lower = names.map(function(n) { return n.toLowerCase(); });

  const declared = portsClauseOf(userDesc);
  for (const want of declared) {
    if (lower.indexOf(want.toLowerCase()) < 0) {
      out.push("the description's port list names \"" + want + "\" — it must appear in iface "
        + "with EXACTLY that name (no renaming, no suffixes)");
    }
  }
  if (declared.length > 0) {
    const allowed = new Set(declared.map(function(t) { return t.toLowerCase(); }));
    // Ports introduced by PROSE ("A separate input port event_in ...") are as
    // legitimate as the enumerated list — run 42's own description does this.
    let im;
    PORT_INTRO_RE.lastIndex = 0;
    while ((im = PORT_INTRO_RE.exec(String(userDesc || ""))) !== null) {
      allowed.add(im[1].toLowerCase());
    }
    // "…input port event_in…" — PORT_INTRO_RE captures the word after
    // "input", which here is "port", not the name. The colon in "Ports:"
    // keeps the enumerated clause out of this regex's reach.
    const introPort = /\b(?:input|output|inout)?\s*ports?\s+([A-Za-z_]\w{1,20})\b/gi;
    while ((im = introPort.exec(String(userDesc || ""))) !== null) {
      allowed.add(im[1].toLowerCase());
    }
    // Clock and reset are always allowed, enumerated or not. They are the two
    // ports every sequential module has, and the two a user most readily
    // leaves out of a casual list as self-evident — "Ports: req, gnt" for an
    // arbiter that plainly needs a clock. Without this the check tells a
    // COMPLIANT model to delete clk and rst_n, which yields an unclockable
    // module; the spec's own reset-contract advisory then cannot run either,
    // since it keys on the presence of a clock port.
    //
    // Same contradiction shape as run 44's b0e860d — a port demanded by one
    // check and rejected as an extra by another — reached here from the
    // opposite direction. Deliberately narrow: any OTHER unlisted port stays
    // a violation, because that is the false-spec class run 43 halted on.
    const extras = names.filter(function(n) {
      const nm = n.toLowerCase();
      if (STRUCTURAL_PORT_RE.test(nm)) return false;
      return !allowed.has(nm);
    });
    if (extras.length > 0) {
      out.push("iface contains port(s) the description's enumerated list does not: "
        + extras.join(", ") + " — the list is exhaustive; remove or rename them");
    }
  }

  const params = Array.isArray(spec.params) ? spec.params : [];
  for (const want of paramClausesOf(userDesc)) {
    const got = params.find(function(pp) {
      return String((pp && pp.name) || "").toLowerCase() === want.name.toLowerCase();
    });
    if (!got) {
      out.push("the description declares parameter " + want.name + " (default " + want.def
        + ") — it must appear in params with that exact name");
    } else if (String(got.def).trim() !== want.def
               && normLit(String(got.def)) !== normLit(want.def)) {
      out.push("parameter " + want.name + " default must be " + want.def
        + " as described (spec has " + got.def + ")");
    }
  }

  const specText = normLit(JSON.stringify(spec));
  for (const lit of literalsOf(userDesc)) {
    if (specText.indexOf(lit) < 0) {
      out.push("the description quotes the literal constant " + lit
        + " — it must appear verbatim in the spec (a transposed constant becomes an "
        + "unfixable oracle disagreement downstream)");
    }
  }
  return out;
}

export function detectMalformedSpec(spec, userDesc, opts) {
  const schema = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { schema: ["spec output is not a JSON object"], missingPorts: [], advisories: [] };
  }
  const advisories = [];
  if (!Array.isArray(spec.requirements) || spec.requirements.length === 0) {
    schema.push("\"requirements\" must be a non-empty array of requirement objects");
  } else if (!opts || opts.checkFuncMust !== false) {
    // Empty-contract rule, moved forward from the judge (measured: run 17 —
    // the spec demoted every functional requirement to "Should"; the run
    // burned 40 minutes before the eval gate's req_func_must criterion
    // failed the requirement-less contract at the very end).
    //
    // ADVISORY, not schema: it joins the corrective re-ask but never halts
    // the run — the eval gate keeps final authority (and stays disableable
    // there). A requirement counts as functional-Must when its cat matches
    // the eval gate's shared synonym matcher OR its id carries the
    // REQ-FUNC- prefix — the spec node's own cat-alignment step (which runs
    // AFTER this guard) derives cat from that prefix, so a mismatched
    // (id, cat) pair the pipeline would repair itself must not re-ask.
    const hasFuncMust = spec.requirements.some(function(r) {
      if (!r || !/^must$/i.test(String(r.pri || ""))) return false;
      return FUNCTIONAL_CAT_RE.test(String(r.cat || "").toLowerCase())
        || /^REQ-FUNC-/i.test(String(r.id || ""));
    });
    if (!hasFuncMust) {
      advisories.push("at least one requirement should have cat \"Functionality\" AND pri \"Must\" — "
        + "the module's core behaviors are Must requirements, not Should");
    }
  }
  if (!Array.isArray(spec.iface) || spec.iface.length === 0) {
    schema.push("\"iface\" must be a non-empty array of port objects");
  }
  // Reset-contract advisory (run 29: the spec was SILENT about dout's reset
  // behavior; RTL cleared it, the reference-model TB retained it — both
  // defensible readings, one irreducible test failure). A SEQUENTIAL design
  // (has a clock port) must state each output's reset behavior in a `reset`
  // field. Advisory like the empty-contract rule: joins the corrective
  // re-ask, never halts the run.
  if (Array.isArray(spec.iface)) {
    const sequential = spec.iface.some(function(p) {
      return p && p.dir === "input" && /^(clk|clock)/i.test(String(p.name || ""));
    });
    if (sequential) {
      const bare = spec.iface.filter(function(p) {
        return p && p.dir === "output" && !String(p.reset || "").trim();
      }).map(function(p) { return p.name; });
      if (bare.length > 0) {
        advisories.push("every OUTPUT port of a sequential design carries a \"reset\" field — "
          + "a post-reset value or \"retains last value\"; missing on: " + bare.join(", "));
      }
    }
  }
  const missingPorts = [];
  if (Array.isArray(spec.iface) && spec.iface.length > 0) {
    const names = spec.iface.map(function(p) {
      return String((p && p.name) || "").toLowerCase();
    }).filter(Boolean);
    const desc = String(userDesc || "");
    const seen = {};
    // When the description carries an ENUMERATED ports clause, that clause
    // (plus prose-introduced ports) is the authority and specFidelityViolations
    // checks it exactly. The loose snake_case scan below exists only for
    // descriptions WITHOUT such a clause (run 18) — running it anyway makes the
    // two checks contradict each other: on run 43's description it demanded
    // "event_clear" (a register-map entry) and "h0000_0001" (a fragment of
    // 32'h0000_0001) as ports, a compliant model ADDED them, and the fidelity
    // check then halted the run for iface extras. Measured: run 43 attempt 4's
    // halt was this loop, and run 43's own PASSING spec carries the same two
    // false positives.
    const enumerated = portsClauseOf(desc);
    const rawTokens = enumerated.length > 0 ? [] :
      (desc.match(/\b[a-z][a-z0-9]*_[a-z0-9_]*\b/gi) || [])
        .map(function(t) { return t.toLowerCase(); })
        // Literal fragments are never port names: "32'h0000_0001" leaves
        // "h0000_0001", "8'b1010_1010" leaves "b1010_1010".
        .filter(function(t) { return !/^[hbdo]?[0-9a-f]+(_[0-9a-f]+)+$/.test(t); });
    // Rule (b): names introduced as "input din" / "output dout" / "clock clk".
    // Suppressed for the same reason the token scan is: when the description
    // ENUMERATES its ports, specFidelityViolations checks that list exactly
    // and the heuristics must stand down. Left running, this rule read
    // "a reader that misses the strobe still sees the last byte" and demanded
    // a port called "still" (run 47) — the same false-positive class that
    // halted run 43, arriving through the prose rule instead of the token one.
    let m;
    if (enumerated.length === 0) {
      PORT_INTRO_RE.lastIndex = 0;
      while ((m = PORT_INTRO_RE.exec(desc)) !== null) {
        const t = m[1].toLowerCase();
        if (!PORT_TOKEN_STOPWORDS.has(t)) rawTokens.push(t);
      }
    }
    const tokens = rawTokens
      .filter(function(t) { return t.length <= 16 && !seen[t] && (seen[t] = true); });
    for (const t of tokens) {
      const present = names.some(function(n) {
        return n.indexOf(t) >= 0 || t.indexOf(n) >= 0;
      });
      if (!present) missingPorts.push(t);
    }
  }
  const fidelity = (!opts || opts.checkFidelity !== false)
    ? specFidelityViolations(spec, userDesc) : [];
  if (schema.length === 0 && missingPorts.length === 0 && advisories.length === 0
      && fidelity.length === 0) return null;
  return { schema: schema, missingPorts: missingPorts, advisories: advisories, fidelity: fidelity };
}

/**
 * The RTL-side adoption chokepoint: strip leaked testbench modules, then run
 * the deterministic syntax repairs. Every rtl-family site (rtl_generate
 * output, lint candidates, rtl_review adoptions) calls THIS instead of
 * maybeRepair directly, so kind-awareness lives in one place. `logFn(title,
 * body)` is optional (same contract as maybeRepairWithLog).
 */
export function repairRtlCandidate(config, code, logFn) {
  if (typeof code === "string") {
    const s = stripEmbeddedTbModules(code);
    if (s.stripped.length > 0) {
      if (logFn) logFn("✂ Stripped embedded testbench module(s) from RTL candidate",
        s.stripped.join(", ") + " — a testbench belongs in the TB artifact; left in the RTL it collides with the real TB at verify.");
      code = s.code;
    }
  }
  return maybeRepairWithLog(config, code, logFn);
}

export function stripEmbeddedTbModules(code) {
  const src = String(code == null ? "" : code);
  const lines = src.split("\n");
  const blocks = [];               // { name, start, end } inclusive line idxs
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*module\s+([A-Za-z_]\w*)/);
    if (m && !open) open = { name: m[1], start: i };
    if (open && /^\s*endmodule\b/.test(lines[i])) {
      blocks.push({ name: open.name, start: open.start, end: i });
      open = null;
    }
  }
  const tbBlocks = blocks.filter(function(b) { return /_tb$/i.test(b.name); });
  const keeps = blocks.length - tbBlocks.length;
  if (tbBlocks.length === 0 || keeps === 0) return { code: src, stripped: [] };
  const drop = new Set();
  for (const b of tbBlocks) for (let i = b.start; i <= b.end; i++) drop.add(i);
  const out = lines.filter(function(_, i) { return !drop.has(i); });
  return { code: out.join("\n").replace(/\n{3,}/g, "\n\n"), stripped: tbBlocks.map(function(b) { return b.name; }) };
}

/**
 * Reject a TB fix candidate that DISCARDED the testbench's architectural
 * infrastructure (measured, nemotron e2e run 4: a late fix rewrote the whole
 * TB — the step() task, the check() task, and the ref_ shadow model all
 * vanished, replaced by self-blocking `define/`ifndef task wrappers whose
 * bodies compile out. The rewrite was LARGER than the original, so
 * detectGuttedRewrite could not fire, and it shipped as the final artifact).
 *
 * A marker only counts when the CURRENT TB has it — a directed-architecture
 * TB (no step/check/ref_ markers) never trips this guard, and every fix
 * prompt demands minimal diffs + verbatim infrastructure, so losing a marker
 * is never a legitimate fix. False-positive cost matches detectGuttedRewrite:
 * one skipped candidate, never a broken artifact.
 *
 * @param {string} current    the TB the loop currently holds
 * @param {string} candidate  the fix/regen output under consideration
 * @returns {boolean} true when an architectural marker present in `current`
 *                    is missing from `candidate`
 */
export function detectTbInfraLoss(current, candidate) {
  // Head-cut floor (runs 30/39): a candidate that lost the module header is
  // corrupt regardless of what infrastructure survives below the cut — catch
  // it here so review adoption paths reject with a message even when no CLI
  // is configured for the lint gate.
  if (headerlessReplacement(current, candidate)) return true;
  const cur = String(current == null ? "" : current);
  const cand = String(candidate == null ? "" : candidate);
  const markers = [
    /\btask\s+automatic\s+step\s*\(/,     // canonical step(n) time-advance task
    /\btask\s+automatic\s+check\s*\(/,    // check task (pass/fail counters)
    /\bref_[A-Za-z_]\w*/,                 // reference-model shadow signals
  ];
  for (const re of markers) {
    if (re.test(cur) && !re.test(cand)) return true;
  }
  // GENERAL orphaned-call check (measured, nemotron run 8 resume: a verify TB
  // fix deleted the apply_reset task while its 4 call sites remained — a
  // compile-guaranteed regression the named markers above don't cover). Any
  // task DEFINED in the current TB whose calls survive in the candidate must
  // keep its definition; a fix that removes a task together with all its
  // calls is a legitimate edit and passes.
  const defRe = /\btask\s+(?:automatic\s+)?([A-Za-z_]\w*)\s*[(;]/g;
  let m;
  while ((m = defRe.exec(cur))) {
    const name = m[1];
    if (new RegExp("\\btask\\s+(?:automatic\\s+)?" + name + "\\s*[(;]").test(cand)) continue;
    if (new RegExp("^[ \\t]*" + name + "\\s*\\(", "m").test(cand)) return true;
  }
  return false;
}

/**
 * Append a COMPLETE-MODULE directive to a fix prompt, used to RE-ASK after a
 * candidate came back gutted (detectGuttedRewrite). The goal is a WORKING
 * REPLACEMENT — deleting the offending construct to satisfy a checker is not a
 * fix, but neither is stalling on the problematic original. This pushes the
 * model to correct the specific lines while preserving the whole module.
 *
 * Phrased positively on purpose (measured — naming a wrong form primes the
 * model to produce it): it states what to KEEP and how to CORRECT, with only a
 * one-clause mention of the observed failure. Pure; returns a shallow copy.
 *
 * @param {object} promptObj  a fix prompt ({systemPrompt, userMessage, …})
 * @returns {object} copy with the directive appended to userMessage
 */
export function noDeletionDirective(promptObj) {
  const directive =
    "\n\n━━ COMPLETE-MODULE REQUIREMENT ━━\n" +
    "The previous attempt returned an incomplete module (its body was dropped). " +
    "Return the COMPLETE, WORKING module this time:\n" +
    "• Keep the module name, EVERY port (same names, directions, widths), and every parameter exactly as they are.\n" +
    "• Keep ALL existing logic — every always block, continuous assignment, and instantiation stays present.\n" +
    "• Resolve the finding by CORRECTING the specific offending lines (adjust a width, add a default, " +
    "fix a literal base, complete a sensitivity list, add a case default), not by removing the construct that triggered it.\n" +
    "• The result is a complete module of comparable size to the current code — a working replacement, never a shorter stub.";
  return Object.assign({}, promptObj, {
    userMessage: (promptObj && promptObj.userMessage ? promptObj.userMessage : "") + directive,
  });
}

/**
 * Tiered fix-loop convergence (docs/improvement-roadmap.md #2). Measured:
 * every loop exhausted its cap because the old exit treated status FAIL as
 * "has errors" — and Verilator exits non-zero under -Wall for WARNINGS alone,
 * so a 0-error result could never stop the loop. Tiers:
 *   errors > 0                        → keep fixing
 *   0 errors, warnings, opt-in strict → keep fixing (lintWarningsAsErrors)
 *   0 errors, warnings                → CONVERGED (warnings reported, not looped)
 *   status FAIL, nothing parsed       → NOT converged (an unparsed diagnostic —
 *                                       never call that clean)
 * Pure; shared by lint and lint_test.
 */
// Warning codes that can HIDE A FUNCTIONAL BUG — every one of these has been
// a real defect in this project's run history (width truncation, inferred
// latches, incomplete cases, wrong assignment flavour, multiple drivers,
// implicit nets, procedural assignment to a wire). Under
// lintWarningsAsErrors these keep gating.
//
// Everything else is HYGIENE: unused declarations, filename conventions,
// missing trailing newline, and WIDTHEXPAND (zero-extension is safe by
// definition — the dangerous direction is WIDTHTRUNC, which is tier 1).
// Measured (runs 33/34/35): three consecutive stage failures on 0 errors and
// 1-5 hygiene warnings cost ~80 min of fix-loop time, cleared NOTHING, and
// moved no eval criterion — the lint criteria count errors only, so the gate
// was pure cost. Hygiene warnings are now reported, not gated.
const SEMANTIC_WARNING_CODES = new Set([
  "WIDTHTRUNC", "LATCH", "CASEINCOMPLETE", "CASEOVERLAP", "CASEX",
  "BLKSEQ", "COMBDLY", "MULTIDRIVEN", "IMPLICIT", "PROCASSWIRE",
  "PROCASSINIT", "IMPLICITSTATIC", "ALWCOMBORDER", "LATCHLOOP",
  "UNDRIVEN", "SELRANGE", "INFINITELOOP", "BLKANDNBLK",
  // DEFPARAM: IEEE-deprecated for its murky elaboration-order semantics —
  // an override that silently fails to take effect leaves the DUT at its
  // DEFAULT parameter while the testbench believes it was overridden, so a
  // depth/width test can silently exercise the wrong design. Reached this
  // list the honest way: the fail-closed default already gated run 34's
  // `defparam dut.CLKS_PER_BIT = …`, and the replay that proved it made the
  // classification explicit rather than incidental.
  "DEFPARAM",
]);

/**
 * Split lint warnings into the ones that can hide a functional bug and the
 * ones that are style/hygiene. Pure; unknown codes are treated as SEMANTIC
 * (fail closed — a new Verilator warning we have not classified should gate
 * rather than slip through).
 * @returns {{semantic: Array, hygiene: Array}}
 */
export function splitWarnings(warnings) {
  const semantic = [];
  const hygiene = [];
  for (const w of (warnings || [])) {
    const code = String((w && w.code) || "").toUpperCase();
    if (code && !SEMANTIC_WARNING_CODES.has(code) && HYGIENE_WARNING_CODES.has(code)) hygiene.push(w);
    else semantic.push(w);
  }
  return { semantic: semantic, hygiene: hygiene };
}

const HYGIENE_WARNING_CODES = new Set([
  "UNUSEDPARAM", "UNUSEDSIGNAL", "UNUSED", "UNUSEDGENVAR",
  "DECLFILENAME", "EOFNEWLINE", "WIDTHEXPAND", "VARHIDDEN",
  "PINCONNECTEMPTY", "SYNCASYNCNET", "UNDRIVENSIGNAL",
  // IMPORTSTAR: `import pkg::*;` at compilation-unit scope "may pollute the
  // global namespace". It says nothing about whether the module is correct —
  // it is a scoping convention, and both placements are legal SV.
  //
  // It reaches this list because a SYSTEM run makes it universal: every
  // module imports the shared package, and $unit scope is the placement a
  // model reaches for first. Unclassified, it fell to the fail-closed
  // default and gated. Measured (run 49, laguna-s-2.1 driving the run 48
  // spec): rr_arbiter failed BOTH its lint stages with **0 errors**, spent
  // all three maxLintIters trying to satisfy it, and shipped with the import
  // untouched plus an inert `// verilator lint_off IMPORTSTAR` trailing
  // comment. Every module in every system run would have failed lint the
  // same way, so the lint verdict carried no information at all.
  "IMPORTSTAR",
]);

/**
 * The stage's PASS/FAIL stamp, using the SAME two-tier rule as lintConverged
 * and the lint eval criteria. Previously each lint node computed this inline
 * as `errors === 0 && (!warningsAsErrors || warnings === 0)`, a third copy of
 * the policy — so run 36's Lint RTL converged on 4 hygiene WIDTHEXPAND
 * warnings and then stamped FAIL anyway. One helper, one policy.
 */
export function lintStatusOf(parsed, treatWarningsAsErrors) {
  const errs = ((parsed && parsed.errors) || []).length;
  if (errs > 0) return "FAIL";
  if (treatWarningsAsErrors
      && splitWarnings((parsed && parsed.warnings) || []).semantic.length > 0) return "FAIL";
  return "PASS";
}

export function lintConverged(lintData, treatWarningsAsErrors) {
  const errs = ((lintData && lintData.errors) || []).length;
  const warns = ((lintData && lintData.warnings) || []).length;
  if (errs > 0) return false;
  // Two-tier: only bug-hiding warnings gate under warnings-as-errors.
  if (treatWarningsAsErrors && splitWarnings((lintData && lintData.warnings) || []).semantic.length > 0) return false;
  if (lintData && lintData.status === "FAIL" && warns === 0) return false;
  return true;
}

/**
 * Pair each completed verify iteration's triage decision with the NEXT
 * iteration's measurement (the decision's actual outcome) — compact rows for
 * the fix prompts' attempt ledger (prompts/base.js attemptLedgerSection).
 * Run 18 working-set curation: iteration N+1 needs "iter 1: test_generate
 * regenerated → 33/54 (no change), REJECT_NO_IMPROVEMENT", not an unbounded
 * accumulation of its own past fix descriptions. Same pairing rule as
 * judge.js triageAttemptsFrom. Pure; shared by verify and judge.
 */
export function attemptRowsFromHistory(history) {
  const h = history || [];
  const rows = [];
  for (let i = 0; i + 1 < h.length; i++) {
    if (!h[i] || !h[i].triageTarget) continue;
    const next = h[i + 1] || {};
    rows.push({
      iter:     h[i].iter != null ? h[i].iter : i + 1,
      target:   h[i].triageTarget,
      pass:     typeof next.pass === "number" ? next.pass : null,
      total:    next.total,
      decision: (next.classification && next.classification.patchDecision) || null,
      flipped:  !!h[i].triageFlipped,
    });
  }
  return rows;
}

/**
 * NO-OP FIX ITERATION (measured: run 37). A review fix loop that produced
 * BYTE-IDENTICAL code has nothing to build on: the next iteration re-asks the
 * same model with the same code and the same review, and its re-review is
 * guaranteed to reproduce the verdict just recorded. On run 37's RTL Review
 * that pair of calls cost ~9.5 minutes of a 36-minute stage (devstral runs at
 * 3-4 output tokens/sec: ~189s per review, ~386s per fix).
 *
 * Takes the iteration ledger and reports whether the LAST entry was a fix
 * attempt that changed nothing. Only `*review_fix*` kinds count — the
 * `initial_review` entry records beforeCode === afterCode BY CONSTRUCTION
 * (it reviews without fixing), so counting it would break the loop before it
 * ever ran a single fix. Pure + exported for testing.
 */
export function lastFixWasNoOp(iterations) {
  const list = Array.isArray(iterations) ? iterations : [];
  const last = list[list.length - 1];
  const st = last && last._structured;
  if (!st) return false;
  if (String(st.kind || "").indexOf("review_fix") < 0) return false;

  // `fixOutcome` says WHY the code is unchanged, and only one reading is a
  // no-op (run 39). A candidate we REJECTED — worse lint, more bug-hiding
  // warnings, a scored regression — is the opposite situation: the model did
  // produce something new, the next attempt sees that outcome, and the
  // forward-candidate machinery exists precisely to converge from there. Ending
  // the loop on a rejection throws away a retry the cap had budgeted for.
  if (typeof st.fixOutcome === "string") return st.fixOutcome === "identical";

  // No outcome recorded (older checkpoints): fall back to comparing the code,
  // which cannot tell the two cases apart but preserves the prior behaviour.
  if (typeof st.beforeCode !== "string" || typeof st.afterCode !== "string") return false;
  if (st.beforeCode.length === 0) return false;
  return st.beforeCode === st.afterCode;
}

/**
 * REVIEW-SCORE REGRESSION (measured across runs 20-37). The review fix loops
 * were the only fix loops in the pipeline with no monotonicity rule on their
 * own headline metric: rtl_review gates a candidate on lint error count and
 * test_review on TB-infrastructure loss, but neither compares the new review
 * against the one it was fixing, so a fix that made the review WORSE was
 * adopted and the next iteration built on it.
 *
 * TWO SIGNALS, not one. The ledger over 15 runs holds five score regressions:
 *
 *   run 28 test_review  75/5  → 60/6    score -15, issues +1
 *   run 36 rtl_review   47/8  → 45/12   score  -2, issues +4
 *   run 37 test_review  59/6  → 16/11   score -43, issues +5
 *   run 36 test_review  58/27 → 55/25   score  -3, issues -2
 *   run 37 rtl_review   68/8  → 60/7    score  -8, issues -1
 *
 * The last two REDUCED the issue count while scoring lower — an LLM's holistic
 * score is noisy across two separate completions, and discarding a fix that
 * measurably removed findings would trade a real gain for that noise. So a
 * regression requires the score to drop AND the blocking-issue count not to
 * improve. That catches the first three (including run 28's, which SHIPPED,
 * and run 37's collapse to the campaign-low 16) and leaves the last two alone.
 * Requiring both signals also removes any need for a magnitude threshold.
 *
 * Counts critical+major when severities are present (the loop's own gate), and
 * falls back to total issues when they are not. A missing or non-numeric score
 * on either side reports NO regression — the existing gates keep governing
 * rather than a comparison against undefined deciding anything.
 */
export function reviewFixRegressed(prior, candidate) {
  const scoreOf = function(r) {
    const v = r && r.score;
    return typeof v === "number" && isFinite(v) ? v : null;
  };
  const ps = scoreOf(prior), cs = scoreOf(candidate);
  if (ps === null || cs === null) return false;
  if (cs >= ps) return false;                      // no score drop → nothing to judge
  const blocking = function(r) {
    const issues = (r && r.issues) || [];
    const cm = issues.filter(function(i) {
      const sev = String((i && (i.severity || i.sev)) || "").toLowerCase();
      return sev === "critical" || sev === "major";
    }).length;
    // No severities anywhere → the count is uninformative; use the total.
    return cm > 0 ? cm : issues.length;
  };
  return blocking(candidate) >= blocking(prior);
}

/**
 * LINT-COUNT ADOPTION DECISION shared by both review nodes (run 39). Given
 * {errors, semantic} counts for a candidate and for the code it would replace,
 * name the regression or return null to adopt. Errors outrank semantic
 * warnings; equal counts adopt (the fix may have progressed elsewhere).
 *
 * Run 39 measured why this must exist in test_review too: its chain fix
 * adopted a headerless TB carrying 7 compile errors — test_review had only the
 * infra-loss check and a verdict downgrade that rejects nothing, while
 * rtl_review has had this gate since run 7. One predicate, two callers.
 */
export function lintAdoptionRegression(cand, cur) {
  if (!cand || !cur) return null;
  if (typeof cand.errors === "number" && typeof cur.errors === "number"
      && cand.errors > cur.errors) return "errors";
  if (typeof cand.semantic === "number" && typeof cur.semantic === "number"
      && cand.semantic > cur.semantic) return "semantic";
  return null;
}

/**
 * STRUCTURAL FLOOR for code slots (runs 30 + 39). Three byte-exact sightings
 * of the same corruption — a TB's first N lines (timescale + module header +
 * head region) deleted, remainder untouched — shipped or nearly shipped
 * across 9 runs and 2 models. The 2026-07-31 hunt ELIMINATED extractJSON,
 * repairSV, repairRtlCandidate and the persisted patch edits as the actor,
 * and the writer's own record was clobbered in every sighting, so the actor
 * is still unnamed. This predicate is the defense that needs no name: a
 * SystemVerilog source that HAD a module header may never be replaced by one
 * without — no legitimate transform, fix, or rewrite removes the module
 * declaration.
 */
export function headerlessReplacement(prevCode, nextCode) {
  const hasHeader = function(s) {
    return typeof s === "string" && /(^|\n)\s*module\s+\w+/.test(s);
  };
  return hasHeader(prevCode) && typeof nextCode === "string"
    && nextCode.length > 0 && !hasHeader(nextCode);
}

/**
 * Formal counterexample evidence for fix prompts (run 40). A formal FAIL is
 * DIRECT evidence against the RTL — the properties are bound to the design,
 * the testbench is not involved — and naming the violated assertion is what
 * made the formal fixer converge in one iteration (replay-trio program).
 * Run 40's judge loop had a counterexample naming dut.sv:266 step 2 and none
 * of its fix prompts mentioned it. Null unless a real FAIL verdict exists.
 */
export function formalEvidenceOf(state) {
  const fv = state && state.formal_verify;
  if (!fv || fv.status !== "FAIL") return null;
  return {
    violated: fv.violated || null,
    depth: fv.depth != null ? fv.depth : null,
    cexWindow: fv.cexWindow || null,
  };
}

