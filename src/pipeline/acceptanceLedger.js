// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// acceptanceLedger — per-requirement acceptance spine (Phases 1–2)
//
// The eval gate measures requirement coverage in aggregate; the ledger adds the
// per-requirement view: each spec requirement gets one explicit STATUS and a
// single `green` flag, so a run has a monotonic "N/M Must green — are we there
// yet?" picture instead of only category rollups.
//
// PURE. Attribution is NOT re-implemented here — the verify node already maps
// each test to a requirement (`tests[].req` via attributeTestToReq); deriveLedger
// just consumes that. `estimated`/`compiled`/`inGate` are injected, so the core
// is unit-testable with plain arrays.
//
// green = a requirement is confirmed by a real passing test OR satisfied
// structurally (its interface exists because the design compiled). An
// LLM-ESTIMATED pass is deliberately NOT green — visible, but no independent
// evidence yet, so the ledger never over-claims.
// ═══════════════════════════════════════════════════════════════════════════

const STRUCTURAL_CATS = ["intf", "interface", "io", "port"];

const CAT_TO_CRIT = [
  { id: "func",   re: /^(func|functional|functionality)$/ },
  { id: "verif",  re: /^(verif|verification|test|testbench)$/ },
  { id: "timing", re: /^(timing|perf|performance)$/ },
  { id: "intf",   re: /^(intf|interface|io|port)$/ },
];

function up(s) { return String(s == null ? "" : s).toUpperCase(); }
function lc(s) { return String(s == null ? "" : s).toLowerCase(); }
function isStructuralCat(cat) { return STRUCTURAL_CATS.indexOf(lc(cat)) >= 0; }

/** Map a requirement's free-text category to the eval criterion category id. */
function critCatId(cat) {
  const c = lc(cat);
  for (const m of CAT_TO_CRIT) if (m.re.test(c)) return m.id;
  return null;
}

/**
 * Is this requirement covered by an ENABLED requirement criterion? Pure over a
 * normalized evalCfg ({ id: { enabled, threshold } }).
 */
export function isReqInGate(req, evalCfg) {
  const cfg = evalCfg || {};
  function on(id) { return !!(cfg[id] && cfg[id].enabled); }
  const pri = lc(req && req.pri);
  const catId = critCatId(req && req.cat);
  if (catId && (pri === "must" || pri === "should") && on("req_" + catId + "_" + pri)) return true;
  if (pri === "must" && (on("req_must_attributed") || on("req_must_green"))) return true;
  return false;
}

/**
 * Tally mutation kills per requirement (Phase 6). A killed mutant's `killedBy`
 * test names are mapped to requirements via verify.tests[].req; each mutant
 * credits at most 1 to a requirement (so strength = # distinct bugs the req's
 * tests caught, not # of tests). Unattributed killers are ignored. Pure.
 * @returns {{ byReq: { [REQ]: number } }}
 */
export function attributeMutationKills(killers, verifyTests) {
  const ks = Array.isArray(killers) ? killers : [];
  const tests = Array.isArray(verifyTests) ? verifyTests : [];
  const nameToReq = {};
  tests.forEach(function(t) { if (t && t.name && t.req) nameToReq[t.name] = up(t.req); });
  const byReq = {};
  ks.forEach(function(k) {
    const reqs = new Set();
    ((k && k.killedBy) || []).forEach(function(name) { const rid = nameToReq[name]; if (rid) reqs.add(rid); });
    reqs.forEach(function(rid) { byReq[rid] = (byReq[rid] || 0) + 1; });
  });
  return { byReq: byReq };
}

/**
 * Derive the per-requirement ledger. Pure.
 * @param {Array}  requirements  spec.requirements [{ id, pri, cat, desc }]
 * @param {Array}  verifyTests   verify.tests [{ name, st, req }]
 * @param {object} [opts] { estimated, compiled, inGate?(req)->bool, mutation? }
 * @returns {{ requirements: Array, progress: object }}
 */
