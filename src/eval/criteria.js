// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// eval/criteria — Deterministic eval criteria registry
//
// Each criterion has a deterministic measurer that reads project state
// (typically `currentState` inside the judge node, but the same shape
// works for any module's stageData snapshot) and returns:
//
//   { measured: <0..100>, denominator: <int>, detail: <string|null> }
//
// `measured` is a percentage (so the gate's "exceeds threshold" comparison
// is uniform across all criterion types). `denominator` is the count
// the percentage was computed from (helpful for UI: "12/15 reqs covered"
// vs the bare 80%). `detail` is a short human-readable note for the
// table in the GUI/CLI.
//
// CONTINUOUS-DEVELOPMENT NOTE: this is a registry. Adding a new
// criterion means adding one entry — no switch statements get edited.
// The criterion id is the persisted key in config.evalCriteria, so
// breaking-change ids should use a new id and migrate.
//
// CATEGORIES (matching the Q2 taxonomy):
//   requirements  — by category × priority (4 cats × 2 pris = up to 8)
//   verify        — pass rate, simulator quality
//   coverage      — line, branch, toggle, fsm, expr
//   formal        — assertions present, covers present
//   lint          — RTL clean, TB clean
//   review        — RTL review score, TB review score
// ═══════════════════════════════════════════════════════════════════════════

import { buildLedgerForState } from "../pipeline/acceptanceLedger.js";

/**
 * Helper: percentage of `nums.filter(predicate).length / nums.length`,
 * returning 100 when there are zero items (vacuous truth — no items
 * means nothing FAILED). Callers gate visibility via `denominator: 0`
 * so the UI can show "n/a" when this is the case.
 */
function pctOf(arr, predicate) {
  if (!Array.isArray(arr) || arr.length === 0) {
    return { pct: 100, denom: 0 };
  }
  const matched = arr.filter(predicate).length;
  return { pct: Math.round((matched / arr.length) * 100), denom: arr.length };
}

/**
 * Build the requirement-category criteria. We expand the cartesian
 * product cat × pri into individual criterion entries, so the user can
 * say e.g. "func+Must at 100, func+Should at 80, intf+Must at 100,
 * verif+anything: off."
 *
 * `cat` values come from the spec.requirements `cat` field. The set
 * func/verif/timing/intf is what the prompt elicits today; if a future
 * project introduces a new category, requirements with that category
 * are scored under the most general "ALL" criterion (id: req_all_*)
 * which is also generated below as a fallback.
 */
const REQ_CATEGORIES = [
  { id: "func",   label: "Functional"  },
  { id: "verif",  label: "Verification"},
  { id: "timing", label: "Timing"      },
  { id: "intf",   label: "Interface"   },
];
const REQ_PRIORITIES = [
  { id: "must",   label: "Must"        },
  { id: "should", label: "Should"      },
  // The "All priorities" union of must+should+may is exposed by the UI
  // (EvalsTab) as a per-category parent CHECKBOX that toggles its must+should
  // children, rather than as a
  // separate criterion in the catalog. Cleaner mental model + 4 fewer
  // entries to scroll past.
];

/**
 * @param {string} cat
 * @param {string} priFilter  - "must" | "should" | "all"
 * @returns {function(state) -> {measured, denominator, detail}}
 */
