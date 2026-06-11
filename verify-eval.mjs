// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// verify-eval — Standalone verifier for src/eval/* (deterministic gate)
//
// Same pattern as verify-skills.mjs / verify-term.mjs: zero deps, run
// with `node`. No LLM mocking needed — this entire subsystem is pure
// functions over plain state objects.
// ═══════════════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") await r;
    process.stdout.write("  \u001b[32m✓\u001b[0m " + name + "\n");
    passed++;
  } catch (e) {
    process.stdout.write("  \u001b[31m✗\u001b[0m " + name + "  →  " + (e.message || e) + "\n");
    failures.push({ name, message: e.message || String(e) });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// criteria — registry, defaults, normalization
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[eval/criteria]");
const {
  listCriteria, getCriterion, listCategories,
  defaultEvalConfig, normalizeEvalConfig, _internal,
} = await import("./src/eval/criteria.js");

await check("criteria: catalog has 21 entries (9 reqs + 1 verify + 5 cov + 2 formal + 2 lint + 2 review)", () => {
  const all = listCriteria();
  // 4 cats × 2 priorities = 8 reqs, + req_must_attributed (strict
  // traceability); +1 verify; +5 coverage; +2 formal; +2 lint; +2 review = 21
  assert.equal(all.length, 21);
});

// The catalog no longer contains req_*_all entries. The
// "All priorities" surface is a UI grouping checkbox in EvalsTab that
// toggles must+should children together; it is NOT its own criterion.
await check("criteria: no req_*_all entries (A4: 'All priorities' is UI grouping, not a criterion)", () => {
  const allIds = listCriteria().map(function(c) { return c.id; });
  const ghostAllIds = allIds.filter(function(id) { return /^req_.*_all$/.test(id); });
  assert.deepEqual(ghostAllIds, [],
    "expected zero req_*_all entries; got: " + JSON.stringify(ghostAllIds));
});

await check("criteria: requirements category has 9 entries (4 cats × must+should + attribution)", () => {
  const reqIds = listCriteria()
    .filter(function(c) { return c.category === "requirements"; })
    .map(function(c) { return c.id; })
    .sort();
  assert.deepEqual(reqIds, [
    "req_func_must",   "req_func_should",
    "req_intf_must",   "req_intf_should",
    "req_must_attributed",
    "req_timing_must", "req_timing_should",
    "req_verif_must",  "req_verif_should",
  ]);
});

await check("criteria: all entries have required fields", () => {
  for (const c of listCriteria()) {
    assert.ok(typeof c.id === "string" && c.id.length > 0, "id missing for " + JSON.stringify(c));
    assert.ok(["requirements", "verify", "coverage", "formal", "lint", "review"].includes(c.category),
      "bad category for " + c.id);
    assert.ok(typeof c.label === "string" && c.label.length > 0);
    assert.ok(typeof c.defaultEnabled === "boolean");
    assert.ok(typeof c.defaultThreshold === "number");
    assert.ok(c.defaultThreshold >= 0 && c.defaultThreshold <= 100);
  }
});

await check("criteria: getCriterion returns null for unknown id", () => {
  assert.equal(getCriterion("does_not_exist"), null);
});

await check("criteria: getCriterion returns the registered record with measurer", () => {
  const c = getCriterion("verify_pass_rate");
  assert.ok(c);
  assert.equal(typeof c.measure, "function");
});

await check("criteria: defaultEvalConfig matches Q3 conservative defaults", () => {
  const cfg = defaultEvalConfig();
  // Q3: func reqs (must) 100, verify 100, RTL lint clean; rest off
  assert.equal(cfg.req_func_must.enabled, true);
  assert.equal(cfg.req_func_must.threshold, 100);
  assert.equal(cfg.verify_pass_rate.enabled, true);
  assert.equal(cfg.lint_rtl_clean.enabled, true);
  // Off by default
  assert.equal(cfg.req_func_should.enabled, false);
  assert.equal(cfg.req_intf_must.enabled, false);
  assert.equal(cfg.coverage_line.enabled, false);
  assert.equal(cfg.formal_assertions_present.enabled, false);
  assert.equal(cfg.lint_tb_clean.enabled, false);
  assert.equal(cfg.review_rtl_score.enabled, false);
});

await check("criteria: defaultEvalConfig has every catalog id", () => {
  const cfg = defaultEvalConfig();
  for (const meta of listCriteria()) {
    assert.ok(cfg[meta.id], "default config missing entry for " + meta.id);
  }
});

await check("criteria: normalizeEvalConfig clamps threshold to 0..100", () => {
  const r1 = normalizeEvalConfig({ req_func_must: { enabled: true, threshold: 200 } });
  assert.equal(r1.config.req_func_must.threshold, 100);
  assert.match(r1.warnings[0], /clamped to 100/);

  const r2 = normalizeEvalConfig({ req_func_must: { enabled: true, threshold: -5 } });
  assert.equal(r2.config.req_func_must.threshold, 0);
  assert.match(r2.warnings[0], /clamped to 0/);
});

await check("criteria: normalizeEvalConfig drops unknown criterion ids with warning", () => {
  const r = normalizeEvalConfig({ nonexistent_criterion: { enabled: true, threshold: 50 } });
  assert.match(r.warnings[0], /unknown criterion id/);
  // Other defaults preserved
  assert.equal(r.config.req_func_must.enabled, true);
});

await check("criteria: normalizeEvalConfig handles empty/missing input", () => {
  const r1 = normalizeEvalConfig(null);
  assert.equal(r1.config.req_func_must.enabled, true);
  const r2 = normalizeEvalConfig({});
  assert.equal(r2.config.req_func_must.enabled, true);
});

await check("criteria: listCategories returns the 6 expected categories in display order", () => {
  assert.deepEqual(listCategories(),
    ["requirements", "verify", "coverage", "formal", "lint", "review"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// measurers — direct unit tests on each criterion's measure() fn
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[eval/measurers]");

await check("measurer: req_func_must matches 'Functionality' (synonym handling)", () => {
  const c = getCriterion("req_func_must");
  const m = c.measure({
    spec: { requirements: [{ id: "R1", cat: "Functionality", pri: "Must" }] },
    judge: { trace: [{ req: "R1", ok: true }] },
  });
  assert.equal(m.measured, 100);
  assert.equal(m.denominator, 1);
});

await check("measurer: req_func_must vacuously 100 when no in-scope reqs", () => {
  const c = getCriterion("req_func_must");
  const m = c.measure({
    spec: { requirements: [{ id: "R1", cat: "Interface", pri: "Must" }] },
    judge: { trace: [] },
  });
  assert.equal(m.measured, 100);
  assert.equal(m.denominator, 0);
});

await check("measurer: req_func_must reports % when partially traced", () => {
  const c = getCriterion("req_func_must");
  const m = c.measure({
    spec: { requirements: [
      { id: "R1", cat: "func", pri: "must" },
      { id: "R2", cat: "func", pri: "must" },
      { id: "R3", cat: "func", pri: "must" },
    ]},
    judge: { trace: [
      { req: "R1", ok: true },
      { req: "R2", ok: true },
      { req: "R3", ok: false },
    ]},
  });
  assert.equal(m.measured, 67);
  assert.equal(m.denominator, 3);
});

await check("measurer: verify_pass_rate computes pct from pass/total", () => {
  const c = getCriterion("verify_pass_rate");
  assert.equal(c.measure({ verify: { pass: 4, fail: 1, total: 5 } }).measured, 80);
  assert.equal(c.measure({ verify: { pass: 0, fail: 1, total: 1 } }).measured, 0);
  assert.equal(c.measure({ verify: { pass: 1, fail: 0, total: 1 } }).measured, 100);
});

await check("measurer: verify_pass_rate vacuously 100 with no tests", () => {
  const c = getCriterion("verify_pass_rate");
  const m = c.measure({ verify: { pass: 0, fail: 0, total: 0 } });
  assert.equal(m.measured, 100);
  assert.equal(m.denominator, 0);
});

await check("measurer: coverage_line reads from verify.cov.line", () => {
  const c = getCriterion("coverage_line");
  assert.equal(c.measure({ verify: { cov: { line: 75 } } }).measured, 75);
  assert.equal(c.measure({ verify: { cov: { line: 100 } } }).measured, 100);
});

await check("measurer: coverage_line returns 0 when no coverage data", () => {
  const c = getCriterion("coverage_line");
  assert.equal(c.measure({ verify: {} }).measured, 0);
  assert.equal(c.measure({ verify: { cov: {} } }).measured, 0);
  assert.equal(c.measure({}).measured, 0);
});

await check("measurer: lint_rtl_clean is binary on errors=0", () => {
  const c = getCriterion("lint_rtl_clean");
  assert.equal(c.measure({ lint: { errors: [], warnings: [] } }).measured, 100);
  assert.equal(c.measure({ lint: { errors: [{ msg: "x" }], warnings: [] } }).measured, 0);
});

await check("measurer: formal_assertions_present is binary on count > 0", () => {
  const c = getCriterion("formal_assertions_present");
  assert.equal(c.measure({ formal_props: { properties: [] } }).measured, 0);
  assert.equal(c.measure({
    formal_props: { properties: [{ type: "assert" }, { type: "assume" }] }
  }).measured, 100);
});

await check("measurer: review_rtl_score reads rtl_review.score directly", () => {
  const c = getCriterion("review_rtl_score");
  assert.equal(c.measure({ rtl_review: { score: 87 } }).measured, 87);
  assert.equal(c.measure({}).measured, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// gate — runEvalGate end-to-end
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[eval/gate]");
const { runEvalGate, triageTargetsFor } = await import("./src/eval/gate.js");

await check("gate: PASS with state satisfying default-enabled criteria", () => {
  const v = runEvalGate({
    spec: { requirements: [{ id: "R1", cat: "func", pri: "must" }] },
    judge: { trace: [{ req: "R1", ok: true }] },
    verify: { pass: 1, fail: 0, total: 1, cov: {} },
    lint: { errors: [], warnings: [] },
  }, defaultEvalConfig());
  assert.equal(v.overall, "PASS");
  assert.equal(v.totalEnabled, 3);
  assert.equal(v.passed, 3);
  assert.equal(v.failed, 0);
  assert.equal(v.score, 100);
});

await check("gate: FAIL produces failingIds for each failing criterion", () => {
  const v = runEvalGate({
    spec: { requirements: [{ id: "R1", cat: "func", pri: "must" }] },
    judge: { trace: [{ req: "R1", ok: true }] },
    verify: { pass: 0, fail: 1, total: 1, cov: {} },  // failing
    lint: { errors: [{ msg: "e" }], warnings: [] },   // failing
  }, defaultEvalConfig());
  assert.equal(v.overall, "FAIL");
  assert.equal(v.failed, 2);
  assert.deepEqual(v.failingIds.sort(),
    ["lint_rtl_clean", "verify_pass_rate"].sort());
});

await check("gate: score is % of enabled criteria passing", () => {
  // 3 enabled, 2 pass → 67
  const v = runEvalGate({
    spec: { requirements: [{ id: "R1", cat: "func", pri: "must" }] },
    judge: { trace: [{ req: "R1", ok: true }] },
    verify: { pass: 0, fail: 1, total: 1 },
    lint: { errors: [], warnings: [] },
  }, defaultEvalConfig());
  assert.equal(v.score, 67);
});

await check("gate: vacuous 100 score when nothing enabled", () => {
  const off = {};
  for (const c of listCriteria()) off[c.id] = { enabled: false, threshold: 100 };
  const v = runEvalGate({}, off);
  assert.equal(v.overall, "PASS");
  assert.equal(v.score, 100);
  assert.equal(v.totalEnabled, 0);
});

await check("gate: per-criterion margin reports measured - threshold", () => {
  const v = runEvalGate({
    verify: { pass: 7, fail: 3, total: 10 },
  }, {
    verify_pass_rate: { enabled: true, threshold: 90 },
  });
  const verifyResult = v.results.find(function(r) { return r.id === "verify_pass_rate"; });
  assert.equal(verifyResult.measured, 70);
  assert.equal(verifyResult.threshold, 90);
  assert.equal(verifyResult.margin, -20);
  assert.equal(verifyResult.status, "FAIL");
});

await check("gate: PASS rule is measured >= threshold (100 vs 100 should pass)", () => {
  const v = runEvalGate({
    verify: { pass: 10, fail: 0, total: 10 },
  }, {
    verify_pass_rate: { enabled: true, threshold: 100 },
  });
  const verifyResult = v.results.find(function(r) { return r.id === "verify_pass_rate"; });
  assert.equal(verifyResult.measured, 100);
  assert.equal(verifyResult.status, "PASS",
    "100 ≥ 100 must pass — otherwise threshold=100 is unreachable");
});

await check("gate: results array preserves all 21 criteria (enabled or not)", () => {
  const v = runEvalGate({}, defaultEvalConfig());
  assert.equal(v.results.length, 21);
  // Disabled ones get status SKIP
  const skips = v.results.filter(function(r) { return r.status === "SKIP"; });
  assert.ok(skips.length > 0, "expected some SKIP entries with conservative defaults");
});

await check("gate: categories summary tracks pass/fail/skipped per category", () => {
  const v = runEvalGate({
    spec: { requirements: [{ id: "R1", cat: "func", pri: "must" }] },
    judge: { trace: [{ req: "R1", ok: true }] },
    verify: { pass: 1, fail: 0, total: 1 },
    lint: { errors: [], warnings: [] },
  }, defaultEvalConfig());
  assert.equal(v.categories.requirements.pass, 1);    // req_func_must
  assert.equal(v.categories.verify.pass, 1);          // verify_pass_rate
  assert.equal(v.categories.lint.pass, 1);            // lint_rtl_clean
  // Categories with no defaults enabled are all skipped
  assert.equal(v.categories.coverage.pass + v.categories.coverage.fail, 0);
  assert.ok(v.categories.coverage.skipped > 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// triageTargetsFor — picks fix targets from verdict
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[eval/triage]");

await check("triage: empty list when no failures", () => {
  const targets = triageTargetsFor({ failingIds: [], results: [] });
  assert.deepEqual(targets, []);
});

await check("triage: verify failure → [test_generate, rtl_generate]", () => {
  // Disable other defaults so only verify_pass_rate is enabled
  const onlyVerify = {};
  for (const c of listCriteria()) onlyVerify[c.id] = { enabled: false, threshold: 100 };
  onlyVerify.verify_pass_rate = { enabled: true, threshold: 100 };
  const verdict = runEvalGate({
    verify: { pass: 0, fail: 1, total: 1 },
  }, onlyVerify);
  const targets = triageTargetsFor(verdict);
  assert.deepEqual(targets, ["test_generate", "rtl_generate"]);
});

await check("triage: requirements failure → [rtl_generate, spec]", () => {
  const onlyReq = {};
  for (const c of listCriteria()) onlyReq[c.id] = { enabled: false, threshold: 100 };
  onlyReq.req_func_must = { enabled: true, threshold: 100 };
  const verdict = runEvalGate({
    spec: { requirements: [{ id: "R1", cat: "func", pri: "must" }] },
    judge: { trace: [{ req: "R1", ok: false }] },
  }, onlyReq);
  const targets = triageTargetsFor(verdict);
  assert.deepEqual(targets, ["rtl_generate", "spec"]);
});

await check("triage: lint failure → [rtl_generate]", () => {
  const onlyLint = {};
  for (const c of listCriteria()) onlyLint[c.id] = { enabled: false, threshold: 100 };
  onlyLint.lint_rtl_clean = { enabled: true, threshold: 100 };
  const verdict = runEvalGate({
    lint: { errors: [{ msg: "e" }], warnings: [] },
  }, onlyLint);
  const targets = triageTargetsFor(verdict);
  assert.deepEqual(targets, ["rtl_generate"]);
});

await check("triage: coverage failure → [test_generate]", () => {
  const onlyCov = {};
  for (const c of listCriteria()) onlyCov[c.id] = { enabled: false, threshold: 100 };
  onlyCov.coverage_line = { enabled: true, threshold: 80 };
  const verdict = runEvalGate({
    verify: { cov: { line: 50 } },
  }, onlyCov);
  const targets = triageTargetsFor(verdict);
  assert.deepEqual(targets, ["test_generate"]);
});

await check("triage: deduplicates targets across multiple failing categories", () => {
  // Both verify and coverage failing → both want test_generate; dedup
  const cfg = {};
  for (const c of listCriteria()) cfg[c.id] = { enabled: false, threshold: 100 };
  cfg.verify_pass_rate = { enabled: true, threshold: 100 };
  cfg.coverage_line    = { enabled: true, threshold: 80 };
  const verdict = runEvalGate({
    verify: { pass: 0, fail: 1, total: 1, cov: { line: 50 } },
  }, cfg);
  const targets = triageTargetsFor(verdict);
  assert.equal(targets[0], "test_generate");
  assert.equal(new Set(targets).size, targets.length, "no duplicate targets");
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 3 fallback: all-pass tests + no req attribution
//   covers the "verify says PASS, judge says func-must fails" symptom.
// ═══════════════════════════════════════════════════════════════════════════

await check("layer 3 fallback: all-pass uncoupled tests presume Must coverage", () => {
  const state = {
    spec: { requirements: [
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "a" },
      { id: "REQ-FUNC-002", cat: "Functionality", pri: "Must", desc: "b" },
    ]},
    verify: { pass: 3, fail: 0, total: 3, tests: [
      { name: "t_reset",  st: "PASS", req: null },
      { name: "t_write",  st: "PASS", req: null },
      { name: "t_read",   st: "PASS", req: null },
    ]},
  };
  const r = getCriterion("req_func_must").measure(state);
  assert.equal(r.measured, 100);
  assert.equal(r.denominator, 2);
  assert.match(r.detail, /presumed via all-pass/);
});

await check("layer 3 fallback: Should/May do NOT benefit (rigor preserved)", () => {
  const state = {
    spec: { requirements: [
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Should", desc: "a" },
    ]},
    verify: { pass: 1, fail: 0, total: 1, tests: [
      { name: "t_x",  st: "PASS", req: null },
    ]},
  };
  const r = getCriterion("req_func_should").measure(state);
  assert.equal(r.measured, 0);
});

await check("layer 3 fallback: does NOT trigger when any test failed", () => {
  const state = {
    spec: { requirements: [
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "a" },
    ]},
    verify: { pass: 2, fail: 1, total: 3, tests: [
      { name: "t_a", st: "PASS", req: null },
      { name: "t_b", st: "FAIL", req: null },
      { name: "t_c", st: "PASS", req: null },
    ]},
  };
  const r = getCriterion("req_func_must").measure(state);
  assert.equal(r.measured, 0);
});

await check("layer 3 fallback: does NOT trigger when tests have annotations (rigor preserved)", () => {
  const state = {
    spec: { requirements: [
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "a" },
      { id: "REQ-FUNC-002", cat: "Functionality", pri: "Must", desc: "b" },
    ]},
    verify: { pass: 2, fail: 0, total: 2, tests: [
      { name: "t_a", st: "PASS", req: "REQ-FUNC-001" },
      { name: "t_b", st: "PASS", req: null },
    ]},
  };
  const r = getCriterion("req_func_must").measure(state);
  // 1/2 = 50% via Layer 2 (one annotated test); the unannotated test
  // does NOT trigger layer 3 because the suite isn't fully uncoupled
  assert.equal(r.measured, 50);
});

await check("layer 2: per-req attribution via verify.tests[i].req still works", () => {
  const state = {
    spec: { requirements: [
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "a" },
    ]},
    verify: { pass: 1, fail: 0, total: 1, tests: [
      { name: "test_req_func_001", st: "PASS", req: "REQ-FUNC-001" },
    ]},
  };
  const r = getCriterion("req_func_must").measure(state);
  assert.equal(r.measured, 100);
  assert.match(r.detail, /via verify\.tests fallback/);
});

// ═══════════════════════════════════════════════════════════════════════════
// req_must_attributed — strict traceability gate
//   The rigorous counterpart to the per-category criteria: NEVER honors the
//   all-pass presumption. Opt-in (defaultEnabled false).
// ═══════════════════════════════════════════════════════════════════════════

await check("req_must_attributed: 100 when every Must req has attributed passing tests", () => {
  const state = {
    spec: { requirements: [
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must",   desc: "a" },
      { id: "REQ-INTF-001", cat: "Interface",     pri: "Must",   desc: "b" },
      { id: "REQ-TIME-001", cat: "Timing",        pri: "Should", desc: "c" }, // not in scope
    ]},
    verify: { tests: [
      { name: "t_func", st: "PASS", req: "REQ-FUNC-001" },
      { name: "t_intf", st: "PASS", req: "REQ-INTF-001" },
    ]},
  };
  const r = getCriterion("req_must_attributed").measure(state);
  assert.equal(r.measured, 100);
  assert.equal(r.denominator, 2);
});

await check("req_must_attributed: all-pass UNANNOTATED suite scores 0 (no Layer-3 presumption)", () => {
  // Identical setup to the Layer-3 fallback check above — where
  // req_func_must presumes coverage, this criterion demands the trace.
  const state = {
    spec: { requirements: [
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "a" },
      { id: "REQ-FUNC-002", cat: "Functionality", pri: "Must", desc: "b" },
    ]},
    verify: { pass: 3, fail: 0, total: 3, tests: [
      { name: "t_reset", st: "PASS", req: null },
      { name: "t_write", st: "PASS", req: null },
      { name: "t_read",  st: "PASS", req: null },
    ]},
  };
  const r = getCriterion("req_must_attributed").measure(state);
  assert.equal(r.measured, 0, "green-but-untraceable must not satisfy the strict gate");
  assert.match(r.detail, /REQ-FUNC-001/);
});

await check("req_must_attributed: partial attribution scores proportionally + names the gaps", () => {
  const state = {
    spec: { requirements: [
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "a" },
      { id: "REQ-FUNC-002", cat: "Functionality", pri: "Must", desc: "b" },
    ]},
    verify: { tests: [
      { name: "t_a", st: "PASS", req: "REQ-FUNC-001" },
      { name: "t_b", st: "PASS", req: null },
    ]},
  };
  const r = getCriterion("req_must_attributed").measure(state);
  assert.equal(r.measured, 50);
  assert.match(r.detail, /REQ-FUNC-002/);
  assert.ok(!/REQ-FUNC-001/.test(r.detail.split("—")[1] || ""), "satisfied req not listed as missing");
});

await check("req_must_attributed: an attributed FAILING test does not satisfy the req", () => {
  const state = {
    spec: { requirements: [
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "a" },
    ]},
    verify: { tests: [
      { name: "t_a", st: "FAIL", req: "REQ-FUNC-001" },
    ]},
  };
  const r = getCriterion("req_must_attributed").measure(state);
  assert.equal(r.measured, 0);
});

await check("req_must_attributed: vacuous pass with no Must requirements", () => {
  const state = {
    spec: { requirements: [{ id: "REQ-X", cat: "Functionality", pri: "Should", desc: "x" }] },
    verify: { tests: [{ name: "t", st: "PASS", req: null }] },
  };
  const r = getCriterion("req_must_attributed").measure(state);
  assert.equal(r.measured, 100);
  assert.equal(r.denominator, 0);
});

await check("triage: req_must_attributed failure routes to test_generate first", () => {
  // Annotation gaps live in the TESTBENCH; the requirements category's
  // default targets (rtl_generate/spec) cannot add // covers: lines.
  const verdict = {
    failingIds: ["req_must_attributed"],
    results: [{ id: "req_must_attributed", status: "FAIL", category: "requirements" }],
  };
  const targets = triageTargetsFor(verdict);
  assert.equal(targets[0], "test_generate");
  assert.ok(targets.indexOf("rtl_generate") > 0, "category defaults still follow");
});

// ═══════════════════════════════════════════════════════════════════════════
// Verdict
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════");
console.log("  Passed: " + passed);
console.log("  Failed: " + failures.length);
console.log("  Status: " + (failures.length === 0 ? "ALL PASS ✓" : "FAILURES"));
console.log("═══════════════════════════════════════");
if (failures.length > 0) {
  for (const f of failures) console.log("  • " + f.name + ": " + f.message);
  process.exit(1);
}