export function deriveLedger(requirements, verifyTests, opts) {
  const o = opts || {};
  const reqs = Array.isArray(requirements) ? requirements : [];
  const tests = Array.isArray(verifyTests) ? verifyTests : [];
  const estimated = !!o.estimated;
  const compiled = !!o.compiled;
  const inGate = typeof o.inGate === "function" ? o.inGate : function() { return false; };

  // Mutation strength (Phase 6): POSITIVE evidence only. "killed a mutant" ⇒
  // strong; "no kills" is inconclusive (unproven), never a downgrade of green.
  const hasMutation = !!(o.mutation && Array.isArray(o.mutation.killers));
  const killsByReq = hasMutation ? attributeMutationKills(o.mutation.killers, tests).byReq : {};

  const byReq = {};
  for (const t of tests) {
    if (!t || !t.req) continue;
    const k = up(t.req);
    (byReq[k] = byReq[k] || []).push(t);
  }

  const entries = reqs.map(function(r) {
    const linked = byReq[up(r.id)] || [];
    const coveringTests = linked.map(function(t) { return t.name; });
    const failingTests = linked.filter(function(t) { return t.st === "FAIL"; }).map(function(t) { return t.name; });
    let status;
    if (linked.length > 0) {
      if (failingTests.length > 0) status = "tested-failing";
      else status = estimated ? "tested-passing-estimated" : "tested-passing";
    } else {
      status = (isStructuralCat(r.cat) && compiled) ? "structural" : "untested";
    }
    const green = status === "tested-passing" || status === "structural";
    // Strength is orthogonal to green and applies only to a REAL passing req.
    const mutationKills = hasMutation ? (killsByReq[up(r.id)] || 0) : 0;
    let strength = "n/a";
    if (hasMutation && status === "tested-passing") {
      strength = mutationKills > 0 ? "strong" : "unproven";
    }
    return {
      id: r.id, pri: r.pri || null, cat: r.cat || null, desc: r.desc || "",
      status: status, green: green, inGate: !!inGate(r),
      coveringTests: coveringTests, failingTests: failingTests,
      strength: strength, mutationKills: mutationKills,
    };
  });

  const must = entries.filter(function(e) { return lc(e.pri) === "must"; });
  const greenMust = must.filter(function(e) { return e.green; }).length;
  const greenAll = entries.filter(function(e) { return e.green; }).length;
  const totalMust = must.length;
  const totalAll = entries.length;
  const done = totalMust > 0 ? greenMust === totalMust : (totalAll > 0 ? greenAll === totalAll : false);
  const testedPassingMust = must.filter(function(e) { return e.status === "tested-passing"; }).length;
  const strongMust = must.filter(function(e) { return e.strength === "strong"; }).length;

  return {
    requirements: entries,
    progress: {
      greenMust: greenMust, totalMust: totalMust, greenAll: greenAll, totalAll: totalAll, done: done,
      testedPassingMust: testedPassingMust, strongMust: strongMust,
    },
  };
}

/**
 * Assemble the ledger from a pipeline state (the shape the UI/judge phases will
 * consume). `estimated` from verify.cli !== true; `compiled` from verify having
 * run without a `compilation` FAIL; `inGate` from the enabled req criteria.
 */
export function buildLedgerForState(state, evalCfg) {
  const st = state || {};
  const spec = st.spec || {};
  const verify = st.verify || {};
  const reqs = Array.isArray(spec.requirements) ? spec.requirements : [];
  const tests = Array.isArray(verify.tests) ? verify.tests : [];
  const verifyRan = !!(st.verify && (verify.cli === true || tests.length > 0 || typeof verify.pass === "number"));
  const hasCompileFail = tests.some(function(t) { return t && t.name === "compilation" && t.st === "FAIL"; });
  const cfg = evalCfg || {};
  return deriveLedger(reqs, tests, {
    estimated: verify.cli !== true,
    compiled: verifyRan && !hasCompileFail,
    inGate: function(r) { return isReqInGate(r, cfg); },
    mutation: verify.mutation || null,
  });
}

/**
 * Must requirements that are NOT green — the convergence target. Includes
 * untested Must reqs (which never appear in a failing-tests list) and
 * estimated passes (not yet real). Sorted failing → untested → estimated.
 * @returns {Array<{id, status, desc, pri}>}
 */
export function unmetMustRequirements(ledger) {
  const entries = (ledger && ledger.requirements) || [];
  const order = { "tested-failing": 0, "untested": 1, "tested-passing-estimated": 2 };
  return entries
    .filter(function(e) { return lc(e.pri) === "must" && !e.green; })
    .map(function(e) { return { id: e.id, status: e.status, desc: e.desc, pri: e.pri }; })
    .sort(function(a, b) {
      const ra = order[a.status]; const rb = order[b.status];
      return (ra == null ? 9 : ra) - (rb == null ? 9 : rb);
    });
}

/** One-line progress summary, e.g. "3/5 Must green · 7/12 all". */
export function formatLedgerProgress(progress) {
  const p = progress || {};
  return (p.greenMust || 0) + "/" + (p.totalMust || 0) + " Must green · "
    + (p.greenAll || 0) + "/" + (p.totalAll || 0) + " all";
}