function reqCriterionMeasurer(cat, priFilter) {
  return function measure(state) {
    const reqs = (state && state.spec && state.spec.requirements) || [];
    const trace = (state && state.judge && state.judge.trace)
      || (state && state.judge_pre_eval_trace)  // judge node may stash partial trace
      || [];
    const traceById = new Map();
    for (const t of trace) traceById.set(t.req, t);

    // The gate runs BEFORE the judge produces a trace, so on the first
    // eval-gate invocation `trace` is empty and every req would measure 0%. To
    // break this circularity, when there's no trace
    // entry for a requirement we fall back to deriving "is this req
    // satisfied" directly from verify.tests, which carries a `req`
    // field per test (populated by attributeTestToReq in the verify
    // node). A req is satisfied iff ≥1 test points at it AND all such
    // tests are PASS. This is the same logic the judge's trace
    // synthesizer uses post-hoc; doing it here makes the measurer
    // self-sufficient.
    const verify = state && state.verify;
    const tests  = (verify && Array.isArray(verify.tests)) ? verify.tests : [];
    const testsByReq = new Map();
    for (const t of tests) {
      if (!t || !t.req) continue;
      if (!testsByReq.has(t.req)) testsByReq.set(t.req, []);
      testsByReq.get(t.req).push(t);
    }
    function isReqSatisfiedViaVerify(reqId) {
      const linked = testsByReq.get(reqId) || [];
      if (linked.length === 0) return null;  // unknown (no link)
      return linked.every(function(t) { return t.st === "PASS"; });
    }

    const inScope = reqs.filter(function(r) {
      // Match category — also accept synonyms the LLM uses interchangeably.
      const rc = (r.cat || "").toLowerCase();
      const matchCat =
        (cat === "func"   && /^(func|functional|functionality)$/.test(rc)) ||
        (cat === "verif"  && /^(verif|verification|test|testbench)$/.test(rc)) ||
        (cat === "timing" && /^(timing|perf|performance)$/.test(rc)) ||
        (cat === "intf"   && /^(intf|interface|io|port)$/.test(rc));
      if (!matchCat) return false;
      // Priority filter
      const rp = (r.pri || "").toLowerCase();
      if (priFilter === "must")   return rp === "must";
      if (priFilter === "should") return rp === "should";
      return true;  // "all"
    });

    if (inScope.length === 0) {
      return { measured: 100, denominator: 0,
        detail: "no " + cat + " requirements at " + priFilter + " priority" };
    }
    let passing = 0;
    let viaTrace = 0;
    let viaVerify = 0;
    let viaAllPass = 0;
    let untested = 0;

    // Layer 3 fallback: when the testbench has NO `// covers: REQ-X`
    // annotations (so attributeTestToReq returned null for every test) BUT
    // verify ran and every test passed,
    // we presume Must requirements are covered via the test suite
    // as a whole. This matches user expectations ("verify shows all
    // pass, why does judge say func-must fails?") while preserving
    // rigor for the explicit-trace path: when annotations exist,
    // Layers 1+2 still demand per-req attribution.
    //
    // Conditions for activation:
    //   - verify ran (tests array non-empty)
    //   - every test passed
    //   - no test in verify.tests has a `req` field set (i.e. the
    //     entire suite is uncoupled from requirements)
    // The presumption is logged in the detail string so reviewers
    // know the verdict isn't rigorously trace-backed.
    const everyTestPassed = tests.length > 0 && tests.every(function(t) { return t && t.st === "PASS"; });
    const noTestHasReq    = tests.length > 0 && tests.every(function(t) { return !t || !t.req; });
    const allPassFallback = everyTestPassed && noTestHasReq;

    for (const r of inScope) {
      const t = traceById.get(r.id);
      if (t && t.ok === true) { passing++; viaTrace++; continue; }
      // No positive trace evidence — try verify-tests fallback
      const viaV = isReqSatisfiedViaVerify(r.id);
      if (viaV === true) { passing++; viaVerify++; continue; }
      // Layer 3: all-pass uncoupled fallback
      if (allPassFallback && priFilter === "must") {
        // Only Must reqs benefit from the all-pass presumption.
        // Should/May still need explicit coverage to count.
        passing++; viaAllPass++;
        continue;
      }
      if (viaV === null) untested++;
    }
    const pct = Math.round((passing / inScope.length) * 100);
    let detailExtra = "";
    if (viaAllPass > 0) {
      detailExtra = " (" + viaAllPass + " presumed via all-pass; testbench lacks " +
        "// covers: annotations — judge result is not rigorously traceable)";
    } else if (viaVerify > 0) {
      detailExtra = " (" + viaVerify + " via verify.tests fallback)";
    } else if (untested > 0 && passing === 0) {
      detailExtra = " — " + untested + " req(s) have no test link in verify.tests";
    }
    return {
      measured: pct,
      denominator: inScope.length,
      detail: passing + "/" + inScope.length + " " + cat + "/" + priFilter +
        " requirements traced+ok" + detailExtra,
    };
  };
}

