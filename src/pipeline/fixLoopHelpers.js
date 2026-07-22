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
  const missingPorts = [];
  if (Array.isArray(spec.iface) && spec.iface.length > 0) {
    const names = spec.iface.map(function(p) {
      return String((p && p.name) || "").toLowerCase();
    }).filter(Boolean);
    const desc = String(userDesc || "");
    const seen = {};
    const rawTokens = (desc.match(/\b[a-z][a-z0-9]*_[a-z0-9_]*\b/gi) || [])
      .map(function(t) { return t.toLowerCase(); });
    // Rule (b): names introduced as "input din" / "output dout" / "clock clk".
    let m;
    PORT_INTRO_RE.lastIndex = 0;
    while ((m = PORT_INTRO_RE.exec(desc)) !== null) {
      const t = m[1].toLowerCase();
      if (!PORT_TOKEN_STOPWORDS.has(t)) rawTokens.push(t);
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
  if (schema.length === 0 && missingPorts.length === 0 && advisories.length === 0) return null;
  return { schema: schema, missingPorts: missingPorts, advisories: advisories };
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
export function lintConverged(lintData, treatWarningsAsErrors) {
  const errs = ((lintData && lintData.errors) || []).length;
  const warns = ((lintData && lintData.warnings) || []).length;
  if (errs > 0) return false;
  if (treatWarningsAsErrors && warns > 0) return false;
  if (lintData && lintData.status === "FAIL" && warns === 0) return false;
  return true;
}