/**
 * Strict attribution measurer: every Must requirement must have ≥1
 * EXPLICITLY attributed passing test.
 *
 * "Attributed" means the test carries a `req` field — populated by the
 * verify node's attributeTestToReq from Layer 1 (REQ-ID in the test name)
 * or Layer 2 (`// covers: REQ-ID` annotation in the testbench).
 *
 * This is the rigorous counterpart to the per-category req criteria above:
 * those accept the Layer-3 all-pass presumption ("suite passed and has no
 * annotations at all → presume Musts covered"), which keeps the default
 * gate friendly but means a PASS isn't necessarily traceable. Enabling
 * this criterion turns traceability into a hard gate — an unannotated
 * suite scores 0 here no matter how green it is, because nothing connects
 * any test to any requirement.
 *
 * Satisfaction rule per requirement (same as the verify-tests fallback in
 * reqCriterionMeasurer): ≥1 linked test AND every linked test PASSes.
 */
function mustAttributionMeasurer() {
  return function measure(state) {
    const reqs = (((state && state.spec && state.spec.requirements) || []))
      .filter(function(r) { return ((r && r.pri) || "").toLowerCase() === "must"; });
    if (reqs.length === 0) {
      return { measured: 100, denominator: 0, detail: "no Must requirements" };
    }
    const verify = state && state.verify;
    const tests = (verify && Array.isArray(verify.tests)) ? verify.tests : [];
    if (tests.length === 0) {
      return { measured: 0, denominator: reqs.length, detail: "verify has no test results" };
    }
    let satisfied = 0;
    const missing = [];
    for (const r of reqs) {
      const linked = tests.filter(function(t) { return t && t.req === r.id; });
      if (linked.length > 0 && linked.every(function(t) { return t.st === "PASS"; })) {
        satisfied++;
      } else {
        missing.push(r.id);
      }
    }
    const pct = Math.round((satisfied / reqs.length) * 100);
    return {
      measured: pct,
      denominator: reqs.length,
      detail: satisfied + "/" + reqs.length +
        " Must requirements have explicitly attributed passing tests" +
        (missing.length > 0
          ? " — unattributed/failing: " + missing.slice(0, 6).join(", ")
            + (missing.length > 6 ? ", …" : "")
          : ""),
    };
  };
}

/**
 * Must-requirement greenness via the acceptance ledger. Broader than
 * req_must_attributed: a Must requirement counts as green when it has a real
 * passing attributed test OR is satisfied structurally (an Interface req whose
 * ports exist because the design compiled). An LLM-estimated pass does NOT
 * count — the ledger keeps `green` to real evidence. Vacuous PASS when there
 * are no Must requirements.
 */
function reqMustGreenMeasurer() {
  return function measure(state) {
    const led = buildLedgerForState(state, {});
    const p = led.progress;
    if (!p || p.totalMust === 0) {
      return { measured: 100, denominator: 0, detail: "no Must requirements" };
    }
    return {
      measured: Math.round((p.greenMust / p.totalMust) * 100),
      denominator: p.totalMust,
      detail: p.greenMust + "/" + p.totalMust + " Must requirements green (passing test or structural)",
    };
  };
}

/**
 * Mutation score — testbench strength, measured by pipeline/mutation.js.
 *
 * verify.mutation is only populated when config.mutationTesting is on AND
 * the design passed on the real CLI backend. score = killed / valid × 100;
 * a surviving mutant is a deliberate bug the TB never noticed. With no data
 * the measurer reports denominator 0 so the gate can distinguish "didn't
 * run" from "ran and scored 0".
 */
function mutationScoreMeasurer() {
  return function measure(state) {
    const m = state && state.verify && state.verify.mutation;
    if (!m) {
      return { measured: 0, denominator: 0,
        detail: "no mutation data — enable config.mutationTesting (needs CLI backend)" };
    }
    const valid = (m.total || 0) - (m.invalid || 0);
    if (valid === 0) {
      return { measured: 100, denominator: 0, detail: "no valid mutants ran" };
    }
    const survivors = (m.survived || []).map(function(s) { return s.id + "@" + s.line; });
    return {
      measured: m.score,
      denominator: valid,
      detail: m.killed + "/" + valid + " mutants killed" +
        (survivors.length > 0 ? " — survivors: " + survivors.join(", ") : ""),
    };
  };
}

/**
 * Verify pass rate — straightforward.
 */
function verifyPassRateMeasurer() {
  return function measure(state) {
    const v = state && state.verify;
    if (!v || v.total == null || v.total === 0) {
      return { measured: 100, denominator: 0, detail: "no tests recorded" };
    }
    const pct = Math.round(((v.pass || 0) / v.total) * 100);
    return {
      measured: pct,
      denominator: v.total,
      detail: (v.pass || 0) + "/" + v.total + " tests passing"
        + (v.cli ? " (CLI sim)" : " (LLM-est)"),
    };
  };
}

/**
 * Coverage by type (line/branch/toggle/fsm/expr). Reads from
 * verify.cov.<type>. Missing → 0 (not 100), because if you opt INTO a
 * coverage criterion and the project has no measurement, that's a
 * meaningful failure — set the threshold to 0 to disable.
 */
function coverageMeasurer(kind) {
  return function measure(state) {
    const cov = state && state.verify && state.verify.cov;
    if (!cov) {
      return { measured: 0, denominator: 0,
        detail: "no coverage data (verify hasn't run with coverage)" };
    }
    const v = cov[kind];
    if (typeof v !== "number" || isNaN(v)) {
      return { measured: 0, denominator: 0, detail: "no " + kind + " coverage data" };
    }
    return { measured: Math.round(v), denominator: 1, detail: kind + " coverage = " + v + "%" };
  };
}

/**
 * Formal criteria — count properties of a given type.
 */
function formalCountMeasurer(type) {
  // type ∈ "assert" | "cover"
  return function measure(state) {
    const fp = state && state.formal_props;
    if (!fp) {
      return { measured: 0, denominator: 0, detail: "no formal_props stage data" };
    }
    const items = type === "cover"
      ? (fp.covers || [])
      : ((fp.properties || []).filter(function(p) { return p.type === "assert"; }));
    // Boolean criterion: present (≥ 1) → 100, absent → 0. The user can
    // still set threshold to 100 (must have ≥1) or 0 (always pass).
    return {
      measured: items.length > 0 ? 100 : 0,
      denominator: items.length,
      detail: items.length + " " + (type === "cover" ? "cover statements" : "assertions") + " declared",
    };
  };
}

/**
 * Lint clean criteria — error count. The criterion is "no errors";
 * percentage is binary (100 if errors=0, else 0). Warnings are
 * counted separately under their own criterion.
 */
function lintCleanMeasurer(stageKey) {
  // stageKey ∈ "lint" | "lint_test"
  return function measure(state) {
    const l = state && state[stageKey];
    if (!l) {
      return { measured: 0, denominator: 0, detail: "no " + stageKey + " stage data" };
    }
    const errs = (l.errors || []).length;
    return {
      measured: errs === 0 ? 100 : 0,
      denominator: errs,
      detail: errs + " errors, " + ((l.warnings || []).length) + " warnings",
    };
  };
}

/**
 * Review score criteria — rtl_review.score / test_review.score, treated
 * as already-percentaged.
 */
function reviewScoreMeasurer(stageKey) {
  return function measure(state) {
    const r = state && state[stageKey];
    if (!r || typeof r.score !== "number") {
      return { measured: 0, denominator: 0, detail: "no " + stageKey + " score" };
    }
    return {
      measured: Math.round(r.score),
      denominator: 1,
      detail: stageKey + " score = " + r.score + "/100",
    };
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Each entry: { id, category, label, defaultEnabled, defaultThreshold, measure }
 *
 *   id              : unique stable key (used in config.evalCriteria)
 *   category        : grouping for the GUI panel ("requirements" | "verify"
 *                     | "coverage" | "formal" | "lint" | "review")
 *   label           : human-readable
 *   defaultEnabled  : applied when config.evalCriteria has no entry (Q3
 *                     "conservative defaults" choice)
 *   defaultThreshold: 0..100, applied as above
 *   measure(state)  : deterministic fn returning {measured, denominator, detail}
 *
 * The catalog is built lazily so REQ_CATEGORIES × REQ_PRIORITIES expands
 * cleanly. Order matters for GUI display — categories grouped, then alpha.
 */
const CATALOG = (function buildCatalog() {
  const out = [];

  // Requirements — cat × pri matrix (12 entries)
  for (const cat of REQ_CATEGORIES) {
    for (const pri of REQ_PRIORITIES) {
      const id = "req_" + cat.id + "_" + pri.id;
      // Conservative defaults (Q3): only func+must on at 100, rest off.
      const defaultEnabled  = (cat.id === "func" && pri.id === "must");
      const defaultThreshold = 100;
      out.push({
        id: id,
        category: "requirements",
        label: cat.label + " (" + pri.label + ")",
        defaultEnabled: defaultEnabled,
        defaultThreshold: defaultThreshold,
        measure: reqCriterionMeasurer(cat.id, pri.id),
      });
    }
  }

  // Attribution rigor — strict traceability gate (see mustAttributionMeasurer
  // for why this exists alongside the per-category req criteria). Off by
  // default: it intentionally rejects unannotated-but-green suites, which is
  // a policy users opt into rather than a conservative default.
  out.push({
    id: "req_must_attributed", category: "requirements",
    label: "Must reqs have attributed tests",
    defaultEnabled: false,
    defaultThreshold: 100,
    measure: mustAttributionMeasurer(),
  });

  // Acceptance-ledger greenness — every Must requirement green (real passing
  // test OR structurally satisfied). Complements req_must_attributed (which
  // demands an attributed passing test) by also crediting structural greens.
  // Off by default — opt into ledger-based gating.
  out.push({
    id: "req_must_green", category: "requirements",
    label: "Must reqs green (acceptance ledger)",
    defaultEnabled: false,
    defaultThreshold: 100,
    measure: reqMustGreenMeasurer(),
  });

  // Verify
  out.push({
    id: "verify_pass_rate", category: "verify", label: "Test pass rate",
    defaultEnabled: true,    // Q3 conservative
    defaultThreshold: 100,
    measure: verifyPassRateMeasurer(),
  });
  // TB strength via mutation testing (category "verify" so a failure
  // triages to test_generate first — a weak TB needs better tests, not
  // different RTL). Opt-in: requires config.mutationTesting + CLI backend.
  out.push({
    id: "mutation_score", category: "verify", label: "Mutation score (TB strength)",
    defaultEnabled: false,
    defaultThreshold: 60,
    measure: mutationScoreMeasurer(),
  });

  // Coverage by type
  for (const k of ["line", "branch", "toggle", "fsm", "expr"]) {
    out.push({
      id: "coverage_" + k,
      category: "coverage",
      label: "Coverage — " + k,
      defaultEnabled: false,  // Q3 conservative
      defaultThreshold: k === "line" || k === "branch" ? 80 : 50,
      measure: coverageMeasurer(k),
    });
  }

  // Formal
  out.push({
    id: "formal_assertions_present", category: "formal", label: "Assertions declared",
    defaultEnabled: false, defaultThreshold: 100,
    measure: formalCountMeasurer("assert"),
  });
  out.push({
    id: "formal_covers_present", category: "formal", label: "Cover statements declared",
    defaultEnabled: false, defaultThreshold: 100,
    measure: formalCountMeasurer("cover"),
  });

  // Lint
  out.push({
    id: "lint_rtl_clean", category: "lint", label: "RTL lint clean (0 errors)",
    defaultEnabled: true,    // Q3 conservative
    defaultThreshold: 100,
    measure: lintCleanMeasurer("lint"),
  });
  out.push({
    id: "lint_tb_clean", category: "lint", label: "TB lint clean (0 errors)",
    defaultEnabled: false,
    defaultThreshold: 100,
    measure: lintCleanMeasurer("lint_test"),
  });

  // Review
  out.push({
    id: "review_rtl_score", category: "review", label: "RTL review score",
    defaultEnabled: false, defaultThreshold: 70,
    measure: reviewScoreMeasurer("rtl_review"),
  });
  out.push({
    id: "review_tb_score", category: "review", label: "TB review score",
    defaultEnabled: false, defaultThreshold: 70,
    measure: reviewScoreMeasurer("test_review"),
  });

  return out;
})();

const BY_ID = new Map();
for (const c of CATALOG) BY_ID.set(c.id, c);

/** Public: list every registered criterion (read-only metadata). */
export function listCriteria() {
  return CATALOG.map(function(c) {
    return {
      id: c.id,
      category: c.category,
      label: c.label,
      defaultEnabled: c.defaultEnabled,
      defaultThreshold: c.defaultThreshold,
    };
  });
}

/** Public: look up a criterion by id (returns full record incl. measurer). */
export function getCriterion(id) {
  return BY_ID.get(id) || null;
}

/** Public: list category names in display order. */
export function listCategories() {
  return ["requirements", "verify", "coverage", "formal", "lint", "review"];
}

/**
 * Build a default config.evalCriteria object — this is what gets seeded
 * when a project has no eval config yet (Q3 conservative defaults).
 */
export function defaultEvalConfig() {
  const out = {};
  for (const c of CATALOG) {
    out[c.id] = { enabled: c.defaultEnabled, threshold: c.defaultThreshold };
  }
  return out;
}

/**
 * Validate (and optionally normalize) a user-supplied evalCriteria
 * object. Unknown ids and out-of-range thresholds are coerced or dropped
 * with collected warnings; the result is always a valid config.
 *
 * Threshold rule: 0 ≤ threshold ≤ 100 (per Q3). Values outside that
 * range are clamped.
 */
export function normalizeEvalConfig(raw) {
  const warnings = [];
  const out = defaultEvalConfig();
  if (!raw || typeof raw !== "object") return { config: out, warnings };
  for (const id of Object.keys(raw)) {
    if (!BY_ID.has(id)) {
      warnings.push("unknown criterion id '" + id + "' (ignored)");
      continue;
    }
    const v = raw[id];
    if (!v || typeof v !== "object") {
      warnings.push("criterion '" + id + "' value is not an object (using defaults)");
      continue;
    }
    const enabled = v.enabled === true;
    let t = typeof v.threshold === "number" ? v.threshold : out[id].threshold;
    if (t < 0)   { warnings.push("criterion '" + id + "' threshold " + t + " < 0 (clamped to 0)");   t = 0;   }
    if (t > 100) { warnings.push("criterion '" + id + "' threshold " + t + " > 100 (clamped to 100)"); t = 100; }
    out[id] = { enabled: enabled, threshold: t };
  }
  return { config: out, warnings };
}

// Test seam — exposes catalog for verify-eval.mjs to count entries
export const _internal = { CATALOG, REQ_CATEGORIES, REQ_PRIORITIES };
